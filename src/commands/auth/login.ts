/**
 * `monday auth login --profile <name>` — OAuth flow + credentials cache
 * write per cli-design §7.3 / §7.4 (v0.3-plan §3 M21).
 *
 * **v0.3-M21 pre-flight stub.** The verb is registered for forward-
 * compatibility — agent scripts targeting `monday auth login` are
 * stable across the M21 implementation drop — and rejects every
 * invocation today with `internal_error` carrying the M21-pending
 * hint. The argv shape (`--profile <name>` global flag, no
 * positional) is the final shape the M21 implementation ships
 * against; only the action body changes.
 *
 * **Output schema is the future-shape envelope** (per §7.3.1 step 8):
 * `{profile, account_id, scopes}`. Today the verb always rejects so
 * this schema never validates a real payload — it ships for the
 * `monday schema` introspection surface and the future drop-in.
 *
 * **What lands at M21 implementation:**
 *   - Generate per-attempt `state` via {@link generateOAuthState}.
 *   - Bind the listener via {@link bindOAuthListener} (fixed port —
 *     {@link OAUTH_DEFAULT_PORT}).
 *   - Open the browser to the consent URL; print the URL to stderr
 *     as a headless-friendly fallback (cli-design §7.3.1 step 3).
 *   - Wait for the redirect, verify CSRF via {@link verifyCsrf},
 *     exchange the code via {@link exchangeCode}.
 *   - Post-exchange `account { id }` query for the success-envelope
 *     `account_id` (probe-confirmed string-typed: e.g.,
 *     `"34900083"`).
 *   - Persist via
 *     {@link import('../../config/credentials.js').setProfileCredentials}.
 *   - Emit success envelope per §7.3.1 step 8.
 *
 * **The token itself never appears in `data`** per §7.4.3 redaction
 * discipline + .claude/rules/security.md. The success envelope's
 * `account_id` + `scopes` echo the OAuth-app-granted scope set so
 * agents can self-audit without re-running the flow.
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

const loginOutputSchema = z
  .object({
    profile: z.string().min(1),
    account_id: z.string().min(1),
    scopes: z.array(z.string()),
  })
  .strict();

export type AuthLoginOutput = z.infer<typeof loginOutputSchema>;

export const authLoginCommand: CommandModule<
  z.infer<typeof inputSchema>,
  AuthLoginOutput
> = {
  name: 'auth.login',
  summary:
    'OAuth flow that writes a per-profile credentials cache entry (v0.3-M21 pre-flight stub — runtime body lands at M21 implementation)',
  examples: [
    'monday auth login --profile work',
    'monday auth login --profile personal',
  ],
  // OAuth flow itself is non-idempotent (each `code` is single-use
  // per OAuth's spec) — but the credentials-write layer is
  // idempotent (re-running overwrites the named profile entry per
  // §7.3.2). The contract-level shape is "running this verb leaves
  // the named profile authenticated" so we report `idempotent: true`
  // — agent retries against the same `--profile` are safe.
  idempotent: true,
  inputSchema,
  outputSchema: loginOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(
      program,
      'auth',
      'OAuth-issued credentials cache (v0.3-M21; cli-design §7.3 / §7.4)',
    );
    noun
      .command('login')
      .description(authLoginCommand.summary)
      // `--profile <name>` is the global flag (cli-design §4.4); this
      // command does NOT redeclare it — commander attaches global
      // flags to the parent `program`. The action reads
      // `program.opts().profile` and surfaces `usage_error` when
      // missing.
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...authLoginCommand.examples.map((e) => `  ${e}`),
          '',
          'NOTE: Pre-flight stub — runtime OAuth body lands at v0.3-M21',
          'implementation. The verb registers the argv shape so agent',
          'scripts targeting `monday auth login --profile <name>` are',
          'stable across the M21 drop-in.',
          '',
        ].join('\n'),
      )
      // The action is async even though the body is synchronous —
      // commander routes async-rejection-shaped errors through to
      // the runner's catch-all envelope mapper, while sync throws
      // can be swallowed by commander's own error path. Mirrors the
      // M20 time-track stub's async-action pattern.
      .action(async () => {
        const flags = parseGlobalFlags(program.opts(), ctx.env);
        if (flags.profile === undefined || flags.profile.length === 0) {
          throw new UsageError(
            '`monday auth login` requires `--profile <name>` (or `MONDAY_PROFILE` env)',
            {
              details: {
                hint: 'each profile authenticates against a (possibly different) Monday account; the credentials cache is per-profile so the verb cannot infer a target.',
              },
            },
          );
        }
        // Validate the resolved profile name through the input
        // schema so any future tightening of the rules (e.g.,
        // disallowed characters) lives in one place.
        authLoginCommand.inputSchema.parse({ profile: flags.profile });
        // Pre-flight stub — every invocation rejects. M21
        // implementation replaces this with the real OAuth flow per
        // cli-design §7.3.1.
        await Promise.reject(
          new ApiError(
            'internal_error',
            '`monday auth login` is a v0.3-M21 pre-flight stub — runtime OAuth body lands at M21 implementation alongside the listener + token-exchange wire calls.',
            {
              details: {
                profile: flags.profile,
                hint: 'M21 implementation kickoff (next session) registers the OAuth app at Monday\'s developer portal, lands the listener + token-exchange in `src/api/oauth.ts`, and replaces this stub with the real action body.',
              },
            },
          ),
        );
      });
  },
};
