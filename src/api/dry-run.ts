/**
 * Dry-run engine (`cli-design.md` §6.4 + §5.3, `v0.1-plan.md` §3 M5a).
 *
 * Single export `planChanges` — given a board / item / set-pair list,
 * runs every read-side resolution that the matching live mutation
 * would run (column lookup, value translation, current-state read)
 * and emits a `planned_changes[]` array byte-compatible with the
 * `cli-design.md` §6.4 sample.
 *
 * **Why a separate module.** column-values.ts owns *translation*;
 * resolution lives in columns.ts; current-state reads live in the
 * item GraphQL queries spread across the command surface. The
 * dry-run engine is the unique spot that orchestrates all three for
 * a planned-but-unsent mutation. Keeping it in its own module means
 * M5b's three command surfaces (`item set` / `item clear` /
 * `item update`) each call `planChanges(...)` once when `--dry-run`
 * is set, rather than reimplementing the orchestration in three
 * places.
 *
 * **All-or-nothing semantics.** Any resolution failure — unknown
 * column, ambiguous column, unsupported type, unknown email — fails
 * the entire batch. cli-design §6.4 prescribes the dry-run envelope
 * as a single `data: null` + populated `planned_changes` shape;
 * surfacing partial plans would force the caller to second-guess
 * which entries actually planned versus which silently dropped.
 * The engine collects every `--set` pair before translating, but
 * the first failing pair short-circuits — the typed error bubbles
 * with whatever `details` the underlying resolver / translator
 * built.
 *
 * **Mutation kind selection** (`change_simple_column_value` /
 * `change_column_value` / `change_multiple_column_values`) goes
 * through `selectMutation`, so the dry-run engine and the
 * eventually-live M5b mutation pick the same wire shape from the
 * same source of truth. The `operation` field in each
 * `PlannedChange` reflects what the live call would issue.
 *
 * **Resolved-from echoes.** Two slots, one per kind:
 *   - **Date** — relative tokens carry a `DateResolution`
 *     (`{input, timezone, now}`) on the translated value. Rendered
 *     as `details.resolved_from` on the diff cell.
 *   - **People** — the people translator emits a
 *     `PeopleResolution` (`{tokens: [{input, resolved_id}, ...]}`)
 *     pairing each input token with its resolved Monday user ID.
 *     Rendered as `details.resolved_from` on people diff cells.
 *
 * Other types (status / dropdown / text / long_text / numbers and
 * non-relative dates) emit no `details` block — there's nothing to
 * resolve beyond what's already visible in the wire payload.
 */

import { ApiError } from '../utils/errors.js';
import type { MondayClient } from './client.js';
import type { JsonValue } from '../types/json.js';
import {
  resolveColumnWithRefresh,
  type ResolverWarning,
} from './columns.js';
import {
  parseColumnValue,
  type RawItem,
  type RawColumnValue,
} from './item-projection.js';
import {
  ITEM_FIELDS_FRAGMENT,
  parseRawItem,
} from './item-helpers.js';
import type { BoardColumn } from './board-metadata.js';
import {
  selectMutation,
  translateColumnValueAsync,
  type DateResolutionContext,
  type PeopleResolutionContext,
  type SelectedMutation,
  type TranslatedColumnValue,
} from './column-values.js';

/**
 * One agent-supplied `--set <token>=<value>` pair, pre-split by the
 * command layer into the resolution token and the raw value. The
 * engine handles resolution + translation; argv splitting (per
 * cli-design §5.3 step 3) belongs upstream.
 */
export interface SetEntry {
  /** The raw column token agent typed (`status`, `due`, `id:status_4`). */
  readonly token: string;
  /** The raw value agent typed (post-`=` split). */
  readonly value: string;
}

