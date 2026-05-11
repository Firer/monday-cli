/**
 * Shared body-source resolver for the comment-cluster verbs (`update
 * create` / `update reply` / `update edit`). Lifted out of M5b's
 * `update create` when the third consumer arrived — `update edit`
 * (M13) — per the v0.1-plan §17 R-timing rule ("lift on the third
 * consumer").
 *
 * Reads the markdown body from one of the three accepted sources:
 *
 *   1. `--body <md>` (`inlineBody`) — inline.
 *   2. `--body-file <path>` (`bodyFile`) — from disk.
 *   3. `--body-file -` — from stdin (`ctx.stdin`).
 *
 * Throws `usage_error` for:
 *   - Both `--body` and `--body-file` set (mutually exclusive).
 *   - Neither set (no source).
 *   - `--body-file -` with no `ctx.stdin` available (programmer
 *     wiring bug; should not happen via the binary).
 *   - Empty (or whitespace-only) result after read (Monday rejects
 *     empty body strings; surface up-front rather than wait for
 *     `validation_failed`).
 */

import { readFile } from 'node:fs/promises';
import { UsageError, errorMessage } from '../../utils/errors.js';

export interface ReadBodyInputs {
  /** `--body <md>` value (per-command flag). */
  readonly inlineBody: string | undefined;
  /** `--body-file <path>` value (global flag — see `types/global-flags.ts`). */
  readonly bodyFile: string | undefined;
  /** `ctx.stdin` from the runner — needed for `--body-file -`. */
  readonly stdin: NodeJS.ReadableStream | undefined;
  /**
   * Verb name for the "no source" error message (e.g. "monday update
   * reply requires either --body <md> or ..."). Defaults to a generic
   * phrasing if omitted.
   */
  readonly verbHint?: string;
}

const DEFAULT_NO_SOURCE_VERB =
  'monday update create / reply / edit requires either --body <md> or ' +
  '--body-file <path>. Use --body-file - to read from stdin.';

export const readUpdateBody = async (
  inputs: ReadBodyInputs,
): Promise<string> => {
  const { inlineBody, bodyFile, stdin } = inputs;
  const verbHint = inputs.verbHint ?? DEFAULT_NO_SOURCE_VERB;

  if (inlineBody !== undefined && bodyFile !== undefined) {
    throw new UsageError(
      '--body and --body-file are mutually exclusive; pick one.',
      { details: { has_inline_body: true, body_file: bodyFile } },
    );
  }
  if (inlineBody !== undefined) {
    if (inlineBody.trim().length === 0) {
      // Empty-after-trim must reject too — `--body "   "` shouldn't
      // sneak past and surface as Monday's `validation_failed`
      // post-mutation. Same trim policy the file / stdin branches
      // apply.
      throw new UsageError(
        '--body cannot be empty (or whitespace-only). Pass markdown ' +
          'content or use --body-file <path> to read from disk / stdin.',
      );
    }
    return inlineBody;
  }
  if (bodyFile === undefined) {
    throw new UsageError(verbHint);
  }
  if (bodyFile === '-') {
    if (stdin === undefined) {
      throw new UsageError(
        '--body-file - requested stdin, but no stdin is wired into ' +
          'the runner. This is a programmer wiring bug.',
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString('utf8').trimEnd();
    if (body.length === 0) {
      throw new UsageError(
        'stdin produced an empty body. Pipe non-empty content into ' +
          '--body-file - or pass --body <md> inline.',
        { details: { body_file: '-' } },
      );
    }
    return body;
  }
  // File on disk. UTF-8 always; binary content would corrupt the
  // markdown anyway. Trim trailing whitespace so a trailing newline
  // from `cat foo.md` doesn't surface as a literal `\n` in the
  // posted comment.
  const raw = await readFile(bodyFile, 'utf8').catch((err: unknown) => {
    throw new UsageError(
      `--body-file: failed to read ${JSON.stringify(bodyFile)} (${errorMessage(err)}).`,
      {
        cause: err,
        details: { body_file: bodyFile },
      },
    );
  });
  const body = raw.trimEnd();
  if (body.length === 0) {
    throw new UsageError(
      `--body-file: ${JSON.stringify(bodyFile)} is empty (after trim). ` +
        `Monday rejects empty comment bodies.`,
      { details: { body_file: bodyFile } },
    );
  }
  return body;
};
