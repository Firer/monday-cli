/**
 * Bulk per-item partial-success path for the v0.3-M25
 * `item update --continue-on-error` flag (`cli-design.md` §6.4
 * "Bulk per-item partial-success" sub-section).
 *
 * **What this module owns.** A thin wrapper around
 * {@link dispatchSequential} from
 * `src/api/partial-success-mutation.ts` that drives the matched-
 * item-ID list through one wire call per item, capturing per-
 * item failures into the result records rather than aborting
 * the loop. The wrapper sits BETWEEN the bulk command-action
 * orchestrator (`src/commands/item/update.ts:runBulk`) and the
 * shared `dispatchSequential` helper — the action body owns the
 * matched-item-walk + column-resolution pre-pass + confirmation
 * gate, then hands the resolved `SelectedMutation` + matched-
 * item IDs to this wrapper, which fans them out + projects the
 * partial-success envelope's `data.results[]` records.
 *
 * **Why a separate module rather than folding into update.ts.**
 * Three reasons:
 *
 *   1. **Single-source-of-truth for the partial-success contract
 *      surface.** M13 `update clear-all`, M14 `workspace
 *      add-users` / `remove-users`, M15 `board add-users`, and
 *      M25 `item update --continue-on-error` all share the
 *      `{<id_field>, ok, error?}` per-record shape backed by
 *      `dispatchSequential`. Keeping M25's wrapper next to its
 *      family in `src/api/` (rather than buried in a command
 *      file) keeps the family discoverable + makes future M27
 *      bulk-write extensions (notification fan-out?) lift
 *      cleanly into the same module.
 *
 *   2. **Action-body size budget.** `src/commands/item/update.ts`
 *      already runs ~1100 LOC carrying both single-item +
 *      v0.1 fail-fast bulk paths; adding the partial-success
 *      branch inline would push it past 1300 and bury the
 *      `dispatchSequential` integration. The action layer
 *      branches on `parsed.continueOnError` and dispatches into
 *      this module's `runPartialSuccessBulkUpdate` instead.
 *
 *   3. **Test surface ergonomics.** Per-item partial-success
 *      tests (mock `client.raw` with a routing predicate that
 *      flips success/failure per item-ID) read cleaner against
 *      the wrapper's seam than against the action body's
 *      branched control flow.
 *
 * **What stays at the action layer.** Argv-parse, column
 * resolution, items_page walk, confirmation gate, dry-run path,
 * source aggregation seed, and the universal-partial-success
 * `ok: true` envelope assembly (via `emitMutation`). The
 * wrapper returns the `data.results[]` array + the per-item
 * source-leg fold; the action body wires that into the
 * envelope it would have emitted on the v0.1 fail-fast bulk
 * path's success branch.
 *
 * **Stub bodies under `c8 ignore start/stop` block-wraps.**
 * M25 pre-flight contract diff (this commit) pins the module
 * signatures + per-item result schema; runtime body lift lands
 * at M25 implementation. The stub rejects with
 * `internal_error.details.hint` pointing at the M25 impl
 * session per the M21 oauth-stub / M24 history-stub precedent
 * (`5c07840` / `bad98ba`).
 *
 * **Per-item dispatch wiring.** At M25 impl, the runtime body
 * loops `dispatchSequential` over `matchedItemIds` with the
 * id-field `'item_id'`. The per-item dispatch callback fires
 * one `executeMutation` call (lifted from
 * `commands/item/update.ts:executeMutation` or shared into
 * `src/api/item-mutation-execute.ts` if the test-double seam
 * demands it). Successes populate `results[i].item` with the
 * `ProjectedItem`; failures land in `results[i].error: {code,
 * message}` via `dispatchSequential`'s built-in error
 * decoration. `internal_error` codes re-throw as whole-call
 * (M14 round-2 F1 precedent — schema-drift in the response
 * MUST NOT be papered over as a per-item failure).
 *
 * **`data.summary.failed_count` invariant.** The action body
 * derives `failed_count` from the result records
 * (`results.filter((r) => !r.ok).length`); the wrapper does
 * NOT compute it directly because the summary slot also
 * carries `matched_count` + `applied_count` + `board_id` —
 * shapes the action body already owns from the walker + the
 * matched-item-walk + the argv. Keeping the summary
 * assembly at the action layer prevents wrapper-vs-action
 * drift on the partial-success contract's per-summary shape.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { projectedItemSchema, type ProjectedItem } from './item-projection.js';
import type { PartialSuccessResult } from './partial-success-mutation.js';
import type { SelectedMutation } from './column-values.js';
import type { MondayClient } from './client.js';
import type { EnvelopeSource } from './source-aggregator.js';

/**
 * Per-item result schema for the partial-success bulk envelope's
 * `data.results[]` slot. Each record carries `item_id` + `ok` +
 * either `item` (on success) or `error` (on failure). The two
 * branches share the discriminator `ok: boolean` — agents read
 * `r.ok ? r.item : r.error` to dispatch on outcome.
 *
 * The `item` slot on success records is the §6.2 `ProjectedItem`
 * shape (same projection single-item `item update` emits as
 * `data`). The `error` slot on failure records carries
 * `{code, message}` populated from
 * `dispatchSequential`'s per-target error decoration.
 *
 * `z.discriminatedUnion` would be the natural shape but
 * `dispatchSequential`'s result records carry a dynamic
 * id-field key (`{item_id: ..., ok, error?}`) — modelling that
 * as a per-record union complicates the schema and downstream
 * consumers' type-narrowing. The flatter shape below carries
 * `item` + `error` as optionals; the action body's projection
 * + the wrapper's per-item dispatch enforce the
 * mutual-exclusion invariant at runtime.
 */
