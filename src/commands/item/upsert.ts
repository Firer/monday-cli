/**
 * `monday item upsert --board <bid> --name <n> --match-by <col>[,<col>...]
 *  [--set <col>=<val>]... [--set-raw <col>=<json>]... [--dry-run]`
 * (`cli-design.md` §4.3 line 529, §5.8 + §6.4 + §6.5,
 * `v0.2-plan.md` §3 M12).
 *
 * The idempotency-cluster verb. **0 matches** → branches to
 * `create_item` (M9 wire surface). **1 match** → branches to the v0.1
 * `item update` shape (synthetic `name` key bundled into
 * `change_multiple_column_values` per §5.3 step 5; or
 * `change_simple_column_value(column_id: "name")` when `--name` is the
 * only diff). **2+ matches** → fails with `ambiguous_match` carrying
 * `details.candidates: [{id, name}, ...]` capped at 10. The mutation
 * envelope's `data.operation: "create_item" | "update_item"` exposes
 * the branch on the success envelope; the dry-run encodes the same
 * via `planned_changes[0].operation`.
 *
 * **Sequential-retry idempotent only** (cli-design §5.8 + §9.1). Two
 * agents observing zero matches at the same instant both branch to
 * `create_item`; the next call from either agent surfaces the
 * duplicate as `ambiguous_match`. Concurrent-write protection via
 * Monday's resource-locking mutations is a v0.4 candidate (cli-design
 * §9.3). Race-mitigation guidance — pick a stable hidden-key column
 * for `--match-by` and tighten the predicate so a duplicate from a
 * race surfaces as `ambiguous_match` on the next call — lives in
 * `--help` and §6.5.
 *
 * **Match-by semantics.** `--match-by <col>[,<col>...]` accepts
 * comma-separated column tokens (resolved via the same column
 * resolver `--set` uses) plus the literal `name` pseudo-token, which
 * matches against the item's `name` field via Monday's `column_id:
 * "name"` filter. Multiple tokens AND-combine — adding a token
 * narrows the match set, so an agent seeing `ambiguous_match` knows
 * widening the predicate by one column is the recovery path. Each
 * column token's match value comes from the corresponding
 * `--set <token>=<value>` (which is **required** for every match-by
 * column token); the `name` token's match value comes from
 * `--name <n>`. `--set-raw <col>=<json>` participates in column
 * updates but **cannot appear in `--match-by`** because the JSON wire
 * shape isn't a filter-comparable scalar — `usage_error` if an agent
 * tries.
 *
 * **Mutation surface reuse, not entry-point reuse.** This module
 * issues the same wire mutations `commands/item/create.ts` and
 * `commands/item/update.ts` issue (CREATE_ITEM_MUTATION,
 * CHANGE_SIMPLE_COLUMN_VALUE_MUTATION, CHANGE_COLUMN_VALUE_MUTATION,
 * CHANGE_MULTIPLE_COLUMN_VALUES_MUTATION); the GraphQL strings are
 * inlined here rather than imported because every existing site
 * declares them locally too (the third-consumer trigger fires at the
 * fourth+ site, not the third — see v0.2-plan §16's lift-on-third-
 * consumer rule). The translator pipeline (`resolveAndTranslate` +
 * `selectMutation` + `bundleColumnValues`) is the shared layer the
 * three commands collapse onto, so the synthetic-`name` bundling +
 * column-archived remap + `name + multi-column` atomicity contracts
 * stay byte-identical across all three verbs.
 *
 * Idempotent: yes (sequential retry — re-running the same args
 * yields the same item, with the second call hitting the update
 * branch).
 */

import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, MondayCliError, UsageError } from '../../utils/errors.js';
import type { ResolverWarning } from '../../api/columns.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';
import {
  bundleColumnValues,
  selectMutation,
  type SelectedMutation,
  type TranslatedColumnValue,
} from '../../api/column-values.js';
import {
  parseSetRawExpression,
  type ParsedSetRawExpression,
} from '../../api/raw-write.js';
import {
  splitSetExpression,
  type SetExpression,
} from '../../api/set-expression.js';
import { buildResolutionContexts } from '../../api/resolution-context.js';
import {
  SourceAggregator,
  mergeSource,
  mergeCacheAge,
  mergeSourceWithPreflight,
} from '../../api/source-aggregator.js';
import { resolveAndTranslate } from '../../api/resolution-pass.js';
import { foldAndRemap } from '../../api/resolver-error-fold.js';
import { planChanges, planCreate } from '../../api/dry-run.js';
import {
  loadBoardMetadata,
  refreshBoardMetadata,
  type BoardMetadata,
} from '../../api/board-metadata.js';
import { buildQueryParams, type QueryParams } from '../../api/filters.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import {
  ITEM_FIELDS_FRAGMENT,
  resolveMeFactory,
} from '../../api/item-helpers.js';
import { projectMutationItem } from '../../api/item-mutation-result.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import type { Warning } from '../../utils/output/envelope.js';

// ============================================================
// GraphQL — match-by lookup + mutation surface.
// ============================================================

/**
 * Match-by lookup query. Mirrors `item update --where`'s
 * `items_page(query_params: {rules: [{column_id, compare_value,
 * operator}]})` shape so the resolver / cache contract stays the same
 * across the two surfaces. limit=11 short-circuits the
 * 0/1/2+ branch decision in a single round-trip without a full
 * cursor walk: the 11th item exists only when ≥11 candidates match,
 * which already gives `ambiguous_match` plus 10 capped candidates the
 * §6.5 details schema documents.
 */
const UPSERT_LOOKUP_QUERY = `
  query ItemUpsertLookup(
    $boardId: ID!
    $limit: Int!
    $queryParams: ItemsQuery
  ) {
    boards(ids: [$boardId]) {
      items_page(limit: $limit, query_params: $queryParams) {
        cursor
        items {
          id
          name
        }
      }
    }
  }
`;

