/**
 * `monday config get [key] [--profile <name>]` — emits the resolved
 * value (per the precedence chain) for one key or all 4 (cli-design
 * §4.3 + §7.2.1, v0.12-M55-E). RESOLVED-value shape, not stored —
 * the verb reports the same value a runtime command would see.
 *
 * **Precedence chain visible in output.** Each emitted entry carries
 * a `source` discriminator from
 * `src/config/profile-defaults.ts:resolveProfileDefault`:
 *   - `'env_var'` — value came from `MONDAY_BOARD` / `MONDAY_OUTPUT`
 *     / etc. (per-key bindings in §7.2.1).
 *   - `'profile_default'` — value came from
 *     `[profiles.<active>.defaults]` TOML.
 *   - `'unset'` — neither env nor profile carries a value;
 *     `value` is `null`.
 *
 * **`cli_flag` source is explicitly OUT OF SCOPE** per D2 in
 * v0.12-plan §3 M55-E. `monday config get` is a config-state read,
 * not a runtime resolution; the runtime CLI flag wins per the
 * D1 application layer at command-invocation time, but doesn't
 * affect this verb's output.
 *
 * **`--profile <name>`** scopes the read to a non-active profile.
 * Implicit-v1 mode (no profile selected) emits env-only resolution
 * — `MONDAY_BOARD=...` still surfaces as `source: 'env_var'`; the
 * profile_default arm collapses to `'unset'` for every key.
 *
 * **Idempotent:** yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitSuccess } from '../emit.js';
import {
  PROFILE_DEFAULTS_KEYS,
  loadProfilesConfig,
  type ProfileDefaultsKey,
} from '../../config/profiles.js';
import {
  resolveProfileDefault,
  type ResolveProfileDefaultResult,
} from '../../config/profile-defaults.js';
import {
  resolveReadProfileName,
  validateProfileDefaultsKey,
} from './_shared.js';

// Note: `key` is parsed as raw string here — allowlist check
// happens via `validateProfileDefaultsKey` AFTER parseArgv so the
// rejection lands as config_error (exit 3) per D3/D5.
const inputSchema = z
  .object({
    key: z.string().min(1).optional(),
  })
  .strict();

const sourceSchema = z.enum(['env_var', 'profile_default', 'unset']);

const entrySchema = z
  .object({
    key: z.enum(PROFILE_DEFAULTS_KEYS),
    value: z.union([z.string(), z.number()]).nullable(),
    source: sourceSchema,
  })
  .strict();

const configGetOutputSchema = z
  .object({
    profile: z.string().nullable(),
    entries: z.array(entrySchema),
  })
  .strict();

export type ConfigGetOutput = z.infer<typeof configGetOutputSchema>;

/** Maps the discriminated-union resolver result into the verb's
 * emitted shape (value + source, with `null` for unset). */
const resultToEntry = (
  key: ProfileDefaultsKey,
  result: ResolveProfileDefaultResult,
): { key: ProfileDefaultsKey; value: string | number | null; source: 'env_var' | 'profile_default' | 'unset' } => {
  if (result.source === 'unset') {
    return { key, value: null, source: 'unset' };
  }
  return { key, value: result.value, source: result.source };
};

export const configGetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ConfigGetOutput
> = {
  name: 'config.get',
  summary: 'Read a profile-scoped argument default (or all 4 when <key> omitted)',
  examples: [
    'monday config get board',
    'monday config get',
    'monday config get output --profile work --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: configGetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'config');
    noun
      .command('get [key]')
      .description(configGetCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...configGetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (key: unknown) => {
        const parsed = parseArgv(configGetCommand.inputSchema, {
          ...(key === undefined ? {} : { key }),
        });
        // Validate AFTER parseArgv so unknown-key rejection lands as
        // config_error (exit 3) per D3/D5.
        const validKey =
          parsed.key !== undefined
            ? validateProfileDefaultsKey(parsed.key)
            : undefined;

        const profile = await resolveReadProfileName(ctx, program.opts());
        const config = await loadProfilesConfig(profile.homeOptions);
        const profileDefaults =
          profile.name !== undefined
            ? config?.profiles[profile.name]?.defaults
            : undefined;

        // Per-key LAZY resolution (Codex IMPL R1 P1): when the user
        // names a specific key (`monday config get board`), validate
        // only that key's env binding. A malformed `MONDAY_OUTPUT`
        // can't crash a `config get board` invocation. The all-keys
        // variant (`monday config get`) still resolves all 4 — by
        // design, since the user's question IS "show me every
        // resolved default + its source".
        const keysToResolve =
          validKey !== undefined ? [validKey] : PROFILE_DEFAULTS_KEYS;
        const entries = keysToResolve.map((k) =>
          resultToEntry(
            k,
            resolveProfileDefault(k, { env: ctx.env, profileDefaults }),
          ),
        );

        emitSuccess({
          ctx,
          data: {
            profile: profile.name ?? null,
            entries,
          },
          schema: configGetCommand.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};