export interface PlanChangesInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly itemId: string;
  /** The full list of `--set` pairs the command layer parsed. */
  readonly setEntries: readonly SetEntry[];
  /**
   * Date-resolution context — clock + tz for relative tokens. M5b's
   * command layer plumbs `MONDAY_TIMEZONE` env override here. When
   * omitted, the date translator falls back to system clock + tz.
   */
  readonly dateResolution?: DateResolutionContext;
  /**
   * People-resolution context — `resolveMe` + `resolveEmail`.
   * Required when any `--set` pair targets a `people` column;
   * `translateColumnValueAsync` raises `internal_error` if missing.
   */
  readonly peopleResolution?: PeopleResolutionContext;
  /** Cache root + tz from process.env; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** `--no-cache`: skip the column-metadata cache entirely. */
  readonly noCache?: boolean;
}

/**
 * One planned change — the §6.4 wire shape. The engine returns an
 * array of these (length 1 in v0.1; M5b's bulk path produces N).
 *
 * Field order matches the sample at cli-design.md §6.4 lines
 * 1206-1217 byte-for-byte: `operation`, `board_id`, `item_id`,
 * `resolved_ids`, `diff`. Inserting a field reorders the JSON
 * output — pinned by snapshot test against the literal sample.
 */
export interface PlannedChange {
  /** The Monday mutation the live `--no-dry-run` call would issue. */
  readonly operation:
    | 'change_simple_column_value'
    | 'change_column_value'
    | 'change_multiple_column_values';
  readonly board_id: string;
  readonly item_id: string;
  /**
   * Token → resolved column ID map. Per §6.4: agents capture
   * `resolved_ids[token]` for stable downstream calls — the human-
   * friendly token in the original `--set` may be a column title
   * that gets renamed; the resolved ID is permanent.
   */
  readonly resolved_ids: Readonly<Record<string, string>>;
  /**
   * Resolved-column-ID → diff cell. `from` is the parsed Monday
   * value the column currently holds (or `null` for an empty cell);
   * `to` is the wire payload the live mutation would send. The
   * optional `details.resolved_from` carries the resolution echo
   * for date-relative tokens and people inputs.
   */
  readonly diff: Readonly<Record<string, DiffCell>>;
}

/**
 * One column's diff cell. `from` and `to` are JSON-shaped for the
 * envelope; details (when present) carries the resolution echo for
 * date / people inputs. cli-design §6.4 lines 1213-1214 pin the
 * shape — `details` is an optional sibling of `from` / `to`,
 * present only when the translator emitted an echo.
 */
export interface DiffCell {
  readonly from: JsonValue;
  readonly to: JsonValue;
  readonly details?: { readonly resolved_from: JsonValue };
}

export interface PlanChangesResult {
  readonly plannedChanges: readonly PlannedChange[];
  /**
   * Aggregate envelope source: `live` if any leg fetched live (the
   * item read always does); `cache` only if every leg hit cache;
   * `mixed` when the column-resolution refresh path fired. v0.1's
   * dry-run always reads the item live — there's no item-state
   * cache — so `source` is always `live` or `mixed` in practice.
   * The `cache` value is reserved for v0.2 when item-state caching
   * lands.
   */
  readonly source: 'live' | 'cache' | 'mixed';
  readonly cacheAgeSeconds: number | null;
  readonly warnings: readonly ResolverWarning[];
}

/**
 * Resolves every `--set` pair, fetches the item's current state,
 * translates each value, and assembles a single `PlannedChange`
 * (v0.1 — one item per call). All-or-nothing: any resolution
 * failure throws the typed error directly so the command layer
 * surfaces it through the runner's normal error path.
 */
