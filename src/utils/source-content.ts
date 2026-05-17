/**
 * Generic file-or-stdin-or-inline-string source-content reader
 * (R-v0.5-NEW-18 lift, v0.5-M37 IMPL kickoff — ahead-of-feat per
 * R-NEW-29 M25 + R-NEW-70 M34 cadence; `v0.5-plan.md` §22 R-v0.5-NEW-18
 * entry).
 *
 * Five sites consume the same shape post-lift:
 *
 *   - `src/commands/update/create.ts` (M13; `--body <md>` /
 *     `--body-file <path|->`).
 *   - `src/commands/update/reply.ts` (M13).
 *   - `src/commands/update/edit.ts` (M13).
 *   - `src/commands/doc/import-html.ts` (M37; `--html-string <s>` /
 *     `--html <file|->`).
 *   - `src/commands/doc/append-markdown.ts` (M37; `--markdown-string
 *     <s>` / `--markdown <file|->`).
 *
 * All five materialise a content payload from one of three mutually-
 * exclusive sources:
 *
 *   1. `inline` — literal content via an inline-string flag (e.g.
 *      `--body <md>`, `--html-string <s>`, `--markdown-string <s>`).
 *   2. `file` — file path via a file-source flag (e.g.
 *      `--body-file <path>`, `--html <file>`, `--markdown <file>`).
 *   3. `file === '-'` — stdin (requires the `stdin` slot wired by
 *      the runner).
 *
 * Mutex of (1) vs (2) is typically enforced at the parse boundary via
 * a cross-field `.refine()` on the argv schema (see R-v0.5-NEW-20);
 * the helper rejects the both-set case defensively. Inline byte-length
 * cap is enforced at the parse boundary via `.refine()` (see
 * R-v0.5-NEW-21); when {@link ReadSourceContentInputs.maxBytes} is
 * supplied here, the same cap is applied at the runtime read boundary
 * for the file / stdin path (file content size isn't known at argv-
 * parse time).
 *
 * Throws `UsageError` for:
 *   - Both `inline` and `file` set (pre-parse-boundary drift).
 *   - Neither set (no source).
 *   - `file === '-'` with no `stdin` (programmer wiring bug).
 *   - Empty (or whitespace-only) result after read.
 *   - File-read failure (ENOENT / EACCES / etc.) wrapped with the
 *     underlying error message.
 *   - Oversized payload (when `maxBytes` is set) with
 *     `details.size_bytes` + `details.limit_bytes` + `details.source`
 *     ('inline' / 'file' / 'stdin') for agent introspection.
 */

import { readFile } from 'node:fs/promises';
import { UsageError, errorMessage } from './errors.js';

export interface ReadSourceContentInputs {
  /** Inline-string flag value (e.g. `--body <md>` / `--html-string`). */
  readonly inline: string | undefined;
  /** File-source flag value (e.g. `--body-file <path>` / `--html <file>`). */
  readonly file: string | undefined;
  /** stdin slot wired by the runner — required for `<file-flag> -`. */
  readonly stdin: NodeJS.ReadableStream | undefined;
  /**
   * Inline-flag display name for error messages (e.g. `'--body'`,
   * `'--html-string'`). Surfaces verbatim into `error.message`.
   */
  readonly inlineFlagName: string;
  /**
   * File-source flag display name for error messages (e.g.
   * `'--body-file'`, `'--html'`).
   */
  readonly fileFlagName: string;
  /**
   * Verb-specific "neither set" error message. Omit for a generic
   * `${inlineFlagName} or ${fileFlagName}` phrasing. Callers usually
   * supply a verb-named hint (e.g. "monday update create requires
   * either --body <md> or --body-file <path>. Use --body-file - to
   * read from stdin.").
   */
  readonly verbHint?: string;
  /**
   * Optional UTF-8 byte-length cap applied to the resolved content.
   * When set, the helper rejects oversized payloads as `usage_error`
   * with structured `details.size_bytes` / `details.limit_bytes` /
   * `details.source`. M37 supplies `MAX_DOC_IMPORT_PAYLOAD_BYTES`
   * (`256_000`) per D13 closure; M13 supplies nothing (no wire-side
   * cap on `update` body payloads).
   */
  readonly maxBytes?: number;
  /**
   * Trim trailing whitespace from file / stdin content. Default
   * `true` (matches M13 behaviour — a trailing newline from `cat
   * foo.md` doesn't surface as a literal `\n` in the posted
   * comment / doc payload). Inline content is always returned
   * verbatim (post empty-trim rejection); the parameter only
   * affects file / stdin paths.
   */
  readonly trimTrailingWhitespace?: boolean;
}

