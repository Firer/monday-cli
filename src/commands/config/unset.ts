/**
 * `monday config unset <key> [--profile <name>]` — removes one key
 * from the active (or `--profile`-scoped) profile's
 * `[profiles.<name>.defaults]` table (cli-design §4.3 + §7.2.1,
 * v0.12-M55-E).
 *
 * **Idempotent on a missing key.** Mirrors `monday auth logout`
 * on a missing-profile entry: a no-op `ok: true` envelope per
 * cli-design §3.1's idempotency rule. The emitted `previous_value`
 * reflects whether the key was actually present pre-call.
 *
 * **Not destructive:** no `--yes` gate per cli-design §3.1 — the
 * verb is configuration-only and reversible (re-run `monday config
 * set <key> <value>` to restore).
 *
 * **Scope:** same defaults-only allowlist as `monday config set`;
 * non-allowlist keys reject with `unknown_defaults_key` at the
 * parse boundary.
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
  resolveActiveProfileName,
  validateProfileDefaultsKey,
} from './_shared.js';

// Note: `key` is parsed as a raw string; allowlist check runs via
// `validateProfileDefaultsKey` after parseArgv so the rejection
// lands as config_error (exit 3) per D3/D5.
const inputSchema = z
  .object({
    key: z.string().min(1, '<key> must be non-empty'),
  })
  .strict();

const configUnsetOutputSchema = z
  .object({
    profile: z.string(),
    key: z.enum(PROFILE_DEFAULTS_KEYS),
    previous_value: z.union([z.string(), z.number()]).nullable(),
  })
  .strict();

export type ConfigUnsetOutput = z.infer<typeof configUnsetOutputSchema>;

export const configUnsetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ConfigUnsetOutput
> = {
  name: 'config.unset',
  summary: 'Remove a profile-scoped argument default (idempotent on absent key)',
  examples: [
    'monday config unset board',
    'monday config unset workspace --profile work',
    'monday config unset output --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: configUnsetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'config');
    noun
      .command('unset <key>')
      .description(configUnsetCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...configUnsetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (key: unknown) => {
        const parsed = parseArgv(configUnsetCommand.inputSchema, { key });
        const validKey = validateProfileDefaultsKey(parsed.key);

        const profile = await resolveActiveProfileName(ctx, program.opts());
        const existing = await loadProfilesConfig(profile.homeOptions);
        const { next, result } = mutateProfileDefaultsInPlace(existing, {
          profile: profile.name,
          mode: 'unset',
          key: validKey,
        });

        // Idempotent: if the key was already absent, the next config
        // equals the existing config (the mutator drops empty
        // defaults blocks). Still write to ensure the file's bytes
        // are canonical TOML — cheap on a small file, and the
        // observable contract is `ok: true` either way.
        await writeProfilesConfig(next, profile.homeOptions);

        emitMutation({
          ctx,
          data: {
            profile: profile.name,
            key: validKey,
            previous_value: result.previousValue ?? null,
          },
          schema: configUnsetCommand.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};
