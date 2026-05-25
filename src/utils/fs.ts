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

import { chmod, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

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

/**
 * Atomically writes `payload` to `fullPath` with restrictive
 * permissions. The canonical secure-file write used by every module
 * that persists a token-adjacent or cache artefact to disk:
 *
 *   1. Write to a unique tmp sibling (`${fullPath}.<uuid>.tmp`) with
 *      the requested `mode`.
 *   2. `chmod` the tmp file to `mode` — `writeFile`'s `mode` is only
 *      advisory under umask on some platforms, so re-applying it is
 *      what actually guarantees the file is never left group/world
 *      readable.
 *   3. `rename` over the final path — atomic on the same filesystem,
 *      so a reader never observes a half-written file.
 *
 * On any failure the tmp file is best-effort unlinked so a half-
 * written `.tmp` doesn't accumulate, then the caller-supplied
 * {@link AtomicWriteParams.wrapError} maps the raw error to the
 * module's typed error (`CacheError` / `ConfigError`).
 *
 * The caller owns directory preparation — the secure-dir `mkdir` +
 * `chmod 0o700` stays at each call site because the dir shape (root
 * vs nested, cache vs config) and its error wrapper differ. This
 * helper is only the write-then-rename leg they all share.
 *
 * v0.12 R-v0.12-NEW-9 lift: consolidates the byte-identical pattern
 * previously inlined at `cache.ts` (`writeEntry`),
 * `credentials.ts` (`writeCredentials`), `dev-conventions.ts`
 * (`saveDevMapping`), and `profiles.ts` (`writeProfilesConfig`).
 */
export interface AtomicWriteParams {
  readonly fullPath: string;
  readonly payload: string;
  readonly mode: number;
  /**
   * Maps the raw write/rename failure to the module's typed error.
   * Invoked only on the failure path (after the best-effort tmp
   * cleanup). The catch variable is `unknown`; wrappers narrow it
   * themselves (most via the shared `asError`).
   */
  readonly wrapError: (err: unknown) => Error;
}

export const atomicWriteSecureFile = async ({
  fullPath,
  payload,
  mode,
  wrapError,
}: AtomicWriteParams): Promise<void> => {
  const tmpPath = `${fullPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, payload, { mode });
    await chmod(tmpPath, mode);
    await rename(tmpPath, fullPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw wrapError(err);
  }
};