const CREATE_ITEM_MUTATION = `
  mutation ItemUpsertCreate(
    $boardId: ID!
    $itemName: String!
    $columnValues: JSON
    $createLabelsIfMissing: Boolean
  ) {
    create_item(
      board_id: $boardId
      item_name: $itemName
      column_values: $columnValues
      create_labels_if_missing: $createLabelsIfMissing
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_SIMPLE_COLUMN_VALUE_MUTATION = `
  mutation ItemUpsertSimple(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: String!
    $createLabelsIfMissing: Boolean
  ) {
    change_simple_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
      create_labels_if_missing: $createLabelsIfMissing
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_COLUMN_VALUE_MUTATION = `
  mutation ItemUpsertRich(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: JSON!
    $createLabelsIfMissing: Boolean
  ) {
    change_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
      create_labels_if_missing: $createLabelsIfMissing
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_MULTIPLE_COLUMN_VALUES_MUTATION = `
  mutation ItemUpsertMulti(
    $itemId: ID!
    $boardId: ID!
    $columnValues: JSON!
    $createLabelsIfMissing: Boolean
  ) {
    change_multiple_column_values(
      item_id: $itemId
      board_id: $boardId
      column_values: $columnValues
      create_labels_if_missing: $createLabelsIfMissing
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

// ============================================================
// Wire response zod schemas (parse-boundary discipline, R18).
// ============================================================

const lookupItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
  })
  .loose();

const lookupResponseSchema = z
  .object({
    boards: z
      .array(
        z
          .object({
            items_page: z.object({
              cursor: z.string().nullable(),
              items: z.array(lookupItemSchema),
            }),
          })
          .loose(),
      )
      .min(1),
  })
  .loose();

interface CreateItemResponse {
  readonly create_item: unknown;
}
interface ChangeSimpleResponse {
  readonly change_simple_column_value: unknown;
}
interface ChangeColumnResponse {
  readonly change_column_value: unknown;
}
interface ChangeMultipleResponse {
  readonly change_multiple_column_values: unknown;
}
// ============================================================
// Output schema — projected item + operation discriminator.
// ============================================================

const operationEnum = z.enum(['create_item', 'update_item']);

export const itemUpsertOutputSchema = projectedItemSchema.extend({
  /**
   * Branch discriminator per cli-design §6.4 + v0.2-plan §3 M12.
   * `"create_item"` when the lookup found 0 matches; `"update_item"`
   * when it found exactly 1. The slot lives on `data` (rather than
   * `meta`) because v0.1's mutation envelope already keeps
   * operation-shape signals in `data` — `meta` is reserved for
   * cross-verb cache / source / pagination state. Codex round-2 P2.
   */
  operation: operationEnum,
});

export type ItemUpsertOutput = z.infer<typeof itemUpsertOutputSchema>;

// ============================================================
// Input schema + dispatch.
// ============================================================

/**
 * The literal pseudo-token `--match-by` accepts to match against the
 * item's `name` field. Case-sensitive — agents need a deterministic
 * token; lowercase `name` is the convention `cli-design.md` §5.8
 * pins. Column tokens that happen to be titled `Name` (capitalised)
 * still resolve through the column resolver per the normal title-
 * resolution rules; this constant is the *pseudo*-column escape.
 */
const NAME_PSEUDO_TOKEN = 'name';

const inputSchema = z
  .object({
    board: BoardIdSchema,
    name: z.string().refine((s) => s.trim().length > 0, {
      message: '--name must be non-empty (whitespace-only is rejected)',
    }),
    matchBy: z
      .array(z.string())
      .min(1, '--match-by requires at least one token'),
    set: z.array(z.string()).default([]),
    setRaw: z.array(z.string()).default([]),
    createLabelsIfMissing: z.boolean().optional(),
  })
  .strict();

type ParsedInput = z.infer<typeof inputSchema>;

/**
 * One parsed match-by token + its match value. `kind: 'name'` for the
 * literal pseudo-token (value comes from `--name`); `kind: 'column'`
 * for everything else (value comes from the corresponding
 * `--set <token>=<value>`).
 */
type MatchByEntry =
  | { readonly kind: 'name'; readonly token: 'name'; readonly value: string }
  | { readonly kind: 'column'; readonly token: string; readonly value: string };

/**
 * Splits the comma-separated `--match-by` argv into individual tokens
 * + de-duplicates. Trims whitespace; rejects empty tokens
 * (`--match-by status,,owner` is a usage error, not a silent drop).
 */
const parseMatchByTokens = (raw: readonly string[]): readonly string[] => {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    for (const piece of r.split(',')) {
      const trimmed = piece.trim();
      if (trimmed.length === 0) {
        throw new UsageError(
          '--match-by entries must not be empty (an empty segment between ' +
            'commas, or a whitespace-only token, was rejected).',
          { details: { raw } },
        );
      }
      if (seen.has(trimmed)) {
        throw new UsageError(
          `--match-by tokens must be unique; ${JSON.stringify(trimmed)} ` +
            `appeared more than once.`,
          { details: { token: trimmed } },
        );
      }
      seen.add(trimmed);
      tokens.push(trimmed);
    }
  }
  return tokens;
};

/**
 * Pairs each match-by token with its match value. For the `name`
 * pseudo-token the value is `--name <n>`; for every column token,
 * the value is the corresponding `--set <token>=<value>`. Throws
 * `usage_error` with token-specific guidance when the pairing fails.
 *
 * `--set-raw` entries cannot supply match values — the JSON wire
 * shape isn't a filter-comparable scalar. The check is at parse-
 * boundary (resolution-free), so a malformed match-by pairing fails
 * before any network call.
 */
