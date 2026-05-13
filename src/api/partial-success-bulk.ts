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
 * **Shipped at M25 IMPL (`fe15181`).** Pre-flight contract
 * diff (`d5839a9`) pinned the module signatures + per-item
 * result schema + pure-helper bodies; the M25 IMPL feat fills
 * the runtime body of `runPartialSuccessBulkUpdate` + drops
 * the `c8 ignore start/stop` block-wraps that surrounded both
 * the wrapper body and the action-body routing branch at
 * `src/commands/item/update.ts:runBulk`. The `executeMutation`
 * lift to `src/api/item-mutation-execute.ts` (renamed
 * `executeItemMutation`) shipped ahead at `78889df` (R-NEW-29
 * 3-consumer trigger: single-item + fail-fast bulk + M25
 * partial-success bulk).
 *
 * **v0.4-M30 extension.** Adds the `concurrency` input slot +
 * the routing branch to {@link dispatchParallel} (new module
 * `src/api/parallel-dispatch.ts` — runtime body landed at M30
 * IMPL). When the caller passes `concurrency > 1`, the runtime
 * fans out per-target dispatches via a bounded async-pool;
 * absent or `concurrency === 1` preserves the M25 sequential
 * path verbatim. The per-target dispatch closure is hoisted to
 * a named local so both routes share the same
 * `executeItemMutation` + `foldAndRemap` body — keeps the
 * R-NEW-28 6-axis behavioral-equivalence audit straightforward.
 * The M30 IMPL also threads an optional `signal?: AbortSignal`
 * through both dispatchers (axis-6 scheduler short-circuit).
 *
 * **Per-item dispatch wiring.** Runtime body routes between
 * {@link dispatchSequential} (default — `concurrency` absent /
 * `=== 1`) and {@link dispatchParallel} (v0.4-M30 —
 * `concurrency > 1`) over `matchedItemIds` with id-field
 * `'item_id'`. The per-target dispatch callback (shared between
 * routes verbatim) fires one `executeItemMutation` call.
 * Successes populate `results[i].item` with the `ProjectedItem`
 * via a side-map fold; failures land in
 * `results[i].error: {code, message}` via the dispatcher's
 * built-in error decoration. `internal_error` codes re-throw
 * as whole-call (M14 round-2 F1 precedent — schema-drift in
 * the response MUST NOT be papered over as a per-item failure).
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
import { ApiError, MondayCliError } from '../utils/errors.js';
import { projectedItemSchema, type ProjectedItem } from './item-projection.js';
import {
  dispatchSequential,
  type DispatchOneTargetInputs,
  type PartialSuccessResult,
} from './partial-success-mutation.js';
import { dispatchParallel } from './parallel-dispatch.js';
import { executeItemMutation } from './item-mutation-execute.js';
import { foldAndRemap } from './resolver-error-fold.js';
import type { ResolverWarning } from './columns.js';
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
 *   through to the per-item `executeMutation` call AND to the
 *   per-item `foldAndRemap` archived-column probe.
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
 * **Codex round-1 P1-1 fix.** Per-item failures must inherit
 * the SAME error-code remap the v0.1 fail-fast bulk path
 * applies — a stale-cache `validation_failed` remaps to the
 * stable `column_archived` code agents key off (cli-design
 * §6.5). The wrapper's per-item dispatch callback fires
 * `foldAndRemap` BEFORE throwing into `dispatchSequential` so
 * the per-record `error.code` in `data.results[]` matches the
 * shape the fail-fast path would have surfaced as the
 * top-level `error.code`. That requires the same context the
 * fail-fast remap needs:
 *
 * - `resolverWarnings` — folded into the remapped error's
 *   `details.resolver_warnings` slot. Same shape the fail-fast
 *   path carries via `foldResolverWarningsIntoError`.
 * - `remapColumnIds` — every translated column ID. The remap
 *   probe scans them in order and remaps to the first
 *   archived one. Single-column callers pass a one-element
 *   array; multi-column callers pass every column they tried
 *   to write (Codex M5b finding #3 precedent).
 * - `env` — process env for the `refreshBoardMetadata` cache
 *   call inside the remap probe.
 * - `noCache` — flag pass-through to the remap probe.
 * - `resolutionSource` — `'live' | 'cache' | 'mixed'`. The
 *   remap probe fires ONLY when the original resolution was
 *   cache-sourced; a `live` resolution already saw the live
 *   archived flag, so a `validation_failed` after live
 *   resolution is genuine.
 *
 * The helper returns `{ results }`. The action layer:
 *   1. derives `failed_count` from `results.filter(r => !r.ok)`,
 *   2. folds the dispatch source signal (always `'live'`) into
 *      the `SourceAggregator` via
 *      `sourceAgg.record(PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE,
 *      null)` — exported constant rather than a bare literal,
 *   3. assembles the `data.summary` slot with
 *      `matched_count` / `applied_count` / `failed_count` /
 *      `board_id`,
 *   4. emits the partial-success envelope via `emitMutation`,
 *      passing `apiVersion` only (no `lastResponse` capture —
 *      per-item `request_id`s aren't a useful aggregate
 *      signal; the partial-success envelope carries per-item
 *      outcomes inside `data.results[]` instead).
 */
export interface RunPartialSuccessBulkUpdateInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly matchedItemIds: readonly string[];
  readonly mutation: SelectedMutation;
  readonly createLabelsIfMissing: boolean | undefined;
  readonly resolverWarnings: readonly ResolverWarning[];
  readonly remapColumnIds: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly noCache: boolean;
  readonly resolutionSource: 'live' | 'cache' | 'mixed';
  /**
   * v0.4-M30 `--concurrency <N>` argv slot (cli-design §9.3 +
   * §6.4 "Bulk per-item partial-success — Parallel dispatch").
   * `undefined` or `1` routes through `dispatchSequential`
   * (byte-equivalent to the v0.3-M25 path); `> 1` routes
   * through {@link dispatchParallel} (bounded async-pool).
   * Action layer's argv parser pins the value to
   * `[MIN_CONCURRENCY, MAX_CONCURRENCY]` (1..32) before reaching
   * this helper.
   */
  readonly concurrency: number | undefined;
  /**
   * v0.4-M30 SIGINT / abort threading. When the runner aborts
   * `ctx.signal`, both dispatchers check `signal.aborted` at the
   * iteration / worker-loop boundary and re-throw the signal's
   * reason whole-call (mirrors {@link dispatchParallel} axis-6).
   * In-flight wire calls abort via the existing
   * `MondayClient.signal` configured at construction time
   * (the client threads its signal into every fetch). Optional
   * — omitting it preserves v0.3-M25 behaviour exactly for
   * callers that don't need cooperative abort.
   */
  readonly signal?: AbortSignal;
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
 * The wrapper does NOT return the last wire response — mirrors
 * the v0.1 fail-fast bulk path's `emitMutation` call which
 * passes only `apiVersion` (the per-item `request_id`s aren't
 * a useful aggregate signal; the partial-success envelope
 * carries per-item outcomes inside `data.results[]` instead).
 *
 * The dispatch source signal (always `'live'` post-dispatch
 * — every Monday mutation counts as a `live` leg per
 * `SourceAggregator`'s precedent) is folded into the action
 * layer's `SourceAggregator` via
 * `sourceAgg.record(PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE, null)`
 * rather than returned from the wrapper. The constant is
 * exported for the call site to read against a named symbol
 * rather than a bare string literal.
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
 *
 * Implementation (M25 impl `78889df` refactor + this commit;
 * extended at v0.4-M30 pre-flight with the `concurrency` routing
 * branch):
 *
 *   1. Loop {@link dispatchSequential} (default / M25 path) OR
 *      {@link dispatchParallel} (v0.4-M30 `--concurrency > 1`
 *      path; runtime body landed at M30 IMPL) over
 *      `matchedItemIds` with id-field `'item_id'`.
 *   2. Per-item dispatch callback fires
 *      {@link executeItemMutation} against the resolved
 *      `SelectedMutation`. On a {@link MondayCliError} catch,
 *      run {@link foldAndRemap} with `resolverWarnings` +
 *      `remapColumnIds` + `env` + `noCache` + `resolutionSource`
 *      from the inputs BEFORE re-throwing into
 *      `dispatchSequential`. This makes the per-record
 *      `error.code` in `data.results[]` carry the SAME stable
 *      code (`column_archived` after a stale-cache
 *      `validation_failed` remap) that the v0.1 fail-fast
 *      path would have surfaced at the top level — Codex
 *      round-1 P1-1 contract requirement (cli-design §6.5
 *      stable-code rule applies uniformly across the bulk
 *      fail-modes).
 *   3. On success, capture the `ProjectedItem` into a side
 *      map keyed by `item_id`.
 *   4. After the loop, walk the result rows (from whichever
 *      dispatcher fired — `dispatchSequential` by default;
 *      {@link dispatchParallel} when `concurrency > 1`) and
 *      fold the per-item `ProjectedItem` from the side
 *      map into each `results[i].item` slot via
 *      {@link foldPartialSuccessBulkResult}. Failure records
 *      already carry `error: {code, message}` (with the
 *      foldAndRemap-applied code) via the dispatcher's built-in
 *      error decoration (both routes share the same per-target
 *      error capture contract).
 *   5. Return `{results}` — the action layer folds the
 *      constant `'live'` dispatch source via
 *      `sourceAgg.record(PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE,
 *      null)` and emits the envelope.
 *
 * **`internal_error` re-throw escape hatch.** Per M14 round-2
 * F1 / round-3 F1, `dispatchSequential` re-throws
 * `internal_error` so schema-drift in the response surfaces
 * as whole-call (top-level `ok: false`) rather than per-record
 * — papering over `internal_error` would hide the malformed-
 * response signal agents need to know about. The M25 wrapper
 * inherits this behaviour by NOT wrapping the
 * `dispatchSequential` re-throw — `foldAndRemap` only ever
 * runs against {@link MondayCliError} instances, and it
 * NEVER converts a non-internal_error into internal_error,
 * so the re-throw path through dispatchSequential remains
 * the canonical schema-drift surface.
 *
 * **Non-`MondayCliError` re-throw.** Programmer-bug exceptions
 * (TypeError, RangeError, etc.) raised by the executor or by
 * `foldAndRemap`'s refresh probe propagate through
 * `dispatchSequential`'s non-CliError re-throw branch unchanged,
 * surfacing as whole-call `internal_error` via the runner's
 * catch-all (mirrors M14's pattern at
 * `users-fan-out-mutation.ts` and the documented behaviour at
 * `partial-success-mutation.ts:93`).
 */
export const runPartialSuccessBulkUpdate = async (
  inputs: RunPartialSuccessBulkUpdateInputs,
): Promise<RunPartialSuccessBulkUpdateResult> => {
  const {
    client,
    boardId,
    matchedItemIds,
    mutation,
    createLabelsIfMissing,
    resolverWarnings,
    remapColumnIds,
    env,
    noCache,
    resolutionSource,
    concurrency,
    signal,
  } = inputs;

  const projectedById = new Map<string, ProjectedItem>();

  // Per-target dispatch closure shared between the sequential
  // (v0.3-M25 default) and parallel (v0.4-M30 `--concurrency > 1`)
  // routes. Both dispatch helpers contract on the same
  // {@link DispatchOneTargetInputs}-shaped callback so the closure
  // body is byte-equivalent across routes — only the OUTER call
  // (dispatchSequential vs dispatchParallel) changes. This keeps the
  // R-NEW-28 6-axis behavioral-equivalence audit straightforward:
  // every per-target outcome (success projection capture; `MondayCliError`
  // foldAndRemap + re-throw; non-CliError re-throw) is shared verbatim.
  const perTargetDispatch = async (
    { targetId }: DispatchOneTargetInputs<string>,
  ): Promise<void> => {
    try {
      const result = await executeItemMutation(client, {
        mutation,
        itemId: targetId,
        boardId,
        createLabelsIfMissing,
      });
      projectedById.set(targetId, result.projected);
    } catch (err: unknown) {
      if (err instanceof MondayCliError) {
        // Codex pre-flight round-1 P1-1: thread the remap
        // context through so per-item failures inherit the
        // SAME `validation_failed` → `column_archived`
        // stale-cache remap the v0.1 fail-fast path applies.
        // Without this, archived-column failures would
        // surface as `validation_failed` in `data.results[]`
        // even though the v0.1 path surfaces `column_archived`
        // for the same root cause (cli-design §6.5 stable-
        // code rule). foldAndRemap NEVER converts a non-
        // internal_error into internal_error, so
        // dispatchSequential's internal_error re-throw escape
        // hatch (M14 round-2 F1) stays intact.
        const remapped = await foldAndRemap({
          err,
          warnings: resolverWarnings,
          client,
          boardId,
          columnIds: remapColumnIds,
          env,
          noCache,
          resolutionSource,
        });
        throw remapped;
      }
      // Non-MondayCliError — programmer bug. Re-throw through
      // dispatchSequential / dispatchParallel's non-CliError branch
      // so the runner's catch-all surfaces it as internal_error
      // (whole-call, not per-record). Mirrors users-fan-out-mutation.ts
      // and is the documented partial-success contract.
      throw err;
    }
  };

  // v0.4-M30 routing: `--concurrency <N>` with N > 1 routes through
  // {@link dispatchParallel} (bounded async-pool); absent / N === 1
  // routes through the unchanged {@link dispatchSequential} path.
  // Both dispatchers thread the optional `signal` so SIGINT-aware
  // callers see consistent cooperative abort semantics across routes
  // (R-NEW-28 axis 6).
  let dispatchResults: readonly PartialSuccessResult[];
  if (concurrency !== undefined && concurrency > 1) {
    dispatchResults = await dispatchParallel(
      matchedItemIds,
      'item_id',
      perTargetDispatch,
      concurrency,
      signal,
    );
  } else {
    dispatchResults = await dispatchSequential(
      matchedItemIds,
      'item_id',
      perTargetDispatch,
      signal,
    );
  }

  const results: PartialSuccessBulkUpdateResult[] = dispatchResults.map(
    (row) => {
      // Side-map lookup requires the item_id string from the row;
      // foldPartialSuccessBulkResult also enforces the same
      // invariant + throws internal_error if the id-field is
      // missing or non-string (dispatchSequential contract).
      const itemIdSlot = row.item_id;
      const projected =
        typeof itemIdSlot === 'string'
          ? projectedById.get(itemIdSlot)
          : undefined;
      return foldPartialSuccessBulkResult(row, projected);
    },
  );

  return { results };
};

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
