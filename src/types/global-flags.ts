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
 *    `MONDAY_PROFILE` env per the §8 decision-5 deferral
 *    (accept absent or `default`; anything else is `usage_error`).
 *
 * Codex review §4–§6 caught the original schema's drift — it
 * declared `noCache: boolean` and `columns: string[]` and tested
 * against hand-shaped objects rather than real commander output.
 * This rewrite uses commander's actual shape on the input boundary
 * and produces the consumer-friendly shape on the output boundary.
 */

const PROFILE_V03_HINT =
  'Multi-profile support lands in v0.3 (`monday auth login`). ' +
  'For now, omit --profile/MONDAY_PROFILE or set them to `default`.';

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

  readonly profile: 'default' | undefined;
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
 * `--profile` deferral (`v0.1-plan.md` §8 decision 5). Accept absent
 * or the literal `default`; anything else is `usage_error` with a
 * v0.3 hint. `MONDAY_PROFILE` env is treated identically — flag and
 * env must agree if both are set.
 */
const resolveProfile = (
  flagValue: string | undefined,
  envValue: string | undefined,
): 'default' | undefined => {
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
  const chosen = fromFlag ?? fromEnv;
  if (chosen === undefined) {
    return undefined;
  }
  if (chosen !== 'default') {
    throw new UsageError(
      `profile "${chosen}" is not supported in v0.1`,
      { details: { hint: PROFILE_V03_HINT } },
    );
  }
  return 'default';
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