export const partialSuccessBulkUpdateResultSchema = z.object({
  item_id: z.string().min(1),
  ok: z.boolean(),
  item: projectedItemSchema.optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .optional(),
});

export type PartialSuccessBulkUpdateResult = z.infer<
  typeof partialSuccessBulkUpdateResultSchema
>;

/**
 * Output `data` shape for the partial-success bulk envelope.
 * `data.operation` is the literal `"item_update"` (mirrors M14's
 * add-users / remove-users discriminator at `data.operation`;
 * agents switch on it to confirm which verb produced the
 * envelope).
 *
 * `data.summary` extends the v0.1 fail-fast bulk-summary with
 * `failed_count` — items whose per-item dispatch failed under
 * the `--continue-on-error` path. The invariant
 * `matched_count === applied_count + failed_count` holds for
 * every M25 success envelope.
 */
export const partialSuccessBulkUpdateDataSchema = z.object({
  operation: z.literal('item_update'),
  summary: z.object({
    matched_count: z.number().int().nonnegative(),
    applied_count: z.number().int().nonnegative(),
    failed_count: z.number().int().nonnegative(),
    board_id: z.string().min(1),
  }),
  results: z.array(partialSuccessBulkUpdateResultSchema),
});

export type PartialSuccessBulkUpdateData = z.infer<
  typeof partialSuccessBulkUpdateDataSchema
>;

/**
 * Inputs for the partial-success bulk dispatch helper.
 *
 * - `client` — the `MondayClient` (or test-double) the wrapper
 *   calls `client.raw` against. Action layer hands this in
 *   after `resolveClient` has run.
 * - `boardId` — the board the matched items live on. Threaded
 *   through to the per-item `executeMutation` call.
 * - `matchedItemIds` — IDs from the items_page walker; non-
 *   empty (action layer's empty-match branch emits a clean
 *   no-op envelope before reaching this helper).
 * - `mutation` — the pre-resolved `SelectedMutation` (one of
 *   `change_simple_column_value` / `change_column_value` /
 *   `change_multiple_column_values`). Column resolution + the
 *   synthetic-name fold run ONCE at the action layer, BEFORE
 *   the per-item dispatch — this helper sees the resolved
 *   `SelectedMutation` and fans it out.
 * - `createLabelsIfMissing` — Monday's
 *   `change_*_column_value.create_labels_if_missing` flag.
 *   Threaded through to every per-item dispatch.
 *
 * The helper returns `{ results, lastResponse }`. The action
 * layer:
 *   1. derives `failed_count` from `results.filter(r => !r.ok)`,
 *   2. folds the per-item dispatch legs into the
 *      `SourceAggregator` (one `'live'` leg per dispatched
 *      item),
 *   3. assembles the `data.summary` slot with
 *      `matched_count` / `applied_count` / `failed_count` /
 *      `board_id`,
 *   4. emits the partial-success envelope via `emitMutation`,
 *      passing `lastResponse` to `toEmit` for the meta slot
 *      (request_id + api_version come from the last per-item
 *      response — mirrors M14/M15's `lastResponse` capture).
 */
export interface RunPartialSuccessBulkUpdateInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly matchedItemIds: readonly string[];
  readonly mutation: SelectedMutation;
  readonly createLabelsIfMissing: boolean | undefined;
}

/**
 * Result returned by {@link runPartialSuccessBulkUpdate} to the
 * action layer.
 *
 * - `results` — the array of per-item records the helper built
 *   via `dispatchSequential` + the per-item projection
 *   callback. Direct mirror of `data.results[]` in the §6.4
 *   envelope. **Mutable array** so the action layer can pass
 *   it directly to `partialSuccessBulkUpdateDataSchema.parse`
 *   (zod's `z.array(...)` infers a mutable array — wrapping
 *   `readonly` would force a spread at the call site).
 *
 * The action layer folds the dispatch source signal
 * (`'live'` — every Monday mutation counts as a `live` leg
 * per `SourceAggregator`'s precedent) into its own aggregator
 * via `sourceAgg.record('live', null)` — same pattern as the
 * v0.1 fail-fast bulk path's terminal source-leg call. The
 * wrapper does NOT return a separate `dispatchSource` slot
 * because the signal is constant (`'live'`) post-dispatch and
 * folding it at the action layer keeps the wrapper's surface
 * minimal.
 *
 * The wrapper does NOT return the last wire response — mirrors
 * the v0.1 fail-fast bulk path's `emitMutation` call which
 * passes only `apiVersion` (the per-item `request_id`s aren't
 * a useful aggregate signal; the partial-success envelope
 * carries per-item outcomes inside `data.results[]` instead).
 */
export interface RunPartialSuccessBulkUpdateResult {
  readonly results: PartialSuccessBulkUpdateResult[];
}

/**
 * Constant source signal the partial-success bulk dispatch
 * contributes to the action layer's `SourceAggregator`. Always
 * `'live'` post-dispatch — every Monday mutation counts as a
 * `live` leg. Exported so the action layer's
 * `sourceAgg.record(...)` call site reads against a named
 * constant rather than a bare string literal.
 */
export const PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE: EnvelopeSource = 'live';

/**
 * Drives the per-item dispatch loop under `--continue-on-error`.
 * Pre-flight stub — runtime body lands at M25 implementation
 * per the M21 oauth-stub / M24 history-stub precedent.
 *
 * **`Promise.reject` shape** so commander's async-rejection
 * routing surfaces the stub through the runner's envelope
 * mapper (sync throws can be swallowed by commander's own
 * error path — the M20 time-track + M21 oauth + M24 history
 * stub pattern). The hint points at the M25 implementation
 * session so the agent reading the rejection knows the verb
 * is staged for the next milestone close.
 *
 * Runtime body (M25 impl):
 *   1. Loop `dispatchSequential` over `matchedItemIds` with
 *      id-field `'item_id'`.
 *   2. Per-item dispatch callback fires `executeMutation`
 *      (the existing helper or a lifted shared version).
 *   3. On success, capture the `ProjectedItem` into a side
 *      map keyed by `item_id`.
 *   4. After the loop, walk the `dispatchSequential` results
 *      and fold the per-item `ProjectedItem` from the side
 *      map into each `results[i].item` slot. Failure records
 *      already carry `error: {code, message}` via
 *      `dispatchSequential`'s built-in error decoration.
 *   5. Return `{results}` — the action layer folds the
 *      constant `'live'` dispatch source via
 *      `sourceAgg.record(PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE,
 *      null)` and emits the envelope.
 */
/* c8 ignore start */
export const runPartialSuccessBulkUpdate = (
  _inputs: RunPartialSuccessBulkUpdateInputs,
): Promise<RunPartialSuccessBulkUpdateResult> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      '`runPartialSuccessBulkUpdate` is a v0.3-M25 pre-flight stub — runtime partial-success bulk dispatch lands at M25 implementation.',
      {
        details: {
          hint:
            'M25 implementation kickoff (next session) lands the runtime per-item dispatch body via `dispatchSequential` per the docstring spec — id-field "item_id", per-item executeMutation wiring, ProjectedItem side-map fold, and dispatchSource live-leg signal.',
        },
      },
    ),
  );
/* c8 ignore stop */

