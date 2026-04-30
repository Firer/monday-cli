/**
 * Parse-boundary helper (R18).
 *
 * Per `.claude/rules/validation.md` "Never bubble raw ZodError out of
 * a parse boundary": a raw `ZodError` reaching the runner's catch-all
 * does map to `internal_error` (right semantic code) but loses the
 * `details.issues` array — agents debugging a malformed Monday
 * response see only the bare message. Wrapping every parse boundary
 * with `safeParse` + `ApiError(internal_error)` carrying
 * `details.issues` keeps the failing field path visible in the
 * envelope.
 *
 * R17 fixed `userByEmail`'s parse boundary; the M5a-closing dry-run
 * commit extended the same pattern to its `rawItemSchema.parse`
 * boundary. R18 sweeps the remaining ZodError surfaces in:
 *   - `api/board-metadata.ts` (live-fetch `responseSchema.parse` +
 *     per-board `boardMetadataSchema.parse`);
 *   - `api/item-helpers.ts` (the new `parseRawItem` helper that the
 *     four item commands consume);
 *   - `commands/emit.ts` (`schema.parse` drift catch).
 *
 * Cache-read parse callbacks (`board-metadata.ts parseCacheEntry`,
 * `resolvers.ts readDirectoryCache`) intentionally swallow ZodError
 * via the surrounding cache-miss try/catch — a corrupt cache file
 * is treated as a miss and a live fetch follows. Wrapping there
 * would not change behaviour; left as-is to keep the surface narrow.
 */

import { ApiError } from './errors.js';
import type { z } from 'zod';

export interface WrapZodErrorOptions {
  /**
   * Free-form context — populates the error message and lands on
   * `details` so agents see the failing operation. Keep short; the
   * `issues` array carries the per-field detail.
   */
  readonly context: string;
  /** Optional `details` extras merged alongside `issues`. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Override hint text. Default points at "Monday response shape drift / schema mismatch". */
  readonly hint?: string;
}

/**
 * Returns the parsed value when `result.success` is true; otherwise
 * throws a typed `ApiError(internal_error)` carrying
 * `details.issues` (path + message + zod code per failing field).
 *
 * Use at every parse boundary that consumes data from outside the
 * compiled bundle (live API responses, freshly-projected types
 * returned from action bodies, on-disk JSON). Cache parses
 * deliberately don't use this — they fall through to a live fetch
 * on parse failure rather than surfacing the drift.
 */
export const unwrapOrThrow = <T>(
  result: z.ZodSafeParseResult<T>,
  options: WrapZodErrorOptions,
): T => {
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
    code: i.code,
  }));
  const hint =
    options.hint ??
    'this is a data-integrity error in Monday\'s response (or a ' +
      'schema drift); verify the response shape and update the ' +
      'schema if Monday\'s contract has changed.';
  throw new ApiError(
    'internal_error',
    `${options.context} — schema rejected the payload at ` +
      `${String(issues.length)} issue${issues.length === 1 ? '' : 's'}.`,
    {
      cause: result.error,
      details: {
        ...(options.details ?? {}),
        issues,
        hint,
      },
    },
  );
};
