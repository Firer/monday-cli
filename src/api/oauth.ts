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
 *     `{"error": "<code>", "error_description": "<text>"}`.
 *
 *   - Redirect URI matching is documented as exact (Monday Apps
 *     OAuth docs); design ships fixed-port `127.0.0.1:9876`.
 *
 *   - Token response shape per Monday's docs:
 *     `{access_token, token_type, scope}`. **No `expires_in`**;
 *     Monday tokens "do not expire and are valid until the user
 *     uninstalls your app".
 *
 * **OAuth client registration (M21 implementation Part 1).**
 * `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` are pinned in source
 * per the public-OAuth-client convention — the secret authenticates
 * the *app* (monday-cli), not the user. The user's flow is
 * protected by the per-attempt `state` CSRF token + the listener-
 * bound `redirect_uri`. **Until an OAuth app is registered with
 * Monday's developer portal, the constants below carry placeholder
 * values; production users see `oauth_failed.reason:
 * "code_exchange_failed"` until they're swapped pre-publish.**
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiError } from '../utils/errors.js';
import { z } from 'zod';

/** Monday Apps OAuth authorize endpoint. */
export const OAUTH_AUTHORIZE_URL = 'https://auth.monday.com/oauth2/authorize';

/** Monday Apps OAuth token-exchange endpoint. */
export const OAUTH_TOKEN_URL = 'https://auth.monday.com/oauth2/token';

/**
 * Default port for the local-loopback OAuth callback listener. Pinned
 * to `9876` to match cli-design §7.3.1 step 2; the OAuth app's
 * redirect URI configuration pins this port.
 */
export const OAUTH_DEFAULT_PORT = 9876;

/** Path the listener answers; the OAuth app's redirect URI pins this. */
export const OAUTH_CALLBACK_PATH = '/callback';

/** Default listener timeout: 5 minutes (cli-design §7.3.1 step 4). */
export const OAUTH_DEFAULT_LISTENER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * **PLACEHOLDER — replace with the registered Monday OAuth app's
 * client_id pre-publish.** Tests do not depend on the value
 * (cassettes intercept `/oauth2/token`); production users hit
 * `oauth_failed.reason: "code_exchange_failed"` until swapped.
 *
 * Register at https://developer.monday.com/apps with redirect URI
 * exactly `http://127.0.0.1:9876/callback`.
 */
export const OAUTH_CLIENT_ID = '<UNREGISTERED_PENDING_OAUTH_APP>';

/**
 * **PLACEHOLDER — replace alongside {@link OAUTH_CLIENT_ID}.** Same
 * pre-publish swap; see {@link OAUTH_CLIENT_ID} for context.
 */
export const OAUTH_CLIENT_SECRET = '<UNREGISTERED_PENDING_OAUTH_APP>';

/**
 * Documented Monday Apps OAuth scopes per Monday's published docs at
 * the M21 pre-flight probe (2026-05-10). Each entry is exposed
 * verbatim so the OAuth-app-registration step (M21 implementation
 * Part 1) can request the subset the CLI actually needs without a
 * second source-of-truth elsewhere.
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
 * The default scope set requested by `monday auth login` — a working
 * subset of {@link OAUTH_SCOPES}. Agents calling `monday auth login`
 * without a `--scopes` flag (v0.4+) pick up these.
 */
export const OAUTH_DEFAULT_REQUESTED_SCOPES: readonly OAuthScope[] = [
  'account:read',
  'boards:read',
  'boards:write',
  'me:read',
  'tags:read',
  'updates:read',
  'updates:write',
  'users:read',
];

/**
 * The redirect payload as parsed by the listener.
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
 * pinned defaults.
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
  readonly port: number;
  readonly awaitRedirect: () => Promise<RedirectPayload>;
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
  /** Optional fetch-impl override for tests. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Raw `/oauth2/token` success-response body shape per Monday Apps
 * OAuth docs.
 */
