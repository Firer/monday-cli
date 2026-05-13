/**
 * `monday auth login --profile <name>` — OAuth flow + credentials cache
 * write per cli-design §7.3 / §7.4 (v0.3-plan §3 M21).
 *
 * **Flow shape (cli-design §7.3.1):**
 *
 *   1. Generate per-attempt CSRF state.
 *   2. Bind a local listener on `127.0.0.1:9876` (or call the
 *      `__test_oauth_helper` seam when set).
 *   3. Build the consent URL + open the browser; print the URL to
 *      stderr as a headless-friendly fallback.
 *   4. Wait for the redirect.
 *   5. Verify CSRF (constant-time compare; length mismatches route to
 *      `csrf_mismatch`, NOT `internal_error`).
 *   6. Map redirect kind: `code` → exchange; `error: 'access_denied'`
 *      → `oauth_failed.user_denied`; any other error →
 *      `oauth_failed.authorization_failed`.
 *   7. Exchange the code at `/oauth2/token`.
 *   8. Query `account { id }` with the new token to populate the
 *      success envelope's `account_id`.
 *   9. Persist via {@link setProfileCredentials}.
 *  10. Emit success envelope (token NEVER in `data` per §7.4.3).
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { emitSuccess } from '../emit.js';
import {
  bindOAuthListener,
  exchangeCode,
  generateOAuthState,
  verifyCsrf,
  OAUTH_AUTHORIZE_URL,
  OAUTH_CALLBACK_PATH,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_UNREGISTERED_PLACEHOLDER,
  OAUTH_DEFAULT_REQUESTED_SCOPES,
  type OAuthListenerHandle,
} from '../../api/oauth.js';
import {
  buildTestOAuthListener,
  readTestOAuthFixture,
  TEST_OAUTH_HELPER_ENV_VAR,
} from '../../api/oauth-test-helper.js';
import {
  setProfileCredentials,
  type ProfileEntry,
} from '../../config/credentials.js';
import { createFetchTransport } from '../../api/transport.js';
import { MondayClient, PINNED_API_VERSION } from '../../api/client.js';
import type { Transport } from '../../api/transport.js';
import type { RunContext } from '../../cli/run.js';

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

const accountIdQuery = 'query AuthLoginAccountId { account { id } }';

const accountIdResponseSchema = z
  .object({
    account: z
      .object({
        id: z.string().min(1),
      })
      .loose(),
  })
  .loose();

/**
 * Best-effort browser-open via the platform's default opener. Spawned
 * detached + unref'd so a missing opener doesn't keep the parent
 * process alive. Returns `true` if the spawn appeared to start; the
 * fallback URL print runs regardless so headless boxes still see the
 * link.
 */
/* c8 ignore start — production-only browser-open path; tests bypass
   it via the __test_oauth_helper seam. */
