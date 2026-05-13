/**
 * AbortSignal utilities shared across dispatchers + streaming verbs
 * (R-NEW-55).
 *
 * Three consumers today share the "extract `signal.reason` as an
 * Error, fall back to a fresh `Error('aborted')`" pattern:
 *
 *   1. `src/api/partial-success-mutation.ts:dispatchSequential` —
 *      iteration-boundary signal check; re-throws the reason
 *      whole-call.
 *   2. `src/api/parallel-dispatch.ts:dispatchParallel` — worker-
 *      loop signal check; re-throws + sets the pool's `aborted`
 *      flag so other workers stop scheduling new dispatches.
 *   3. `src/api/item-watch.ts:sleepWithSignal` — both the
 *      race-window guard (sync `signal.aborted` check before
 *      listener registration) and the abort-listener path
 *      reject the sleep promise with the extracted reason.
 *
 * `src/api/retry.ts:signalAbortError` is semantically adjacent but
 * DELIBERATELY divergent: retry.ts assigns `name = 'AbortError'` to
 * match the Web Platform's DOMException-style surface so callers
 * can branch on `err.name === 'AbortError'`. Stays inline to
 * preserve the DOMException naming. {@link extractSignalReason}
 * below matches the dispatcher / sleep-helper semantics (no
 * `AbortError` rename); retry.ts carries its own naming-preserving
 * variant.
 */

/**
 * Reads `signal.reason` and returns it as an `Error` instance the
 * caller can `throw` directly. When the abort reason is already an
 * `Error`, return it verbatim — preserves cause chains, error
 * classes (`UsageError`, `ApiError`, etc.), and any
 * caller-attached details. When the reason is anything else (a
 * bare string, `undefined`, a non-Error object), wrap in a fresh
 * `Error('aborted')` so the caller always has a throwable shape.
 *
 * Used by `dispatchSequential` + `dispatchParallel` (iteration /
 * worker-loop signal check) and `sleepWithSignal` (race-window
 * abort + listener-fired abort).
 */
export const extractSignalReason = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('aborted');
};
