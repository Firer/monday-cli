/**
 * OAuth flow primitives for the v0.3-M21 `monday auth login` /
 * `monday auth logout` verbs (cli-design §7.3 / §7.4).
 *
 * **Empirical probe findings (2026-05-10, against `auth.monday.com`):**
 *
 *   - `/oauth2/authorize` accepts arbitrary query params and encodes
 *     them all into a JWT-signed `oauth_payload_token`, then 302-
 *     redirects to `https://auth.monday.com/login?oauth_payload_token=<jwt>`.
 *     Extra params like `code_challenge` + `code_challenge_method=S256`
 *     are silently round-tripped through the JWT but **not enforced**
 *     at token-exchange time — Monday's `/oauth2/token` requires
 *     `client_secret` regardless. Verbatim probe response when the
 *     PKCE-shape exchange omits `client_secret`:
 *     `{"error":"invalid_request","error_description":"Missing client_secret param"}`
 *     (status 400). PKCE is therefore **not load-bearing for v0.3**;
 *     the design ships without `code_challenge` / `code_verifier`.
 *
 *   - `/oauth2/token` rejection responses follow RFC 6749 standard
 *     shape (status 400, `application/json; charset=utf-8`):
 *     `{"error": "<code>", "error_description": "<text>"}` where
 *     `<code>` is `invalid_request` for missing/invalid params; other
 *     standard codes (`invalid_grant`, `invalid_client`,
 *     `unauthorized_client`, etc.) are reachable in the live flow but
 *     not surfaced by the probe (no real OAuth app registered yet).
 *
 *   - `client_secret` is **required**: Monday rejects every probe
 *     attempt that omits it. The CLI ships with a pinned
 *     `OAUTH_CLIENT_SECRET` per the public-OAuth-client convention —
 *     the secret authenticates the *app* (monday-cli), not the user;
 *     user-flow protection comes from the per-attempt `state` CSRF
 *     token + the listener-bound `redirect_uri`.
 *
 *   - Redirect URI matching is documented as exact (Monday Apps
 *     OAuth docs); the probe couldn't empirically test wildcard
 *     acceptance without a registered app, but the published "must
 *     match" wording rules out ephemeral `127.0.0.1:0` ports. Design
 *     ships a fixed port (`OAUTH_DEFAULT_PORT`); the OAuth app's
 *     redirect URI configuration pins this port.
 *
 *   - Token response shape per Monday's docs (probe-confirmed at the
 *     error envelope; success-shape pins to docs verbatim until M21
 *     implementation runs the full flow): `{access_token, token_type,
 *     scope}`. **No `expires_in`**; Monday tokens "do not expire and
 *     are valid until the user uninstalls your app" (Monday Apps
 *     OAuth docs). `expires_at` in the credentials cache (§7.4.1) is
 *     pinned `null` for v0.3.
 *
 * **Module surface.** Five exports:
 *
 *   - `generateOAuthState(): string` — pure helper. 32-byte
 *     `crypto.randomBytes` → base64url. No I/O.
 *   - `verifyCsrf(received, expected): boolean` — constant-time
 *     comparison via `crypto.timingSafeEqual` with explicit length
 *     guard so length-mismatched buffers route to `csrf_mismatch`
 *     rather than `internal_error` (cli-design §7.3.1 step 5).
 *   - `bindOAuthListener({port?, timeoutMs?})` — binds an HTTP
 *     listener on `127.0.0.1` at the given port (default
 *     `OAUTH_DEFAULT_PORT`); returns a handle exposing
 *     `awaitRedirect()` + `close()`. **Stub-body** — throws
 *     `internal_error` until M21 implementation lands the listener.
 *   - `exchangeCode(...)` — `POST /oauth2/token` with
 *     `application/x-www-form-urlencoded` body containing
 *     `grant_type=authorization_code&code&client_id&client_secret&redirect_uri`.
 *     **Stub-body** — throws `internal_error` until M21 implementation
 *     ships the live exchange.
 *   - Constants `OAUTH_AUTHORIZE_URL`, `OAUTH_TOKEN_URL`,
 *     `OAUTH_DEFAULT_PORT`, `OAUTH_CALLBACK_PATH`,
 *     `OAUTH_DEFAULT_LISTENER_TIMEOUT_MS`, `OAUTH_SCOPES` (the
 *     documented Monday scope list).
 *
 * **What's deferred to M21 implementation (NOT this pre-flight):**
 *
 *   - `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` — pinned in source at
 *     M21 implementation kickoff once an OAuth app is registered for
 *     monday-cli at Monday's developer portal. The pre-flight stubs
 *     reject every call so this can't yet route through.
 *   - The listener body itself (`node:http` + path/state validation
 *     + 5-min timer + AbortController plumbing).
 *   - The token-exchange body (`fetch` against `OAUTH_TOKEN_URL` +
 *     RFC 6749 error mapping + zod validation of the success
 *     response).
 *   - The success-envelope `account_id` post-exchange query
 *     (`account { id }` GraphQL — confirmed string-typed by the
 *     probe, e.g., `"34900083"`).
 *
 * **No PKCE in v0.3.** The cli-design §7.3.1 step 1 originally
 * proposed PKCE with `client_secret` fallback; the empirical probe
 * confirmed `client_secret` is mandatory regardless, so PKCE is
 * non-load-bearing complexity dropped from the v0.3 wire shape. A
 * future PKCE upgrade is a separate cli-design §7.3 amendment with
 * its own Codex review.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../utils/errors.js';

/** Monday Apps OAuth authorize endpoint. */
export const OAUTH_AUTHORIZE_URL = 'https://auth.monday.com/oauth2/authorize';