/**
 * Pure helper — folds a `dispatchSequential` result row + a
 * `ProjectedItem` side-map entry into the partial-success-bulk
 * per-item record shape this module emits to the action layer.
 *
 * The helper is **shipped as a real implementation** (not a
 * stub) so the pre-flight Codex review can verify the
 * projection shape against the contract pinned in cli-design
 * §6.4 inline. M25 implementation reuses the helper unchanged.
 *
 * `record` is the row produced by `dispatchSequential` with
 * id-field `'item_id'` — carries `{item_id, ok, error?}` per
 * the partial-success contract. `projectedItem` is the
 * `ProjectedItem` the per-item dispatch callback captured on
 * success (`undefined` on failure).
 *
 * Returns the per-item shape with `item` populated only when
 * the dispatch succeeded; `error` populated only when it
 * failed. The mutual-exclusion invariant is enforced at the
 * boundary: success records never carry `error`, failure
 * records never carry `item`.
 */
export const foldPartialSuccessBulkResult = (
  record: PartialSuccessResult,
  projectedItem: ProjectedItem | undefined,
): PartialSuccessBulkUpdateResult => {
  // Dot-access: `dispatchSequential` builds the record with
  // the dynamic id-field key (`'item_id'`) carrying the target
  // ID. The dot-access narrows the unknown index-signature
  // value to a string via the runtime guard below; the helper
  // throws `internal_error` if the shape doesn't match (which
  // would be a programmer bug — `dispatchSequential`'s contract
  // is to populate the id-field slot for every result row).
  const itemIdSlot = record.item_id;
  if (typeof itemIdSlot !== 'string' || itemIdSlot.length === 0) {
    throw new ApiError(
      'internal_error',
      'partial-success bulk result row is missing the `item_id` field — dispatchSequential contract violation.',
      {
        details: {
          record_keys: Object.keys(record),
        },
      },
    );
  }
  if (record.ok) {
    if (projectedItem === undefined) {
      throw new ApiError(
        'internal_error',
        `partial-success bulk result row for item_id ${itemIdSlot} reported ok: true but no ProjectedItem was captured — wrapper-layer side-map miss.`,
        {
          details: {
            item_id: itemIdSlot,
          },
        },
      );
    }
    return {
      item_id: itemIdSlot,
      ok: true,
      item: projectedItem,
    };
  }
  // Failure path — `dispatchSequential` populates `error` on
  // every non-`ok` row; the schema's `.optional()` declarations
  // narrow defensively here.
  if (record.error === undefined) {
    throw new ApiError(
      'internal_error',
      `partial-success bulk result row for item_id ${itemIdSlot} reported ok: false but no error payload was captured — dispatchSequential contract violation.`,
      {
        details: {
          item_id: itemIdSlot,
        },
      },
    );
  }
  return {
    item_id: itemIdSlot,
    ok: false,
    error: {
      code: record.error.code,
      message: record.error.message,
    },
  };
};

/**
 * Pure helper — derives the `data.summary` slot from the
 * matched-item count + the per-item results array. The
 * `matched_count === applied_count + failed_count` invariant
 * is enforced here; a mismatch throws `internal_error` since
 * it would indicate a wrapper-layer bug (some matched item
 * neither succeeded nor failed). Shipped as a real
 * implementation so the pre-flight Codex review can verify the
 * shape against cli-design §6.4 inline.
 */
export const buildPartialSuccessBulkSummary = ({
  matchedCount,
  boardId,
  results,
}: {
  readonly matchedCount: number;
  readonly boardId: string;
  readonly results: readonly PartialSuccessBulkUpdateResult[];
}): PartialSuccessBulkUpdateData['summary'] => {
  const appliedCount = results.filter((r) => r.ok).length;
  const failedCount = results.filter((r) => !r.ok).length;
  if (appliedCount + failedCount !== matchedCount) {
    throw new ApiError(
      'internal_error',
      `partial-success bulk summary invariant violated — matched_count (${String(matchedCount)}) !== applied_count (${String(appliedCount)}) + failed_count (${String(failedCount)}).`,
      {
        details: {
          matched_count: matchedCount,
          applied_count: appliedCount,
          failed_count: failedCount,
          board_id: boardId,
        },
      },
    );
  }
  return {
    matched_count: matchedCount,
    applied_count: appliedCount,
    failed_count: failedCount,
    board_id: boardId,
  };
};
