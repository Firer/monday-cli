import { z } from 'zod';
import { UsageError } from '../utils/errors.js';

/**
 * Global-flag zod schema (`cli-design.md` §4.4).
 *
 * One source of truth for the flags every command accepts.
 * Commander parses argv into a loose `Record<string, unknown>`;
 * this module coerces / refines / normalises before the value
 * crosses into `commands/*` — the parse-at-the-edge rule from
 * `validation.md`.
 *
 * Two layers, deliberately separated:
 *
 *  - **`globalFlagsRawSchema`** — accepts commander's raw output
 *    shape exactly as it lands. `--no-cache` becomes `{cache:false}`
 *    (not `{noCache:true}`); `--no-color` becomes `{color:false}`;
 *    `--columns id,name` is the single string `"id,name"` (commander
 *    doesn't auto-split). String→number coercion happens here too
 *    because commander hands `--timeout 5000` over as `"5000"`.
 *
 *  - **`parseGlobalFlags(rawOpts, env)`** — parses through the raw
 *    schema, then projects into the normalised `GlobalFlags` shape
 *    the rest of the codebase consumes (`noCache`, `noColor`,
 *    `columns: string[]`). Also resolves `--profile` against
 *    `MONDAY_PROFILE` env per cli-design §7.2 (`--profile` flag >
 *    `MONDAY_PROFILE` env; mismatch is `usage_error`). The actual
 *    profile-config + credentials-cache lookup happens later in
 *    `cli/run.ts`'s config-load step at v0.3-M21 implementation;
 *    pre-flight only widens the structural acceptance.
 *
 * **v0.3-M21 pre-flight widening.** Pre-v0.3 the resolver rejected
 * any profile name other than `default` with a v0.3 hint; with the
 * §7.2 / §7.3 / §7.4 surface in force from M21 onwards, any non-
 * empty profile name parses through structurally. The actual
 * resolution-to-token step (cache > api_token_env > config_error)
 * lands at M21 implementation in `cli/run.ts`; until then, non-auth
 * commands using `--profile work` silently use the implicit-v1
 * (`MONDAY_API_TOKEN`) token.
 *
 * Codex review §4–§6 caught the original schema's drift — it
 * declared `noCache: boolean` and `columns: string[]` and tested
 * against hand-shaped objects rather than real commander output.
 * This rewrite uses commander's actual shape on the input boundary
 * and produces the consumer-friendly shape on the output boundary.
 */

const apiVersionSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/u, { message: 'expected YYYY-MM' });

