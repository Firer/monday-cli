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

interface SummarisedIssue {
  readonly path: string;
  readonly message: string;
  /**
   * Optional structured params from `ZodIssue.params` (set via
   * `ctx.addIssue({ ..., params })` in `.superRefine` /
   * `.refine`). Preserved so structured per-issue context — e.g.
   * the M23 `conflicting_flags` slot on the
   * scoping-lever-mutual-exclusion issue — reaches the agent
   * through the error envelope's `details.issues[].params`
   * (Codex M23 pre-flight round-2 P2-3 fix).
   */
  readonly params?: Readonly<Record<string, unknown>>;
}

const summariseIssues = (
  err: z.ZodError,
): { readonly summary: string; readonly issues: readonly SummarisedIssue[] } => {
  const issues: SummarisedIssue[] = err.issues.map((issue) => {
    const base: SummarisedIssue = {
      path: issue.path.map((p) => String(p)).join('.'),
      message: issue.message,
    };
    // `ZodIssue.params` is optional + bare-Record; preserve only
    // when present so the per-issue shape stays minimal for issues
    // that don't carry structured context.
    const maybeParams = (issue as { params?: Record<string, unknown> }).params;
    if (maybeParams !== undefined) {
      return { ...base, params: maybeParams };
    }
    return base;
  });
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