export interface RawTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly scope: string;
}

/**
 * Normalized success-response shape that {@link exchangeCode} returns.
 */
export interface TokenResponse {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly scope: string;
}

// `.loose()` so a Monday-side extension field (e.g., `expires_in` if
// Monday ever adds it) doesn't fail the parse. Forward-compatible
// widening: a field added by Monday lands in a Part 2+ amendment that
// surfaces it.
const rawTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    scope: z.string(),
  })
  .loose();

const rfc6749ErrorSchema = z
  .object({
    error: z.string().min(1),
    error_description: z.string().optional(),
  })
  .loose();

/**
 * Generates a 32-byte cryptographically-random `state` token, encoded
 * base64url. Pure helper — no I/O.
 */
export const generateOAuthState = (): string => {
  return randomBytes(32).toString('base64url');
};

/**
 * Constant-time CSRF comparison. Returns `false` on length mismatch
 * (without throwing — cli-design §7.3.1 step 5 routes that to
 * `csrf_mismatch`, NOT `internal_error`). Returns `false` on the
 * empty-string case.
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

const STATIC_SUCCESS_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>monday-cli</title>' +
  '<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#1f2d3d;}</style>' +
  '</head><body><h1>monday-cli</h1><p>You can close this tab now.</p></body></html>';

/**
 * Binds an HTTP listener on `127.0.0.1:<port>`, waits for a single
 * redirect to `${OAUTH_CALLBACK_PATH}?code=…&state=…` (or
 * `?error=…&state=…`), and returns a handle whose `awaitRedirect`
 * resolves with the parsed payload.
 *
 * Failure surfaces:
 *   - Bind error (port held by another process or peer
 *     `monday auth login`) → reject with `oauth_failed.reason:
 *     "port_in_use"`.
 *   - 5-minute timer elapses with no redirect → reject with
 *     `oauth_failed.reason: "timeout"` (retryable: true; mirrors
 *     M2-era cache_error override-at-throw-site precedent).
 */
