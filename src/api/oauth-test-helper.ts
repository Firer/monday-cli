/**
 * `__test_oauth_helper` test seam per cli-design §7.3.4.
 *
 * Substitutes for {@link bindOAuthListener} when the env var
 * `__test_oauth_helper` is set; production code paths never see this
 * helper. The substitution lives in `src/commands/auth/login.ts` —
 * this module exposes the construction primitive.
 *
 * **Fixture file shape** (read from the path the env var holds):
 *
 * ```json
 * {
 *   "code": "fixture-code",
 *   "force_csrf_mismatch": true,
 *   "force_user_denied": true,
 *   "force_authorization_failed": {
 *     "error": "invalid_scope",
 *     "error_description": "requested scope `boards:write` not granted"
 *   },
 *   "force_listener_timeout": true
 * }
 * ```
 *
 * All four `force_*` flags are mutually exclusive; the first
 * non-undefined slot wins. The fixture **does not** carry `state` —
 * it's randomly generated per invocation; the helper synthesises the
 * redirect with the CLI's own generated `state` echoed back so CSRF
 * verification passes by default.
 *
 * The fixture's PATH (the env var's value) is never echoed to the
 * output envelope, never logged at any verbosity level, and is
 * scrubbed from `--debug` output the same way `MONDAY_API_TOKEN` is.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ApiError, ConfigError, asError } from '../utils/errors.js';
import type { OAuthListenerHandle, RedirectPayload } from './oauth.js';

/** Env var name the test seam checks. The leading double-underscore
 * discourages production use; tests set it explicitly. */
export const TEST_OAUTH_HELPER_ENV_VAR = '__test_oauth_helper';

const fixtureSchema = z
  .object({
    code: z.string().min(1),
    force_csrf_mismatch: z.literal(true).optional(),
    force_user_denied: z.literal(true).optional(),
    force_authorization_failed: z
      .object({
        error: z.string().min(1),
        error_description: z.string().optional(),
      })
      .strict()
      .optional(),
    force_listener_timeout: z.literal(true).optional(),
  })
  .strict();

export type TestOAuthFixture = z.infer<typeof fixtureSchema>;

/**
 * Reads the test-helper fixture file and parses it. Surfaces
 * `config_error` for any failure (file missing, malformed JSON,
 * schema mismatch); a misconfigured test seam should fail loud,
 * not silently fall back to the real listener.
 */
export const readTestOAuthFixture = async (
  fixturePath: string,
): Promise<TestOAuthFixture> => {
  let raw: string;
  try {
    raw = await readFile(fixturePath, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `cannot read __test_oauth_helper fixture at ${fixturePath}`,
      {
        cause: asError(err),
        details: {
          path: fixturePath,
          hint: 'set __test_oauth_helper to the path of a valid fixture file or unset the env var to use the real OAuth listener',
        },
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `__test_oauth_helper fixture at ${fixturePath} is not valid JSON`,
      {
        cause: asError(err),
        details: { path: fixturePath },
      },
    );
  }
  const result = fixtureSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `__test_oauth_helper fixture at ${fixturePath} does not match the documented shape`,
      {
        cause: result.error,
        details: {
          path: fixturePath,
          issues: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      },
    );
  }
  return result.data;
};

/**
 * Builds a synthetic {@link OAuthListenerHandle} from the fixture +
 * the CLI's generated `state`. No real socket bind; `awaitRedirect`
 * resolves (or rejects) based on the fixture's `force_*` flags.
 */
export const buildTestOAuthListener = (
  fixture: TestOAuthFixture,
  generatedState: string,
): OAuthListenerHandle => {
  let resolved = false;
  const handle: OAuthListenerHandle = {
    port: 0,
    awaitRedirect: () =>
      new Promise<RedirectPayload>((resolve, reject) => {
        if (resolved) {
          // Idempotent — repeat awaits are a programmer error in
          // production, but the test seam guards explicitly so a
          // double-await fails loud rather than hanging forever.
          reject(
            new ApiError(
              'internal_error',
              '__test_oauth_helper.awaitRedirect called twice',
            ),
          );
          return;
        }
        resolved = true;

        if (fixture.force_listener_timeout === true) {
          // Mirror the real listener's timeout payload exactly so the
          // command-level error mapping treats both surfaces
          // identically.
          reject(
            new ApiError(
              'oauth_failed',
              'OAuth listener timed out before the redirect arrived (test fixture)',
              {
                details: {
                  reason: 'timeout',
                  hint: 're-run `monday auth login` and complete the consent flow within 5 minutes',
                },
                retryable: true,
              },
            ),
          );
          return;
        }

        if (fixture.force_csrf_mismatch === true) {
          // Substitute a different state so the caller's verifyCsrf
          // call fails. Length-equal so the timing-safe path runs
          // (mirrors the production CSRF code path; not just a
          // length-mismatch shortcut).
          const sameLengthDifferentState = generatedState
            .split('')
            .reverse()
            .join('');
          // Ensure it's actually different — if `generatedState` is
          // a palindrome (vanishingly rare), flip the first byte.
          const echoed =
            sameLengthDifferentState === generatedState
              ? `${String.fromCharCode(
                  (generatedState.charCodeAt(0) ^ 1) & 0x7f,
                )}${generatedState.slice(1)}`
              : sameLengthDifferentState;
          resolve({ kind: 'code', code: fixture.code, state: echoed });
          return;
        }

        if (fixture.force_user_denied === true) {
          resolve({
            kind: 'error',
            error: 'access_denied',
            errorDescription: undefined,
            state: generatedState,
          });
          return;
        }

        if (fixture.force_authorization_failed !== undefined) {
          resolve({
            kind: 'error',
            error: fixture.force_authorization_failed.error,
            errorDescription:
              fixture.force_authorization_failed.error_description,
            state: generatedState,
          });
          return;
        }

        // Default: success path with the CLI's own state echoed back.
        resolve({
          kind: 'code',
          code: fixture.code,
          state: generatedState,
        });
      }),
    close: () => {
      // No-op — no socket to close.
    },
  };
  return handle;
};