/** Monday Apps OAuth token-exchange endpoint. */
export const OAUTH_TOKEN_URL = 'https://auth.monday.com/oauth2/token';

/**
 * Default port for the local-loopback OAuth callback listener. Pinned
 * to `9876` to match the design fallback in cli-design §7.3.1 step 2;
 * the OAuth app's redirect URI configuration pins this port. A
 * collision with another `monday auth login` invocation surfaces as
 * `oauth_failed.reason: "port_in_use"` rather than `internal_error`.
 */
export const OAUTH_DEFAULT_PORT = 9876;

/** Path the listener answers; the OAuth app's redirect URI pins this. */
export const OAUTH_CALLBACK_PATH = '/callback';

/** Default listener timeout: 5 minutes (cli-design §7.3.1 step 4). */
export const OAUTH_DEFAULT_LISTENER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Documented Monday Apps OAuth scopes per Monday's published docs at
 * the M21 pre-flight probe (2026-05-10). Each entry is exposed
 * verbatim so the OAuth-app-registration step (M21 implementation
 * kickoff) can request the subset the CLI actually needs without a
 * second source-of-truth elsewhere. The CLI's own scope-request set
 * is a subset chosen at M21 implementation alongside the OAuth-app
 * registration.
 */
export const OAUTH_SCOPES = [
  'account:read',
  'assets:read',
  'boards:read',
  'boards:write',
  'departments:read',
  'departments:write',
  'docs:read',
  'docs:write',
  'me:read',
  'notifications:write',
  'tags:read',
  'teams:read',
  'teams:write',
  'updates:read',
  'updates:write',
  'users:read',
  'users:write',
  'webhooks:read',
  'webhooks:write',
  'workspaces:read',
  'workspaces:write',
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/**
 * The redirect payload as parsed by the listener. Either a successful
 * authorisation code with the echoed `state`, or a Monday-side error
 * with the echoed `state` so CSRF verification runs before the error
 * is folded into the envelope.
 *
 * Monday's authorize endpoint surfaces standard RFC 6749 error
 * responses (`access_denied` if the user clicks "Cancel"; documented
 * codes also include `invalid_scope`, `unauthorized_client`,
 * `server_error`, `temporary_unavailable`). M21 implementation maps:
 *
 *   - `access_denied` →
 *     `oauth_failed.details.reason: "user_denied"`
 *   - any other documented `error` code →
 *     `oauth_failed.details.reason: "authorization_failed"`
 *     with `details.monday_code` carrying the redirect's `error`
 *     and `details.monday_description` carrying the redirect's
 *     `error_description`.
 */
export type RedirectPayload =
  | { readonly kind: 'code'; readonly code: string; readonly state: string }
  | {
      readonly kind: 'error';
      readonly error: string;
      readonly errorDescription: string | undefined;
      readonly state: string;
    };

/**
 * Inputs to {@link bindOAuthListener}. Both fields optional with
 * pinned defaults — production callers pass nothing; tests inject
 * via `__test_oauth_helper` per cli-design §7.3.4.
 */
export interface BindOAuthListenerInputs {
  readonly port?: number;
  readonly timeoutMs?: number;
}

/**
 * Handle returned from {@link bindOAuthListener}. Decoupled from
 * `node:http`'s `Server` so tests can substitute a fixture handle
 * without a real socket bind.
 */
export interface OAuthListenerHandle {
  /** The bound port — equals the input or {@link OAUTH_DEFAULT_PORT}. */
  readonly port: number;
  /**
   * Resolves with the next redirect's parsed payload, or rejects
   * with an `ApiError` whose `code` is `oauth_failed` carrying the
   * appropriate `details.reason` (`timeout` if the in-process timer
   * fired before any redirect arrived). Does **not** verify CSRF —
   * caller runs {@link verifyCsrf} against the resolved payload.
   */
  readonly awaitRedirect: () => Promise<RedirectPayload>;
  /** Best-effort close — idempotent + safe after `awaitRedirect` settles. */
  readonly close: () => void;
}

/**
 * Inputs to {@link exchangeCode}. Mirror Monday's documented
 * `/oauth2/token` body shape verbatim. `clientSecret` is **required**
 * per the empirical probe; PKCE-only is not supported.
 */
export interface ExchangeCodeInputs {
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Raw `/oauth2/token` success-response body shape per Monday Apps
 * OAuth docs. Snake_case wire field names match Monday's response
 * verbatim — M21 implementation parses the `fetch` response body
 * through a zod schema (added alongside the runtime body, NOT
 * shipped in pre-flight) into this shape, then normalizes to
 * {@link TokenResponse}.
 */
export interface RawTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly scope: string;
}

/**
 * Normalized success-response shape that {@link exchangeCode} returns
 * to its callers. CamelCase per the project's TS convention; the
 * snake_case → camelCase normalization happens inside `exchangeCode`'s
 * runtime body (M21 implementation) so the camelCase shape is the
 * stable contract for `commands/auth/login.ts`'s consumer code.
 *
 * **No `expires_in`** — Monday's docs explicitly state tokens "do
 * not expire and are valid until the user uninstalls your app". The
 * credentials cache's `expires_at` slot (§7.4.1) is pinned `null`
 * for v0.3; if a future Monday API ever adds `expires_in`, the field
 * grows here and {@link RawTokenResponse} alongside it without
 * bumping `schema_version` (the on-disk shape already accepts
 * `string | null`).
 */
export interface TokenResponse {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly scope: string;
}

/**
 * Generates a 32-byte cryptographically-random `state` token, encoded
 * base64url for inclusion in the authorise URL. Pure helper — no I/O.
 *
 * Length is 43 chars (base64url-encoded 32 bytes), well above the
 * 8-char minimum the OAuth 2.0 RFC suggests for CSRF tokens. Random
 * source is `crypto.randomBytes`, which uses the OS-level CSPRNG.
 */
export const generateOAuthState = (): string => {
  return randomBytes(32).toString('base64url');
};

/**
 * Constant-time CSRF comparison. The redirect's `state` query param
 * must equal the per-attempt `state` byte-for-byte; mismatched
 * lengths fail without invoking `crypto.timingSafeEqual` (which
 * throws on length mismatch — the throw would route to
 * `internal_error` rather than the security-signal-correct
 * `csrf_mismatch`). All other length-pair comparisons go through
 * the timing-safe path so a partial-prefix match doesn't leak via
 * comparison-time timing.
 *
 * Returns `false` on any mismatch including the empty-string case;
 * caller surfaces `oauth_failed.reason: "csrf_mismatch"` on `false`
 * without invoking the token-exchange step.
 */
export const verifyCsrf = (received: string, expected: string): boolean => {
  const receivedBytes = Buffer.from(received, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (receivedBytes.length !== expectedBytes.length) {
    return false;
  }
  if (receivedBytes.length === 0) {
    return false;
  }
  return timingSafeEqual(receivedBytes, expectedBytes);
};

/**
 * Stub-body for the OAuth listener bind. M21 implementation replaces
 * with `node:http` server creation, listening at
 * `127.0.0.1:<port>`, single-request handler matching
 * `${OAUTH_CALLBACK_PATH}?code=…&state=…` (or `?error=…&state=…`),
 * and a 5-minute `setTimeout` (cancellable via `AbortController` so
 * SIGINT closes the listener cleanly per cli.md "Signal handling").
 *
 * Intentionally throws synchronously rather than returning a half-
 * built handle — pre-flight callers should never reach this in a
 * happy path; M21 implementation replaces the body wholesale.
 */
/* c8 ignore next 14 — pre-flight stub-body. M21 implementation
   replaces with the real listener. */
export const bindOAuthListener = (
  _inputs: BindOAuthListenerInputs = {},
): Promise<OAuthListenerHandle> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      '`bindOAuthListener` is a v0.3-M21 pre-flight stub — the listener body lands at M21 implementation alongside `monday auth login`.',
      {
        details: {
          hint: 'M21 implementation kickoff registers the OAuth app at Monday\'s developer portal and replaces this stub with the real listener.',
        },
      },
    ),
  );

/**
 * Stub-body for the `/oauth2/token` exchange. M21 implementation
 * replaces with a `fetch(OAUTH_TOKEN_URL, { method: 'POST', body:
 * urlencoded, headers })` call, parses the response (RFC 6749
 * standard error shape on 4xx; `{access_token, token_type, scope}`
 * on 200), and maps Monday's `error` field to
 * `oauth_failed.reason: "code_exchange_failed"` with
 * `details.monday_code: <error>` + `details.monday_description:
 * <error_description>`.
 *
 * Pre-flight throws with the same M21-stub hint as
 * {@link bindOAuthListener} so accidental invocations during
 * pre-flight tests surface a clear "not yet implemented" envelope.
 */
/* c8 ignore next 14 — pre-flight stub-body. M21 implementation
   replaces with the real exchange. */
export const exchangeCode = (
  _inputs: ExchangeCodeInputs,
): Promise<TokenResponse> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      '`exchangeCode` is a v0.3-M21 pre-flight stub — the token-exchange body lands at M21 implementation alongside `monday auth login`.',
      {
        details: {
          hint: 'M21 implementation kickoff registers the OAuth app at Monday\'s developer portal and replaces this stub with the real exchange.',
        },
      },
    ),
  );