export const bindOAuthListener = (
  inputs: BindOAuthListenerInputs = {},
): Promise<OAuthListenerHandle> => {
  const requestedPort = inputs.port ?? OAUTH_DEFAULT_PORT;
  const timeoutMs = inputs.timeoutMs ?? OAUTH_DEFAULT_LISTENER_TIMEOUT_MS;

  return new Promise<OAuthListenerHandle>((resolveBind, rejectBind) => {
    let pendingPayload: RedirectPayload | undefined;
    let redirectResolver:
      | ((payload: RedirectPayload) => void)
      | undefined;
    let closed = false;

    const server = createServer(
      (req: IncomingMessage, res: ServerResponse): void => {
        const url = req.url ?? '/';
        const parsed = (() => {
          try {
            return new URL(url, `http://127.0.0.1`);
          } catch {
            // Defensive: a malformed URL string from Node's http parser is
            // vanishingly rare; the catch guard keeps the listener loud
            // rather than crashing.
            /* c8 ignore next */
            return undefined;
          }
        })();
        if (parsed?.pathname !== OAUTH_CALLBACK_PATH) {
          res.statusCode = 404;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end('not found');
          return;
        }
        const params = parsed.searchParams;
        const state = params.get('state') ?? '';
        const code = params.get('code');
        const errorParam = params.get('error');

        if (errorParam !== null && errorParam.length > 0) {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(STATIC_SUCCESS_HTML);
          const errorDescription = params.get('error_description') ?? undefined;
          const payload: RedirectPayload = {
            kind: 'error',
            error: errorParam,
            errorDescription,
            state,
          };
          // Race-window guard; production callers always subscribe
          // before the redirect arrives.
          /* c8 ignore start */
          if (redirectResolver !== undefined) {
            redirectResolver(payload);
          } else {
            pendingPayload = payload;
          }
          /* c8 ignore stop */
          return;
        }

        if (code !== null && code.length > 0) {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(STATIC_SUCCESS_HTML);
          const payload: RedirectPayload = { kind: 'code', code, state };
          // Race-window guard; production callers always subscribe
          // before the redirect arrives.
          /* c8 ignore start */
          if (redirectResolver !== undefined) {
            redirectResolver(payload);
          } else {
            pendingPayload = payload;
          }
          /* c8 ignore stop */
          return;
        }

        // Defensive: neither `code` nor `error` is unreachable via
        // Monday's redirect (always populates one). The 400 keeps the
        // listener loud rather than hanging on a malformed URL.
        res.statusCode = 400;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('missing code or error parameter');
      },
    );

    const closeServer = (): void => {
      // closeServer is idempotent; the guard fires only when both
      // the redirect handler and the timeout race to close, which
      // tests don't reproduce deterministically.
      /* c8 ignore start */
      if (closed) {
        return;
      }
      /* c8 ignore stop */
      closed = true;
      // Best-effort close — `Server.close()` waits for connections to
      // drain. The static HTML page closes immediately after `res.end`,
      // so this completes promptly in the happy path.
      server.close(() => {
        // c8 ignore next — close callback completes after connections drain.
      });
    };

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        rejectBind(
          new ApiError(
            'oauth_failed',
            `local OAuth listener cannot bind 127.0.0.1:${String(requestedPort)} — port already in use`,
            {
              details: {
                reason: 'port_in_use',
                port: requestedPort,
                hint: 'another `monday auth login` process or unrelated service is holding the port; resolve the conflict and retry',
              },
              cause: err,
            },
          ),
        );
        return;
      }
      // Non-EADDRINUSE bind errors are rare (EACCES on privileged
      // ports, ENOMEM, etc.) and not reproducible from a unit test
      // against 127.0.0.1:0.
      /* c8 ignore start */
      rejectBind(
        new ApiError(
          'oauth_failed',
          `local OAuth listener failed to bind 127.0.0.1:${String(requestedPort)}: ${err.message}`,
          {
            details: { reason: 'port_in_use', port: requestedPort },
            cause: err,
          },
        ),
      );
      /* c8 ignore stop */
    });

    server.listen(requestedPort, '127.0.0.1', () => {
      // Resolve the actual bound port — when caller passed `0`, the
      // OS assigned a random free port; tests + the consent URL need
      // the real one. The non-object/null address branch covers Unix-
      // socket binds that this 127.0.0.1 listener never produces.
      const address = server.address();
      /* c8 ignore start */
      const actualPort =
        typeof address === 'object' && address !== null
          ? address.port
          : requestedPort;
      /* c8 ignore stop */

      const handle: OAuthListenerHandle = {
        port: actualPort,
        awaitRedirect: () =>
          new Promise<RedirectPayload>((resolve, reject) => {
            // If the redirect arrived before awaitRedirect was called
            // (vanishingly rare in production but possible in fast
            // test paths), drain the pending payload immediately.
            /* c8 ignore next 6 — race-window guard; unit tests subscribe
               before sending the redirect, so this path doesn't fire. */
            if (pendingPayload !== undefined) {
              const p = pendingPayload;
              pendingPayload = undefined;
              closeServer();
              resolve(p);
              return;
            }

            // Arm the timer here, not at bind time — the 5-min budget
            // is "wait for redirect" not "wait for caller to subscribe."
            const timer = setTimeout(() => {
              const err = new ApiError(
                'oauth_failed',
                `OAuth listener timed out after ${String(timeoutMs)}ms waiting for the redirect`,
                {
                  details: {
                    reason: 'timeout',
                    timeout_ms: timeoutMs,
                    hint: 're-run `monday auth login` and complete the consent flow within 5 minutes',
                  },
                  // Override the umbrella `oauth_failed` retryable=false
                  // floor — listener-timeout is a transient signal an
                  // agent can safely retry (cli-design §7.3.3 footnote).
                  retryable: true,
                },
              );
              closeServer();
              reject(err);
            }, timeoutMs);
            timer.unref();

            redirectResolver = (payload) => {
              clearTimeout(timer);
              closeServer();
              resolve(payload);
            };
          }),
        close: closeServer,
      };
      resolveBind(handle);
    });
  });
};