export const planChanges = async (
  inputs: PlanChangesInputs,
): Promise<PlanChangesResult> => {
  if (inputs.setEntries.length === 0) {
    // Defensive — the command layer is supposed to reject the
    // no-`--set` case before reaching the engine. Surfacing as
    // internal_error rather than usage_error because reaching this
    // path is a wiring bug, not a user fault.
    throw new ApiError(
      'internal_error',
      'planChanges called with zero --set entries; the command ' +
        'layer should reject the no-`--set` case before invoking the ' +
        'dry-run engine.',
      { details: { board_id: inputs.boardId, item_id: inputs.itemId } },
    );
  }

  // 1) Resolve every column token. Cache-miss-refresh per §5.3 step 5
  //    fires once per token (resolveColumnWithRefresh owns the dance);
  //    we collect warnings + source/age aggregates as we go.
  const warnings: ResolverWarning[] = [];
  const resolvedByToken = new Map<string, TranslatedColumnValue>();
  const resolvedIds: Record<string, string> = {};
  // Aggregate source starts as `undefined` so the first leg's value
  // becomes the seed; merging then folds subsequent legs in. Pre-fix,
  // seeding to `cache` made `live + live + live` resolve to `mixed`
  // because the first merge crossed `cache → live`.
  let aggregateSource: 'live' | 'cache' | 'mixed' | undefined = undefined;
  let aggregateCacheAge: number | null = null;

  for (const entry of inputs.setEntries) {
    // Mutation paths must include archived columns in the resolver
    // view so we can distinguish "doesn't exist" from "exists but
    // archived" — cli-design §5.3 step 6: "Mutations against
    // archived columns return `column_archived` regardless".
    // resolveColumnWithRefresh would otherwise filter archived
    // columns out and we'd surface `column_not_found`, which is
    // the wrong code (the column DOES exist; it's just archived).
    const resolution = await resolveColumnWithRefresh({
      client: inputs.client,
      boardId: inputs.boardId,
      token: entry.token,
      includeArchived: true,
      ...(inputs.env === undefined ? {} : { env: inputs.env }),
      ...(inputs.noCache === undefined ? {} : { noCache: inputs.noCache }),
    });
    warnings.push(...resolution.warnings);
    aggregateSource = mergeSource(aggregateSource, resolution.source);
    aggregateCacheAge = mergeCacheAge(aggregateCacheAge, resolution.cacheAgeSeconds);

    if (isArchivedColumn(resolution.match.column)) {
      // Surface any resolver warnings (column_token_collision /
      // stale_cache_refreshed) under details.resolver_warnings so
      // they aren't lost when the failure envelope replaces the
      // success envelope's `warnings` slot. Codex pass-2 finding:
      // a stale-cache-then-archived flow would otherwise drop the
      // refresh signal — the agent would never know the cache was
      // wrong AND the column was archived.
      const resolverDetailWarnings = resolution.warnings.map((w) => ({
        code: w.code,
        message: w.message,
        details: w.details,
      }));
      throw new ApiError(
        'column_archived',
        `Column ${JSON.stringify(resolution.match.column.id)} on board ` +
          `${inputs.boardId} is archived. Monday rejects mutations against ` +
          `archived columns; un-archive the column in Monday or pick a ` +
          `different target.`,
        {
          details: {
            column_id: resolution.match.column.id,
            column_title: resolution.match.column.title,
            column_type: resolution.match.column.type,
            board_id: inputs.boardId,
            ...(resolverDetailWarnings.length > 0
              ? { resolver_warnings: resolverDetailWarnings }
              : {}),
          },
        },
      );
    }

    const translated = await translateColumnValueAsync({
      column: { id: resolution.match.column.id, type: resolution.match.column.type },
      value: entry.value,
      ...(inputs.dateResolution === undefined
        ? {}
        : { dateResolution: inputs.dateResolution }),
      ...(inputs.peopleResolution === undefined
        ? {}
        : { peopleResolution: inputs.peopleResolution }),
    });

    if (resolvedIds[entry.token] !== undefined) {
      // Duplicate token — same as `selectMutation`'s duplicate-id
      // branch but caught earlier so the column-resolution work
      // stops. Same shape so the multi-call path's error doesn't
      // diverge from the single-call path's error.
      throw new ApiError(
        'usage_error',
        `Multiple --set entries target column token ${JSON.stringify(entry.token)}. ` +
          `Pass at most one --set per column; if two tokens resolve to the ` +
          `same column ID after NFC + case-fold normalisation, use the ` +
          `\`id:<column_id>\` prefix to disambiguate.`,
        {
          details: {
            token: entry.token,
            resolved_id: resolution.match.column.id,
          },
        },
      );
    }
    resolvedByToken.set(entry.token, translated);
    resolvedIds[entry.token] = resolution.match.column.id;
  }

  // Aggregate cross-column duplicate detection: two distinct tokens
  // (e.g. `status` and `id:status_4`) may resolve to the same column.
  // selectMutation owns this check for the multi case but it's
  // correct to surface the failure pre-translation so the engine
  // never produces a half-built diff.
  const seenColumnIds = new Set<string>();
  for (const [token, value] of resolvedByToken) {
    if (seenColumnIds.has(value.columnId)) {
      throw new ApiError(
        'usage_error',
        `Multiple --set entries resolve to the same column ID ` +
          `${JSON.stringify(value.columnId)} (last token: ` +
          `${JSON.stringify(token)}). Pass at most one --set per column.`,
        {
          details: {
            column_id: value.columnId,
            tokens: [...resolvedByToken.entries()]
              .filter(([, v]) => v.columnId === value.columnId)
              .map(([t]) => t),
          },
        },
      );
    }
    seenColumnIds.add(value.columnId);
  }

  // 2) Fetch item current state. The query mirrors `item get`'s
  //    shape — board/group/columns inline — because the dry-run
  //    diff key is the resolved column ID (not the title) and we
  //    need the current `value` per column.
  const itemRead = await fetchItem(inputs.client, inputs.itemId);
  // Item read is always live in v0.1; mark aggregate accordingly.
  aggregateSource = mergeSource(aggregateSource, 'live');

  if (itemRead.boardId !== null && itemRead.boardId !== inputs.boardId) {
    // Defensive: caller's `boardId` doesn't match the item's actual
    // home board. Could indicate a stale `--board` override or a
    // wrong-tenant cross-call. Surface as `usage_error` (caller can
    // fix) rather than `internal_error`.
    throw new ApiError(
      'usage_error',
      `Item ${inputs.itemId} lives on board ${itemRead.boardId} but the ` +
        `dry-run was issued against board ${inputs.boardId}. Re-run ` +
        `with the correct --board, or omit --board to let the CLI ` +
        `look it up.`,
      {
        details: {
          item_id: inputs.itemId,
          item_board_id: itemRead.boardId,
          requested_board_id: inputs.boardId,
        },
      },
    );
  }

  // 3) Pick the mutation kind FIRST. `selectMutation` owns the
  //    long_text re-wrap (`{text: <value>}` inside multi vs bare
  //    string in single) per cli-design §5.3 step 5; the dry-run
  //    diff `to` should reflect the *actual* wire shape that would
  //    be sent. Building diff cells before selectMutation would
  //    mis-render long_text in multi as a bare string.
  const orderedTranslated: TranslatedColumnValue[] = inputs.setEntries.map(
    (entry) => {
      const translated = resolvedByToken.get(entry.token);
      /* c8 ignore next 3 — defensive: every token landed in
         resolvedByToken in the loop above. */
      if (translated === undefined) {
        throw new ApiError('internal_error', 'planChanges: lost translated entry');
      }
      return translated;
    },
  );
  const mutation: SelectedMutation = selectMutation(orderedTranslated);
  const operation: PlannedChange['operation'] = mutation.kind;

  // 4) Build diff cells per resolved column, projecting `to` from
  //    the selected mutation's wire shape. For single mutations
  //    the projection is identity; for multi the long_text re-wrap
  //    surfaces in the diff as it would on the wire.
  const diff: Record<string, DiffCell> = {};
  for (const translated of orderedTranslated) {
    const wireTo = projectWireTo(translated, mutation);
    diff[translated.columnId] = buildDiffCell(
      translated,
      wireTo,
      itemRead.byColumnId.get(translated.columnId),
    );
  }

  const plannedChange: PlannedChange = {
    operation,
    board_id: inputs.boardId,
    item_id: inputs.itemId,
    resolved_ids: resolvedIds,
    diff,
  };

  return {
    plannedChanges: [plannedChange],
    // aggregateSource has been merged at least twice by this point
    // (column + item legs) because setEntries.length > 0 was enforced
    // at the top, and the assignment threads through `mergeSource`
    // which can never return undefined — TS narrows accordingly.
    source: aggregateSource,
    cacheAgeSeconds: aggregateCacheAge,
    warnings,
  };
};

