/**
 * Bounded-concurrency per-item dispatch helper for the v0.4-M30
 * `--concurrency <N>` flag extension to `cli-design` §6.4 "Bulk per-
 * item partial-success" (the M25 `item update --continue-on-error`
 * path).
 *
 * **What this module owns.** A bounded-concurrency async-pool variant
 * of `src/api/partial-success-mutation.ts:dispatchSequential` —
 * maintains at most N in-flight per-target dispatch promises at any
 * time, captures per-target failures into the result records exactly
 * the way `dispatchSequential` does. The result array preserves
 * INPUT ORDER (not completion order), so downstream consumers
 * (`src/api/partial-success-bulk.ts:foldPartialSuccessBulkResult`)
 * see the same row sequence regardless of which target completed
 * first. Per-target error decoration + `internal_error` re-throw +
 * non-`MondayCliError` re-throw semantics MUST match
 * `dispatchSequential` exactly so the `--concurrency 1` route
 * (which still threads through this helper at IMPL) is byte-
 * equivalent to the existing sequential path.
 *
 * **Why a separate module.** Three reasons mirroring
 * `src/api/partial-success-bulk.ts`'s carve-out:
 *
 *   1. **Single-source-of-truth for the async-pool pattern.** The
 *      v0.4-M30 IMPL session lands the bounded-concurrency
 *      orchestration in one place; any future bulk verb that
 *      needs parallel dispatch (`item clear --where`, M13 `update
 *      clear-all`, M14 user-fan-out family) imports the same
 *      helper without duplicating the in-flight-counter +
 *      slot-recycling logic.
 *   2. **Test surface ergonomics.** Mocking the async-pool
 *      timing (e.g., asserting "no more than N promises ever
 *      in-flight at any tick") is cleaner at the helper's seam
 *      than against the action body's branched control flow.
 *   3. **Stub-then-IMPL cadence.** Pre-flight ships the type
 *      surface + the stubbed body under `c8 ignore start/stop`
 *      (this commit); IMPL ships the runtime body + the
 *      integration tests against `FixtureTransport` cassettes
 *      that exercise the parallel dispatch matrix.
 *
 * **What stays at the caller layer.** Argv parse, column
 * resolution, items_page walk, confirmation gate, dry-run path,
 * source aggregation seed, envelope assembly. The wrapper
 * returns the per-item result rows; the caller folds them into
 * `data.results[]` via `foldPartialSuccessBulkResult` (unchanged
 * from M25).
 *
 * **Shipped at v0.4-M30 pre-flight (this commit).** Stub body
 * throws `internal_error` with `details.deferred_to:
 * "v0.4-M30 IMPL"` per the M29 stub-then-IMPL precedent. Runtime
 * body lands at M30 IMPL.
 *
 * **Empirical probe finding (2026-05-13, API 2026-01).** Monday's
 * per-account concurrency cap for trivial reads exceeds 100
 * in-flight without triggering `concurrency_exceeded`; the cap
 * value is plan-tier-dependent (cli-design §2.5) and not
 * empirically pinnable from a single account. The
 * {@link MAX_CONCURRENCY} value below (`32`) is a conservative
 * upper bound for the CLI argv — well under any plausible per-
 * account cap while large enough to give meaningful speedup on
 * bulk operations against high-latency Monday endpoints. The
 * existing `src/api/retry.ts` layer already handles
 * `concurrency_exceeded` with exponential backoff per cli-design
 * §2.5; M30 IMPL inherits this without new logic.
 */

import { ApiError } from '../utils/errors.js';
import type {
  PartialSuccessResult,
  DispatchOneTargetInputs,
} from './partial-success-mutation.js';

/**
 * Minimum `--concurrency` argv value. `1` is a valid no-op that
 * routes through this helper but maintains sequential semantics
 * (one in-flight at a time). Lets agents flip the flag without
 * worrying about a `0`-edge case + keeps the byte-equivalence
 * guarantee with the existing `dispatchSequential` path when
 * `--concurrency 1` is passed explicitly.
 */
export const MIN_CONCURRENCY = 1;

/**
 * Maximum `--concurrency` argv value. Conservative upper bound
 * informed by the M30 pre-flight empirical probe
 * (`scripts/probe/m30-concurrency.ts`, 2026-05-13, API 2026-01)
 * which observed no `concurrency_exceeded` at N=100 in-flight
 * `me { id }` reads. `32` leaves substantial headroom under any
 * plausible plan-tier cap while bounding the worst-case
 * connection-pool pressure on Monday's edge.
 */