export const OUTPUT_FORMATS = ['json', 'table', 'text', 'ndjson'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Commander's raw option shape after `program.parse(...)`. Boolean
 * flags default to `undefined` if not passed; we normalise them via
 * zod defaults below so the consumer-facing object has stable
 * presence.
 */
export const globalFlagsRawSchema = z
  .object({
    output: z.enum(OUTPUT_FORMATS).optional(),
    json: z.boolean().default(false),
    table: z.boolean().default(false),
    full: z.boolean().default(false),
    width: z.coerce.number().int().positive().optional(),
    /** Commander emits the literal string; we split on `,` later. */
    columns: z.string().min(1).optional(),

    minimal: z.boolean().default(false),
    quiet: z.boolean().default(false),
    verbose: z.boolean().default(false),
    /** `--no-color`: commander sets `color: false`. Default `true`. */
    color: z.boolean().default(true),
    /** `--no-cache`: commander sets `cache: false`. Default `true`. */
    cache: z.boolean().default(true),

    profile: z.string().optional(),
    apiVersion: apiVersionSchema.optional(),
    timeout: z.coerce.number().int().positive().optional(),
    retry: z.coerce.number().int().nonnegative().default(3),

    dryRun: z.boolean().default(false),
    yes: z.boolean().default(false),

    /** Long-form text body source (per-command, but global flag in §4.4). */
    bodyFile: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => !(v.json && v.table), {
    message: '--json and --table are mutually exclusive',
    path: ['json'],
  })
  .refine((v) => !(v.quiet && v.verbose), {
    message: '--quiet and --verbose are mutually exclusive',
    path: ['quiet'],
  })
  .refine((v) => !(v.full && v.json), {
    message: '--full has no effect with --json (JSON output is never truncated)',
    path: ['full'],
  });

export type GlobalFlagsRaw = z.infer<typeof globalFlagsRawSchema>;

/**
 * The normalised shape every command consumes. `noCache` /
 * `noColor` are inverted from commander's `cache`/`color` so command
 * code reads the way the flags do. `columns` is split. `profile` is
 * narrowed to its v0.1 acceptable value (or absent).
 */
export interface GlobalFlags {
  readonly output: OutputFormat | undefined;
  readonly json: boolean;
  readonly table: boolean;
  readonly full: boolean;
  readonly width: number | undefined;
  readonly columns: readonly string[] | undefined;

  readonly minimal: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly noColor: boolean;
  readonly noCache: boolean;

  readonly profile: string | undefined;
  readonly apiVersion: string | undefined;
  readonly timeout: number | undefined;
  readonly retry: number;

  readonly dryRun: boolean;
  readonly yes: boolean;

  readonly bodyFile: string | undefined;
}

const splitColumns = (raw: string | undefined): readonly string[] | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : parts;
};

/**
 * `--profile` source-priority resolver per cli-design §7.2.
 *
 * Returns the chosen profile name (or `undefined` when neither flag
 * nor env is set, signalling the implicit-v1 path). The flag wins
 * over the env when both are set to the same value; a mismatch
 * surfaces `usage_error` per the same rule.
 *
 * **v0.3-M21 pre-flight surface.** Any non-empty string parses
 * through; the actual lookup (does the named profile exist in
 * `~/.monday-cli/config.toml`? does `~/.monday-cli/credentials`
 * have an entry for it? is the named `api_token_env` populated?)
 * is M21 implementation work in `cli/run.ts`'s config-load step.
 * `parseGlobalFlags` does NOT touch the filesystem.
 */
const resolveProfile = (
  flagValue: string | undefined,
  envValue: string | undefined,
): string | undefined => {
  const fromFlag = flagValue !== undefined && flagValue.length > 0
    ? flagValue
    : undefined;
  const fromEnv = envValue !== undefined && envValue.length > 0
    ? envValue
    : undefined;

  if (fromFlag !== undefined && fromEnv !== undefined && fromFlag !== fromEnv) {
    throw new UsageError(
      `--profile (${fromFlag}) conflicts with MONDAY_PROFILE (${fromEnv})`,
      {
        details: {
          hint: 'set --profile and MONDAY_PROFILE to the same value, or omit one',
        },
      },
    );
  }
  return fromFlag ?? fromEnv;
};

const formatZodIssues = (
  err: z.ZodError,
): { summary: string; issues: { path: string; message: string }[] } => {
  const issues = err.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  const summary = issues
    .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
    .join('; ');
  return { summary, issues };
};

/**
 * Parses commander's raw global-options object into the normalised
 * `GlobalFlags` shape. Throws `UsageError` (with structured
 * `details.issues` / `details.hint` where useful) on any failure —
 * the runner catch-all maps that to exit 1 + envelope.
 */
export const parseGlobalFlags = (
  rawOpts: unknown,
  env: NodeJS.ProcessEnv = {},
): GlobalFlags => {
  const result = globalFlagsRawSchema.safeParse(rawOpts);
  if (!result.success) {
    const { summary, issues } = formatZodIssues(result.error);
    throw new UsageError(`invalid global flags: ${summary}`, {
      cause: result.error,
      details: { issues },
    });
  }
  const raw = result.data;

  return {
    output: raw.output,
    json: raw.json,
    table: raw.table,
    full: raw.full,
    width: raw.width,
    columns: splitColumns(raw.columns),
    minimal: raw.minimal,
    quiet: raw.quiet,
    verbose: raw.verbose,
    noColor: !raw.color,
    noCache: !raw.cache,
    profile: resolveProfile(raw.profile, env.MONDAY_PROFILE),
    apiVersion: raw.apiVersion,
    timeout: raw.timeout,
    retry: raw.retry,
    dryRun: raw.dryRun,
    yes: raw.yes,
    bodyFile: raw.bodyFile,
  };
};
