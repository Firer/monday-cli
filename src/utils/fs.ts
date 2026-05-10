/**
 * Filesystem helpers shared across modules that talk to `node:fs`.
 *
 * v0.3-M21 Part 2 R-NEW-1: the 5-line `isENOENT` helper was duplicated
 * verbatim in `src/api/cache.ts`, `src/config/credentials.ts`, and
 * `src/config/profiles.ts`. The 3-consumer trigger fires at M21 close
 * (mirrors R45 / R48 / R51 cadence — "lift when a third consumer
 * lands"). Pure boilerplate consolidation; no behaviour change.
 *
 * Kept narrow on purpose. New filesystem-shaped helpers (e.g., a
 * shared `wrapFsError` factory in R-NEW-3) land here only when their
 * own consumer-count thresholds fire.
 */

/**
 * Returns `true` when `err` is a Node fs error with `code === 'ENOENT'`.
 *
 * The non-object guard is `c8 ignore`d because in practice every
 * `fs/promises` rejection wraps a real `Error` — but the guard exists
 * to keep the function strict-typed (`err: unknown`) for callers that
 * pass `catch (err)` directly.
 */
export const isENOENT = (err: unknown): boolean => {
  /* c8 ignore next 3 — non-object errors don't reach this guard via
     fs/promises (every promise rejection wraps a real Error). */
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  return (err as { code?: unknown }).code === 'ENOENT';
};