/**
 * `archived` is a nullable boolean on Monday's column shape — `null`
 * means "no archive flag set", `false` means "explicitly active",
 * `true` means archived. Treat any truthy value as archived; `null`
 * / `false` / `undefined` all flow through.
 */
const isArchivedColumn = (column: BoardColumn): boolean =>
  column.archived === true;

/**
 * Merges per-leg `source` values into the aggregate envelope source
 * per §6.1: the first leg seeds (`undefined → next`); any `mixed` is
 * contagious; otherwise `cache + live → mixed`; otherwise the
 * unanimous value. Same rule callers fold across multi-leg reads in
 * M3 / M4.
 */
const mergeSource = (
  current: 'live' | 'cache' | 'mixed' | undefined,
  next: 'live' | 'cache' | 'mixed',
): 'live' | 'cache' | 'mixed' => {
  if (current === undefined) return next;
  if (current === 'mixed' || next === 'mixed') return 'mixed';
  if (current === next) return current;
  return 'mixed';
};

/**
 * Merges per-leg `cacheAgeSeconds` into the aggregate. Per §6.1,
 * the envelope's `cache_age_seconds` is the **oldest** age across
 * legs that hit cache — it represents the worst-case staleness.
 * `null` legs (live fetches) don't update the aggregate; if all
 * legs are live, the aggregate stays `null`.
 */
