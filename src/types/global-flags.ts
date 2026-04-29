import { z } from 'zod';

/**
 * Global-flag zod schema (`cli-design.md` §4.4).
 *
 * One source of truth for the flags every command accepts. Commander
 * parses argv into a loose `Record<string, unknown>`; this schema
 * coerces / refines / brand-types everything before it crosses into
 * `commands/*` — the parse-at-the-edge rule from `validation.md`.
 *
 * Flag-pair conflicts (`--quiet --verbose`, `--json --table`) belong
 * here too. Output-format selection has its own resolver
 * (`utils/output/select.ts`) that handles the `--json`/`--table`/
 * `--output` combination since the env / TTY fallback is involved;
 * this schema only flags the contradictions that are unconditionally
 * wrong.
 */

const PROFILE_V03_HINT =
  'Multi-profile support lands in v0.3 (`monday auth login`). ' +
  'For now, omit --profile or use `default`.';

const apiVersionSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/u, { message: 'expected YYYY-MM' });

const profileSchema = z
  .string()
  .refine((v) => v === 'default', { message: PROFILE_V03_HINT });

export const OUTPUT_FORMATS = ['json', 'table', 'text', 'ndjson'] as const;

/**
 * Loose input shape — what commander hands us before refinement.
 * Strings come in for numeric flags (`--timeout 5000`); coerce-to-number
 * lives at the boundary, not deeper.
 */
export const globalFlagsInputSchema = z
  .object({
    output: z.enum(OUTPUT_FORMATS).optional(),
    json: z.boolean().default(false),
    table: z.boolean().default(false),
    full: z.boolean().default(false),
    width: z.coerce.number().int().positive().optional(),
    columns: z.array(z.string().min(1)).optional(),

    minimal: z.boolean().default(false),
    quiet: z.boolean().default(false),
    verbose: z.boolean().default(false),
    color: z.boolean().default(true),

    noCache: z.boolean().default(false),

    profile: profileSchema.optional(),
    apiVersion: apiVersionSchema.optional(),
    timeout: z.coerce.number().int().positive().optional(),
    retry: z.coerce.number().int().nonnegative().default(3),

    dryRun: z.boolean().default(false),
    yes: z.boolean().default(false),
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

export type GlobalFlagsInput = z.input<typeof globalFlagsInputSchema>;
export type GlobalFlags = z.output<typeof globalFlagsInputSchema>;