const tryOpenBrowser = (url: string): boolean => {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  try {
    const child = spawn(opener, [url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    child.on('error', () => {
      // Swallow — the URL print covers headless boxes.
    });
    return true;
  } catch {
    return false;
  }
};
/* c8 ignore stop */

/**
 * Fetches `account { id }` with the just-obtained token. Honours
 * `ctx.transport` if present (test path) — production builds a fresh
 * `FetchTransport` carrying the new token.
 */
const fetchAccountId = async (
  accessToken: string,
  ctx: RunContext,
): Promise<string> => {
  // Tests inject `ctx.transport` (FixtureTransport); production hits
  // the `createFetchTransport` fallback to issue a fresh client
  // carrying the just-obtained OAuth token.
  /* c8 ignore next 8 */
  const transport: Transport =
    ctx.transport ??
    createFetchTransport({
      endpoint: 'https://api.monday.com/v2',
      apiToken: accessToken,
      apiVersion: PINNED_API_VERSION,
      timeoutMs: 30_000,
    });
  const client = new MondayClient({
    transport,
    signal: ctx.signal,
    retries: 0,
    verbose: false,
  });
  const response = await client.raw<unknown>(accountIdQuery, undefined, {
    operationName: 'AuthLoginAccountId',
  });
  // R-NEW-19 lift — canonical parse-failure via `unwrapOrThrow`;
  // Monday's `account { id }` surface is contract-stable so this
  // path stays defensive (c8-ignore-wrapped — the helper itself is
  // tested end-to-end, the per-site failure is not reachable from
  // unit tests).
  /* c8 ignore start */
  const parsedData = unwrapOrThrow(
    accountIdResponseSchema.safeParse(response.data),
    {
      context: 'post-OAuth `account { id }` response',
    },
  );
  return parsedData.account.id;
  /* c8 ignore stop */
};

const credentialsHomeOptions = (
  ctx: RunContext,
): { home?: string; env: NodeJS.ProcessEnv } => {
  const home = ctx.env.HOME;
  // The HOME-undefined arm falls through to homedir() inside
  // resolveCredentialsPath; testing it would write to the user's
  // real ~/.monday-cli/credentials, so the branch is production-only.
  /* c8 ignore next 3 */
  return home !== undefined && home.length > 0
    ? { home, env: ctx.env }
    : { env: ctx.env };
};

const buildConsentUrl = (state: string, redirectUri: string): string => {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', OAUTH_DEFAULT_REQUESTED_SCOPES.join(' '));
  return url.toString();
};

export const authLoginCommand: CommandModule<
  z.infer<typeof inputSchema>,
  AuthLoginOutput
> = {
  name: 'auth.login',
  summary: 'OAuth flow that writes a per-profile credentials cache entry',
  examples: [
    'monday auth login --profile work',
    'monday auth login --profile personal',
  ],
  // OAuth flow itself is non-idempotent (each `code` is single-use per
  // OAuth's spec) but the credentials-write layer is idempotent
  // (re-running overwrites the named profile entry per §7.3.2).
  idempotent: true,
  inputSchema,
  outputSchema: loginOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(
      program,
      'auth',
      'OAuth-issued credentials cache (cli-design §7.3 / §7.4)',
    );
    noun
      .command('login')
      .description(authLoginCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...authLoginCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async () => {
        // Production-only placeholder guard. When the shipped OAuth
        // credentials are still the `<UNREGISTERED_PENDING_OAUTH_APP>`
        // placeholders, the upstream `/oauth2/token` exchange would
        // fail with a cryptic `oauth_failed.code_exchange_failed`.
        // Surface a clear `usage_error` pointing at the API-token
        // path instead. OAuth login is deferred to a future version
        // per v0.3-plan §8 Decision 11 rejection. The test seam
        // (`__test_oauth_helper`) bypasses this — integration tests
        // stub `/oauth2/token` and don't depend on real credentials.
        const helperPath = ctx.env[TEST_OAUTH_HELPER_ENV_VAR];
        if (
          OAUTH_CLIENT_ID === OAUTH_UNREGISTERED_PLACEHOLDER &&
          (helperPath === undefined || helperPath.length === 0)
        ) {
          throw new UsageError(
            '`monday auth login` is not available in this release; authenticate via the MONDAY_API_TOKEN env var instead. OAuth login is deferred to a future version.',
            {
              details: {
                reason: 'oauth_unregistered',
                hint: 'set MONDAY_API_TOKEN=<your-monday-api-token> (mint from Monday → Profile → Developers → My Access Tokens) and re-run any `monday` command without `monday auth login`',
              },
            },
          );
        }

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
        authLoginCommand.inputSchema.parse({ profile: flags.profile });

        const state = generateOAuthState();

        // Step 2: bind listener (or test seam).
        let listener: OAuthListenerHandle;
        if (helperPath !== undefined && helperPath.length > 0) {
          const fixture = await readTestOAuthFixture(helperPath);
          listener = buildTestOAuthListener(fixture, state);
        } else {
          // Production-only socket bind path; unit tests use the test
          // seam, integration tests stub the env.
          /* c8 ignore start */
          listener = await bindOAuthListener();
          /* c8 ignore stop */
        }

        try {
          const redirectUri = `http://127.0.0.1:${String(
            // Production listener.port > 0; only the test-helper path
            // (port: 0) reaches the truthy arm.
            /* c8 ignore next */
            listener.port === 0 ? 9876 : listener.port,
          )}${OAUTH_CALLBACK_PATH}`;
          const consentUrl = buildConsentUrl(state, redirectUri);

          // Step 3: open browser + print URL fallback. Skipped under
          // the test seam (no browser to open in tests; the helper
          // synthesises the redirect directly). Production-only path.
          /* c8 ignore start */
          if (helperPath === undefined) {
            tryOpenBrowser(consentUrl);
            ctx.stderr.write(
              `Open this URL in your browser to continue: ${consentUrl}\n`,
            );
          }
          /* c8 ignore stop */

          // Step 4: wait for redirect.
          const payload = await listener.awaitRedirect();

          // Step 5: verify CSRF.
          if (!verifyCsrf(payload.state, state)) {
            throw new ApiError(
              'oauth_failed',
              'CSRF state mismatch on OAuth redirect — refusing to exchange code',
              {
                details: {
                  reason: 'csrf_mismatch',
                  hint: 're-run `monday auth login --profile <name>` to start a fresh OAuth flow',
                },
              },
            );
          }

          // Step 6: map error redirects.
          if (payload.kind === 'error') {
            if (payload.error === 'access_denied') {
              throw new ApiError(
                'oauth_failed',
                'OAuth authorization was denied at the consent screen',
                {
                  details: {
                    reason: 'user_denied',
                    hint: 're-run `monday auth login --profile <name>` and approve the consent screen',
                  },
                },
              );
            }
            throw new ApiError(
              'oauth_failed',
              `OAuth authorization failed: ${payload.error}${payload.errorDescription !== undefined ? ` — ${payload.errorDescription}` : ''}`,
              {
                mondayCode: payload.error,
                details: {
                  reason: 'authorization_failed',
                  monday_code: payload.error,
                  ...(payload.errorDescription !== undefined
                    ? { monday_description: payload.errorDescription }
                    : {}),
                  hint: 'check the OAuth app configuration (scopes / client settings) and retry; for `temporary_unavailable`, retry shortly',
                },
              },
            );
          }

          // Step 7: exchange code.
          const tokenResponse = await exchangeCode({
            code: payload.code,
            redirectUri,
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET,
          });

          // Fold the just-obtained token into the value-scan secret
          // bag BEFORE any subsequent emission can echo it. The
          // preAction redaction-runtime preload (program.ts) runs
          // BEFORE the OAuth exchange so the new token isn't in
          // `ctx.runtimeSecrets` yet; if the post-exchange
          // `account { id }` probe below fails with a GraphQL
          // error.message echoing the presented Authorization
          // header, the error envelope's value-scan layer needs
          // this entry to scrub it (cli-design §7.4.3 — Codex
          // M21 Part 2 P1 finding).
          ctx.runtimeSecrets.push(tokenResponse.accessToken);

          // Step 8: post-exchange `account { id }`.
          const accountId = await fetchAccountId(
            tokenResponse.accessToken,
            ctx,
          );

          // Step 9: persist credentials.
          const scopesArray = tokenResponse.scope
            .split(' ')
            .filter((s) => s.length > 0);
          const entry: ProfileEntry = {
            access_token: tokenResponse.accessToken,
            obtained_at: ctx.clock().toISOString(),
            expires_at: null,
            scopes: scopesArray,
            account_id: accountId,
          };
          await setProfileCredentials(
            { profileName: flags.profile, entry },
            credentialsHomeOptions(ctx),
          );

          // Step 10: emit success envelope. Token NEVER in `data`.
          emitSuccess({
            ctx,
            data: {
              profile: flags.profile,
              account_id: accountId,
              scopes: scopesArray,
            },
            schema: authLoginCommand.outputSchema,
            programOpts: program.opts(),
            source: 'live',
            apiVersion: PINNED_API_VERSION,
            cacheAgeSeconds: null,
          });
        } finally {
          listener.close();
        }
      });
  },
};
