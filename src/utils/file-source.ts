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
 *
 * **v0.8-M47 stdin sibling.** The file `--set <file-col>=-` stdin
 * source (D7 fold) is a SEPARATE sibling — {@link readStdinFileSource}
 * below — not a retrofit into {@link precheckLocalFile} /
 * {@link buildBlobFromPath}. Those two stay path-only by design: their
 * fire-point ordering (pre-check BEFORE `resolveClient` so a bad path
 * surfaces as `usage_error` not `config_error`; Blob build AFTER
 * column-type validation) is load-bearing and doesn't transfer to a
 * single non-replayable stream. The stdin source buffers stdin once
 * (no `fs.stat` is possible on a stream), so it carries no pre-check
 * size leg; the routing layer (`file-column-set.ts:
 * routeFileColumnDispatch`) enforces stdin's single-file /
 * single-target scope BEFORE this helper is reached.
 */

import { stat as fsStat, access as fsAccess, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve as resolvePath, basename } from 'node:path';
import { ApiError, UsageError, asError, errorCode } from './errors.js';
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

/**
 * Sentinel value selecting stdin as the file source on a file-column
 * `--set <file-col>=-` (or the `monday item set <iid> <file-col>=-`
 * positional). v0.8-M47 D7 fold — closes the v0.6-M38 D7 deferral.
 * A bare `-` is the conventional CLI stdin token (mirrors the
 * `--body-file -` shape on `monday update create` / `update reply`).
 */
export const STDIN_FILE_SENTINEL = '-';

/**
 * Default filename used for Monday's wire `Asset.name` when a stdin
 * `<file-col>=-` source is dispatched WITHOUT an explicit
 * `--filename <name>`. Pinned at the v0.8-M47 pre-flight probe:
 * `add_file_to_column` accepts any non-empty filename (`"blob"` /
 * `"stdin"` / a real name all return `200`); only an EMPTY filename
 * `500`s. `"blob"` is source-agnostic (stdin carries no intrinsic
 * name) and matches the probe's tested default. Agents that want a
 * meaningful `Asset.name` pass `--filename`.
 */
export const DEFAULT_STDIN_FILENAME = 'blob';

/**
 * True when a file-column `--set` value selects stdin as its source
 * (i.e. the agent passed the bare {@link STDIN_FILE_SENTINEL}). Pure
 * predicate — the actual stdin read happens later via
 * {@link readStdinFileSource}, AFTER the routing layer
 * (`file-column-set.ts:routeFileColumnDispatch`) has confirmed the
 * stdin source is the sole file entry on a single-target callShape.
 */
export const isStdinFileSetSource = (value: string): boolean =>
  value === STDIN_FILE_SENTINEL;

/**
 * Resolves the wire `Asset.name` for a stdin `<file-col>=-` source:
 * the agent's `--filename` when present, else
 * {@link DEFAULT_STDIN_FILENAME}. A non-empty `--filename` is already
 * guaranteed by the command schemas (`z.string().min(1)`), so this
 * never returns an empty name (which Monday `500`s). Extracted so the
 * default-fallback branch is unit-tested once rather than replicated
 * across the four `<file-col>=-` dispatch sites (`item set` live +
 * dry-run, single-item `item update`, `item create`).
 */
export const resolveStdinFilename = (
  filename: string | undefined,
): string => filename ?? DEFAULT_STDIN_FILENAME;

/**
 * Result of a successful {@link readStdinFileSource} read. Mirrors the
 * shape {@link buildBlobFromPath} feeds the multipart transport (a Web
 * `Blob` + the resolved filename) plus the buffered byte length
 * (`fs.stat` is impossible on a stream, so size is the post-read
 * buffer length rather than a pre-check measurement).
 */
export interface StdinFileSource {
  /** The buffered stdin bytes wrapped as a Web `Blob`. */
  readonly blob: Blob;
  /** Resolved `Asset.name` — `--filename` or {@link DEFAULT_STDIN_FILENAME}. */
  readonly filename: string;
  /** Buffered byte length (post-read; `0` rejects upstream — Monday `500`s empty). */
  readonly fileSizeBytes: number;
}

/**
 * Reads the entire stdin stream into memory and wraps it as a Web
 * `Blob` with a `Content-Type` sniffed from `filename` (so a
 * `--filename report.pdf` still gets the right mime). The Blob is the
 * payload the multipart transport sends to Monday's wire `File!`
 * scalar — same downstream contract as {@link buildBlobFromPath}, but
 * sourced from a single non-replayable stream rather than a path.
 *
 * Unlike {@link precheckLocalFile} there is no pre-read size/readable
 * pre-check leg: a stream can't be `fs.stat`'d, and reading it to
 * measure would consume the only copy. Callers therefore reach this
 * helper only AFTER the routing layer has confirmed (a) exactly one
 * stdin `<file-col>=-` per call, (b) it is the sole file `--set`
 * entry, and (c) the callShape is single-target (`item set` /
 * single-item `item update` / `item create`) — bulk fan-out can't
 * replay one stream across N items.
 *
 * **Status: v0.8-M47 pre-flight stub.** The argv `<file-col>=-` +
 * `--filename` surface, the `routeFileColumnDispatch` stdin-scope
 * enforcement, and the cross-doc contract are the shipped pre-flight
 * contract; this stdin-read + Blob-construction leg lands at the
 * v0.8-M47 IMPL. The stub throws `internal_error` with
 * `details.reason: 'm47_preflight_stub'` so the surface is reachable
 * + regression-pinned without yet consuming stdin.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- v0.8-M47 pre-flight stub; live body (M47 IMPL) awaits the stdin read. The `async` + `Promise<StdinFileSource>` signature is the shipped contract.
export const readStdinFileSource = async (filename: string): Promise<StdinFileSource> => {
  /* c8 ignore start — v0.8-M47 pre-flight stub; the live stdin read +
     Blob construction lands at M47 IMPL. The argv + --filename +
     routing + scope-enforcement surface is the shipped contract; only
     this leg is stubbed (mirrors M42/M43 `*_preflight_stub` cadence). */
  throw new ApiError(
    'internal_error',
    'readStdinFileSource: v0.8-M47 pre-flight stub — stdin file ' +
      '`--set <file-col>=-` runtime body lands at the M47 IMPL.',
    {
      details: {
        reason: 'm47_preflight_stub',
        filename,
        milestone: 'v0.8-M47',
        hint:
          'stdin file `--set` is contract-pinned but not yet ' +
          'implemented; pass a local file path instead until v0.8-M47 ' +
          'IMPL ships the stdin read.',
      },
    },
  );
  /* c8 ignore stop */
};