const mergeCacheAge = (
  current: number | null,
  next: number | null,
): number | null => {
  if (next === null) return current;
  if (current === null) return next;
  return Math.max(current, next);
};

/**
 * Projects the wire-side `to` value for a translated column,
 * matching the actual mutation's payload exactly — including the
 * `long_text` re-wrap that `selectMutation` applies for multi
 * mutations. The single-mutation cases pass the translator's
 * payload through unchanged.
 *
 * Why route through the selected mutation: `change_simple_column_value`
 * accepts a bare string for `long_text`, but
 * `change_multiple_column_values` requires `{text: <value>}` for
 * the same type (cli-design §5.3 step 5 spec gap, pinned via
 * fixture in column-values.test.ts). The dry-run diff `to` should
 * reflect the wire shape the live mutation would actually send;
 * routing through `selectMutation`'s output keeps both sides
 * consistent without the dry-run engine duplicating the re-wrap.
 */
const projectWireTo = (
  translated: TranslatedColumnValue,
  mutation: SelectedMutation,
): JsonValue => {
  if (mutation.kind === 'change_multiple_column_values') {
    const value = mutation.columnValues[translated.columnId];
    /* c8 ignore next 3 — defensive: every translated column lands
       in the multi map by construction in selectMutation. */
    if (value === undefined) {
      throw new ApiError('internal_error', 'projectWireTo: lost multi entry');
    }
    return value;
  }
  // Single-mutation path: payload's value is the wire value.
  return translated.payload.value;
};

/**
 * Builds one diff cell. `from` decodes the current Monday value (or
 * `null` for empty cells); `to` is the wire-side projection
 * (`projectWireTo` already applied the long_text re-wrap for
 * multi). `details.resolved_from` populates only when the
 * translator emitted an echo.
 */
