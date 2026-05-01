/**
 * `monday item update <iid> [--name <n>] [--set <col>=<val>]...` —
 * multi-column atomic update + optional rename.
 * (`cli-design.md` §4.3 line 490, §5.3, `v0.1-plan.md` §3 M5b).
 *
 * Two argv shapes:
 *
 *   1. **Single-item** (this commit): positional `<itemId>` +
 *      repeatable `--set <col>=<val>` + optional `--name <n>`.
 *      Multi-`--set` (≥2) bundles into one
 *      `change_multiple_column_values` mutation (atomic on Monday's
 *      side per §5.3 step 5). `--name` rolls into the same multi
 *      mutation when columns are also present, otherwise fires a
 *      dedicated `change_simple_column_value(column_id: "name", ...)`.
 *
 *   2. **Bulk** (next commit): `--where <expr>` repeatable + no
 *      positional `<itemId>` — applies the same `--set` / `--name`
 *      bundle to every matching item via Monday's `items_page`
 *      walker. `confirmation_required` fires without `--yes` (and
 *      without `--dry-run`) per cli-design §10.2.
 *
 * **`--name` + `--set` atomicity.** Per cli-design §5.3 step 5, the
 * design promises atomicity for multi-column updates. Bundling the
 * name into the multi mutation keeps the same atomicity guarantee
 * for `--name + --set`. Monday's
 * `change_multiple_column_values(column_values: JSON!)` accepts
 * `name` as a special key in the map. The dry-run engine produces
 * a single `PlannedChange` whose `diff` includes both column keys
 * and a `name` key when both are passed.
 *
 * **`--name` only.** Single field → `change_simple_column_value(
 * column_id: "name", value: <n>)`. Atomic by default (single
 * mutation).
 *
 * **`--create-labels-if-missing`** (cli-design §4.3) — passes
 * through to Monday's `change_*_column_value(create_labels_if_missing:
 * true)`. Tells Monday to auto-create unknown status / dropdown
 * labels rather than rejecting with `validation_failed`. Off by
 * default; agents who want labels-on-demand pass the flag
 * explicitly.
 *
 * Idempotent: yes — `change_*` mutations are idempotent. Multi-set
 * is also idempotent (re-running with the same args produces the
 * same item state).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, MondayCliError, UsageError } from '../../utils/errors.js';
import {
  resolveColumnWithRefresh,
  type ResolverWarning,
} from '../../api/columns.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';
import {
  selectMutation,
  translateColumnValueAsync,
  type DateResolutionContext,
  type PeopleResolutionContext,
  type SelectedMutation,
  type TranslatedColumnValue,
} from '../../api/column-values.js';
import { userByEmail } from '../../api/resolvers.js';
import {
  foldResolverWarningsIntoError,
  maybeRemapValidationFailedToArchived,
} from '../../api/resolver-error-fold.js';
import { planChanges } from '../../api/dry-run.js';
import { buildQueryParams } from '../../api/filters.js';
import {
  loadBoardMetadata,
  refreshBoardMetadata,
  type BoardMetadata,
} from '../../api/board-metadata.js';
import {
  paginate,
  DEFAULT_PAGE_SIZE,
  type PaginatedPage,
} from '../../api/pagination.js';
import {
  ConfirmationRequiredError,
} from '../../utils/errors.js';
import type { RunContext } from '../../cli/run.js';
import type { GlobalFlags } from '../../types/global-flags.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import {
  ITEM_FIELDS_FRAGMENT,
  parseRawItem,
  resolveMeFactory,
} from '../../api/item-helpers.js';
import {
  projectItem,
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import type { Warning } from '../../utils/output/envelope.js';

const ITEM_BOARD_LOOKUP_QUERY = `
  query ItemBoardLookup($ids: [ID!]!) {
    items(ids: $ids) {
      id
      board { id }
    }
  }
`;

const CHANGE_SIMPLE_COLUMN_VALUE_MUTATION = `
  mutation ItemUpdateSimple(
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
  mutation ItemUpdateRich(
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
  mutation ItemUpdateMulti(
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

const boardLookupResponseSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: ItemIdSchema,
          board: z.object({ id: BoardIdSchema }).nullable(),
        }),
      )
      .nullable(),
  })
  .loose();

interface ChangeSimpleResponse {
  readonly change_simple_column_value: unknown;
}
interface ChangeColumnResponse {
  readonly change_column_value: unknown;
}
interface ChangeMultipleResponse {
  readonly change_multiple_column_values: unknown;
}

export const itemUpdateOutputSchema = projectedItemSchema;
export type ItemUpdateOutput = ProjectedItem;

/**
 * Input shape — supports both single-item and bulk shapes.
 *
 *   - Single-item: `itemId` positional required; `where` empty.
 *   - Bulk:        `itemId` positional omitted; `where` non-empty
 *                  AND `board` required.
 *
 * The split lives in `validateInputShape` (action body) so the zod
 * schema captures the union without the per-shape conditional logic
 * — the action layer reads the discriminator and dispatches.
 */
