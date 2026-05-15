/**
 * Comma-separated branded-ID list argv parser (R-NEW-70 lift,
 * v0.5-M34 pre-flight kickoff — ahead-of-feat per R-NEW-29 M25
 * cadence; `v0.5-plan.md` §22 R-NEW-70 entry).
 *
 * Three sites in `src/commands/*` consume a `--<flag> <id,...>`
 * comma-separated list of branded IDs at the argv-parse boundary +
 * reject malformed entries as `usage_error`:
 *
 *   - `monday workspace add-users` / `workspace remove-users` /
 *     `board add-users` already use the mixed numeric-or-email
 *     {@link parseUsersArg} helper (different shape — accepts
 *     emails + numeric IDs; NOT a consumer of this helper).
 *   - `monday doc list --workspace <wid,...>`
 *     (`src/commands/doc/list.ts`, M32 pre-flight — 1st pure-brand-list
 *     consumer; pre-lift `parseWorkspaceListArg` inline copy).
 *   - `monday user team-create --users <id,...>` / `team-add-members
 *     <tid> --users <id,...>` / `team-remove-members <tid> --users
 *     <id,...>` (`src/commands/user/team-*.ts`, M34 pre-flight —
 *     3rd-5th consumers; would each duplicate the ~35-line inline
 *     pattern without this lift).
 *
 * Each pre-lift site shared the outer-split + trim + empty-entry +
 * per-entry brand-validation outline; the per-call sites carried
 * verb-specific error-message strings + detail keys + hint text. M34
 * pre-flight pushed the count to 4 (1 migrated + 3 new), crossing the
 * R7/R8 3-consumer threshold; this lift ships AHEAD of the M34
 * pre-flight feat commit mirroring R-NEW-29's M25 cadence (lift
 * commit lands first, feat commit consumes the lifted helper, Codex
 * review then sees the lifted shape).
 *
 * **Why this is NOT folded into {@link parseUsersArg}.** The mixed
 * numeric-or-email shape inflates the helper's signature with an
 * `email_kind` discriminator + a directory-cache leg's source-
 * aggregator coupling that's load-bearing in the fan-out path but
 * irrelevant to a pure brand-list parse. Keeping the two shapes as
 * sibling helpers keeps the pure-brand-list call sites readable and
 * the mixed-mode fan-out call sites tightly typed.
 */

import type { z } from 'zod';
import { UsageError } from './errors.js';

export interface ParseBrandedListArgOptions {
  /**
   * The argv flag name including the leading dashes (e.g.
   * `'--workspace'`, `'--users'`). Surfaces verbatim into
   * `error.message` so the agent sees which flag rejected.
   */
  readonly flagName: string;
  /**
   * Short noun phrase describing one entry (e.g. `'numeric workspace
   * ID'`, `'numeric user ID'`). Surfaces into the per-entry
   * rejection message: `"--<flag> entry "<token>" is not a
   * <entryDescription>"`.
   */
  readonly entryDescription: string;
  /**
   * Free-form hint surfaced into `error.details.hint` on per-entry
   * brand-validation failure (e.g. `'workspace IDs are numeric
   * (e.g. 12345)'`). Same hint used for both the empty-entry
   * rejection (where it falls back to a generic "no leading,
   * trailing, or duplicate commas" message if {@link emptyEntryHint}
   * is unset) and the per-entry rejection.
   */
  readonly hint: string;
  /**
   * Optional hint override for the empty-entry rejection path
   * (trailing comma / leading comma / double comma). Defaults to
   * `"e.g. ${flagName} <id-or-token>,<id-or-token> — no leading,
   * trailing, or duplicate commas"` when unset, which matches the
   * pre-lift `parseWorkspaceListArg` shape verbatim.
   */
  readonly emptyEntryHint?: string;
}

/**
 * Splits a comma-separated argv string into an array of brand-
 * validated typed IDs. Whitespace around commas is trimmed. Empty
 * entries (trailing comma, leading comma, double comma) reject
 * with `usage_error.details.hint`; non-conforming entries reject
 * via the supplied zod brand schema (`details.issues[]` carries
 * the per-issue path/message + `details.argv_value` echoes the
 * raw input so agents can correlate retries against the original
 * argv).
 *
 * The brand-validation step uses `safeParse` so the zod error
 * doesn't bubble through the runner's catch-all as
 * `internal_error` (per `validation.md`'s "Never bubble raw
 * ZodError out of a parse boundary" rule). Caller wraps with the
 * verb's outer `parseArgv` for the rest of the argv surface.
 *
 * Empty input strings (`raw === ''`) reject at the per-verb input
 * schema's `.min(1)` check BEFORE reaching this helper — the
 * helper assumes a non-empty raw string. The empty-`raw` defensive
 * branch is c8-ignored as unreachable from production.
 */
export const parseBrandedListArg = <T>(
  raw: string,
  brandSchema: z.ZodType<T>,
  options: ParseBrandedListArgOptions,
): readonly T[] => {
  const tokens = raw.split(',').map((t) => t.trim());
  const ids: T[] = [];
  for (const token of tokens) {
    if (token === '') {
      throw new UsageError(
        `${options.flagName} contains an empty entry (trailing comma ` +
          `or double comma); pass a comma-separated list of ` +
          `${options.entryDescription}s.`,
        {
          details: {
            hint:
              options.emptyEntryHint ??
              `e.g. ${options.flagName} <id>,<id> — no leading, ` +
                `trailing, or duplicate commas`,
            argv_value: raw,
          },
        },
      );
    }
    const parsed = brandSchema.safeParse(token);
    if (!parsed.success) {
      throw new UsageError(
        `${options.flagName} entry ${JSON.stringify(token)} is not a ${options.entryDescription}`,
        {
          cause: parsed.error,
          details: {
            issues: parsed.error.issues.map((i) => ({
              path: i.path.map((p) => String(p)).join('.'),
              message: i.message,
            })),
            argv_value: raw,
            hint: options.hint,
          },
        },
      );
    }
    ids.push(parsed.data);
  }
  return ids;
};