const buildMatchByEntries = (inputs: {
  readonly tokens: readonly string[];
  readonly setEntries: readonly SetExpression[];
  readonly rawTokens: ReadonlySet<string>;
  readonly name: string;
}): readonly MatchByEntry[] => {
  const entries: MatchByEntry[] = [];
  // Index --set entries by token for O(1) lookup. `splitSetExpression`
  // preserves the agent's verbatim token (no normalisation), so the
  // match-by token must be character-equal to the --set token.
  const setByToken = new Map<string, SetExpression>();
  for (const e of inputs.setEntries) {
    setByToken.set(e.token, e);
  }
  for (const token of inputs.tokens) {
    if (token === NAME_PSEUDO_TOKEN) {
      entries.push({ kind: 'name', token: 'name', value: inputs.name });
      continue;
    }
    if (inputs.rawTokens.has(token)) {
      throw new UsageError(
        `--match-by ${JSON.stringify(token)} cannot be paired with a ` +
          `--set-raw entry; the JSON wire shape isn't a filter-comparable ` +
          `scalar. Pass the same column via --set <token>=<scalar> for ` +
          `match-by, or drop ${JSON.stringify(token)} from --match-by.`,
        { details: { token } },
      );
    }
    const setEntry = setByToken.get(token);
    if (setEntry === undefined) {
      throw new UsageError(
        `--match-by ${JSON.stringify(token)} requires a corresponding ` +
          `--set ${token}=<value> (the upsert pulls the match value from ` +
          `--set so the create branch and the lookup share one source of ` +
          `truth). Add --set ${token}=<value>, or drop ` +
          `${JSON.stringify(token)} from --match-by.`,
        { details: { token } },
      );
    }
    entries.push({ kind: 'column', token, value: setEntry.value });
  }
  return entries;
};

// ============================================================
// Lookup — resolves match-by to query rules + walks one page.
// ============================================================

interface LookupResult {
  readonly items: readonly { readonly id: string; readonly name: string }[];
  readonly hasMore: boolean;
  /** Resolver warnings emitted during column-token resolution. */
  readonly warnings: readonly ResolverWarning[];
  /**
   * Whether the column-token resolver fired the `onColumnNotFound`
   * refresh path. Used to fold the source aggregate towards `mixed`
   * when metadata was cache-served.
   */
  readonly refreshed: boolean;
  /**
   * Possibly refreshed metadata — identity-equal to inputs.metadata
   * when no refresh fired.
   */
  readonly metadata: BoardMetadata;
}

interface LookupInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly metadata: BoardMetadata;
  readonly matchBy: readonly MatchByEntry[];
  /**
   * Cache-miss-refresh callback. Provided when metadata came from
   * cache; the column resolver fires this once on the first
   * `column_not_found` to retry against fresh metadata (cli-design
   * §5.3 step 5). `undefined` when metadata was already live.
   */
  readonly onColumnNotFound: (() => Promise<BoardMetadata>) | undefined;
}

/**
 * Resolves the column-token half of `--match-by` against the board's
 * metadata, builds the `query_params.rules` payload, and queries
 * `items_page` once with `limit: 11` so the 0 / 1 / 2+ branch
 * decision needs no second round-trip.
 *
 * Column-token rules go through `buildQueryParams` — the same path
 * `item search` / `item update --where` use — so per-column-type
 * value resolution (the `me` token for people columns, the same
 * cache-miss-refresh + collision-warning collection) inherits
 * automatically. `name` pseudo-tokens skip the column resolver
 * entirely (Monday accepts `column_id: "name"` in `query_params.rules`
 * as a built-in filter against the item's `name` field, no metadata
 * lookup needed) and are prepended to the rules array post-build.
 *
 * **Known v0.2 round-trip limits (cli-design §5.8 caveat).** The
 * lookup leg and the `--set` translator have asymmetric grammars,
 * so only a subset of column kinds round-trip cleanly when the same
 * column appears in both `--match-by` and `--set`:
 *
 *   - **People:** only `me` (resolved on both legs). Emails resolve
 *     in `--set` but pass verbatim in lookup; raw numeric user IDs
 *     are rejected by the people `--set` grammar (cli-design §5.3
 *     step 3, M5b deferral).
 *   - **Date:** NOT v0.2-safe — Monday's items_page filter requires
 *     `compare_value: ["EXACT", "YYYY-MM-DD"]` for date-equals,
 *     but `buildQueryParams` emits a bare-ISO `["YYYY-MM-DD"]` (the
 *     same shape `item search` / `item update --where` ship). The
 *     EXACT-marker lift is a cross-surface v0.3 candidate.
 *   - **Status / dropdown:** label text (e.g. `Backlog`) round-trips
 *     because Monday's filter compares against the stored label.
 *   - **Text / long_text / numbers / item name / external_id-shaped
 *     hidden text:** verbatim pass-through on both legs.
 *   - **Link / email / phone (rich pipe grammar):** the friendly
 *     `<scalar>|<text>` write parses to `{url, text}` / `{email,
 *     text}` / `{phone, country}` but the lookup leg sends the
 *     literal pipe string — best-effort only.
 *
 * The recommended canonical pattern is a stable hidden text /
 * external_id column as the synthetic key. Email→ID, numeric-user-
 * ID acceptance, relative-date resolution, and the date EXACT-
 * marker lift are v0.3 cross-surface follow-ups (would lift `item
 * search` and `item update --where` simultaneously).
 */