const inputSchema = z
  .object({
    itemId: ItemIdSchema.optional(),
    set: z.array(z.string()).default([]),
    name: z.string().min(1).optional(),
    board: BoardIdSchema.optional(),
    where: z.array(z.string()).default([]),
    // Empty `--filter-json ''` would slip through `buildQueryParams`
    // as "no filter" (`hasFilterJson` is gated on `length > 0`) while
    // still tripping `validateInputShape`'s "bulk mode" discriminator
    // (`filterJson !== undefined`) — net effect, a whole-board mutation
    // an agent likely thought was filtered. Reject at the schema
    // boundary so no network call fires. Codex pass-3 of the §10.2
    // backfill PR caught this — see v0.1-plan §3 M5b session 4.
    //
    // `.refine(trim)` rather than `.min(1)` so a whitespace-only
    // `--filter-json '   '` is also caught at the schema boundary;
    // pre-fix it slipped past `.min(1)` and only failed inside
    // `parseFilterJson` AFTER board metadata loaded — same
    // ultimate `usage_error`, but a wasted network call (Codex
    // pass-1 of this fix).
    filterJson: z
      .string()
      .refine(
        (s) => s.trim().length > 0,
        '--filter-json must be a non-empty JSON object',
      )
      .optional(),
    createLabelsIfMissing: z.boolean().optional(),
  })
  .strict()
  // At least one of --set or --name must be provided. An empty
  // call (`monday item update 12345`) is meaningless and would
  // produce a zero-mutation envelope that surprises agents.
  .refine(
    (v) => v.set.length > 0 || v.name !== undefined,
    {
      message: 'item update requires at least one of --set or --name',
      path: ['set'],
    },
  );

type ParsedInput = z.infer<typeof inputSchema>;

/**
 * Discriminates between the single-item and bulk argv shapes per
 * cli-design §10.2. Single-item: positional `<iid>` present, no
 * `--where` / `--filter-json`. Bulk: no positional, `--where` (or
 * `--filter-json`) present, `--board` required. Either side: at
 * least one of `--set` / `--name` (already enforced by the zod
 * refinement above).
 */
type DispatchShape =
  | { readonly kind: 'single'; readonly itemId: string }
  | { readonly kind: 'bulk' };

const validateInputShape = (parsed: ParsedInput): DispatchShape => {
  const hasItemId = parsed.itemId !== undefined;
  const hasFilter = parsed.where.length > 0 || parsed.filterJson !== undefined;
  if (hasItemId && hasFilter) {
    throw new UsageError(
      'item update accepts either a positional <itemId> OR --where / ' +
        '--filter-json (bulk shape), not both. Pick one.',
      { details: { item_id: parsed.itemId, where_count: parsed.where.length } },
    );
  }
  if (!hasItemId && !hasFilter) {
    throw new UsageError(
      'item update requires either a positional <itemId> or --where / ' +
        '--filter-json for the bulk shape.',
      { details: {} },
    );
  }
  if (hasFilter && parsed.board === undefined) {
    throw new UsageError(
      'item update --where / --filter-json requires --board <bid>. The ' +
        'bulk shape walks Monday\'s items_page on the named board.',
      { details: { where_count: parsed.where.length } },
    );
  }
  if (hasItemId) {
    /* c8 ignore next 4 — defensive: hasItemId === true means
       parsed.itemId is non-undefined; the type guard exists for TS. */
    if (parsed.itemId === undefined) {
      throw new UsageError('item update: itemId narrowing failed');
    }
    return { kind: 'single', itemId: parsed.itemId };
  }
  return { kind: 'bulk' };
};

const splitSetExpression = (raw: string): { readonly token: string; readonly value: string } => {
  const idx = raw.indexOf('=');
  if (idx <= 0) {
    throw new UsageError(
      `--set: expected <col>=<val> (got ${JSON.stringify(raw)}); ` +
        `use shell quoting and the id:/title: prefix when the column ` +
        `token contains "="`,
      { details: { input: raw } },
    );
  }
  return {
    token: raw.slice(0, idx),
    value: raw.slice(idx + 1),
  };
};

const resolveBoardId = async (
  client: MondayClient,
  itemId: string,
  explicit: string | undefined,
): Promise<string> => {
  if (explicit !== undefined) return explicit;
  const response = await client.raw<unknown>(
    ITEM_BOARD_LOOKUP_QUERY,
    { ids: [itemId] },
    { operationName: 'ItemBoardLookup' },
  );
  const data = unwrapOrThrow(
    boardLookupResponseSchema.safeParse(response.data),
    {
      context: `Monday returned a malformed ItemBoardLookup response for id ${itemId}`,
      details: { item_id: itemId },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update boardLookupResponseSchema if ' +
        'Monday\'s contract has changed.',
    },
  );
  const first = data.items?.[0];
  if (first === undefined) {
    throw new ApiError(
      'not_found',
      `Item ${itemId} does not exist or the token has no read access.`,
      { details: { item_id: itemId } },
    );
  }
  if (first.board === null) {
    throw new ApiError(
      'not_found',
      `Item ${itemId} has no readable board; the token may not have ` +
        `permission on the item's board, or the item is in a deleted ` +
        `board.`,
      { details: { item_id: itemId } },
    );
  }
  return first.board.id;
};