/**
 * Posts the authorization code to `OAUTH_TOKEN_URL` and returns the
 * normalized {@link TokenResponse}.
 *
 * Failure surfaces:
 *   - 4xx (RFC 6749 standard shape) → throws
 *     `oauth_failed.reason: "code_exchange_failed"` carrying
 *     `monday_code` + `monday_description`.
 *   - 5xx / network error → throws `network_error`.
 *   - Malformed success body → throws `internal_error`.
 */
export const exchangeCode = async (
  inputs: ExchangeCodeInputs,
): Promise<TokenResponse> => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: inputs.code,
    client_id: inputs.clientId,
    client_secret: inputs.clientSecret,
    redirect_uri: inputs.redirectUri,
  }).toString();

  const fetchImpl = inputs.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
  } catch (err) {
    throw new ApiError(
      'network_error',
      `network failure during OAuth token exchange: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
        details: {
          url: OAUTH_TOKEN_URL,
          hint: 'verify connectivity to auth.monday.com and retry',
        },
      },
    );
  }

  const responseBodyText = await response.text();

  if (response.status >= 200 && response.status < 300) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(responseBodyText);
    } catch (err) {
      throw new ApiError(
        'internal_error',
        `OAuth token-exchange success response was not valid JSON (status ${String(response.status)})`,
        {
          cause: err,
          details: {
            http_status: response.status,
            hint: 'this likely indicates a Monday-side change in the response shape; inspect the live response and report.',
          },
        },
      );
    }
    const result = rawTokenResponseSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new ApiError(
        'internal_error',
        'OAuth token-exchange success response did not match the expected shape',
        {
          cause: result.error,
          details: {
            http_status: response.status,
            issues: result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
            hint: 'this likely indicates a Monday-side change in the response shape; inspect the live response and report.',
          },
        },
      );
    }
    return {
      accessToken: result.data.access_token,
      tokenType: result.data.token_type,
      scope: result.data.scope,
    };
  }

  if (response.status >= 400 && response.status < 500) {
    let mondayCode: string | undefined;
    let mondayDescription: string | undefined;
    try {
      const parsedJson = JSON.parse(responseBodyText) as unknown;
      const result = rfc6749ErrorSchema.safeParse(parsedJson);
      if (result.success) {
        mondayCode = result.data.error;
        mondayDescription = result.data.error_description;
      }
    } catch {
      // Body wasn't JSON — leave mondayCode undefined and let the
      // throw below carry the raw status.
    }
    throw new ApiError(
      'oauth_failed',
      `OAuth token exchange failed with HTTP ${String(response.status)}${mondayCode !== undefined ? ` (${mondayCode})` : ''}`,
      {
        httpStatus: response.status,
        ...(mondayCode !== undefined ? { mondayCode } : {}),
        details: {
          reason: 'code_exchange_failed',
          http_status: response.status,
          ...(mondayCode !== undefined ? { monday_code: mondayCode } : {}),
          ...(mondayDescription !== undefined
            ? { monday_description: mondayDescription }
            : {}),
          hint: 're-run `monday auth login --profile <name>` to start a fresh OAuth flow',
        },
      },
    );
  }

  // 5xx or anything else: treat as transient transport-level failure.
  throw new ApiError(
    'network_error',
    `OAuth token exchange failed with HTTP ${String(response.status)}`,
    {
      httpStatus: response.status,
      details: {
        url: OAUTH_TOKEN_URL,
        http_status: response.status,
        hint: 'transient server-side failure; retry shortly',
      },
    },
  );
};
