import { describe, it, expect } from 'vitest';
import { ApiError, type MondayCliError, UsageError } from '../../../src/utils/errors.js';
import { computeBackoffMs, withRetry } from '../../../src/api/retry.js';

const fixedRandom = (n: number): (() => number) => () => n;

describe('computeBackoffMs', () => {
  it('honours retry_after_seconds when set, clamped to maxBackoffMs', () => {
    const err = new ApiError('rate_limited', 'wait', { retryAfterSeconds: 60 });
    expect(
      computeBackoffMs(0, err, {
        baseBackoffMs: 100,
        maxBackoffMs: 5_000,
        random: fixedRandom(0.5),
      }),
    ).toBe(5_000);
  });

  it('exponential growth with deterministic jitter', () => {
    const err = new ApiError('rate_limited', 'try again');
    // jitterFactor = 0.5 + 0.5 = 1.0 → exact 100 * 2^attempt
    const a0 = computeBackoffMs(0, err, {
      baseBackoffMs: 100,
      maxBackoffMs: 30_000,
      random: fixedRandom(0.5),
    });
    const a1 = computeBackoffMs(1, err, {
      baseBackoffMs: 100,
      maxBackoffMs: 30_000,
      random: fixedRandom(0.5),
    });
    const a2 = computeBackoffMs(2, err, {
      baseBackoffMs: 100,
      maxBackoffMs: 30_000,
      random: fixedRandom(0.5),
    });
    expect(a0).toBe(100);
    expect(a1).toBe(200);
    expect(a2).toBe(400);
  });

  it('jitter floor at 0.5, ceiling at <1.5', () => {
    const err = new ApiError('rate_limited', 'try again');
    const lo = computeBackoffMs(2, err, {
      baseBackoffMs: 100,
      maxBackoffMs: 30_000,
      random: fixedRandom(0),
    });
    const hi = computeBackoffMs(2, err, {
      baseBackoffMs: 100,
      maxBackoffMs: 30_000,
      random: fixedRandom(0.999),
    });
    expect(lo).toBe(200); // 400 * 0.5
    expect(hi).toBeCloseTo(400 * 1.499, 0);
  });

  it('caps exponential growth at maxBackoffMs', () => {
    const err = new ApiError('rate_limited', 'try again');
    expect(
      computeBackoffMs(20, err, {
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        random: fixedRandom(0.999),
      }),
    ).toBe(1_000);
  });
});