type ResolvedSource = 'inline' | 'file' | 'stdin';

const enforceMaxBytes = (
  content: string,
  source: ResolvedSource,
  maxBytes: number,
  inputs: ReadSourceContentInputs,
): void => {
  const size = Buffer.byteLength(content, 'utf8');
  if (size <= maxBytes) return;
  const flagName =
    source === 'inline' ? inputs.inlineFlagName : inputs.fileFlagName;
  const details: Record<string, unknown> = {
    source,
    size_bytes: size,
    limit_bytes: maxBytes,
  };
  if (source === 'file' && inputs.file !== undefined) {
    details.file_path = inputs.file;
  }
  throw new UsageError(
    `${flagName}: payload (${String(size)} bytes) exceeds the ${String(
      maxBytes,
    )}-byte wire-side limit. Pass a smaller payload, or split the call.`,
    { details },
  );
};

export const readSourceContent = async (
  inputs: ReadSourceContentInputs,
): Promise<string> => {
  const {
    inline,
    file,
    stdin,
    inlineFlagName,
    fileFlagName,
    maxBytes,
  } = inputs;
  const trimTrailing = inputs.trimTrailingWhitespace ?? true;

  if (inline !== undefined && file !== undefined) {
    throw new UsageError(
      `${inlineFlagName} and ${fileFlagName} are mutually exclusive; pick one.`,
      { details: { [`has_inline_value`]: true, file_path: file } },
    );
  }
  if (inline !== undefined) {
    if (inline.trim().length === 0) {
      throw new UsageError(
        `${inlineFlagName} cannot be empty (or whitespace-only). Pass content or use ${fileFlagName} <path> to read from disk / stdin.`,
      );
    }
    if (maxBytes !== undefined) {
      enforceMaxBytes(inline, 'inline', maxBytes, inputs);
    }
    return inline;
  }
  if (file === undefined) {
    const verbHint =
      inputs.verbHint ??
      `requires either ${inlineFlagName} <s> or ${fileFlagName} <file>. Use ${fileFlagName} - to read from stdin.`;
    throw new UsageError(verbHint);
  }
  if (file === '-') {
    if (stdin === undefined) {
      throw new UsageError(
        `${fileFlagName} - requested stdin, but no stdin is wired into the runner. This is a programmer wiring bug.`,
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = trimTrailing ? raw.trimEnd() : raw;
    if (body.length === 0) {
      throw new UsageError(
        `stdin produced an empty payload. Pipe non-empty content into ${fileFlagName} - or pass ${inlineFlagName} <s> inline.`,
        { details: { source: 'stdin' } },
      );
    }
    if (maxBytes !== undefined) {
      enforceMaxBytes(body, 'stdin', maxBytes, inputs);
    }
    return body;
  }
  // File on disk. UTF-8 always; binary content would corrupt the
  // markdown / HTML payload anyway.
  const raw = await readFile(file, 'utf8').catch((err: unknown) => {
    throw new UsageError(
      `${fileFlagName}: failed to read ${JSON.stringify(file)} (${errorMessage(err)}).`,
      {
        cause: err,
        details: { file_path: file },
      },
    );
  });
  const body = trimTrailing ? raw.trimEnd() : raw;
  if (body.length === 0) {
    throw new UsageError(
      `${fileFlagName}: ${JSON.stringify(file)} is empty (after trim). Pass non-empty content.`,
      { details: { file_path: file } },
    );
  }
  if (maxBytes !== undefined) {
    enforceMaxBytes(body, 'file', maxBytes, inputs);
  }
  return body;
};