const lookupMatches = async (inputs: LookupInputs): Promise<LookupResult> => {
  // Split into name + column tokens. Column tokens go through the
  // shared filter pipeline; name tokens contribute a literal
  // `column_id: "name"` rule prepended to the resulting rules array.
  const columnEntries = inputs.matchBy.filter(
    (e): e is Extract<MatchByEntry, { kind: 'column' }> => e.kind === 'column',
  );
  const nameEntries = inputs.matchBy.filter(
    (e): e is Extract<MatchByEntry, { kind: 'name' }> => e.kind === 'name',
  );

  // Convert column match-by entries to `--where`-shaped strings and
  // hand to the shared filter pipeline. `splitSetExpression` and
  // `parseWhereSyntax` both split on first `=`, so a value containing
  // `=` round-trips correctly.
  const whereClauses = columnEntries.map((e) => `${e.token}=${e.value}`);
  const filterResult = await buildQueryParams({
    metadata: inputs.metadata,
    resolveMe: resolveMeFactory(inputs.client),
    whereClauses,
    filterJson: undefined,
    ...(inputs.onColumnNotFound === undefined
      ? {}
      : { onColumnNotFound: inputs.onColumnNotFound }),
  });

  // Prepend the `name` pseudo-token rules. Monday accepts
  // `column_id: "name"` in `query_params.rules` as a built-in filter
  // against the item's `name` field — no column resolution needed.
  const nameRules: readonly {
    readonly column_id: string;
    readonly operator: string;
    readonly compare_value: readonly string[];
  }[] = nameEntries.map((e) => ({
    column_id: 'name',
    operator: 'any_of',
    compare_value: [e.value],
  }));
  const columnRules =
    (filterResult.queryParams as QueryParams | undefined)?.rules ?? [];
  const rules = [...nameRules, ...columnRules];

  const response = await inputs.client.raw<unknown>(
    UPSERT_LOOKUP_QUERY,
    {
      boardId: inputs.boardId,
      limit: 11,
      queryParams: { rules },
    },
    { operationName: 'ItemUpsertLookup' },
  );
  const data = unwrapOrThrow(
    lookupResponseSchema.safeParse(response.data),
    {
      context: `Monday returned a malformed ItemUpsertLookup response for board ${inputs.boardId}`,
      details: { board_id: inputs.boardId },
    },
  );
  /* c8 ignore next 4 — defensive: schema's `.min(1)` rejects empty
     arrays. */
  const board = data.boards[0];
  if (board === undefined) {
    throw new ApiError('internal_error', 'upsert lookup: empty boards array');
  }
  return {
    items: board.items_page.items,
    hasMore: board.items_page.cursor !== null,
    // Filter pipeline returns `Warning` shape; resolver-warning
    // codes (`column_token_collision`, `stale_cache_refreshed`)
    // structurally widen to ResolverWarning cleanly.
    warnings: filterResult.warnings as readonly ResolverWarning[],
    refreshed: filterResult.refreshed,
    metadata: inputs.metadata,
  };
};

// ============================================================
// Branch decision — 0 / 1 / 2+ matches → create / update / ambiguous.
// ============================================================

type BranchDecision =
  | { readonly kind: 'create' }
  | { readonly kind: 'update'; readonly itemId: string }
  | { readonly kind: 'ambiguous'; readonly error: ApiError };

const decideBranch = (inputs: {
  readonly lookup: LookupResult;
  readonly boardId: string;
  readonly matchBy: readonly MatchByEntry[];
}): BranchDecision => {
  const items = inputs.lookup.items;
  // 0 matches → create branch only when the page is definitively
  // empty (cursor null). An empty page with a non-null cursor is a
  // Monday API anomaly (the items_page contract returns `cursor:
  // null` when no more pages exist) — we can't prove there are zero
  // matches, so fail-closed with internal_error rather than create
  // a duplicate. Codex round-1 F3.
  if (items.length === 0) {
    if (inputs.lookup.hasMore) {
      throw new ApiError(
        'internal_error',
        `item upsert lookup returned an empty page with a non-null cursor on board ${inputs.boardId}; ` +
          `Monday's items_page contract returns cursor: null when no more matches exist. ` +
          `Refusing to create-or-update without a definitive 0/1/2+ count. ` +
          `Re-run; if the issue persists, file a bug.`,
        {
          details: {
            board_id: inputs.boardId,
            match_by: inputs.matchBy.map((e) => e.token),
          },
        },
      );
    }
    return { kind: 'create' };
  }
  if (items.length === 1 && !inputs.lookup.hasMore) {
    /* c8 ignore next 4 — defensive: items.length === 1 narrowing
       guarantees items[0] is non-undefined. */
    const only = items[0];
    if (only === undefined) {
      throw new ApiError('internal_error', 'decideBranch: empty single match');
    }
    return { kind: 'update', itemId: only.id };
  }
  // 2+ matches OR (1 match AND `cursor !== null` → at least 2 across
  // pages). cli-design §6.5 caps the candidates display at 10.
  const candidates = items
    .slice(0, 10)
    .map((i) => ({ id: i.id, name: i.name }));
  const matchValues: Record<string, string> = {};
  for (const e of inputs.matchBy) {
    matchValues[e.token] = e.value;
  }
  const error = new ApiError(
    'ambiguous_match',
    `item upsert matched ${String(items.length)} item(s) on board ${inputs.boardId} ` +
      `with the supplied --match-by; pick a tighter predicate (add another ` +
      `--match-by column, or use a stable hidden-key column) so the next ` +
      `call resolves to a single item.`,
    {
      details: {
        board_id: inputs.boardId,
        match_by: inputs.matchBy.map((e) => e.token),
        match_values: matchValues,
        matched_count: items.length,
        candidates,
      },
    },
  );
  return { kind: 'ambiguous', error };
};

// ============================================================
// Live-mutation execution helpers.
// ============================================================

interface MutationExecResult {
  readonly projected: ProjectedItem;
  readonly response: MondayResponse<unknown>;
}

const executeCreate = async (inputs: {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly itemName: string;
  readonly columnValues: Readonly<Record<string, unknown>> | null;
  readonly createLabelsIfMissing: boolean | undefined;
}): Promise<MutationExecResult> => {
  const response = await inputs.client.raw<CreateItemResponse>(
    CREATE_ITEM_MUTATION,
    {
      boardId: inputs.boardId,
      itemName: inputs.itemName,
      columnValues: inputs.columnValues,
      createLabelsIfMissing: inputs.createLabelsIfMissing ?? false,
    },
    { operationName: 'ItemUpsertCreate' },
  );
  return {
    projected: projectMutationItem({
      raw: response.data.create_item,
      // create_item returns a fresh ID; we don't have one to project
      // against, so the helper falls back to its own check. Pass empty
      // string to indicate "no expected ID" — projectMutationItem
      // surfaces internal_error if Monday returned a null payload.
      itemId: '',
      errorCode: 'internal_error',
      errorMessage:
        'Monday returned no item payload from create_item during upsert.',
    }),
    response,
  };
};

