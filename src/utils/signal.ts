/**
 * AbortSignal utilities shared across dispatchers + streaming verbs.
 *
 * Lift trigger (v0.4-M30 IMPL post-Codex round 1 P3-1; R-NEW-55 in
 * v0.4-plan §22). Three consumers of the same "extract `signal.
 * reason` as an Error, fallback to a fresh `Error('aborted')`" pattern
 * surfaced at M30 IMPL:
 *
 *   1. `src/api/item-watch.ts:sleepWithSignal` (M29) — inlines the
 *      pattern inside the promise constructor + the abort listener.
 *   2. `src/api/partial-success-mutation.ts:signalReason` (M30 IMPL)
 *      — re-exported helper used by `dispatchSequential` +
 *      `dispatchParallel`.
 *   3. `src/api/retry.ts:signalAbortError` (M2) — semantically
 *      adjacent but DELIBERATELY divergent: retry.ts assigns
 *      `name = 'AbortError'` to match the Web Platform's
 *      DOMException-style surface so callers can branch on
 *      `err.name === 'AbortError'`. Stays inline to preserve the
 *      DOMException naming.
 *
 * The lifted helper here matches the M29 / M30 semantics (no
 * `AbortError` rename); retry.ts continues to carry its own
 * naming-preserving variant.
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
