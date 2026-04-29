/**
 * Retry layer for the Monday API client (`v0.1-plan.md` §3 M2,
 * `cli-design.md` §2.5 retry behaviour).
 *
 * `withRetry(thunk, options)` invokes `thunk` until it returns
 * successfully, the abort signal fires, or the retry budget is
 * exhausted. Failures are inspected via the typed `MondayCliError`
 * shape:
 *
 *  - `error.retryable === false` → re-throw immediately.
 *  - `error.retryAfterSeconds` set → sleep that long (clamped to
 *    `maxBackoffMs`) before the next attempt.
 *  - Otherwise → exponential backoff with jitter, doubling per
 *    attempt up to `maxBackoffMs`.
 *
 * The retry count is exposed on `RetryStats` so the caller can
 * surface attempt totals in `--verbose` output and so a regression
 * test can assert "exactly N attempts for a `retryable: true`
 * failure". The latter catches any future SDK update that
 * re-introduces an internal retry layer (`v0.1-plan.md` risk
 * register: "SDK retry double-counting"). Today's SDK
 * (`graphql-request@6.1.0`) has no built-in retry — we still bake
 * the assertion in so it stays true.
 *
 * The thunk receives the current `attempt` (0-indexed) so the API
 * client can include it in debug logs / fixture matchers (e.g. a
 * cassette can assert the second attempt sees the same headers).
 */

import { ApiError, MondayCliError } from '../utils/errors.js';

export interface RetryOptions {
  /**
   * Maximum number of *retries* — i.e. additional attempts after the
   * first call. A value of `3` means up to 4 total transport calls.
   * Comes from `--retry` (default 3).
   */
  readonly retries: number;
  /**
   * Caps the backoff we'll wait between attempts. Honoured even when
   * `retry_after_seconds` requests longer; the design avoids a
   * runaway 60s sleep on a single retry by clamping to the cap and
   * returning the next failure faster.
   */
  readonly maxBackoffMs?: number;
  /** Initial backoff — doubled per attempt, jittered. Default 200ms. */
  readonly baseBackoffMs?: number;
  /**
   * Source of randomness for the jitter. Tests pass a deterministic
   * value (`() => 0.5`) so the sleep schedule is reproducible.
   */
  readonly random?: () => number;
  /**
   * Sleep implementation. Tests pass a fast / instant impl
   * (`(ms) => Promise.resolve()`) so the retry cycle doesn't spend
   * real wall-clock seconds.
   */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Cancellation source. When the signal fires mid-backoff, the
   * outstanding sleep rejects and the retry loop bails — `withRetry`
   * surfaces the underlying `MondayCliError` (or a synthetic abort
   * one) without making another attempt.
   */
  readonly signal: AbortSignal;
}

export interface RetryStats {
  /**
   * Total number of times the thunk was invoked. `1` means the first
   * call succeeded; `>= 2` means at least one retry was applied.
   */
  readonly attempts: number;
  /**
   * Cumulative milliseconds spent sleeping between attempts. Useful
   * for the `--verbose` complexity hint and for diagnosing slow
   * retries in production.
   */
  readonly totalBackoffMs: number;
}

export interface RetryResult<T> {
  readonly value: T;
  readonly stats: RetryStats;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signalAbortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signalAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

const signalAbortError = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  // Match Web Platform behaviour: a DOMException-style AbortError
  // surface so callers can `.name === 'AbortError'` if they want.
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
};

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

/**
 * Computes the delay before the next attempt. Honours
 * `retry_after_seconds` when present (clamped to `maxBackoffMs`),
 * otherwise grows exponentially: `baseBackoffMs * 2 ** attempt` with
 * ±50% jitter.
 *
 * Exported so the unit suite can snapshot the curve and so a future
 * caller-side decorator (e.g. a CI runner that wants to log "next
 * attempt in N ms") can reuse the same algorithm.
 */