const executeUpdate = async (inputs: {
  readonly client: MondayClient;
  readonly mutation: SelectedMutation;
  readonly itemId: string;
  readonly boardId: string;
  readonly createLabelsIfMissing: boolean | undefined;
}): Promise<MutationExecResult> => {
  const labelsFlag = inputs.createLabelsIfMissing ?? false;
  if (inputs.mutation.kind === 'change_simple_column_value') {
    const response = await inputs.client.raw<ChangeSimpleResponse>(
      CHANGE_SIMPLE_COLUMN_VALUE_MUTATION,
      {
        itemId: inputs.itemId,
        boardId: inputs.boardId,
        columnId: inputs.mutation.columnId,
        value: inputs.mutation.value,
        createLabelsIfMissing: labelsFlag,
      },
      { operationName: 'ItemUpsertSimple' },
    );
    return {
      projected: projectMutationItem({
        raw: response.data.change_simple_column_value,
        itemId: inputs.itemId,
        errorCode: 'internal_error',
        errorMessage: `Monday returned no item payload from the mutation for id ${inputs.itemId}.`,
      }),
      response,
    };
  }
  /* c8 ignore start — defensive: in upsert's update branch the
     synthetic `name` translated value always joins the array, so the
     one-rich-only (single-entry rich) shape that selectMutation maps
     to `change_column_value` is unreachable: 0 user --set entries +
     name = 1 simple entry → `change_simple_column_value`; 1+ user
     --set entries + name = 2+ entries → `change_multiple_column_
     values`. The branch is kept exhaustive so a future shape change
     (e.g. dropping the synthetic name on a no-rename code path) can
     opt back in without re-deriving the mutation dispatch. */
  if (inputs.mutation.kind === 'change_column_value') {
    const response = await inputs.client.raw<ChangeColumnResponse>(
      CHANGE_COLUMN_VALUE_MUTATION,
      {
        itemId: inputs.itemId,
        boardId: inputs.boardId,
        columnId: inputs.mutation.columnId,
        value: inputs.mutation.value,
        createLabelsIfMissing: labelsFlag,
      },
      { operationName: 'ItemUpsertRich' },
    );
    return {
      projected: projectMutationItem({
        raw: response.data.change_column_value,
        itemId: inputs.itemId,
        errorCode: 'internal_error',
        errorMessage: `Monday returned no item payload from the mutation for id ${inputs.itemId}.`,
      }),
      response,
    };
  }
  /* c8 ignore stop */
  // change_multiple_column_values — multi-`--set` or `--set + --name`.
  const response = await inputs.client.raw<ChangeMultipleResponse>(
    CHANGE_MULTIPLE_COLUMN_VALUES_MUTATION,
    {
      itemId: inputs.itemId,
      boardId: inputs.boardId,
      columnValues: inputs.mutation.columnValues,
      createLabelsIfMissing: labelsFlag,
    },
    { operationName: 'ItemUpsertMulti' },
  );
  return {
    projected: projectMutationItem({
      raw: response.data.change_multiple_column_values,
      itemId: inputs.itemId,
      errorCode: 'internal_error',
      errorMessage: `Monday returned no item payload from the mutation for id ${inputs.itemId}.`,
    }),
    response,
  };
};

// ============================================================
// Main command export.
// ============================================================

