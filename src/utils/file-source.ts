/**
 * Local-file pre-check + Blob-construction shared helpers for the
 * multipart-upload surfaces. Lifted at v0.6-M38 IMPL kickoff per
 * R-v0.6-NEW-1 (3-consumer trigger fires at IMPL: v0.4-M31's `monday
 * item upload` action body + v0.4-M31's `monday update upload` action
 * body + v0.6-M38's `executeFileColumnSet` runtime body). Mirrors
 * R-NEW-29's M25 lift-ahead-of-feat cadence (extract the shared
 * pattern BEFORE the feat commit that crystallizes the 3rd consumer
 * so the feat diff stays focused on the behavioural change).
 *
 * **Two helpers, distinct fire points** — the M31 / M38 callers run
 * the pre-check BEFORE `resolveClient` so a missing/unreadable-file
 * error surfaces as `usage_error` (exit 1) rather than getting
 * tangled up with `config_error` (exit 3) on a token miss; the Blob
 * construction fires AFTER column-type validation so a non-`file`
 * column rejection or an `item update` mutex rejection doesn't pay
 * for the full read:
 *
 *   1. {@link precheckLocalFile} — `fs.stat()` + `fs.access(R_OK)` +
 *      non-empty check. Surfaces `usage_error` with `details.reason:
 *      'file_not_readable'` (ENOENT / EACCES / path is a directory)
 *      or `'file_empty'` (zero bytes).
 *   2. {@link buildBlobFromPath} — `fs/promises.readFile()` + Web
 *      `Blob` construction with the sniffed `Content-Type` from
 *      `sniffContentType(...)`. No additional error surfaces — read
 *      failures past the pre-check are TOCTOU-class (file removed
 *      between pre-check and read) and surface via the caller's
 *      catch-all.
 *
 * **Behaviour-preserving lift.** Byte-equivalent to the M31 inline
 * copies the lift consolidates — same `usage_error` message prose,
 * same `details.reason` discriminator + `errno_code` slot + hint
 * text, same path resolution (`resolve(process.cwd(), rawPath)`)
 * and basename (`basename(filePath)`). Integration tests for the
 * 2 M31 consumers cover the pre-check error branches; this module
 * adds direct unit tests for the helper + the buildBlobFromPath
 * sibling.
 */

import { stat as fsStat, access as fsAccess, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve as resolvePath, basename } from 'node:path';
import { UsageError, asError, errorCode } from './errors.js';
import { sniffContentType } from './mime.js';

/**
 * Result of a successful {@link precheckLocalFile} call. Carries the
 * resolved absolute path (post `resolve(cwd, rawPath)`), the
 * basename (Monday's wire `Asset.name` source), and the `fs.stat()`
 * size in bytes.
 */
export interface LocalFilePrecheck {
  /** Resolved absolute path. */
  readonly filePath: string;
  /** `basename(filePath)` — Monday's wire `Asset.name` source. */
  readonly filename: string;
  /** Local `fs.stat()` size in bytes (always `>= 1` post-check). */
  readonly fileSizeBytes: number;
}

/**
 * Resolves `rawPath` relative to `process.cwd()` and confirms the
 * file is (a) a regular file (not a directory / socket / device),
 * (b) readable by the current user, and (c) non-empty. Throws
 * {@link UsageError} on any check failure with a `details.reason`
 * discriminator:
 *
 *   - `'file_not_readable'` — `ENOENT` / `EACCES` / path resolves
 *     to a directory or special file. `details.errno_code` echoes
 *     the underlying errno when one was attached to the Node fs
 *     error.
 *   - `'file_empty'` — file exists and is readable but has zero
 *     bytes. Monday rejects empty uploads server-side; the CLI
 *     surfaces the rejection with a clearer hint via the local
 *     pre-check.
 *
 * The Web `Blob` construction for the actual upload payload happens
 * later via {@link buildBlobFromPath} — callers run the pre-check
 * BEFORE the wire dispatch so a bad path doesn't burn a network
 * round-trip, and run the Blob construction AFTER any column-type
 * / mutex validation so a non-`file` column rejection doesn't pay
 * for the full read.
 */
export const precheckLocalFile = async (
  rawPath: string,
): Promise<LocalFilePrecheck> => {
  const filePath = resolvePath(process.cwd(), rawPath);
  const filename = basename(filePath);
  let fileSizeBytes: number;
  try {
    const stats = await fsStat(filePath);
    if (!stats.isFile()) {
      throw new UsageError(
        `<file> ${JSON.stringify(rawPath)} is not a regular file ` +
          `(resolved to ${JSON.stringify(filePath)}).`,
        {
          details: {
            reason: 'file_not_readable',
            file_path: filePath,
            hint:
              'pass a path to a regular readable file; directories ' +
              'and special files (sockets, devices) are rejected.',
          },
        },
      );
    }
    await fsAccess(filePath, fsConstants.R_OK);
    fileSizeBytes = stats.size;
  } catch (err) {
    if (err instanceof UsageError) {
      throw err;
    }
    const code = errorCode(err);
    throw new UsageError(
      `<file> ${JSON.stringify(rawPath)} cannot be read ` +
        `(resolved to ${JSON.stringify(filePath)}): ` +
        `${asError(err).message}.`,
      {
        cause: err,
        details: {
          reason: 'file_not_readable',
          file_path: filePath,
          ...(code === undefined ? {} : { errno_code: code }),
          hint:
            'check that the path exists, is readable by the current ' +
            "user, and isn't a directory.",
        },
      },
    );
  }
  if (fileSizeBytes === 0) {
    throw new UsageError(
      `<file> ${JSON.stringify(rawPath)} is empty (0 bytes); ` +
        `Monday rejects empty uploads server-side.`,
      {
        details: {
          reason: 'file_empty',
          file_path: filePath,
          filename,
          file_size_bytes: 0,
          hint:
            'Monday returns FILE_SIZE_LIMIT_EXCEEDED on empty ' +
            'uploads. Provide a non-empty file or remove the upload ' +
            'call.',
        },
      },
    );
  }
  return { filePath, filename, fileSizeBytes };
};

/**
 * Reads the file at `precheck.filePath` into memory and wraps it as
 * a Web `Blob` with a `Content-Type` sniffed from the filename
 * extension via {@link sniffContentType}. The Blob is the payload
 * the multipart transport sends to Monday's wire `File!` scalar.
 *
 * Run AFTER {@link precheckLocalFile} so the path is known good and
 * the size is known non-zero. Run AFTER column-type validation / M38
 * mutex checks so a non-`file` column rejection or a mutex violation
 * doesn't pay for the full read. The read uses `fs/promises.readFile`
 * which buffers the entire payload into memory — Monday's per-file
 * cap is plan-tier-dependent (typically 500 MB at standard tiers);
 * callers don't pre-check size against a hardcoded ceiling because
 * the cap isn't exposed via the GraphQL schema.
 */
export const buildBlobFromPath = async (
  precheck: LocalFilePrecheck,
): Promise<Blob> => {
  const bytes = await readFile(precheck.filePath);
  return new Blob([bytes], { type: sniffContentType(precheck.filename) });
};