export const computeBackoffMs = (
  attempt: number,
  err: MondayCliError,
  opts: {
    readonly baseBackoffMs: number;
    readonly maxBackoffMs: number;
    readonly random: () => number;
  },
): number => {
  if (err.retryAfterSeconds !== undefined) {
    return clamp(err.retryAfterSeconds * 1000, 0, opts.maxBackoffMs);
  }
  // Exponential backoff: base * 2^attempt, ±50% jitter so simultaneous
  // clients don't synchronise.
  const exp = opts.baseBackoffMs * 2 ** attempt;
  const jitterFactor = 0.5 + opts.random(); // [0.5, 1.5)
  return clamp(exp * jitterFactor, 0, opts.maxBackoffMs);
};

const isRetryable = (err: unknown): err is MondayCliError =>
  err instanceof MondayCliError && err.retryable;

const wrapAbortAsApiError = (signal: AbortSignal, attempt: number): ApiError => {
  // The runner attaches a tagged reason; preserve it so callers can
  // distinguish SIGINT from timeout. We don't *map* SIGINT to a code
  // here — the runner short-circuits before any envelope is emitted —
  // but a test that drives an explicit cancel still gets a typed
  // throwable.
  const reason: unknown = signal.reason;
  const cause: unknown = reason;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : `aborted after ${String(attempt)} attempt${attempt === 1 ? '' : 's'}`;
  return new ApiError('internal_error', message, {
    cause,
    details: { aborted: true, attempts: attempt },
  });
};

/**
 * Calls `thunk` until it succeeds or the budget is exhausted.
 *
 * Throwing semantics:
 *  - On final success: returns `{ value, stats }`.
 *  - On a non-retryable error: rethrows the original error.
 *  - On a retryable error after budget exhaustion: rethrows the
 *    *last* error with `details.attempts` set to the total count, so
 *    agents can see how many times the CLI tried.
 *  - On abort (signal fired): rethrows an `ApiError(internal_error)`
 *    tagged `aborted: true` (the runner inspects `signal.reason` and
 *    decides 130 vs 2). Throwing here keeps the flow uniform — the
 *    caller doesn't have to special-case mid-sleep cancellation.
 */
export const withRetry = async <T>(
  thunk: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> => {
  const baseBackoffMs = options.baseBackoffMs ?? 200;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const { signal, retries } = options;

  // Read `signal.aborted` via a helper so the TS narrowing on the
  // initial check at top-of-loop doesn't lock the type into `false`
  // — the runtime value can flip between attempts when the thunk's
  // own abort fires the signal mid-call.
  const isAborted = (): boolean => signal.aborted;

  let totalBackoffMs = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (isAborted()) {
      throw wrapAbortAsApiError(signal, attempt);
    }
    try {
      const value = await thunk(attempt);
      return { value, stats: { attempts: attempt + 1, totalBackoffMs } };
    } catch (err) {
      if (isAborted()) {
        throw wrapAbortAsApiError(signal, attempt + 1);
      }
      if (!isRetryable(err)) {
        throw err;
      }
      if (attempt === retries) {
        // Decorate the final error with the attempt count so the
        // envelope carries it without losing the original code.
        const decorated = new ApiError(err.code, err.message, {
          cause: err.cause ?? err,
          ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }),
          ...(err.mondayCode === undefined ? {} : { mondayCode: err.mondayCode }),
          ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
          retryable: err.retryable,
          ...(err.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: err.retryAfterSeconds }),
          details: {
            ...(err.details ?? {}),
            attempts: attempt + 1,
          },
        });
        throw decorated;
      }
      const backoffMs = computeBackoffMs(attempt, err, {
        baseBackoffMs,
        maxBackoffMs,
        random,
      });
      totalBackoffMs += backoffMs;
      try {
        await sleep(backoffMs, signal);
      } catch (sleepErr) {
        // Cancelled mid-backoff — the signal fired during the wait.
        // Surface the abort so the runner / caller can decide on
        // exit code rather than continuing the loop.
        if (sleepErr instanceof MondayCliError) {
          throw sleepErr;
        }
        throw wrapAbortAsApiError(signal, attempt + 1);
      }
    }
  }
  // Unreachable — the loop returns or throws; the type checker still
  // wants a guarantee.
  /* c8 ignore next */
  throw new ApiError('internal_error', 'retry loop fell through');
};
