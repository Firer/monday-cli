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

import { errorCode } from './errors.js';

/**
 * Returns `true` when `err` is a Node fs error with `code === 'ENOENT'`.
 *
 * v0.3 post-M23 audit (R-NEW-16): refactored from the open-coded
 * type-guard pattern to call the shared {@link errorCode} helper.
 * Behaviour preserved (returns `false` for non-object errors,
 * non-string codes, and missing-code errors); the lift is mechanical.
 */
export const isENOENT = (err: unknown): boolean =>
  errorCode(err) === 'ENOENT';

/**
 * Formats a `stat.mode` numeric field as an octal `'0NNN'` string —
 * the canonical shape for `chmod`-compatible output in security
 * diagnostics + cache-permission refusal messages.
 *
 * v0.3-M22 close R-NEW-7 lift: the same formatter was duplicated
 * character-identical across `src/api/cache.ts` + `src/config/
 * credentials.ts` + `src/api/probes.ts` (M22 cache_writability
 * probe was the third named consumer). Mirrors the R-NEW-1
 * `isENOENT` lift cadence — pure fs-helper, no behaviour change.
 */
export const formatMode = (mode: number): string =>
  `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
