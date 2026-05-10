/**
 * `monday auth logout --profile <name>` — deletes the named profile's
 * entry from the credentials cache per cli-design §7.3.2 (v0.3-plan
 * §3 M21).
 *
 * **v0.3-M21 pre-flight stub.** Sibling to `auth login`; rejects
 * every invocation today with `internal_error` carrying the M21-
 * pending hint. The argv shape (`--profile <name>` global flag) is
 * the final shape the M21 implementation ships against.
 *
 * **Idempotent.** Per cli-design §7.3.2 — deletes the named profile
 * entry; no-op + `ok: true` on a missing entry. NOT under the
 * destructive-confirmation gate (§3.1) — credential rotation is a
 * routine agent operation, not data mutation requiring `--yes`.
 *
 * **Output schema** is the future-shape envelope: `{profile,
 * was_present}`. The `was_present` slot tells agents whether the
 * delete actually removed an entry vs. ran against an absent
 * profile — useful for "is this profile authenticated?" probing
 * without a separate `auth status` verb (planned for v0.3.x).
 *
 * **What lands at M21 implementation:** call
 * {@link import('../../config/credentials.js').deleteProfileCredentials}
 * + emit the success envelope.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { parseGlobalFlags } from '../../types/global-flags.js';

const inputSchema = z
  .object({
    profile: z.string().min(1),
  })
  .strict();

const logoutOutputSchema = z
  .object({
    profile: z.string().min(1),
    was_present: z.boolean(),
  })
  .strict();

export type AuthLogoutOutput = z.infer<typeof logoutOutputSchema>;

export const authLogoutCommand: CommandModule<
  z.infer<typeof inputSchema>,
  AuthLogoutOutput
> = {
  name: 'auth.logout',
  summary:
    'Delete a profile\'s credentials cache entry (v0.3-M21 pre-flight stub — runtime body lands at M21 implementation)',
  examples: [
    'monday auth logout --profile work',
    'monday auth logout --profile personal',
  ],
  // Fully idempotent — re-running on an already-deleted profile is a
  // no-op + `ok: true` per cli-design §7.3.2. Agents reading the
  // `was_present` slot disambiguate "first delete" from "no-op".
  idempotent: true,
  inputSchema,
  outputSchema: logoutOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(
      program,
      'auth',
      'OAuth-issued credentials cache (v0.3-M21; cli-design §7.3 / §7.4)',
    );
    noun
      .command('logout')
      .description(authLogoutCommand.summary)
      // `--profile <name>` is the global flag (cli-design §4.4) — see
      // `login.ts` for the rationale.
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...authLogoutCommand.examples.map((e) => `  ${e}`),
          '',
          'NOTE: Pre-flight stub — runtime body lands at v0.3-M21',
          'implementation. The verb registers the argv shape so agent',
          'scripts targeting `monday auth logout --profile <name>` are',
          'stable across the M21 drop-in.',
          '',
        ].join('\n'),
      )
      // Async action — see `login.ts` for the rationale.
      .action(async () => {
        const flags = parseGlobalFlags(program.opts(), ctx.env);
        if (flags.profile === undefined || flags.profile.length === 0) {
          throw new UsageError(
            '`monday auth logout` requires `--profile <name>` (or `MONDAY_PROFILE` env)',
            {
              details: {
                hint: 'name the profile whose credentials cache entry should be deleted.',
              },
            },
          );
        }
        authLogoutCommand.inputSchema.parse({ profile: flags.profile });
        await Promise.reject(
          new ApiError(
            'internal_error',
            '`monday auth logout` is a v0.3-M21 pre-flight stub — runtime body lands at M21 implementation alongside the credentials-cache delete primitive.',
            {
              details: {
                profile: flags.profile,
                hint: 'M21 implementation kickoff lands `deleteProfileCredentials` + replaces this stub with the real action body.',
              },
            },
          ),
        );
      });
  },
};
