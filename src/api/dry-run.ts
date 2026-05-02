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
  bundleColumnValues,
  selectMutation,
  translateColumnClear,
  type DateResolutionContext,
  type MultiColumnValue,
  type PeopleResolutionContext,
  type SelectedMutation,
  type TranslatedColumnValue,
} from './column-values.js';
import type { ParsedSetRawExpression } from './raw-write.js';
import { foldResolverWarningsIntoError } from './resolver-error-fold.js';
import { mergeSource } from './source-aggregator.js';
import {
  buildColumnArchivedError,
  resolveAndTranslate,
} from './resolution-pass.js';

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
   * The list of `--set-raw` pairs the command layer parsed (M8
   * escape-hatch surface). Each entry is the result of
   * `parseSetRawExpression` from `api/raw-write.ts` — token + parsed
   * `JsonObject` payload + the original `<json>` string. Resolution
   * runs through the same `resolveColumnWithRefresh` path as
   * `setEntries`; the post-resolution gate (`translateRawColumnValue`)
   * applies the read-only-forever / files-shaped reject lists per
   * cli-design §5.3 escape-hatch contract. The diff `to` side echoes
   * the parsed JsonObject verbatim (whitespace + key ordering from
   * the original argv string aren't preserved — equivalent payloads
   * may render differently per cli-design §5.3 line 973-978).
   */
  readonly rawEntries?: readonly ParsedSetRawExpression[];
  /**
   * Optional rename — the new value for the item's `name` field.
   * Plumbed through `monday item update --name <n>`. The engine
   * treats `name` as a synthetic field (it isn't a column on Monday's
   * board.columns surface) — column resolution is skipped for the
   * `name` slot, and the dry-run diff carries an extra `name` key
   * alongside any column diff entries. When passed alongside one or
   * more `setEntries`, the operation rolls into
   * `change_multiple_column_values` with `name` included in the
   * `column_values` map per Monday's API. Alone, the operation is
   * `change_simple_column_value(column_id: "name", value: <n>)`.
   */
  readonly nameChange?: string;
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
  const rawEntries: readonly ParsedSetRawExpression[] = inputs.rawEntries ?? [];
  if (
    inputs.setEntries.length === 0 &&
    rawEntries.length === 0 &&
    inputs.nameChange === undefined
  ) {
    // Defensive — the command layer is supposed to reject the
    // no-`--set`-and-no-`--set-raw`-and-no-`--name` case before reaching
    // the engine. Surfacing as internal_error rather than usage_error
    // because reaching this path is a wiring bug, not a user fault.
    throw new ApiError(
      'internal_error',
      'planChanges called with zero --set entries, zero --set-raw entries, ' +
        'and no --name change; the command layer should reject the empty ' +
        'case before invoking the dry-run engine.',
      { details: { board_id: inputs.boardId, item_id: inputs.itemId } },
    );
  }

  // Three-pass column resolution + translation per cli-design §5.3
  // — see api/resolution-pass.ts (R20 lift).
  const resolution = await resolveAndTranslate({
    client: inputs.client,
    boardId: inputs.boardId,
    setEntries: inputs.setEntries,
    rawEntries,
    ...(inputs.dateResolution === undefined
      ? {}
      : { dateResolution: inputs.dateResolution }),
    ...(inputs.peopleResolution === undefined
      ? {}
      : { peopleResolution: inputs.peopleResolution }),
    ...(inputs.env === undefined ? {} : { env: inputs.env }),
    ...(inputs.noCache === undefined ? {} : { noCache: inputs.noCache }),
  });
  const warnings: ResolverWarning[] = [...resolution.warnings];
  const resolvedIds = resolution.resolvedIds;
  let aggregateSource: 'live' | 'cache' | 'mixed' | undefined =
    resolution.source;
  const aggregateCacheAge: number | null = resolution.cacheAgeSeconds;

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
  //    mis-render long_text in multi as a bare string. The
  //    `translated` array preserves argv order: --set entries first
  //    then --set-raw, both within their argv order. Pinned by
  //    single-mutation and multi-mutation snapshots.
  const orderedTranslated: readonly TranslatedColumnValue[] =
    resolution.translated;
  // When `--name <n>` is present, prepend a synthetic translated
  // value so `selectMutation` handles bundling uniformly: name-only
  // → `change_simple_column_value(column_id: "name", ...)`; name +
  // columns → `change_multiple_column_values` with name as a key.
  const allTranslated: readonly TranslatedColumnValue[] =
    inputs.nameChange === undefined
      ? orderedTranslated
      : [buildNameTranslatedValue(inputs.nameChange), ...orderedTranslated];
  const mutation: SelectedMutation = selectMutation(allTranslated);
  const operation: PlannedChange['operation'] = mutation.kind;

  // 4) Build diff cells per resolved column, projecting `to` from
  //    the selected mutation's wire shape. For single mutations
  //    the projection is identity; for multi the long_text re-wrap
  //    surfaces in the diff as it would on the wire. Real columns
  //    only — the synthetic `name` entry, when present, lands in
  //    `diff.name` separately so the `from` side reads the item's
  //    `name` field (not a column_values entry).
  const diff: Record<string, DiffCell> = {};
  for (const translated of orderedTranslated) {
    const wireTo = projectWireTo(translated, mutation);
    diff[translated.columnId] = buildDiffCell(
      translated,
      wireTo,
      itemRead.byColumnId.get(translated.columnId),
    );
  }
  if (inputs.nameChange !== undefined) {
    // Synthetic `name` diff cell. The `from` side reads the item's
    // current `name` field (always populated in Monday). No
    // resolver echo since `name` doesn't go through the column
    // translator's date / people paths.
    diff.name = {
      from: itemRead.item.name,
      to: inputs.nameChange,
    };
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
 * Builds a synthetic `TranslatedColumnValue` for a `--name <n>`
 * rename. `selectMutation` then handles bundling uniformly: if it's
 * the only entry → `change_simple_column_value(column_id: "name",
 * value: <n>)`; if there are columns alongside → roll into
 * `change_multiple_column_values` with `name` as a key.
 *
 * **The `name` white lie.** "name" isn't a column on Monday's
 * `board.columns` surface — it's the item's top-level field. We
 * tag the synthetic value with `columnType: 'text'` (closest
 * analog) so `projectForMulti`'s `long_text`-rewrap branch isn't
 * accidentally triggered. The resulting wire shape is correct
 * because Monday's `change_*_column_value` mutations accept
 * `column_id: "name"` with a bare string regardless of which
 * mutation kind is used.
 */
const buildNameTranslatedValue = (
  nameChange: string,
): TranslatedColumnValue => ({
  columnId: 'name',
  columnType: 'text',
  rawInput: nameChange,
  payload: { format: 'simple', value: nameChange },
  resolvedFrom: null,
  peopleResolution: null,
});

export interface PlanClearInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly itemId: string;
  /** The single column token the agent typed (`status`, `id:status_4`). */
  readonly token: string;
  /** Cache root + tz from process.env; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** `--no-cache`: skip the column-metadata cache entirely. */
  readonly noCache?: boolean;
}

