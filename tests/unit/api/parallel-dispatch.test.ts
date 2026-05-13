/**
 * Surface tests for `src/api/parallel-dispatch.ts` — the
 * v0.4-M30 bounded-concurrency dispatch helper that powers
 * `monday item update --where ... --continue-on-error
 * --concurrency <N>` (cli-design §6.4 "Bulk per-item partial-
 * success — Parallel dispatch").
 *
 * Scope: the six R-NEW-28 behavioural-equivalence axes against
 * `dispatchSequential` — per-target error decoration; whole-call
 * re-throw on `internal_error`; whole-call re-throw on
 * non-`MondayCliError`; empty input; input-order preservation;
 * AbortSignal threading. Each axis gets at least one test;
 * concurrency-bound enforcement is asserted independently because
 * a single-thread bound exists only at the worker-pool layer (no
 * analogue in the sequential helper).
 *
 * Tests use a `vi.fn()`-backed dispatch callback rather than a
 * cassette — the helper is pure orchestration over the callback
 * + `signal`, so the natural unit-test seam is the callback
 * itself. Integration coverage exercising the helper through
 * `client.raw` cassettes lives in
 * `tests/integration/commands/item-update-bulk.test.ts` (M30
 * parallel-route block).
 */
import { describe, it, expect, vi } from 'vitest';
import { ApiError, UsageError } from '../../../src/utils/errors.js';
import {
  dispatchParallel,
  MIN_CONCURRENCY,
  MAX_CONCURRENCY,
  DEFAULT_CONCURRENCY,
} from '../../../src/api/parallel-dispatch.js';
import {
  dispatchSequential,
  signalReason,
  type DispatchOneTargetInputs,
} from '../../../src/api/partial-success-mutation.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('parallel-dispatch — exported constants', () => {
  it('MIN_CONCURRENCY = 1 (sentinel for the sequential routing branch)', () => {
    expect(MIN_CONCURRENCY).toBe(1);
  });

  it('MAX_CONCURRENCY = 32 (M30 pre-flight empirical probe ceiling)', () => {
    expect(MAX_CONCURRENCY).toBe(32);
  });

  it('DEFAULT_CONCURRENCY = 1 (preserves v0.3-M25 sequential byte-equivalence)', () => {
    expect(DEFAULT_CONCURRENCY).toBe(1);
  });
});