export const itemUpsertCommand: CommandModule<ParsedInput, ItemUpsertOutput> = {
  name: 'item.upsert',
  summary: 'Create-or-update an item by --match-by predicate (idempotent)',
  examples: [
    'monday item upsert --board 67890 --name "Refactor login" --match-by name --set status=Backlog',
    'monday item upsert --board 67890 --name "Refactor login" --match-by external_id --set external_id=ABC-123 --set status=Backlog',
    'monday item upsert --board 67890 --name "Refactor login" --match-by name,owner --set owner=me --set status=Backlog',
    'monday item upsert --board 67890 --name "Refactor login" --match-by name,priority --set priority=High --set status=Backlog',
    'monday item upsert --board 67890 --name "Refactor login" --match-by name --set status=Backlog --dry-run --json',
  ],
  // Sequential-retry idempotent — see file header + cli-design §5.8.
  // The CommandModule flag is a coarse boolean; the nuanced contract
  // lives in --help / docs / §9.1.
  idempotent: true,
  inputSchema,
  outputSchema: itemUpsertOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('upsert')
      .description(itemUpsertCommand.summary)
      .requiredOption('--board <bid>', 'board ID (required)')
      .requiredOption('--name <n>', 'item name (required, non-empty)')
      .requiredOption(
        '--match-by <list>',
        'comma-separated match tokens (column tokens + literal `name`)',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option(
        '--set <expr>',
        'repeatable <col>=<val>. Required for every non-`name` --match-by token.',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option(
        '--set-raw <expr>',
        'repeatable <col>=<json> raw write (column updates only — cannot appear in --match-by)',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option(
        '--create-labels-if-missing',
        'auto-create unknown status / dropdown labels (Monday flag)',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...itemUpsertCommand.examples.map((e) => `  ${e}`),
          '',
          'Race-mitigation note: upsert is sequential-retry idempotent only.',
          'Two concurrent agents observing zero matches both branch to',
          'create_item; the next call surfaces the duplicate as',
          'ambiguous_match. Pick a stable hidden-key column for --match-by',
          'so race-induced duplicates are recoverable.',
          '',
          'Match-value caveats (per column kind). The lookup leg and the',
          '--set translator have asymmetric grammars in v0.2, so only a',
          'subset of column kinds round-trip cleanly when used in both',
          '--match-by and --set:',
          '',
          '  Always safe (verbatim pass-through on both legs):',
          '    - name (the item-name pseudo-token)',
          '    - text / long_text',
          '    - numbers',
          '    - external_id-shaped hidden text',
          '  Safe via label-text:',
          '    - status / dropdown (pass the label name, not the index)',
          '  Restricted to one value:',
          '    - people: only `me` round-trips. Emails work in --set but',
          '      pass verbatim in lookup (duplicate); raw numeric user',
          '      IDs are rejected by the --set grammar (cli-design §5.3).',
          '  Not v0.2-safe:',
          '    - date: Monday items_page requires `["EXACT", "YYYY-MM-',
          '      DD"]` for date-equals; the lookup leg sends bare ISO,',
          '      so an upsert against a date column duplicates on rerun.',
          '    - link / email / phone: the rich `scalar|text` write',
          '      grammar produces a `{url,text}` / `{email,text}` /',
          '      `{phone,country}` payload that the bare-string filter',
          '      compare cannot match against.',
          '',
          'Recommended canonical pattern: stable hidden text /',
          'external_id column as the synthetic key. Email->ID,',
          'numeric-user-ID acceptance, relative-date resolution, and',
          'the date EXACT-marker lift are v0.3 cross-surface follow-ups',
          '(would also lift `item search` and `item update --where`).',
          '',
        ].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(itemUpsertCommand.inputSchema, opts);
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        // Argv-parse-time failures fire BEFORE any network call.
        // Splits + JSON parse run on pure strings; surfacing here
        // means a malformed --set / --set-raw / --match-by fails fast
        // without burning a board-metadata fetch + lookup round-trip.
        // Same fail-fast invariant as item update / item create.
        const setEntries: readonly SetExpression[] =
          parsed.set.map(splitSetExpression);
        const rawEntries: readonly ParsedSetRawExpression[] =
          parsed.setRaw.map(parseSetRawExpression);
        const matchByTokens = parseMatchByTokens(parsed.matchBy);
        const rawTokens = new Set(rawEntries.map((r) => r.token));
        const matchByEntries = buildMatchByEntries({
          tokens: matchByTokens,
          setEntries,
          rawTokens,
          name: parsed.name,
        });

        // Load board metadata once — every leg (lookup, dry-run /
        // live mutation, column resolver) consumes the same view.
        const meta = await loadBoardMetadata({
          client,
          boardId: parsed.board,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });
        const onColumnNotFound =
          meta.source === 'cache'
            ? async (): Promise<BoardMetadata> => {
                const refreshed = await refreshBoardMetadata({
                  client,
                  boardId: parsed.board,
                  env: ctx.env,
                });
                return refreshed.metadata;
              }
            : undefined;

        // Lookup leg — match-by → items_page rules → 0/1/2+ branch.
        const lookup = await lookupMatches({
          client,
          boardId: parsed.board,
          metadata: meta.metadata,
          matchBy: matchByEntries,
          onColumnNotFound,
        });
        const decision = decideBranch({
          lookup,
          boardId: parsed.board,
          matchBy: matchByEntries,
        });
        if (decision.kind === 'ambiguous') {
          throw decision.error;
        }

        const sourceAgg = new SourceAggregator({
          source: meta.source,
          cacheAgeSeconds: meta.cacheAgeSeconds,
        });
        // Lookup is always live (items_page never caches); the
        // metadata leg may have been cache-served. The resolver may
        // have refreshed; that's already folded into meta via
        // `mergeSource`-style logic below.
        sourceAgg.record('live', null);

        // Filter-warnings → envelope warnings. The resolver fires
        // collision + stale_cache_refreshed; both surface on the
        // success envelope.
        const lookupWarnings: readonly Warning[] = lookup.warnings;

        const { dateResolution, peopleResolution } = buildResolutionContexts(
          { client, ctx, globalFlags },
        );

        if (decision.kind === 'create') {
          await runCreateBranch({
            client,
            boardId: parsed.board,
            name: parsed.name,
            setEntries,
            rawEntries,
            createLabelsIfMissing: parsed.createLabelsIfMissing,
            dateResolution,
            peopleResolution,
            env: ctx.env,
            noCache: globalFlags.noCache,
            dryRun: globalFlags.dryRun,
            ctx,
            programOpts: program.opts(),
            apiVersion,
            toEmit,
            sourceAgg,
            lookupWarnings,
            matchBy: matchByEntries,
          });
          return;
        }

        await runUpdateBranch({
          client,
          boardId: parsed.board,
          itemId: decision.itemId,
          name: parsed.name,
          setEntries,
          rawEntries,
          createLabelsIfMissing: parsed.createLabelsIfMissing,
          dateResolution,
          peopleResolution,
          env: ctx.env,
          noCache: globalFlags.noCache,
          dryRun: globalFlags.dryRun,
          ctx,
          programOpts: program.opts(),
          apiVersion,
          toEmit,
          sourceAgg,
          lookupWarnings,
          matchBy: matchByEntries,
        });
      });
  },
};

// ============================================================
// Branch runners — one per operation arm.
// ============================================================

interface BranchRunInputsBase {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly name: string;
  readonly setEntries: readonly SetExpression[];
  readonly rawEntries: readonly ParsedSetRawExpression[];
  readonly createLabelsIfMissing: boolean | undefined;
  readonly dateResolution: ReturnType<
    typeof buildResolutionContexts
  >['dateResolution'];
  readonly peopleResolution: ReturnType<
    typeof buildResolutionContexts
  >['peopleResolution'];
  readonly env: NodeJS.ProcessEnv;
  readonly noCache: boolean;
  readonly dryRun: boolean;
  readonly ctx: Parameters<typeof emitMutation>[0]['ctx'];
  readonly programOpts: unknown;
  readonly apiVersion: string;
  readonly toEmit: ReturnType<typeof resolveClient>['toEmit'];
  readonly sourceAgg: SourceAggregator;
  readonly lookupWarnings: readonly Warning[];
  readonly matchBy: readonly MatchByEntry[];
}