/**
 * Single-column clear-mode dry-run. cli-design §4.3 ships `item clear`
 * as a single-column-only verb (no `--where` bulk path; that's
 * `item update`'s territory), so the engine doesn't need a
 * setEntries-style multi-token shape — one token in, one
 * `PlannedChange` out. Reuses the same column-resolution +
 * archived-detection + item-state-read machinery as `planChanges`,
 * routed through `translateColumnClear` for the per-type clear
 * payload.
 *
 * **`from` / `to` shape.** Same `DiffCell` contract as
 * `planChanges` — the `from` side decodes the current Monday cell
 * value (or `null` for empty cells); the `to` side is the wire
 * payload the live mutation would send (`""` for simple types, `{}`
 * for rich types). cli-design §6.4's diff-cell shape is invariant
 * across set / clear.
 */
export const planClear = async (
  inputs: PlanClearInputs,
): Promise<PlanChangesResult> => {
  const warnings: ResolverWarning[] = [];
  const resolution = await resolveColumnWithRefresh({
    client: inputs.client,
    boardId: inputs.boardId,
    token: inputs.token,
    includeArchived: true,
    ...(inputs.env === undefined ? {} : { env: inputs.env }),
    ...(inputs.noCache === undefined ? {} : { noCache: inputs.noCache }),
  });
  warnings.push(...resolution.warnings);

  if (isArchivedColumn(resolution.match.column)) {
    throw foldResolverWarningsIntoError(
      buildColumnArchivedError({
        columnId: resolution.match.column.id,
        columnTitle: resolution.match.column.title,
        columnType: resolution.match.column.type,
        boardId: inputs.boardId,
      }),
      resolution.warnings,
    );
  }

  const translated = translateColumnClear({
    id: resolution.match.column.id,
    type: resolution.match.column.type,
  });

  const itemRead = await fetchItem(inputs.client, inputs.itemId);
  let aggregateSource: 'live' | 'cache' | 'mixed' = mergeSource(
    resolution.source,
    'live',
  );

  if (itemRead.boardId !== null && itemRead.boardId !== inputs.boardId) {
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

  const mutation: SelectedMutation = selectMutation([translated]);
  const operation: PlannedChange['operation'] = mutation.kind;
  const wireTo = projectWireTo(translated, mutation);
  const diffCell = buildDiffCell(
    translated,
    wireTo,
    itemRead.byColumnId.get(translated.columnId),
  );

  const plannedChange: PlannedChange = {
    operation,
    board_id: inputs.boardId,
    item_id: inputs.itemId,
    resolved_ids: { [inputs.token]: resolution.match.column.id },
    diff: { [translated.columnId]: diffCell },
  };
  // Item read is always live; aggregate source folds the resolution's
  // source with `live`. `mergeSource` treats `live + live → live`,
  // `cache + live → mixed`, `mixed → mixed`.
  aggregateSource = mergeSource(aggregateSource, 'live');

  return {
    plannedChanges: [plannedChange],
    source: aggregateSource,
    cacheAgeSeconds: resolution.cacheAgeSeconds,
    warnings,
  };
};

// ============================================================
// planCreate (M9 — `item create` dry-run engine).
// ============================================================

/**
 * Discriminator over the two M9 create shapes (cli-design §6.4
 * "Item-create shape").
 *
 *   - `item` — top-level `create_item`. Resolves columns against
 *     `boardId`. `groupId` / `position` ride into the planned shape's
 *     hoisted slots (`group_id`, `position`).
 *   - `subitem` — `create_subitem`. Resolves columns against
 *     `subitemsBoardId` (the auto-generated subitems board the
 *     command layer derived from the parent's `subtasks` column,
 *     classic-board-only). The planned shape omits `board_id` and
 *     hoists `parent_item_id` instead. `--group` / `--position` are
 *     argv-rejected before reaching here.
 *
 * The hierarchy_type gate (`multi_level` rejection) and the
 * `--relative-to` same-board verification both live in the command
 * layer — `planCreate` runs after those checks pass.
 */
export type CreateMode =
  | {
      readonly kind: 'item';
      readonly boardId: string;
      readonly groupId?: string;
      readonly position?: {
        readonly method: 'before' | 'after';
        readonly relativeTo: string;
      };
    }
  | {
      readonly kind: 'subitem';
      readonly parentItemId: string;
      /**
       * The subitems-board ID the column resolver targets. The
       * command layer derives this from the parent's `subtasks`
       * column's `settings_str.boardIds[0]` (classic-only); when
       * that derivation isn't possible (e.g. parent's board has no
       * `subtasks` column yet, or the settings_str is empty), the
       * command rejects with `usage_error` before reaching
       * planCreate.
       */
      readonly subitemsBoardId: string;
    };

export interface PlanCreateInputs {
  readonly client: MondayClient;
  readonly mode: CreateMode;
  /** The new item's name (validated as non-empty by the command layer). */
  readonly name: string;
  readonly setEntries: readonly SetEntry[];
  readonly rawEntries?: readonly ParsedSetRawExpression[];
  readonly dateResolution?: DateResolutionContext;
  readonly peopleResolution?: PeopleResolutionContext;
  readonly env?: NodeJS.ProcessEnv;
  readonly noCache?: boolean;
}

/**
 * One planned create — cli-design §6.4 "Item-create shape" /
 * "Subitem variant". The shape is intentionally distinct from the
 * column-mutation `PlannedChange`:
 *
 *   - `operation` discriminates `'create_item' | 'create_subitem'`.
 *   - `name`, `group_id`, `position`, `parent_item_id` are
 *     **hoisted** (top-level slots) rather than buried inside `diff`,
 *     mirroring the comment-create shape's preference for agent-
 *     scannable fields.
 *   - `diff[<col>].from` is always `null` (the item doesn't exist
 *     yet; nothing to diff against).
 *
 * Optional slots appear only when their input was supplied:
 *   - `group_id` — only when the agent passed `--group <gid>`
 *     (omitted = Monday assigns the default group server-side).
 *   - `position` — only when both `--position` and `--relative-to`
 *     were supplied. Subitem variant always omits.
 *   - `board_id` — present on `create_item` only; the subitem
 *     variant omits it (the subitems board is derived server-side
 *     from the parent and surfacing it as `board_id` would falsely
 *     imply the agent's `--board` value).
 */
export interface CreatePlannedChange {
  readonly operation: 'create_item' | 'create_subitem';
  readonly board_id?: string;
  readonly name: string;
  readonly group_id?: string;
  readonly position?: {
    readonly method: 'before' | 'after';
    readonly relative_to: string;
  };
  readonly parent_item_id?: string;
  readonly resolved_ids: Readonly<Record<string, string>>;
  readonly diff: Readonly<Record<string, DiffCell>>;
}

export interface PlanCreateResult {
  readonly plannedChanges: readonly CreatePlannedChange[];
  /**
   * Aggregate envelope source: same merge rule as `planChanges`
   * (`live` / `cache` / `mixed`). When `setEntries` and `rawEntries`
   * are both empty, no resolution legs run and `source` is `'none'` —
   * dry-run create with no `--set` flags fires no API calls at all.
   */
  readonly source: 'live' | 'cache' | 'mixed' | 'none';
  readonly cacheAgeSeconds: number | null;
  readonly warnings: readonly ResolverWarning[];
}

/**
 * Resolves every `--set` / `--set-raw` token, translates each value,
 * and assembles a single `CreatePlannedChange`. **No item-state read**
 * — the item doesn't exist yet, so every diff cell's `from` is `null`.
 *
 * **All-or-nothing semantics** (same as `planChanges`). Any resolution
 * failure (`column_not_found` / `ambiguous_column` / `column_archived`
 * / `unsupported_column_type` / `user_not_found` / duplicate token /
 * duplicate resolved id) aborts before any further work.
 *
 * **Diff `to` projection.** The wire shape every Monday create
 * mutation accepts is `column_values: JSON!` — the same map shape
 * `change_multiple_column_values` accepts. So the diff `to` side
 * routes through `bundleColumnValues` for byte-equivalence with the
 * live mutation's wire payload, including the `long_text` re-wrap
 * (`{text: <value>}` inside the map).
 *
 * **No-`--set` path.** Create with neither `--set` nor `--set-raw`
 * is valid (Monday accepts `create_item(item_name: ..., column_values:
 * null)`). The function short-circuits the resolution loop and
 * returns a `CreatePlannedChange` with empty `resolved_ids` and `diff`.
 * `source: 'none'` because no API call fired.
 */
export const planCreate = async (
  inputs: PlanCreateInputs,
): Promise<PlanCreateResult> => {
  const rawEntries: readonly ParsedSetRawExpression[] = inputs.rawEntries ?? [];

  // No-set short-circuit. Returns the create payload without any
  // resolution / translation / API leg. Source is 'none' because
  // nothing fired. The dry-run preview is just "name + placement".
  if (inputs.setEntries.length === 0 && rawEntries.length === 0) {
    return {
      plannedChanges: [buildCreatePlannedChange(inputs, {}, {})],
      source: 'none',
      cacheAgeSeconds: null,
      warnings: [],
    };
  }

  // The board to resolve columns against — top-level `boardId` for
  // `create_item`, `subitemsBoardId` for `create_subitem`.
  const resolveBoardId =
    inputs.mode.kind === 'item' ? inputs.mode.boardId : inputs.mode.subitemsBoardId;

  // Three-pass column resolution + translation per cli-design §5.3
  // — see api/resolution-pass.ts (R20 lift).
  const resolution = await resolveAndTranslate({
    client: inputs.client,
    boardId: resolveBoardId,
    setEntries: inputs.setEntries,
    rawEntries,
    ...(inputs.dateResolution === undefined
      ? {}
      : { dateResolution: inputs.dateResolution }),
    ...(inputs.peopleResolution === undefined
      ? {}
      : { peopleResolution: inputs.peopleResolution }),
    ...(inputs.env === undefined ? {} : { env: inputs.env }),
    ...(inputs.noCache === undefined ? {} : { noCache: inputs.noCache }),
  });
  const orderedTranslated = resolution.translated;

  // Bundle into the column_values map shape `create_item.column_values`
  // accepts. Routing through `bundleColumnValues` keeps the long_text
  // re-wrap consistent with the live mutation's wire payload.
  const bundled = bundleColumnValues(orderedTranslated);

  const diff: Record<string, DiffCell> = {};
  for (const t of orderedTranslated) {
    const wireTo = bundled[t.columnId];
    /* c8 ignore next 4 — defensive: bundleColumnValues maps every
       translated value into the bundle by columnId. */
    if (wireTo === undefined) {
      throw new ApiError('internal_error', 'planCreate: lost bundled entry');
    }
    diff[t.columnId] = buildCreateDiffCell(t, wireTo);
  }

  return {
    plannedChanges: [buildCreatePlannedChange(inputs, resolution.resolvedIds, diff)],
    /* c8 ignore next — defensive: the early-return at the top
       handles the no-set case explicitly, so by this line at least
       one resolution leg has populated `source`. The `?? 'none'`
       keeps the type-narrow tidy without surfacing `undefined`. */
    source: resolution.source ?? 'none',
    cacheAgeSeconds: resolution.cacheAgeSeconds,
    warnings: resolution.warnings,
  };
};

/**
 * Builds the create planned-change envelope per cli-design §6.4
 * "Item-create shape" (and its "Subitem variant" sibling). Optional
 * top-level slots appear only when populated; agents read the shape
 * by switching on `operation` and the presence of the optional keys
 * (`board_id` / `parent_item_id` / `group_id` / `position`).
 *
 * Field order matches the cli-design sample for byte-stable JSON
 * output: `operation`, `board_id?` (item only), `parent_item_id?`
 * (subitem only), `name`, `group_id?`, `position?`, `resolved_ids`,
 * `diff`.
 */
const buildCreatePlannedChange = (
  inputs: PlanCreateInputs,
  resolvedIds: Readonly<Record<string, string>>,
  diff: Readonly<Record<string, DiffCell>>,
): CreatePlannedChange => {
  if (inputs.mode.kind === 'item') {
    const change: {
      operation: 'create_item';
      board_id: string;
      name: string;
      group_id?: string;
      position?: {
        method: 'before' | 'after';
        relative_to: string;
      };
      resolved_ids: Readonly<Record<string, string>>;
      diff: Readonly<Record<string, DiffCell>>;
    } = {
      operation: 'create_item',
      board_id: inputs.mode.boardId,
      name: inputs.name,
    } as {
      operation: 'create_item';
      board_id: string;
      name: string;
      resolved_ids: Readonly<Record<string, string>>;
      diff: Readonly<Record<string, DiffCell>>;
    };
    if (inputs.mode.groupId !== undefined) {
      change.group_id = inputs.mode.groupId;
    }
    if (inputs.mode.position !== undefined) {
      change.position = {
        method: inputs.mode.position.method,
        relative_to: inputs.mode.position.relativeTo,
      };
    }
    change.resolved_ids = resolvedIds;
    change.diff = diff;
    return change;
  }
  // subitem
  const change: {
    operation: 'create_subitem';
    parent_item_id: string;
    name: string;
    resolved_ids: Readonly<Record<string, string>>;
    diff: Readonly<Record<string, DiffCell>>;
  } = {
    operation: 'create_subitem',
    parent_item_id: inputs.mode.parentItemId,
    name: inputs.name,
    resolved_ids: resolvedIds,
    diff,
  };
  return change;
};

/**
 * Builds one diff cell for a create's planned change. `from` is
 * always `null` (item doesn't exist yet); `to` is the bundled wire
 * value. Resolver echoes (`details.resolved_from`) for date / people
 * inputs surface the same way `buildDiffCell` handles them — exclusivity
 * pins the same internal_error guard so a future translator setting
 * both echoes is loud, not silent.
 */
const buildCreateDiffCell = (
  translated: TranslatedColumnValue,
  to: MultiColumnValue,
): DiffCell => {
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
      from: null,
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
      from: null,
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
  return { from: null, to };
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
