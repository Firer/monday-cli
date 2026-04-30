/**
 * Wraps a per-command argv schema parse so ZodErrors land as
 * `usage_error` (exit 1), not the runner's catch-all
 * `internal_error` (exit 2).
 *
 * `validation.md` "Never bubble raw ZodError out of a parse
 * boundary" applies to every M3 command's positional + flag
 * boundary. Without this helper, a `monday workspace get abc`
 * (non-numeric) raises a raw ZodError on `WorkspaceIdSchema.parse`,
 * which the runner can't distinguish from an internal contract
 * break — the M0 review caught the same shape one milestone earlier.
 *
 * Returns the parsed value or throws `UsageError` with structured
 * `details.issues` so agents see exactly which field was rejected.
 * The error's `cause` is the original ZodError, retained for `--debug`
 * surfaces (always run through `redact()` before emit).
 */

import type { z } from 'zod';
import { UsageError } from '../utils/errors.js';

const summariseIssues = (
  err: z.ZodError,
): { readonly summary: string; readonly issues: readonly { readonly path: string; readonly message: string }[] } => {
  const issues = err.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join('.'),
    message: issue.message,
  }));
  const summary = issues
    .map((i) => (i.path.length > 0 ? `${i.path}: ${i.message}` : i.message))
    .join('; ');
  return { summary, issues };
};

export const parseArgv = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    const { summary, issues } = summariseIssues(result.error);
    throw new UsageError(`invalid arguments: ${summary}`, {
      cause: result.error,
      details: { issues },
    });
  }
  return result.data;
};