type CreateBranchInputs = BranchRunInputsBase;
interface UpdateBranchInputs extends BranchRunInputsBase {
  readonly itemId: string;
}

const matchByTokenList = (
  matchBy: readonly MatchByEntry[],
): readonly string[] => matchBy.map((e) => e.token);

const runCreateBranch = async (inputs: CreateBranchInputs): Promise<void> => {
  if (inputs.dryRun) {
    // Reuse the M9 dry-run engine so the diff cells match `item
    // create` byte-for-byte; then post-process the planned change to
    // hoist `name` + add the upsert-specific match_by / matched_count
    // echoes per cli-design §6.4 upsert shape.
    const result = await planCreate({
      client: inputs.client,
      mode: { kind: 'item', boardId: inputs.boardId },
      name: inputs.name,
      setEntries: inputs.setEntries,
      ...(inputs.rawEntries.length === 0
        ? {}
        : { rawEntries: inputs.rawEntries }),
      dateResolution: inputs.dateResolution,
      peopleResolution: inputs.peopleResolution,
      env: inputs.env,
      noCache: inputs.noCache,
    });
    const plan = result.plannedChanges[0];
    /* c8 ignore next 6 — defensive: planCreate returns exactly one
       PlannedChange for an item create; the index guard exists for
       narrowing only. */
    if (plan === undefined) {
      throw new ApiError(
        'internal_error',
        'upsert create-branch dry-run: planCreate returned zero plannedChanges',
      );
    }
    const planned: Readonly<Record<string, unknown>> = {
      operation: 'create_item',
      board_id: plan.board_id,
      name: plan.name,
      resolved_ids: plan.resolved_ids,
      diff: plan.diff,
      match_by: matchByTokenList(inputs.matchBy),
      matched_count: 0,
    };
    // Fold the upsert preflight legs (metadata + lookup) into the
    // dry-run source — `meta.source` must reflect EVERY wire leg that
    // fired, not just planCreate's. The metadata leg may be cache or
    // live; the lookup is always live (items_page never caches), so
    // the aggregate is at minimum 'live' (or 'mixed' if metadata
    // hit cache). Codex round-1 F2.
    const preflight = inputs.sourceAgg.result();
    const dryRunSource = mergeSourceWithPreflight(
      result.source,
      preflight.source,
    );
    const dryRunCacheAge = mergeCacheAge(
      result.cacheAgeSeconds,
      preflight.cacheAgeSeconds,
    );
    emitDryRun({
      ctx: inputs.ctx,
      programOpts: inputs.programOpts,
      plannedChanges: [planned],
      source: dryRunSource,
      cacheAgeSeconds: dryRunCacheAge,
      warnings: [...inputs.lookupWarnings, ...result.warnings],
      apiVersion: inputs.apiVersion,
    });
    return;
  }

  // Live create branch — three-pass resolution, bundle into
  // column_values, single round-trip create_item.
  const resolutionResult = await resolveAndTranslate({
    client: inputs.client,
    boardId: inputs.boardId,
    setEntries: inputs.setEntries,
    rawEntries: inputs.rawEntries,
    dateResolution: inputs.dateResolution,
    peopleResolution: inputs.peopleResolution,
    env: inputs.env,
    noCache: inputs.noCache,
  });
  const collectedWarnings: ResolverWarning[] = [
    ...resolutionResult.warnings,
  ];
  const resolvedIds = resolutionResult.resolvedIds;
  if (resolutionResult.source !== undefined) {
    inputs.sourceAgg.record(
      resolutionResult.source,
      resolutionResult.cacheAgeSeconds,
    );
  }
  const translated: readonly TranslatedColumnValue[] =
    resolutionResult.translated;
  const columnValues =
    translated.length === 0 ? null : bundleColumnValues(translated);

  let mutationResult: MutationExecResult;
  try {
    mutationResult = await executeCreate({
      client: inputs.client,
      boardId: inputs.boardId,
      itemName: inputs.name,
      columnValues,
      createLabelsIfMissing: inputs.createLabelsIfMissing,
    });
  } catch (err) {
    if (err instanceof MondayCliError) {
      // Same column-archived remap shape `item create` uses (M9 P1).
      // Cache-sourced resolution + Monday rejecting as
      // validation_failed → check live archived state. Pass every
      // translated column id (M5b finding #3) so multi-`--set` cases
      // where a later target is archived still remap.
      throw await foldAndRemap({
        err,
        warnings: [
          ...inputs.lookupWarnings.flatMap((w): readonly ResolverWarning[] =>
            w.code === 'column_token_collision' ||
            w.code === 'stale_cache_refreshed'
              ? [w as unknown as ResolverWarning]
              : [],
          ),
          ...collectedWarnings,
        ],
        client: inputs.client,
        boardId: inputs.boardId,
        columnIds: translated.map((t) => t.columnId),
        env: inputs.env,
        noCache: inputs.noCache,
        /* c8 ignore next 2 — defensive: resolveAndTranslate returns
           a defined source whenever any --set / --set-raw leg fires.
           The fallback covers the contrived empty-resolution case. */
        resolutionSource: resolutionResult.source ?? 'live',
      });
    }
    throw err;
  }

  // Mutation leg fires live; record so cache-served metadata + live
  // wire calls collapses to `mixed`. Mirrors `item create`'s tail
  // record pattern.
  inputs.sourceAgg.record('live', null);

  const data: ItemUpsertOutput = {
    ...mutationResult.projected,
    operation: 'create_item',
  };
  emitMutation({
    ctx: inputs.ctx,
    data,
    schema: itemUpsertCommand.outputSchema,
    programOpts: inputs.programOpts,
    warnings: [...inputs.lookupWarnings, ...collectedWarnings],
    ...inputs.toEmit(mutationResult.response),
    ...inputs.sourceAgg.result(),
    resolvedIds,
  });
};