export const MAX_CONCURRENCY = 32;

/**
 * Default `--concurrency` value when the argv slot is absent.
 * `1` preserves the v0.3-M25 sequential behaviour exactly —
 * agents who haven't migrated to the M30 surface continue to
 * receive byte-identical envelopes.
 */
export const DEFAULT_CONCURRENCY = 1;

/**
 * Bounded-concurrency dispatch over a target list, with per-
 * target error capture into the result records (NOT abort-on-
 * first-error). Maintains at most `concurrency` in-flight
 * dispatch promises at any moment; new targets enter the pool as
 * earlier ones complete. Result array preserves input order.
 *
 * Behavioural invariants (Codex pre-flight audit-point W3 —
 * R-NEW-28 6-axis behavioral-equivalence to dispatchSequential):
 *
 *   1. **Per-target error code semantics** — every code
 *      `dispatchSequential` would surface for the same per-
 *      target failure lands in `results[i].error.code` here.
 *      `MondayCliError`-typed throws land per-record; the
 *      caller's `foldAndRemap` (via the dispatch callback) is
 *      responsible for the `validation_failed` → `column_archived`
 *      stale-cache remap.
 *   2. **`internal_error` re-throw escape hatch** — if a per-
 *      target dispatch throws `MondayCliError` with `code ===
 *      'internal_error'`, the helper re-throws whole-call
 *      (aborts in-flight + propagates) so schema-drift surfaces
 *      as top-level `ok: false` (M14 round-2 F1 / round-3 F1
 *      precedent at `src/api/partial-success-mutation.ts:82`).
 *      Other in-flight calls' results are NOT salvaged — the
 *      contract is "whole-call failure on internal_error" so a
 *      partial `data.results[]` would be misleading.
 *   3. **Non-`MondayCliError` re-throw** — programmer-bug
 *      exceptions (TypeError, RangeError, etc.) propagate
 *      whole-call via the same path as the
 *      `dispatchSequential`'s non-CliError branch.
 *   4. **Empty input** — `targets.length === 0` returns `[]`
 *      synchronously; no dispatch fires. Matches
 *      `dispatchSequential`'s empty-input handling.
 *   5. **Result ordering** — `results[i]` corresponds to
 *      `targets[i]`, regardless of completion order. Caller's
 *      `foldPartialSuccessBulkResult` side-map lookup keys off
 *      `record.item_id` so the side-map captures are order-
 *      independent; the result array's order matters for
 *      downstream UI / table-rendering / agent-side parsing.
 *   6. **AbortSignal threading (M30 IMPL).** When the runtime
 *      receives SIGINT, the in-flight dispatches must abort
 *      cleanly. The pre-flight stub body doesn't take a signal
 *      parameter — IMPL adds the `signal?: AbortSignal` slot
 *      threaded through to the per-target dispatch callback's
 *      `client.raw(..., { signal })` call site.
 *
 * Pre-flight stub body — throws `internal_error` with explicit
 * `details.deferred_to: "v0.4-M30 IMPL"` so the action layer's
 * routing branch surfaces a clear "feature not yet shipped"
 * envelope rather than a cryptic stack trace if invoked before
 * IMPL lands.
 */
/* c8 ignore start */
export const dispatchParallel = <TargetId extends string>(
  targets: readonly TargetId[],
  idField: string,
  dispatch: (inputs: DispatchOneTargetInputs<TargetId>) => Promise<void>,
  concurrency: number,
): Promise<readonly PartialSuccessResult[]> => {
  // Stub body — runtime lands at v0.4-M30 IMPL per the §22 R-class
  // entry. Non-`async` form because the stub throws synchronously
  // (no `await` site under `require-await`); IMPL replaces with the
  // async-pool implementation + an `async` declaration. `void`s
  // suppress `no-unused-vars` on the contract surface.
  void targets;
  void idField;
  void dispatch;
  void concurrency;
  return Promise.reject(
    new ApiError(
      'internal_error',
      'dispatchParallel is a v0.4-M30 pre-flight stub — runtime body lands at M30 IMPL.',
      {
        details: {
          deferred_to: 'v0.4-M30 IMPL',
        },
      },
    ),
  );
};
/* c8 ignore stop */