const buildDiffCell = (
  translated: TranslatedColumnValue,
  to: JsonValue,
  current: RawColumnValue | undefined,
): DiffCell => {
  const from: JsonValue = current === undefined ? null : decodeFrom(current);
  // Echo-slot exclusivity invariant. Today's translators populate
  // at most one of resolvedFrom (date) / peopleResolution (people).
  // A future translator that mistakenly sets both would silently
  // collapse to the date echo (the first branch wins below); fire
  // an internal_error so the regression is loud, not silent.
  // Codex pass-2 finding F3.
  if (translated.resolvedFrom !== null && translated.peopleResolution !== null) {
    throw new ApiError(
      'internal_error',
      `Translator emitted both resolvedFrom and peopleResolution for ` +
        `column "${translated.columnId}" (type "${translated.columnType}"). ` +
        `These slots are mutually exclusive in v0.1; a translator setting ` +
        `both is a wiring bug.`,
      {
        details: {
          column_id: translated.columnId,
          column_type: translated.columnType,
        },
      },
    );
  }
  if (translated.resolvedFrom !== null) {
    return {
      from,
      to,
      details: {
        resolved_from: {
          input: translated.resolvedFrom.input,
          timezone: translated.resolvedFrom.timezone,
          now: translated.resolvedFrom.now,
        },
      },
    };
  }
  if (translated.peopleResolution !== null) {
    return {
      from,
      to,
      details: {
        resolved_from: {
          tokens: translated.peopleResolution.tokens.map((t) => ({
            input: t.input,
            resolved_id: t.resolved_id,
          })),
        },
      },
    };
  }
  return { from, to };
};

/**
 * Decodes a Monday `column_values[]` entry into the diff `from`
 * shape. Mirrors `cli-design.md` §6.4 sample line 1213: status
 * cells emit `{label, index}`; date emits `{date, time?}`;
 * people emits `{personsAndTeams: [...]}`; simple types emit the
 * `text` string verbatim.
 *
 * Empty cells (`value === null` or empty-string) emit `null` —
 * matches the §6.4 sample line 1214 `from: null` for empty date.
 */
const decodeFrom = (raw: RawColumnValue): JsonValue => {
  if (raw.value === null || raw.value.length === 0) {
    // Simple types still surface the bare `text` when present —
    // Monday sometimes returns `text: "42"` with `value: null` for
    // numbers / text columns. Without this branch, the diff would
    // claim from=null for a populated cell.
    if (raw.text !== null && raw.text.length > 0) {
      return raw.text;
    }
    return null;
  }
  const parsed = parseColumnValue(raw.value);
  // For status / date / people / dropdown the parsed value is a
  // plain JSON object that's already shaped like `{label, index}`
  // / `{date, time}` / `{personsAndTeams: [...]}` /
  // `{ids|labels: [...]}`. For text / long_text / numbers, Monday
  // encodes the value as a JSON-quoted string — JSON.parse returns
  // the bare string. Either way `parsed` is a JsonValue.
  return parsed as JsonValue;
};

const ITEM_DRY_RUN_QUERY = `
  query ItemDryRunRead($ids: [ID!]!) {
    items(ids: $ids) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

interface ItemDryRunResponse {
  readonly items: readonly unknown[] | null;
}

interface ItemReadResult {
  readonly item: RawItem;
  readonly boardId: string | null;
  readonly byColumnId: ReadonlyMap<string, RawColumnValue>;
}

const fetchItem = async (
  client: MondayClient,
  itemId: string,
): Promise<ItemReadResult> => {
  const response = await client.raw<ItemDryRunResponse>(
    ITEM_DRY_RUN_QUERY,
    { ids: [itemId] },
    { operationName: 'ItemDryRunRead' },
  );
  const items = response.data.items ?? [];
  const first = items[0];
  if (first === undefined || first === null) {
    throw new ApiError(
      'not_found',
      `Item ${itemId} does not exist or the token has no read access.`,
      { details: { item_id: itemId } },
    );
  }
  // R18 parse-boundary wrap — validation.md "Never bubble raw
  // ZodError out of a parse boundary". A malformed Monday response
  // (schema drift, future field rename) surfaces as a typed
  // internal_error carrying details.issues + item_id rather than a
  // bare ZodError that loses the failing field path. Threads through
  // the shared `parseRawItem` helper so the dry-run engine, every
  // M4 read command, and any future M5b/M6 consumer pin the same
  // contract via one source of truth.
  const item = parseRawItem(first, { item_id: itemId });
  const byColumnId = new Map<string, RawColumnValue>();
  for (const cv of item.column_values) {
    byColumnId.set(cv.id, cv);
  }
  return {
    item,
    boardId: item.board?.id ?? null,
    byColumnId,
  };
};