const runUpdateBranch = async (inputs: UpdateBranchInputs): Promise<void> => {
  if (inputs.dryRun) {
    // Reuse the M5b dry-run engine. planChanges produces the
    // `change_*` wire-name on the resulting plannedChange; we
    // override to the verb-level `update_item` per cli-design §6.4
    // upsert shape and add the M12 echoes.
    const result = await planChanges({
      client: inputs.client,
      boardId: inputs.boardId,
      itemId: inputs.itemId,
      setEntries: inputs.setEntries,
      ...(inputs.rawEntries.length === 0
        ? {}
        : { rawEntries: inputs.rawEntries }),
      nameChange: inputs.name,
      dateResolution: inputs.dateResolution,
      peopleResolution: inputs.peopleResolution,
      env: inputs.env,
      noCache: inputs.noCache,
    });
    const plan = result.plannedChanges[0];
    /* c8 ignore next 6 — defensive: planChanges returns exactly one
       PlannedChange for a single-item plan; the guard exists for
       narrowing only. */
    if (plan === undefined) {
      throw new ApiError(
        'internal_error',
        'upsert update-branch dry-run: planChanges returned zero plannedChanges',
      );
    }
    const planned: Readonly<Record<string, unknown>> = {
      operation: 'update_item',
      board_id: plan.board_id,
      item_id: plan.item_id,
      name: inputs.name,
      resolved_ids: plan.resolved_ids,
      diff: plan.diff,
      match_by: matchByTokenList(inputs.matchBy),
      matched_count: 1,
    };
    // Fold the upsert preflight legs (metadata + lookup) into the
    // dry-run source. planChanges' source is always `'live' |
    // 'cache' | 'mixed'` (no `'none'` arm — it always reads the
    // item state); use mergeSource directly. Codex round-1 F2.
    const preflight = inputs.sourceAgg.result();
    const dryRunSource = mergeSource(preflight.source, result.source);
    const dryRunCacheAge = mergeCacheAge(
      result.cacheAgeSeconds,
      preflight.cacheAgeSeconds,
    );
    emitDryRun({
      ctx: inputs.ctx,
      programOpts: inputs.programOpts,
      plannedChanges: [planned],
      source: dryRunSource,
      cacheAgeSeconds: dryRunCacheAge,
      warnings: [...inputs.lookupWarnings, ...result.warnings],
      apiVersion: inputs.apiVersion,
    });
    return;
  }

  // Live update branch — three-pass resolution, then
  // selectMutation + execute. Mirrors item update's single-item path
  // verbatim (Codex round-4 P2: same wire shape, same atomicity).
  const resolutionResult = await resolveAndTranslate({
    client: inputs.client,
    boardId: inputs.boardId,
    setEntries: inputs.setEntries,
    rawEntries: inputs.rawEntries,
    dateResolution: inputs.dateResolution,
    peopleResolution: inputs.peopleResolution,
    env: inputs.env,
    noCache: inputs.noCache,
  });
  const collectedWarnings: ResolverWarning[] = [
    ...resolutionResult.warnings,
  ];
  const resolvedIds = resolutionResult.resolvedIds;
  if (resolutionResult.source !== undefined) {
    inputs.sourceAgg.record(
      resolutionResult.source,
      resolutionResult.cacheAgeSeconds,
    );
  }
  const translated: readonly TranslatedColumnValue[] =
    resolutionResult.translated;

  // Synthetic name key — same shape item update's single path uses.
  // selectMutation handles bundling: name-only → simple; name + cols
  // (or ≥2 cols) → multi.
  const allTranslated: readonly TranslatedColumnValue[] = [
    {
      columnId: 'name',
      columnType: 'text',
      rawInput: inputs.name,
      payload: { format: 'simple', value: inputs.name },
      resolvedFrom: null,
      peopleResolution: null,
    },
    ...translated,
  ];

  let mutationResult: MutationExecResult;
  try {
    const mutation: SelectedMutation = selectMutation(allTranslated);
    mutationResult = await executeUpdate({
      client: inputs.client,
      mutation,
      itemId: inputs.itemId,
      boardId: inputs.boardId,
      createLabelsIfMissing: inputs.createLabelsIfMissing,
    });
  } catch (err) {
    if (err instanceof MondayCliError) {
      throw await foldAndRemap({
        err,
        warnings: [
          ...inputs.lookupWarnings.flatMap((w): readonly ResolverWarning[] =>
            w.code === 'column_token_collision' ||
            w.code === 'stale_cache_refreshed'
              ? [w as unknown as ResolverWarning]
              : [],
          ),
          ...collectedWarnings,
        ],
        client: inputs.client,
        boardId: inputs.boardId,
        columnIds: translated.map((t) => t.columnId),
        env: inputs.env,
        noCache: inputs.noCache,
        /* c8 ignore next 3 — defensive: resolveAndTranslate returns
           a defined source whenever any --set / --set-raw leg fires;
           the fallback covers the --name-only update path failing,
           a contrived edge case. */
        resolutionSource: resolutionResult.source ?? 'live',
      });
    }
    throw err;
  }

  inputs.sourceAgg.record('live', null);

  const data: ItemUpsertOutput = {
    ...mutationResult.projected,
    operation: 'update_item',
  };
  emitMutation({
    ctx: inputs.ctx,
    data,
    schema: itemUpsertCommand.outputSchema,
    programOpts: inputs.programOpts,
    warnings: [...inputs.lookupWarnings, ...collectedWarnings],
    ...inputs.toEmit(mutationResult.response),
    ...inputs.sourceAgg.result(),
    resolvedIds,
  });
};