describe('withRetry', () => {
  const noopSleep = async (
    _ms: number,
    signal: AbortSignal,
  ): Promise<void> => {
    if (signal.aborted) {
      throw new ApiError('internal_error', 'abort during sleep');
    }
    await Promise.resolve();
  };

  const liveSignal = new AbortController().signal;

  it('returns immediately on success', async () => {
    const attempts: number[] = [];
    const result = await withRetry(
      async (n) => {
        attempts.push(n);
        return await Promise.resolve('ok');
      },
      { retries: 3, signal: liveSignal, sleep: noopSleep, random: fixedRandom(0.5) },
    );
    expect(result.value).toBe('ok');
    expect(result.stats.attempts).toBe(1);
    expect(result.stats.totalBackoffMs).toBe(0);
    expect(attempts).toEqual([0]);
  });

  it('retries until success', async () => {
    let n = 0;
    const result = await withRetry(
      async () => {
        n++;
        if (n < 3) {
          throw new ApiError('rate_limited', 'try again');
        }
        return await Promise.resolve('done');
      },
      { retries: 5, signal: liveSignal, sleep: noopSleep, random: fixedRandom(0.5) },
    );
    expect(result.value).toBe('done');
    expect(result.stats.attempts).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new UsageError('bad flag');
          return await Promise.resolve('unreachable');
        },
        { retries: 5, signal: liveSignal, sleep: noopSleep },
      ),
    ).rejects.toBeInstanceOf(UsageError);
    expect(n).toBe(1);
  });

  it('exhausts the budget then re-throws decorated with attempts', async () => {
    let n = 0;
    let caught: MondayCliError | undefined;
    try {
      await withRetry(
        async () => {
          n++;
          throw new ApiError('rate_limited', 'try again', { retryAfterSeconds: 0 });
          return await Promise.resolve(null);
        },
        {
          retries: 3,
          signal: liveSignal,
          sleep: noopSleep,
          random: fixedRandom(0.5),
        },
      );
    } catch (err) {
      caught = err as MondayCliError;
    }
    // Hard regression assertion (`v0.1-plan.md` §3 M2): exactly N
    // total transport attempts for a `retryable: true` failure.
    expect(n).toBe(4); // first call + 3 retries
    expect(caught?.code).toBe('rate_limited');
    expect((caught?.details as { attempts: number }).attempts).toBe(4);
    expect(caught?.cause).toBeDefined();
  });

  it('zero-retry budget runs the thunk exactly once and rethrows', async () => {
    let n = 0;
    let caught: ApiError | undefined;
    try {
      await withRetry(
        async () => {
          n++;
          throw new ApiError('rate_limited', 'no retries here');
          return await Promise.resolve(null);
        },
        { retries: 0, signal: liveSignal, sleep: noopSleep, random: fixedRandom(0.5) },
      );
    } catch (err) {
      caught = err as ApiError;
    }
    expect(n).toBe(1);
    expect(caught?.code).toBe('rate_limited');
    expect((caught?.details as { attempts: number }).attempts).toBe(1);
  });

  it('honours retry_after_seconds in the sleep cycle', async () => {
    const sleeps: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        n++;
        if (n === 1) {
          throw new ApiError('rate_limited', 'wait', { retryAfterSeconds: 7 });
        }
        return await Promise.resolve(true);
      },
      {
        retries: 3,
        signal: liveSignal,
        sleep: async (ms) => {
          sleeps.push(ms);
          await Promise.resolve();
        },
        random: fixedRandom(0.5),
      },
    );
    expect(sleeps).toEqual([7_000]);
  });

  it('aborts immediately if signal is already fired', async () => {
    const ctrl = new AbortController();
    ctrl.abort('cancelled');
    let n = 0;
    let caught: MondayCliError | undefined;
    try {
      await withRetry(
        async () => {
          n++;
          return await Promise.resolve('never');
        },
        { retries: 3, signal: ctrl.signal, sleep: noopSleep },
      );
    } catch (err) {
      caught = err as MondayCliError;
    }
    expect(n).toBe(0);
    expect(caught?.code).toBe('internal_error');
    expect(caught?.details).toMatchObject({ aborted: true });
  });

  it('exercises the default sleep — resolves after the configured delay', async () => {
    let n = 0;
    const t0 = Date.now();
    await withRetry(
      async () => {
        n++;
        if (n === 1) {
          throw new ApiError('rate_limited', 'wait briefly', { retryAfterSeconds: 0 });
        }
        return await Promise.resolve('done');
      },
      {
        retries: 1,
        signal: liveSignal,
        // No `sleep` override — exercises the production timer path
        baseBackoffMs: 50,
        maxBackoffMs: 100,
        random: fixedRandom(0.5),
      },
    );
    // Real timer ran at least once; n should be 2 now.
    expect(n).toBe(2);
    // Quick floor: real timer fired, so some real ms elapsed.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(0);
  });

  it('default sleep rejects when the signal aborts before scheduling', async () => {
    const ctrl = new AbortController();
    ctrl.abort('cancelled');
    let caught: unknown;
    try {
      await withRetry(
        async () => {
          await Promise.resolve();
          throw new ApiError('rate_limited', 'wait briefly', { retryAfterSeconds: 0 });
        },
        {
          retries: 2,
          signal: ctrl.signal,
          baseBackoffMs: 50,
          maxBackoffMs: 100,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
  });

  it('default sleep — abort fires *during* the sleep wait', async () => {
    // Real-timer test: thunk fails, retry layer enters default
    // sleep with backoff 200ms; abort fires at t≈30ms. Drives
    // signalAbortError + the catch-block in the retry loop, both
    // of which the noop-sleep tests above can't reach.
    const ctrl = new AbortController();
    let n = 0;
    let caught: unknown;
    try {
      await withRetry(
        async () => {
          n++;
          if (n === 1) {
            setTimeout(() => { ctrl.abort('mid-sleep'); }, 30);
            throw new ApiError('rate_limited', 'transient');
          }
          return await Promise.resolve('unreachable');
        },
        {
          retries: 3,
          signal: ctrl.signal,
          baseBackoffMs: 200,
          maxBackoffMs: 200,
          random: fixedRandom(0.5),
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'internal_error' });
    expect(n).toBe(1);
  });

  it('default sleep — Error-typed abort reason is surfaced', async () => {
    // Same scenario but the abort reason is an Error — exercises
    // signalAbortError's "instanceof Error" branch.
    const ctrl = new AbortController();
    const reason = new Error('error-reason');
    let caught: unknown;
    try {
      await withRetry(
        async () => {
          await Promise.resolve();
          setTimeout(() => { ctrl.abort(reason); }, 20);
          throw new ApiError('rate_limited', 'transient');
        },
        {
          retries: 3,
          signal: ctrl.signal,
          baseBackoffMs: 200,
          maxBackoffMs: 200,
          random: fixedRandom(0.5),
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'internal_error' });
  });

  it('a custom sleep that throws MondayCliError surfaces unchanged (no double-wrap)', async () => {
    const ctrl = new AbortController();
    let caught: unknown;
    const failingSleep = (): Promise<void> =>
      Promise.reject(new ApiError('timeout', 'sleep timed out'));
    try {
      await withRetry(
        async () => {
          await Promise.resolve();
          throw new ApiError('rate_limited', 'transient', { retryAfterSeconds: 0 });
        },
        {
          retries: 3,
          signal: ctrl.signal,
          baseBackoffMs: 100,
          sleep: failingSleep,
        },
      );
    } catch (err) {
      caught = err;
    }
    // The MondayCliError from the custom sleep flows through without
    // being re-wrapped as wrapAbortAsApiError — line 248 of retry.ts.
    expect(caught).toMatchObject({ code: 'timeout' });
  });

  it('aborts mid-backoff and re-throws an abort error', async () => {
    const ctrl = new AbortController();
    let n = 0;
    let caught: MondayCliError | undefined;
    try {
      await withRetry(
        async () => {
          n++;
          // After the first failure, abort the signal during backoff.
          if (n === 1) {
            queueMicrotask(() => { ctrl.abort('cancelled'); });
            throw new ApiError('rate_limited', 'transient');
          }
          return await Promise.resolve('would-not-reach');
        },
        {
          retries: 3,
          signal: ctrl.signal,
          baseBackoffMs: 100,
          random: fixedRandom(0.5),
        },
      );
    } catch (err) {
      caught = err as MondayCliError;
    }
    expect(caught?.code).toBe('internal_error');
    expect(caught?.details).toMatchObject({ aborted: true });
    expect(n).toBe(1);
  });
});