export const itemUpdateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemUpdateOutput
> = {
  name: 'item.update',
  summary: 'Update one or more columns on an item (atomic)',
  examples: [
    'monday item update 12345 --set status=Done',
    'monday item update 12345 --set status=Done --set owner=alice@example.com',
    'monday item update 12345 --name "New title"',
    'monday item update 12345 --name "New title" --set status=Done',
    'monday item update 12345 --set tags=Backend,Frontend --create-labels-if-missing',
    'monday item update 12345 --set status=Done --dry-run --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemUpdateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('update [itemId]')
      .description(itemUpdateCommand.summary)
      .option(
        '--set <expr>',
        'repeatable <col>=<val> column write',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option('--name <n>', 'rename the item')
      .option('--board <bid>', 'board ID (required for bulk; skip lookup for single-item)')
      .option(
        '--where <expr>',
        'repeatable bulk filter (cli-design §10.2): <col><op><val>',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option('--filter-json <json>', 'literal Monday query_params for bulk')
      // `--yes` is a GLOBAL flag (`src/cli/program.ts`); read it via
      // `globalFlags.yes` rather than redeclaring on this subcommand
      // so the flag stays single-source-of-truth across every M5b /
      // M6 mutation surface (and so commander doesn't dispatch the
      // value to a per-subcommand slot that diverges from the
      // global one).
      .option(
        '--create-labels-if-missing',
        'auto-create unknown status / dropdown labels (Monday flag)',
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemUpdateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, opts: unknown) => {
        const parsed = parseArgv(itemUpdateCommand.inputSchema, {
          ...(itemId === undefined ? {} : { itemId }),
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        const dispatch = validateInputShape(parsed);
        if (dispatch.kind === 'bulk') {
          await runBulk({
            parsed,
            client,
            globalFlags,
            apiVersion,
            ctx,
            programOpts: program.opts(),
          });
          return;
        }

        const boardId = await resolveBoardId(
          client,
          dispatch.itemId,
          parsed.board,
        );

        const setEntries = parsed.set.map(splitSetExpression);

        const dateResolution: DateResolutionContext = {
          now: ctx.clock,
          ...(ctx.env.MONDAY_TIMEZONE === undefined
            ? {}
            : { timezone: ctx.env.MONDAY_TIMEZONE }),
        };
        const peopleResolution: PeopleResolutionContext = {
          resolveMe: resolveMeFactory(client),
          resolveEmail: async (email) => {
            const result = await userByEmail({
              client,
              email,
              env: ctx.env,
              noCache: globalFlags.noCache,
            });
            return result.user.id;
          },
        };

        if (globalFlags.dryRun) {
          const result = await planChanges({
            client,
            boardId,
            itemId: dispatch.itemId,
            setEntries,
            ...(parsed.name === undefined ? {} : { nameChange: parsed.name }),
            dateResolution,
            peopleResolution,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: result.plannedChanges as unknown as readonly Readonly<Record<string, unknown>>[],
            source: result.source,
            cacheAgeSeconds: result.cacheAgeSeconds,
            warnings: result.warnings,
            apiVersion,
          });
          return;
        }

        // Live update path. Resolve every column token in one batch
        // before translating, so the agent sees one cumulative
        // resolution-error envelope rather than partial-progress
        // surprises across the array.
        //
        // Codex pass-1 F2: track the per-leg resolution source so
        // F4's `validation_failed` → `column_archived` remap fires
        // correctly for cache-only legs (without warnings). A plain
        // cache hit produces no warning but the `source` is `cache`
        // — checking `collectedWarnings` for `stale_cache_refreshed`
        // alone misses this branch.
        const collectedWarnings: ResolverWarning[] = [];
        const translated: TranslatedColumnValue[] = [];
        const resolvedIds: Record<string, string> = {};
        let aggregateSource: 'live' | 'cache' | 'mixed' | undefined =
          undefined;
        for (const entry of setEntries) {
          const resolution = await resolveColumnWithRefresh({
            client,
            boardId,
            token: entry.token,
            includeArchived: true,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          collectedWarnings.push(...resolution.warnings);
          aggregateSource = mergeSourceForRemap(aggregateSource, resolution.source);

          if (resolution.match.column.archived === true) {
            throw foldResolverWarningsIntoError(
              new ApiError(
                'column_archived',
                `Column ${JSON.stringify(resolution.match.column.id)} on board ` +
                  `${boardId} is archived. Monday rejects mutations against ` +
                  `archived columns; un-archive the column in Monday or pick ` +
                  `a different target.`,
                {
                  details: {
                    column_id: resolution.match.column.id,
                    column_title: resolution.match.column.title,
                    column_type: resolution.match.column.type,
                    board_id: boardId,
                  },
                },
              ),
              collectedWarnings,
            );
          }

          try {
            const t = await translateColumnValueAsync({
              column: {
                id: resolution.match.column.id,
                type: resolution.match.column.type,
              },
              value: entry.value,
              dateResolution,
              peopleResolution,
            });
            translated.push(t);
            resolvedIds[entry.token] = resolution.match.column.id;
          } catch (err) {
            if (err instanceof MondayCliError) {
              throw foldResolverWarningsIntoError(err, collectedWarnings);
            }
            throw err;
          }
        }

        // Build the final SelectedMutation. When `--name` is set,
        // a synthetic translated value (columnId: "name",
        // columnType: "text") joins the array so `selectMutation`
        // dispatches uniformly: name-only → simple; columns + name
        // (or ≥2 columns) → multi.
        const allTranslated: readonly TranslatedColumnValue[] =
          parsed.name === undefined
            ? translated
            : [
                {
                  columnId: 'name',
                  columnType: 'text',
                  rawInput: parsed.name,
                  payload: { format: 'simple', value: parsed.name },
                  resolvedFrom: null,
                  peopleResolution: null,
                },
                ...translated,
              ];

        let mutationResult;
        try {
          const mutation: SelectedMutation = selectMutation(allTranslated);
          mutationResult = await executeMutation(client, {
            mutation,
            itemId: dispatch.itemId,
            boardId,
            createLabelsIfMissing: parsed.createLabelsIfMissing,
          });
        } catch (err) {
          if (err instanceof MondayCliError) {
            // F4 remap: cache-sourced resolution + Monday rejecting
            // as validation_failed → check live archived state.
            // For multi-column updates we don't know which column
            // triggered the rejection; pick the first translated
            // column as a "best effort" remap target. This is a
            // simplification: a future enhancement might iterate
            // every translated column to find the archived one.
            const first = translated[0];
            const folded = foldResolverWarningsIntoError(err, collectedWarnings);
            if (first === undefined) {
              throw folded;
            }
            // Codex pass-1 F2: pass the actual aggregated resolution
            // source (live / cache / mixed) so plain cache hits
            // without `stale_cache_refreshed` warnings still trigger
            // the remap. Pre-fix this looked at warnings only and
            // would skip the remap for the most common stale-cache
            // case.
            throw await maybeRemapValidationFailedToArchived(folded, {
              client,
              boardId,
              columnId: first.columnId,
              env: ctx.env,
              noCache: globalFlags.noCache,
              resolutionSource: aggregateSource ?? 'live',
            });
          }
          throw err;
        }

        const warnings: readonly Warning[] = collectedWarnings;
        emitMutation({
          ctx,
          data: mutationResult.projected,
          schema: itemUpdateCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(mutationResult.response),
          source: collectedWarnings.length > 0 ? 'mixed' : 'live',
          cacheAgeSeconds: null,
          // resolved_ids — same shape as `item set`. The synthetic
          // `name` field doesn't appear here because the slot only
          // echoes RESOLVED tokens (those that went through the
          // column resolver); `name` skipped that step.
          resolvedIds,
        });
      });
  },
};

interface MutationExecResult {
  readonly projected: ProjectedItem;
  readonly response: MondayResponse<unknown>;
}

const executeMutation = async (
  client: MondayClient,
  inputs: {
    readonly mutation: SelectedMutation;
    readonly itemId: string;
    readonly boardId: string;
    readonly createLabelsIfMissing: boolean | undefined;
  },
): Promise<MutationExecResult> => {
  const { mutation, itemId, boardId, createLabelsIfMissing } = inputs;
  const labelsFlag = createLabelsIfMissing ?? false;
  if (mutation.kind === 'change_simple_column_value') {
    const response = await client.raw<ChangeSimpleResponse>(
      CHANGE_SIMPLE_COLUMN_VALUE_MUTATION,
      {
        itemId,
        boardId,
        columnId: mutation.columnId,
        value: mutation.value,
        createLabelsIfMissing: labelsFlag,
      },
      { operationName: 'ItemUpdateSimple' },
    );
    return {
      projected: projectMutationItem(response.data.change_simple_column_value, itemId),
      response,
    };
  }
  if (mutation.kind === 'change_column_value') {
    const response = await client.raw<ChangeColumnResponse>(
      CHANGE_COLUMN_VALUE_MUTATION,
      {
        itemId,
        boardId,
        columnId: mutation.columnId,
        value: mutation.value,
        createLabelsIfMissing: labelsFlag,
      },
      { operationName: 'ItemUpdateRich' },
    );
    return {
      projected: projectMutationItem(response.data.change_column_value, itemId),
      response,
    };
  }
  // change_multiple_column_values — multi-`--set` or `--set + --name`.
  const response = await client.raw<ChangeMultipleResponse>(
    CHANGE_MULTIPLE_COLUMN_VALUES_MUTATION,
    {
      itemId,
      boardId,
      columnValues: mutation.columnValues,
      createLabelsIfMissing: labelsFlag,
    },
    { operationName: 'ItemUpdateMulti' },
  );
  return {
    projected: projectMutationItem(response.data.change_multiple_column_values, itemId),
    response,
  };
};

const projectMutationItem = (raw: unknown, itemId: string): ProjectedItem => {
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned no item payload from the mutation for id ${itemId}.`,
      { details: { item_id: itemId } },
    );
  }
  return projectItem({ raw: parseRawItem(raw, { item_id: itemId }) });
};

/**
 * Aggregates per-leg `source` values into the merge value the F4
 * remap helper consumes. Same merge rule the dry-run engine applies
 * (`live + live → live`, `cache + live → mixed`, `mixed → mixed`).
 * Local copy rather than an export from `api/dry-run.ts` because
 * the engine's `mergeSource` is a private helper there; lifting it
 * would expand the engine's surface for one consumer. If a third
 * consumer arrives, lift to a shared module then.
 */
const mergeSourceForRemap = (
  current: 'live' | 'cache' | 'mixed' | undefined,
  next: 'live' | 'cache' | 'mixed',
): 'live' | 'cache' | 'mixed' => {
  if (current === undefined) return next;
  if (current === 'mixed' || next === 'mixed') return 'mixed';
  if (current === next) return current;
  return 'mixed';
};

/**
 * Bulk dry-run aggregates per-item resolver warnings — the same
 * `stale_cache_refreshed` / `column_token_collision` signals fire
 * once per item the first time they're triggered (subsequent items
 * hit the now-warm cache). De-duplicates by `code + message +
 * details.token` so an agent reading the dry-run envelope sees
 * each unique warning once rather than N copies. Order-preserving:
 * the first occurrence wins.
 */
const dedupeWarnings = (warnings: readonly Warning[]): readonly Warning[] => {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const w of warnings) {
    const tokenKey =
      typeof w.details?.token === 'string'
        ? w.details.token
        : '';
    const key = `${w.code}|${w.message}|${tokenKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
};

// ============================================================
// Bulk path (cli-design §10.2 — `--where` / `--filter-json`).
// ============================================================

const ITEMS_PAGE_QUERY = `
  query ItemsPage(
    $boardId: ID!
    $limit: Int!
    $queryParams: ItemsQuery
  ) {
    boards(ids: [$boardId]) {
      items_page(limit: $limit, query_params: $queryParams) {
        cursor
        items {
          id
        }
      }
    }
  }
`;

const NEXT_ITEMS_PAGE_QUERY = `
  query NextItemsPage($cursor: String!, $limit: Int!) {
    next_items_page(limit: $limit, cursor: $cursor) {
      cursor
      items {
        id
      }
    }
  }
`;

// R18 / Codex pass-1 F6 + pass-2 follow-up: parse boundaries on the
// bulk items_page + next_items_page responses. Schemas are tight —
// `boards` is a non-nullable non-empty array; `items_page` is
// required (not optional). Pre-fix, these were trusted via optional
// chaining — a malformed Monday response (schema drift, a `boards`
// key missing, `items` not an array) would silently surface as an
// empty match set, which is the worst-of-both-worlds failure mode
// for bulk mutations: agents see "0 matched, 0 applied" success
// when the real story is "Monday's response shape changed and we
// couldn't read it". Pass-1's first attempt loosened the schema
// too far (kept items_page optional + boards nullable); pass-2
// tightens the schema so missing fields surface as
// `internal_error` with the failing field path on
// `details.issues`.
const bulkItemSchema = z.object({ id: ItemIdSchema }).loose();

const initialPageResponseSchema = z
  .object({
    boards: z
      .array(
        z
          .object({
            items_page: z.object({
              cursor: z.string().nullable(),
              items: z.array(bulkItemSchema),
            }),
          })
          .loose(),
      )
      .min(1),
  })
  .loose();

const nextPageResponseSchema = z
  .object({
    next_items_page: z.object({
      cursor: z.string().nullable(),
      items: z.array(bulkItemSchema),
    }),
  })
  .loose();

type BulkItem = z.infer<typeof bulkItemSchema>;
type InitialPageResponse = z.infer<typeof initialPageResponseSchema>;
type NextPageResponse = z.infer<typeof nextPageResponseSchema>;

/**
 * Wrapped data shape for the bulk-live success envelope. cli-design
 * §10.2 doesn't pin a specific shape for `data`, so we fold the
 * matched / applied counts into a `summary` slot alongside the
 * per-item projected list. Agents read `data.applied_count` for the
 * "did it work?" probe and `data.items` for the post-mutation state.
 */
const bulkLiveDataSchema = z.object({
  summary: z.object({
    matched_count: z.number().int().nonnegative(),
    applied_count: z.number().int().nonnegative(),
    board_id: z.string(),
  }),
  items: z.array(projectedItemSchema),
});

type BulkLiveData = z.infer<typeof bulkLiveDataSchema>;

interface RunBulkInputs {
  readonly parsed: ParsedInput;
  readonly client: MondayClient;
  readonly globalFlags: GlobalFlags;
  readonly apiVersion: string;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
}

/**
 * Bulk path orchestrator (cli-design §10.2). Walks `items_page` to
 * collect every matched item, then dispatches:
 *
 *   1. Without `--yes` AND without `--dry-run` → throw
 *      `confirmation_required` with the matched count. Per
 *      cli-design §3.1 #7: "destructive ops without `--yes` fail
 *      fast." Bulk multi-item mutations qualify.
 *   2. With `--dry-run` → per-item `planChanges` → emit N-element
 *      `planned_changes`. cli-design §10.2 line 1456-1457: "both
 *      single-item and bulk forms use the same envelope".
 *   3. With `--yes` (and not `--dry-run`) → per-item live mutation
 *      via `executeMutation`. Fail-fast on first error; the error
 *      envelope's `details.applied_to` lists IDs of items that
 *      successfully mutated before the failure.
 *
 * **Why per-item planChanges / executeMutation rather than a
 * single bulk mutation.** Monday has no true bulk-update mutation
 * in 2026-01; the CLI walks items + fires N `change_*` calls. The
 * column resolution + translation work is done once, then reused
 * across every per-item mutation.
 *
 * **Sequential execution.** cli-design §9.3 mandates one-at-a-time
 * requests in v0.1-v0.3; the per-item loop respects that. v0.4's
 * `--concurrency` flag is the future extension point.
 */
const runBulk = async (inputs: RunBulkInputs): Promise<void> => {
  const { parsed, client, globalFlags, apiVersion, ctx, programOpts } = inputs;
  /* c8 ignore next 6 — defensive: validateInputShape guarantees
     parsed.board is non-undefined when shape is bulk; the type
     guard exists for TS. */
  if (parsed.board === undefined) {
    throw new UsageError('item update bulk path: --board is required');
  }
  const boardId = parsed.board;

  // 1) Load board metadata (cache-aware, refresh on column-not-found
  //    during filter parsing per §5.3 step 5).
  const meta = await loadBoardMetadata({
    client,
    boardId,
    env: ctx.env,
    noCache: globalFlags.noCache,
  });
  const onColumnNotFound =
    meta.source === 'cache'
      ? async (): Promise<BoardMetadata> => {
          const refreshed = await refreshBoardMetadata({
            client,
            boardId,
            env: ctx.env,
          });
          return refreshed.metadata;
        }
      : undefined;

  const filterResult = await buildQueryParams({
    metadata: meta.metadata,
    resolveMe: resolveMeFactory(client),
    whereClauses: parsed.where,
    filterJson: parsed.filterJson,
    ...(onColumnNotFound === undefined ? {} : { onColumnNotFound }),
  });

  // 2) Walk items_page collecting matched item IDs. Fail-fast on
  //    stale-cursor per §5.6. Each page response is parsed through
  //    `unwrapOrThrow` so malformed shapes surface as typed
  //    `internal_error` (Codex pass-1 F6).
  const matchedItemIds: string[] = [];
  await paginate<BulkItem, InitialPageResponse | NextPageResponse>({
    fetchInitial: async () => {
      const response = await client.raw<unknown>(
        ITEMS_PAGE_QUERY,
        {
          boardId,
          limit: DEFAULT_PAGE_SIZE,
          queryParams: filterResult.queryParams ?? null,
        },
        { operationName: 'ItemsPage' },
      );
      const data = unwrapOrThrow(
        initialPageResponseSchema.safeParse(response.data),
        {
          context: `Monday returned a malformed ItemsPage response for board ${boardId}`,
          details: { board_id: boardId },
        },
      );
      return { ...response, data };
    },
    fetchNext: async (cursor) => {
      const response = await client.raw<unknown>(
        NEXT_ITEMS_PAGE_QUERY,
        { cursor, limit: DEFAULT_PAGE_SIZE },
        { operationName: 'NextItemsPage' },
      );
      const data = unwrapOrThrow(
        nextPageResponseSchema.safeParse(response.data),
        {
          context: 'Monday returned a malformed NextItemsPage response',
          details: { cursor },
        },
      );
      return { ...response, data };
    },
    now: ctx.clock,
    extractPage: (r): PaginatedPage<BulkItem> => {
      if ('next_items_page' in r.data) {
        const nr = (r as MondayResponse<NextPageResponse>).data;
        return {
          items: nr.next_items_page.items,
          cursor: nr.next_items_page.cursor,
        };
      }
      const ir = (r as MondayResponse<InitialPageResponse>).data;
      // Schema enforces `boards` is non-empty + `items_page` is
      // required, so `boards[0]` is non-undefined here. The
      // type-system doesn't narrow `noUncheckedIndexedAccess` away
      // from min(1) refinements — the guard keeps TS happy.
      const board = ir.boards[0];
      /* c8 ignore next 3 — defensive: schema's `.min(1)` rejects
         empty arrays. */
      if (board === undefined) {
        throw new ApiError('internal_error', 'bulk page: empty boards array');
      }
      return {
        items: board.items_page.items,
        cursor: board.items_page.cursor,
      };
    },
    getId: (item) => item.id,
    all: true,
    onItem: (item) => {
      matchedItemIds.push(item.id);
    },
  });

  // 3) Empty match set — both dry-run and live are clean no-ops.
  //    Emit a success envelope before the confirmation gate fires
  //    (Codex pass-1 F1: `--yes` shouldn't be required to confirm
  //    "no items matched"). Filter warnings still surface so the
  //    agent sees `column_token_collision` / `stale_cache_refreshed`
  //    if the empty result was filter-resolved post-refresh.
  //
  // Codex pass-2: source / cacheAgeSeconds aggregate from the metadata
  // load + the items_page walk (always live). Cache-sourced metadata
  // + live walk → `mixed`; pure-cache metadata stays `cache` only on
  // the impossible no-walk path. The live items_page walk forces the
  // aggregate to `mixed` when metadata was cache-served.
  const emptyEnvelopeSource: 'live' | 'cache' | 'mixed' =
    meta.source === 'cache' ? 'mixed' : 'live';
  if (matchedItemIds.length === 0) {
    if (globalFlags.dryRun) {
      emitDryRun({
        ctx,
        programOpts,
        plannedChanges: [],
        source: emptyEnvelopeSource,
        cacheAgeSeconds: meta.cacheAgeSeconds,
        warnings: filterResult.warnings,
        apiVersion,
      });
      return;
    }
    emitMutation({
      ctx,
      data: {
        summary: { matched_count: 0, applied_count: 0, board_id: boardId },
        items: [],
      } satisfies BulkLiveData,
      schema: bulkLiveDataSchema,
      programOpts,
      warnings: filterResult.warnings,
      source: emptyEnvelopeSource,
      cacheAgeSeconds: meta.cacheAgeSeconds,
      apiVersion,
    });
    return;
  }

  // 4) Confirmation gate. Bulk mutations without --yes (and without
  //    --dry-run) surface `confirmation_required` per §3.1 #7 +
  //    §6.5. Agents read the matched-item count and re-run with
  //    --yes after reviewing. `--yes` is a global flag (program.ts).
  if (!globalFlags.dryRun && !globalFlags.yes) {
    throw new ConfirmationRequiredError(
      `Bulk item update would mutate ${String(matchedItemIds.length)} ` +
        `matched item(s). Re-run with --yes to confirm, or --dry-run to ` +
        `preview.`,
      {
        details: {
          board_id: boardId,
          matched_count: matchedItemIds.length,
          where_clauses: parsed.where,
          ...(parsed.filterJson === undefined
            ? {}
            : { filter_json: parsed.filterJson }),
          hint:
            'Use --dry-run to inspect the planned_changes for every ' +
            'matched item before applying.',
        },
      },
    );
  }

  const setEntries = parsed.set.map(splitSetExpression);

  const dateResolution: DateResolutionContext = {
    now: ctx.clock,
    ...(ctx.env.MONDAY_TIMEZONE === undefined
      ? {}
      : { timezone: ctx.env.MONDAY_TIMEZONE }),
  };
  const peopleResolution: PeopleResolutionContext = {
    resolveMe: resolveMeFactory(client),
    resolveEmail: async (email) => {
      const result = await userByEmail({
        client,
        email,
        env: ctx.env,
        noCache: globalFlags.noCache,
      });
      return result.user.id;
    },
  };

  // 5) Dry-run path: per-item planChanges. Column resolution is
  //    cached after the first call; per-item state read fires per
  //    item (no item-state cache in v0.1).
  //
  // Codex pass-1 F4: aggregate per-item warnings + source + cache
  // age across the batch. Pre-fix, bulk dry-run dropped per-item
  // results' `warnings` and hardcoded `source: 'mixed'`, losing
  // `column_token_collision` / `stale_cache_refreshed` signals
  // the resolver-warning preservation pattern is meant to keep.
  if (globalFlags.dryRun) {
    const allPlanned: Readonly<Record<string, unknown>>[] = [];
    const aggregatedWarnings: Warning[] = [...filterResult.warnings];
    let aggregatedSource: 'live' | 'cache' | 'mixed' =
      meta.source === 'cache' ? 'cache' : 'live';
    let aggregatedCacheAge: number | null = meta.cacheAgeSeconds;
    for (const itemId of matchedItemIds) {
      const result = await planChanges({
        client,
        boardId,
        itemId,
        setEntries,
        ...(parsed.name === undefined ? {} : { nameChange: parsed.name }),
        dateResolution,
        peopleResolution,
        env: ctx.env,
        noCache: globalFlags.noCache,
      });
      for (const plan of result.plannedChanges) {
        allPlanned.push(plan as unknown as Readonly<Record<string, unknown>>);
      }
      // Resolver warnings can fire per item (the cache-miss-refresh
      // dance is per-token). Most fire on the first item only (cache
      // populated for subsequent items), but the helper deduplicates
      // by code+message+token below for compactness.
      for (const w of result.warnings) {
        aggregatedWarnings.push(w);
      }
      aggregatedSource = mergeSourceForRemap(aggregatedSource, result.source);
      if (
        result.cacheAgeSeconds !== null &&
        (aggregatedCacheAge === null ||
          result.cacheAgeSeconds > aggregatedCacheAge)
      ) {
        aggregatedCacheAge = result.cacheAgeSeconds;
      }
    }
    emitDryRun({
      ctx,
      programOpts,
      plannedChanges: allPlanned,
      source: aggregatedSource,
      cacheAgeSeconds: aggregatedCacheAge,
      warnings: dedupeWarnings(aggregatedWarnings),
      apiVersion,
    });
    return;
  }

  // 5) Live path: per-item mutation. Resolve columns once, translate
  //    once, then fire the same SelectedMutation against every
  //    matched item.
  //
  // `collectedWarnings` is the union of filter warnings + resolver
  // warnings, surfaced on the success envelope. `resolverWarnings`
  // is the narrowed subset used by foldResolverWarningsIntoError —
  // the helper's contract is to fold collision / stale_cache_refreshed
  // signals, not generic Warning types.
  const collectedWarnings: Warning[] = [...filterResult.warnings];
  const resolverWarnings: ResolverWarning[] = [];
  const translated: TranslatedColumnValue[] = [];
  const resolvedIds: Record<string, string> = {};
  let aggregateSource: 'live' | 'cache' | 'mixed' =
    meta.source === 'cache' ? 'cache' : 'live';
  for (const entry of setEntries) {
    const resolution = await resolveColumnWithRefresh({
      client,
      boardId,
      token: entry.token,
      includeArchived: true,
      env: ctx.env,
      noCache: globalFlags.noCache,
    });
    collectedWarnings.push(...resolution.warnings);
    resolverWarnings.push(...resolution.warnings);
    aggregateSource = mergeSourceForRemap(aggregateSource, resolution.source);
    if (resolution.match.column.archived === true) {
      throw foldResolverWarningsIntoError(
        new ApiError(
          'column_archived',
          `Column ${JSON.stringify(resolution.match.column.id)} on board ` +
            `${boardId} is archived.`,
          {
            details: {
              column_id: resolution.match.column.id,
              column_title: resolution.match.column.title,
              column_type: resolution.match.column.type,
              board_id: boardId,
            },
          },
        ),
        resolverWarnings,
      );
    }
    try {
      const t = await translateColumnValueAsync({
        column: {
          id: resolution.match.column.id,
          type: resolution.match.column.type,
        },
        value: entry.value,
        dateResolution,
        peopleResolution,
      });
      translated.push(t);
      resolvedIds[entry.token] = resolution.match.column.id;
    } catch (err) {
      if (err instanceof MondayCliError) {
        throw foldResolverWarningsIntoError(err, resolverWarnings);
      }
      throw err;
    }
  }

  const allTranslated: readonly TranslatedColumnValue[] =
    parsed.name === undefined
      ? translated
      : [
          {
            columnId: 'name',
            columnType: 'text',
            rawInput: parsed.name,
            payload: { format: 'simple', value: parsed.name },
            resolvedFrom: null,
            peopleResolution: null,
          },
          ...translated,
        ];

  const mutation: SelectedMutation = selectMutation(allTranslated);
  const appliedItems: ProjectedItem[] = [];
  // Codex pass-1 F3: F4's `validation_failed` → `column_archived`
  // remap must fire on bulk per-item failures too — agents key off
  // the stable `column_archived` code regardless of whether the
  // mutation came from item set / item update single / item update
  // bulk. Pre-fix, bulk failures only ran the resolver-warning
  // fold + bulk-progress decoration; the remap was missing.
  const remapTarget = translated[0];
  const remapSource = aggregateSource;
  for (const itemId of matchedItemIds) {
    try {
      const result = await executeMutation(client, {
        mutation,
        itemId,
        boardId,
        createLabelsIfMissing: parsed.createLabelsIfMissing,
      });
      appliedItems.push(result.projected);
    } catch (err) {
      if (err instanceof MondayCliError) {
        const folded = foldResolverWarningsIntoError(err, resolverWarnings);
        // Apply the F4 remap before bulk-progress decoration. The
        // remap returns the original error unchanged when its
        // preconditions aren't met (non-validation_failed, live
        // source, refresh failure, post-refresh column still
        // active). When it DOES fire, the remapped error keeps the
        // resolver_warnings slot we just folded in.
        let remapped: MondayCliError = folded;
        if (remapTarget !== undefined) {
          remapped = await maybeRemapValidationFailedToArchived(folded, {
            client,
            boardId,
            columnId: remapTarget.columnId,
            env: ctx.env,
            noCache: globalFlags.noCache,
            resolutionSource: remapSource,
          });
        }
        // Decorate with bulk-progress details so agents can see how
        // many items mutated successfully before the failure.
        const existing = remapped.details ?? {};
        if (remapped.code === 'usage_error') {
          throw new UsageError(remapped.message, {
            ...(remapped.cause === undefined ? {} : { cause: remapped.cause }),
            details: {
              ...existing,
              applied_count: appliedItems.length,
              applied_to: appliedItems.map((i) => i.id),
              failed_at_item: itemId,
              matched_count: matchedItemIds.length,
            },
          });
        }
        throw new ApiError(remapped.code, remapped.message, {
          ...(remapped.cause === undefined ? {} : { cause: remapped.cause }),
          ...(remapped.httpStatus === undefined ? {} : { httpStatus: remapped.httpStatus }),
          ...(remapped.mondayCode === undefined ? {} : { mondayCode: remapped.mondayCode }),
          ...(remapped.requestId === undefined ? {} : { requestId: remapped.requestId }),
          retryable: remapped.retryable,
          ...(remapped.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: remapped.retryAfterSeconds }),
          details: {
            ...existing,
            applied_count: appliedItems.length,
            applied_to: appliedItems.map((i) => i.id),
            failed_at_item: itemId,
            matched_count: matchedItemIds.length,
          },
        });
      }
      throw err;
    }
  }

  // Codex pass-2: aggregate `meta.source` + `cache_age_seconds`
  // properly per cli-design §6.1. Pre-fix, source was inferred from
  // warning presence — a plain cache hit (no warning) on metadata
  // would surface as `live` even though the resolver served from
  // cache. M4 pinned this exact regression for read commands; the
  // bulk write path replicated the bug.
  //
  // The items_page walk and per-item mutations always fire live —
  // merge that into `aggregateSource` so a fully-cached metadata +
  // column-resolution path still surfaces as `mixed` (cache-served
  // metadata + live wire calls). Mirrors the empty-match no-op
  // path's `emptyEnvelopeSource` derivation.
  const finalSource = mergeSourceForRemap(aggregateSource, 'live');
  emitMutation({
    ctx,
    data: {
      summary: {
        matched_count: matchedItemIds.length,
        applied_count: appliedItems.length,
        board_id: boardId,
      },
      items: appliedItems,
    } satisfies BulkLiveData,
    schema: bulkLiveDataSchema,
    programOpts,
    warnings: collectedWarnings,
    source: finalSource,
    cacheAgeSeconds: meta.cacheAgeSeconds,
    apiVersion,
    resolvedIds,
  });
};
