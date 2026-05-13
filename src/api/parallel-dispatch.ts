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
 * `dispatchSequential` exactly. Note: `--concurrency 1` does NOT
 * route through this helper — the partial-success-bulk wrapper
 * routes `concurrency === undefined || concurrency === 1` to
 * `dispatchSequential` and only `concurrency > 1` to
 * `dispatchParallel`. The byte-equivalence guarantee at N=1 holds
 * by construction (the sequential path is unchanged from v0.3-M25).
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
 *   3. **Stub-then-IMPL cadence.** Pre-flight (cluster
 *      `8cfd96b..0ca9418`) shipped the type surface + the
 *      stubbed body under `c8 ignore start/stop`; IMPL
 *      (`8faf20e`) landed the runtime body + the integration
 *      tests against `FixtureTransport` cassettes that exercise
 *      the parallel dispatch matrix.
 *
 * **What stays at the caller layer.** Argv parse, column
 * resolution, items_page walk, confirmation gate, dry-run path,
 * source aggregation seed, envelope assembly. The wrapper
 * returns the per-item result rows; the caller folds them into
 * `data.results[]` via `foldPartialSuccessBulkResult` (unchanged
 * from M25).
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

import { MondayCliError } from '../utils/errors.js';
import { extractSignalReason } from '../utils/signal.js';
import type {
  PartialSuccessResult,
  DispatchOneTargetInputs,
} from './partial-success-mutation.js';

/**
 * Minimum `--concurrency` argv value. `1` is a valid no-op:
 * `partial-success-bulk.ts`'s routing branch sends
 * `concurrency === 1` (and `undefined`) to `dispatchSequential`,
 * NOT to this helper, so the byte-equivalence guarantee with the
 * existing v0.3-M25 sequential path at N=1 holds by construction.
 * Letting agents pass `1` explicitly lets them flip the flag
 * without worrying about a `0`-edge case.
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
 *      (aborts the pool/scheduler and propagates) so schema-
 *      drift surfaces as top-level `ok: false` (M14 round-2 F1 /
 *      round-3 F1 precedent at
 *      `src/api/partial-success-mutation.ts`'s
 *      `dispatchSequential`). Other in-flight calls' results
 *      are NOT salvaged — the contract is "whole-call failure
 *      on internal_error" so a partial `data.results[]` would
 *      be misleading. The pool sets an internal `aborted` flag
 *      so workers stop pulling new targets; in-flight dispatches
 *      complete on their own in the background but their writes
 *      never reach the caller because `Promise.all` rejection
 *      surfaces the original error first.
 *   3. **Non-`MondayCliError` re-throw** — programmer-bug
 *      exceptions (TypeError, RangeError, etc.) propagate
 *      whole-call via the same path as the
 *      `dispatchSequential`'s non-CliError branch. Same
 *      `aborted` flag mechanism prevents new dispatches.
 *   4. **Empty input** — `targets.length === 0` returns `[]`
 *      synchronously (after the leading await tick); no
 *      dispatch fires. Matches `dispatchSequential`'s empty-
 *      input handling.
 *   5. **Result ordering** — `results[i]` corresponds to
 *      `targets[i]`, regardless of completion order. Workers
 *      pull from a shared `cursor` to pick the next target's
 *      index, then assign the result by that index — never
 *      `push()`. A late-completing first target still lands at
 *      `results[0]`.
 *   6. **AbortSignal threading.** The optional `signal`
 *      parameter is checked at every worker-loop iteration top.
 *      When `signal.aborted` becomes true, the worker re-throws
 *      `signal.reason` (via `extractSignalReason` from
 *      `src/utils/signal.ts`); the `aborted` flag stops other
 *      workers from scheduling NEW dispatches.
 *      In-flight wire calls abort via the existing
 *      `MondayClient.signal` configured at construction time
 *      (the client threads its signal into every fetch) — the
 *      pool-level check is the scheduler short-circuit, not the
 *      wire-call cancellation source. Mirrors
 *      `dispatchSequential`'s axis-6 signal check at the
 *      iteration boundary.
 */
export const dispatchParallel = async <TargetId extends string>(
  targets: readonly TargetId[],
  idField: string,
  dispatch: (inputs: DispatchOneTargetInputs<TargetId>) => Promise<void>,
  concurrency: number,
  signal?: AbortSignal,
): Promise<readonly PartialSuccessResult[]> => {
  if (targets.length === 0) {
    return [];
  }

  // Pre-allocated result array indexed by input position. Workers
  // assign by index (NOT push) so completion order can't reorder
  // results — axis 5 of the R-NEW-28 audit.
  const results: PartialSuccessResult[] = new Array<PartialSuccessResult>(
    targets.length,
  );

  // Shared cursor across workers. Each worker reads the current
  // value into `i`, increments, then dispatches `targets[i]`. The
  // read-then-increment is safe in single-threaded JS — the worker
  // is between awaits when it touches the cursor.
  let cursor = 0;

  // Whole-call abort flag. Set when a worker hits `internal_error`,
  // a non-`MondayCliError` throw, or the signal aborting. Other
  // workers see the flag at their next iteration top and return
  // immediately without scheduling new dispatches. In-flight
  // dispatches complete (or fail) on their own; their results
  // never reach the caller because Promise.all rejects on the
  // worker that threw.
  let aborted = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted) {
        return;
      }
      if (signal?.aborted === true) {
        aborted = true;
        throw extractSignalReason(signal);
      }
      const i = cursor;
      cursor += 1;
      // `noUncheckedIndexedAccess` is on — read once + narrow rather
      // than a separate length check + non-null assertion, which
      // tripped both `@typescript-eslint/non-nullable-type-assertion-style`
      // and `no-non-null-assertion` depending on the form.
      const targetId = targets[i];
      if (targetId === undefined) {
        return;
      }
      try {
        await dispatch({ targetId });
        results[i] = {
          [idField]: targetId,
          ok: true,
        };
      } catch (err: unknown) {
        if (err instanceof MondayCliError) {
          // Mirror `dispatchSequential`'s axis-2 escape hatch:
          // `internal_error` re-throws whole-call so schema-
          // drift surfaces as top-level `ok: false` rather than
          // being papered over as a per-record slot. The aborted
          // flag prevents other workers from scheduling new
          // dispatches once we throw.
          if (err.code === 'internal_error') {
            aborted = true;
            throw err;
          }
          results[i] = {
            [idField]: targetId,
            ok: false,
            error: { code: err.code, message: err.message },
          };
          continue;
        }
        // Non-MondayCliError — programmer bug. Mirrors
        // `dispatchSequential`'s axis-3 non-CliError re-throw;
        // runner's catch-all surfaces as `internal_error`.
        aborted = true;
        throw err;
      }
    }
  };

  // Spin up `min(concurrency, targets.length)` workers. Extra
  // workers beyond the target count would immediately exit the
  // loop (cursor >= targets.length on first iteration), so they
  // add no value — bounding here keeps the Promise.all shape
  // tight + makes the "N=8 against 4 targets" edge-case
  // deterministic (4 workers, not 8).
  const workerCount = Math.min(concurrency, targets.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
};
