/**
 * `monday config set <key> <value> [--profile <name>]` — sets one
 * key in the active (or `--profile`-scoped) profile's
 * `[profiles.<name>.defaults]` table (cli-design §4.3 + §7.2.1,
 * v0.12-M55-E).
 *
 * **Scope: defaults-only.** Operates EXCLUSIVELY on the 4-key
 * allowlist (`board` / `workspace` / `output` / `concurrency`) per
 * `profileDefaultsBlockSchema`. Any non-allowlist `<key>` rejects at
 * the parse boundary with `config_error details.reason:
 * 'unknown_defaults_key'`. Wrong types reject with
 * `'wrong_defaults_type'`. The verb has no path to the top-level
 * `[profiles.<name>]` slots (`api_token_env`, `api_version`,
 * `default_workspace`, `timezone`) by construction — the
 * `coerceValueForKey` parse boundary enforces the allowlist before
 * any TOML mutation runs (`.claude/rules/security.md` token-storage
 * rule preserved structurally).
 *
 * **Idempotency:** yes — re-running with the same value is a no-op
 * on `config.toml` (the value is already there). The returned
 * `previous_value` slot reflects the prior state.
 *
 * **Not destructive:** no `--yes` gate per cli-design §3.1 (this is
 * configuration-only, doesn't touch any Monday wire surface).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitMutation } from '../emit.js';
import {
  loadProfilesConfig,
  mutateProfileDefaultsInPlace,
  PROFILE_DEFAULTS_KEYS,
  writeProfilesConfig,
} from '../../config/profiles.js';
import {
  coerceValueForKey,
  resolveActiveProfileName,
  validateProfileDefaultsKey,
} from './_shared.js';

// Note: `key` is parsed as a raw string here (NOT a zod enum) —
// the allowlist check runs via `validateProfileDefaultsKey` after
// parseArgv, throwing `config_error.unknown_defaults_key` per D3
// case (a) + D5 in v0.12-plan §3 M55-E. parseArgv wraps Zod errors
// as `usage_error` (exit 1), but the spec binds non-allowlist-key
// rejection to `config_error` (exit 3).
const inputSchema = z
  .object({
    key: z.string().min(1, '<key> must be non-empty'),
    value: z.string().min(1, '<value> must be non-empty'),
  })
  .strict();

const configSetOutputSchema = z
  .object({
    profile: z.string(),
    key: z.enum(PROFILE_DEFAULTS_KEYS),
    value: z.union([z.string(), z.number()]),
    previous_value: z.union([z.string(), z.number()]).nullable(),
  })
  .strict();

export type ConfigSetOutput = z.infer<typeof configSetOutputSchema>;

export const configSetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ConfigSetOutput
> = {
  name: 'config.set',
  summary: 'Set a profile-scoped argument default',
  examples: [
    'monday config set board 987654',
    'monday config set workspace 1234567 --profile work',
    'monday config set output table',
    'monday config set concurrency 4',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: configSetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'config');
    noun
      .command('set <key> <value>')
      .description(configSetCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...configSetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (key: unknown, value: unknown) => {
        const parsed = parseArgv(configSetCommand.inputSchema, {
          key,
          value,
        });
        // Validate AFTER parseArgv so the rejection lands as
        // config_error (exit 3) per D3/D5, not usage_error (exit 1).
        const validKey = validateProfileDefaultsKey(parsed.key);
        const coerced = coerceValueForKey(validKey, parsed.value);

        const profile = await resolveActiveProfileName(ctx, program.opts());
        const existing = await loadProfilesConfig(profile.homeOptions);
        const { next, result } = mutateProfileDefaultsInPlace(existing, {
          profile: profile.name,
          mode: 'set',
          key: validKey,
          value: coerced,
        });
        await writeProfilesConfig(next, profile.homeOptions);

        emitMutation({
          ctx,
          data: {
            profile: profile.name,
            key: validKey,
            value: coerced,
            previous_value: result.previousValue ?? null,
          },
          schema: configSetCommand.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};
