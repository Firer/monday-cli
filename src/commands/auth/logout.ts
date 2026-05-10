/**
 * `monday auth logout --profile <name>` — deletes the named profile's
 * entry from the credentials cache per cli-design §7.3.2 (v0.3-plan
 * §3 M21).
 *
 * Idempotent — deletes the named profile entry; no-op + `ok: true`
 * with `was_present: false` on a missing entry. NOT under the
 * destructive-confirmation gate (§3.1) — credential rotation is a
 * routine agent operation, not data mutation requiring `--yes`.
 *
 * When the post-delete profiles map is empty, the credentials file
 * is **still written** as `{schema_version: '1', profiles: {}}`
 * rather than deleted outright (cli-design §7.3.2 — keeps the
 * schema-version pin discoverable + avoids fresh-install ambiguity).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { UsageError } from '../../utils/errors.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { emitSuccess } from '../emit.js';
import { deleteProfileCredentials } from '../../config/credentials.js';
import { PINNED_API_VERSION } from '../../api/client.js';
import type { RunContext } from '../../cli/run.js';

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

const credentialsHomeOptions = (
  ctx: RunContext,
): { home?: string; env: NodeJS.ProcessEnv } => {
  const home = ctx.env.HOME;
  return home !== undefined && home.length > 0
    ? { home, env: ctx.env }
    : { env: ctx.env };
};

export const authLogoutCommand: CommandModule<
  z.infer<typeof inputSchema>,
  AuthLogoutOutput
> = {
  name: 'auth.logout',
  summary: 'Delete a profile\'s credentials cache entry',
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
      'OAuth-issued credentials cache (cli-design §7.3 / §7.4)',
    );
    noun
      .command('logout')
      .description(authLogoutCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...authLogoutCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
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

        const result = await deleteProfileCredentials(
          flags.profile,
          credentialsHomeOptions(ctx),
        );

        emitSuccess({
          ctx,
          data: {
            profile: flags.profile,
            was_present: result.wasPresent,
          },
          schema: authLogoutCommand.outputSchema,
          programOpts: program.opts(),
          source: 'none',
          apiVersion: PINNED_API_VERSION,
          cacheAgeSeconds: null,
        });
      });
  },
};