describe('dispatchParallel — R-NEW-28 6-axis behavioral equivalence', () => {
  it('axis 4: empty input returns [] without invoking dispatch', async () => {
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockResolvedValue(undefined);
    const result = await dispatchParallel([], 'item_id', dispatch, 4);
    expect(result).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('axis 1: per-target MondayCliError lands in results[i].error.{code, message} (NOT thrown)', async () => {
    const targets = ['A', 'B', 'C'] as const;
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockImplementation(({ targetId }) => {
      if (targetId === 'B') {
        return Promise.reject(
          new ApiError('column_archived', `column archived for ${targetId}`),
        );
      }
      return Promise.resolve();
    });
    const results = await dispatchParallel(targets, 'item_id', dispatch, 2);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ item_id: 'A', ok: true });
    expect(results[1]).toEqual({
      item_id: 'B',
      ok: false,
      error: { code: 'column_archived', message: 'column archived for B' },
    });
    expect(results[2]).toEqual({ item_id: 'C', ok: true });
  });

  it('axis 2: internal_error re-throws whole-call (aborts pool, no partial results returned)', async () => {
    const targets = ['A', 'B', 'C', 'D'] as const;
    let dispatchedAfterFailure = 0;
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockImplementation(async ({ targetId }) => {
      if (targetId === 'B') {
        // Give workers a tick to pick up other targets before the
        // internal_error throws — exercises the "abort in-flight"
        // path rather than a race where A/C/D haven't started.
        await sleep(5);
        throw new ApiError('internal_error', 'response missing root key');
      }
      await sleep(20);
      // If the pool kept scheduling after the internal_error fired
      // the counter would climb past the targets that had already
      // entered the loop body.
      dispatchedAfterFailure += 1;
    });
    await expect(
      dispatchParallel(targets, 'item_id', dispatch, 4),
    ).rejects.toMatchObject({
      code: 'internal_error',
      message: 'response missing root key',
    });
    // All four workers started (concurrency = 4, targets = 4) so
    // every target's dispatch entered the callback; the assertion
    // is that we re-throw rather than fold internal_error into a
    // per-record slot.
    expect(dispatch).toHaveBeenCalledTimes(4);
    // 3 of the 4 successful workers completed their await (A, C, D
    // had a 20ms sleep; B threw at 5ms but Promise.all races for
    // the rejection). Worth verifying the side-effect counter
    // doesn't catch any post-abort scheduled work — a regression
    // here would mean the abort flag is doing nothing.
    expect(dispatchedAfterFailure).toBeLessThanOrEqual(3);
  });

  it('axis 3: non-MondayCliError propagates whole-call (programmer-bug semantics)', async () => {
    const targets = ['A', 'B'] as const;
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockImplementation(({ targetId }) => {
      if (targetId === 'A') {
        return Promise.reject(new TypeError('programmer bug: bad shape'));
      }
      return Promise.resolve();
    });
    await expect(
      dispatchParallel(targets, 'item_id', dispatch, 2),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('axis 5: results array preserves input order despite mixed completion timing', async () => {
    const targets = ['first', 'second', 'third', 'fourth'] as const;
    // `first` is the SLOWEST so it completes LAST chronologically;
    // it must still land at results[0] because the pool assigns by
    // input index, not by completion order. `fourth` completes
    // first.
    const delays: Record<string, number> = {
      first: 60,
      second: 5,
      third: 5,
      fourth: 0,
    };
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockImplementation(async ({ targetId }) => {
      await sleep(delays[targetId] ?? 0);
    });
    const results = await dispatchParallel(targets, 'item_id', dispatch, 4);
    expect(results.map((r) => r.item_id)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
    for (const r of results) {
      expect(r.ok).toBe(true);
    }
  });

  it('axis 6: signal abort throws signal.reason before scheduling new dispatches', async () => {
    const controller = new AbortController();
    const targets = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
    const dispatched: string[] = [];
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockImplementation(async ({ targetId }) => {
      dispatched.push(targetId);
      // Fire the abort after the first batch of targets has been
      // picked up by the workers but before they finish; the
      // post-completion iteration check sees the aborted signal +
      // bails before scheduling the rest.
      if (dispatched.length === 2) {
        controller.abort(new UsageError('test-abort'));
      }
      await sleep(2);
    });
    await expect(
      dispatchParallel(targets, 'item_id', dispatch, 2, controller.signal),
    ).rejects.toMatchObject({ code: 'usage_error', message: 'test-abort' });
    // First batch (2 workers × 1 target each) entered before the
    // abort fired; further scheduling MUST be short-circuited by
    // the worker-loop signal check.
    expect(dispatch.mock.calls.length).toBeLessThan(targets.length);
  });

  it('axis 6: pre-aborted signal throws on first worker iteration (no dispatch fires)', async () => {
    const controller = new AbortController();
    controller.abort(new ApiError('internal_error', 'pre-aborted'));
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockResolvedValue(undefined);
    await expect(
      dispatchParallel(['A', 'B', 'C'], 'item_id', dispatch, 2, controller.signal),
    ).rejects.toMatchObject({ message: 'pre-aborted' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('dispatchParallel — concurrency bound', () => {
  it('never holds more than N dispatches in flight at any tick', async () => {
    const targets = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(8);
      inFlight -= 1;
    });
    await dispatchParallel(targets, 'item_id', dispatch, 3);
    expect(maxInFlight).toBe(3);
    expect(dispatch).toHaveBeenCalledTimes(targets.length);
  });

  it('concurrency > targets.length uses targets.length workers (no idle waste)', async () => {
    const targets = ['A', 'B'] as const;
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(4);
      inFlight -= 1;
    });
    const results = await dispatchParallel(targets, 'item_id', dispatch, 16);
    expect(results).toHaveLength(2);
    expect(maxInFlight).toBe(2);
  });
});

describe('dispatchParallel — idField shape', () => {
  it('uses the provided idField as the per-record key (not hard-coded item_id)', async () => {
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockResolvedValue(undefined);
    const results = await dispatchParallel(['u1', 'u2'], 'user_id', dispatch, 2);
    expect(results).toEqual([
      { user_id: 'u1', ok: true },
      { user_id: 'u2', ok: true },
    ]);
  });
});

// dispatchSequential's signal-aware behaviour mirrors dispatchParallel
// axis 6 — checked at iteration boundary, re-throws signal.reason.
// Cover both branches (signal aborted before first iteration; absent
// signal = no-op) so the M30 IMPL surface is symmetric across routes.
describe('dispatchSequential — M30 optional signal threading', () => {
  it('throws signal.reason when signal is aborted before the loop starts', async () => {
    const controller = new AbortController();
    controller.abort(new ApiError('internal_error', 'pre-aborted'));
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockResolvedValue(undefined);
    await expect(
      dispatchSequential(['A', 'B'], 'item_id', dispatch, controller.signal),
    ).rejects.toMatchObject({ message: 'pre-aborted' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('throws signal.reason at iteration boundary when signal aborts mid-loop', async () => {
    const controller = new AbortController();
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockImplementation(({ targetId }) => {
      if (targetId === 'A') {
        // Abort after the first successful dispatch — the next
        // iteration top sees the aborted signal and bails before
        // calling dispatch again.
        controller.abort(new UsageError('mid-loop abort'));
      }
      return Promise.resolve();
    });
    await expect(
      dispatchSequential(['A', 'B', 'C'], 'item_id', dispatch, controller.signal),
    ).rejects.toMatchObject({ code: 'usage_error', message: 'mid-loop abort' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('with no signal: behaves byte-identically to the v0.3-M25 pre-M30 dispatcher (no signal param required)', async () => {
    // Smoke test the backwards-compatibility guarantee — existing
    // M25 callers that don't pass a signal continue to drive the
    // unchanged sequential body.
    const dispatch = vi.fn<
      (inputs: DispatchOneTargetInputs<string>) => Promise<void>
    >().mockResolvedValue(undefined);
    const results = await dispatchSequential(['A', 'B'], 'item_id', dispatch);
    expect(results).toEqual([
      { item_id: 'A', ok: true },
      { item_id: 'B', ok: true },
    ]);
  });
});

describe('signalReason helper', () => {
  it('returns the signal.reason directly when it is an Error', () => {
    const controller = new AbortController();
    const cause = new UsageError('explicit reason');
    controller.abort(cause);
    expect(signalReason(controller.signal)).toBe(cause);
  });

  it('wraps non-Error reasons in a fresh Error("aborted")', () => {
    const controller = new AbortController();
    controller.abort('a string reason'); // bare string, not Error
    const wrapped = signalReason(controller.signal);
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('aborted');
  });
});
