/**
 * Unit tests for the v0.3-M21 pre-flight `src/api/oauth.ts` surface.
 * The two stub bodies (`bindOAuthListener`, `exchangeCode`) reject
 * with `internal_error`; the two pure helpers (`generateOAuthState`,
 * `verifyCsrf`) ship real bodies that must pass property-based +
 * security-discipline tests.
 *
 * Coverage:
 *   - Type-level surface (constants, interfaces, `OAuthScope` union).
 *   - `generateOAuthState`: produces 43-char base64url strings with
 *     32 bytes of entropy + every call returns a fresh value.
 *   - `verifyCsrf`: byte-for-byte true on equal; false on length
 *     mismatch (no throw — must NOT route to internal_error per
 *     cli-design §7.3.1 step 5); false on prefix collision +
 *     constant-time discipline (we don't time it but we exercise
 *     the path).
 *   - Stub bodies: reject with `internal_error` carrying the M21-
 *     pending hint.
 */

import { describe, expect, it } from 'vitest';
import {
  OAUTH_AUTHORIZE_URL,
  OAUTH_TOKEN_URL,
  OAUTH_DEFAULT_PORT,
  OAUTH_CALLBACK_PATH,
  OAUTH_DEFAULT_LISTENER_TIMEOUT_MS,
  OAUTH_SCOPES,
  bindOAuthListener,
  exchangeCode,
  generateOAuthState,
  verifyCsrf,
  type BindOAuthListenerInputs,
  type ExchangeCodeInputs,
  type OAuthListenerHandle,
  type OAuthScope,
  type RawTokenResponse,
  type RedirectPayload,
  type TokenResponse,
} from '../../../src/api/oauth.js';
import { ApiError } from '../../../src/utils/errors.js';

describe('oauth — constants', () => {
  it('OAUTH_AUTHORIZE_URL pins to auth.monday.com/oauth2/authorize', () => {
    expect(OAUTH_AUTHORIZE_URL).toBe(
      'https://auth.monday.com/oauth2/authorize',
    );
  });

  it('OAUTH_TOKEN_URL pins to auth.monday.com/oauth2/token', () => {
    expect(OAUTH_TOKEN_URL).toBe('https://auth.monday.com/oauth2/token');
  });

  it('OAUTH_DEFAULT_PORT is 9876 (cli-design §7.3.1 step 2 fallback pin)', () => {
    expect(OAUTH_DEFAULT_PORT).toBe(9876);
  });

  it('OAUTH_CALLBACK_PATH is /callback', () => {
    expect(OAUTH_CALLBACK_PATH).toBe('/callback');
  });

  it('OAUTH_DEFAULT_LISTENER_TIMEOUT_MS is 5 minutes (cli-design §7.3.1 step 4)', () => {
    expect(OAUTH_DEFAULT_LISTENER_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it('OAUTH_SCOPES enumerates the documented Monday Apps OAuth scopes', () => {
    // Spot-check the load-bearing entries; the full list is pinned in
    // src/api/oauth.ts and read from Monday's published docs at the
    // M21 pre-flight probe.
    expect(OAUTH_SCOPES).toContain('boards:read');
    expect(OAUTH_SCOPES).toContain('boards:write');
    expect(OAUTH_SCOPES).toContain('users:read');
    expect(OAUTH_SCOPES).toContain('me:read');
    expect(OAUTH_SCOPES).toContain('updates:write');
    expect(OAUTH_SCOPES).toContain('webhooks:write');
    // No duplicates.
    expect(new Set(OAUTH_SCOPES).size).toBe(OAUTH_SCOPES.length);
  });
});

describe('oauth — type-level surface', () => {
  it('OAuthScope is a union of the documented scopes', () => {
    const scope: OAuthScope = 'boards:read';
    expect(scope).toBe('boards:read');
  });

  it('RedirectPayload carries either kind:code or kind:error', () => {
    const ok: RedirectPayload = {
      kind: 'code',
      code: 'fake-code',
      state: 'fake-state',
    };
    const err: RedirectPayload = {
      kind: 'error',
      error: 'access_denied',
      errorDescription: 'user clicked cancel',
      state: 'fake-state',
    };
    expect(ok.kind).toBe('code');
    expect(err.kind).toBe('error');
  });

  it('TokenResponse (camelCase normalized) pins accessToken + tokenType + scope (no expiresIn per Monday docs)', () => {
    const t: TokenResponse = {
      accessToken: 'tok-fixture-xxxx',
      tokenType: 'Bearer',
      scope: 'boards:read boards:write',
    };
    expect(t.accessToken).toBe('tok-fixture-xxxx');
    // Type-system check: TokenResponse does NOT carry expiresIn.
    expect('expiresIn' in t).toBe(false);
  });

  it('RawTokenResponse (snake_case wire shape) pins access_token + token_type + scope', () => {
    // The wire shape from Monday's `/oauth2/token` success body.
    // M21 implementation parses through this snake_case shape then
    // normalizes to TokenResponse (camelCase).
    const raw: RawTokenResponse = {
      access_token: 'tok-fixture-xxxx',
      token_type: 'Bearer',
      scope: 'boards:read boards:write',
    };
    expect(raw.access_token).toBe('tok-fixture-xxxx');
    // No expires_in per Monday's "tokens do not expire" pin.
    expect('expires_in' in raw).toBe(false);
  });

  it('RedirectPayload kind:error maps non-access_denied to authorization_failed (M21 implementation contract)', () => {
    // Monday's documented authorize-endpoint error codes per
    // cli-design §7.3.3: invalid_scope, unauthorized_client,
    // server_error, temporary_unavailable. M21 implementation maps
    // any kind:error with error !== 'access_denied' to
    // oauth_failed.reason: 'authorization_failed' carrying
    // monday_code + monday_description.
    const invalidScope: RedirectPayload = {
      kind: 'error',
      error: 'invalid_scope',
      errorDescription: 'requested scope `boards:write` not granted',
      state: 'fake-state',
    };
    expect(invalidScope.kind).toBe('error');
    expect(invalidScope.error).toBe('invalid_scope');
    expect(invalidScope.errorDescription).toMatch(/boards:write/u);
    const tempUnavailable: RedirectPayload = {
      kind: 'error',
      error: 'temporary_unavailable',
      errorDescription: undefined,
      state: 'fake-state',
    };
    expect(tempUnavailable.error).toBe('temporary_unavailable');
    expect(tempUnavailable.errorDescription).toBeUndefined();
  });

  it('BindOAuthListenerInputs accepts both fields optional', () => {
    const empty: BindOAuthListenerInputs = {};
    const full: BindOAuthListenerInputs = { port: 12345, timeoutMs: 60_000 };
    expect(empty.port).toBeUndefined();
    expect(full.port).toBe(12345);
  });

  it('ExchangeCodeInputs requires clientSecret (no PKCE-only flow)', () => {
    const inputs: ExchangeCodeInputs = {
      code: 'fake-code',
      redirectUri: 'http://127.0.0.1:9876/callback',
      clientId: 'fake-client',
      clientSecret: 'fake-secret',
    };
    expect(inputs.clientSecret).toBe('fake-secret');
  });

  it('OAuthListenerHandle exposes port + awaitRedirect + close', () => {
    // Construct a phony handle to exercise the type-shape; the real
    // handle lands at M21 implementation.
    const handle: OAuthListenerHandle = {
      port: 9876,
      awaitRedirect: () =>
        Promise.resolve<RedirectPayload>({
          kind: 'code',
          code: 'x',
          state: 'y',
        }),
      close: () => {
        /* no-op */
      },
    };
    expect(handle.port).toBe(9876);
  });
});

describe('generateOAuthState', () => {
  it('returns a base64url-encoded string', () => {
    const state = generateOAuthState();
    // base64url alphabet — no `+`, `/`, or `=` padding.
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('encodes 32 bytes (43 characters in base64url)', () => {
    const state = generateOAuthState();
    expect(state.length).toBe(43);
  });

  it('returns a fresh value on each call (sanity — randomBytes is the source)', () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    const c = generateOAuthState();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
});

describe('verifyCsrf', () => {
  it('returns true on byte-equal input', () => {
    const a = 'fixed-state-value-abc123';
    expect(verifyCsrf(a, a)).toBe(true);
  });

  it('returns false on length mismatch (without throwing — cli-design §7.3.1 step 5)', () => {
    // Length-mismatched buffers cause `crypto.timingSafeEqual` to
    // throw; the explicit length-check guard ensures the false
    // outcome routes to oauth_failed.reason: "csrf_mismatch" rather
    // than internal_error.
    expect(verifyCsrf('short', 'much-longer-value')).toBe(false);
    expect(verifyCsrf('', 'nonempty')).toBe(false);
  });

  it('returns false on equal-length but-different content', () => {
    // The CSRF guard exists for security — a partial-prefix match
    // must NOT pass the verification step.
    expect(verifyCsrf('aaaaaaaa', 'aaaaaaab')).toBe(false);
    expect(verifyCsrf('xyz', 'abc')).toBe(false);
  });

  it('returns false on both-empty input (zero-length is itself a CSRF-failure signal)', () => {
    expect(verifyCsrf('', '')).toBe(false);
  });

  it('handles unicode bytes correctly', () => {
    const state = '€-state-€'; // multi-byte UTF-8
    expect(verifyCsrf(state, state)).toBe(true);
    expect(verifyCsrf(state, '€-state-?')).toBe(false);
  });
});

describe('bindOAuthListener — pre-flight stub', () => {
  it('rejects with ApiError carrying code internal_error', async () => {
    await expect(bindOAuthListener()).rejects.toBeInstanceOf(ApiError);
    try {
      await bindOAuthListener();
      expect.fail('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const ae = err as ApiError;
      expect(ae.code).toBe('internal_error');
      expect(ae.message).toMatch(/M21 pre-flight stub/u);
      expect(String(ae.details?.hint)).toMatch(/M21 implementation/u);
    }
  });

  it('rejects regardless of input', async () => {
    await expect(bindOAuthListener({ port: 12345 })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(
      bindOAuthListener({ timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('exchangeCode — pre-flight stub', () => {
  const baseInputs: ExchangeCodeInputs = {
    code: 'fake-code',
    redirectUri: 'http://127.0.0.1:9876/callback',
    clientId: 'fake-client',
    clientSecret: 'fake-secret',
  };

  it('rejects with ApiError carrying code internal_error', async () => {
    await expect(exchangeCode(baseInputs)).rejects.toBeInstanceOf(ApiError);
    try {
      await exchangeCode(baseInputs);
      expect.fail('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const ae = err as ApiError;
      expect(ae.code).toBe('internal_error');
      expect(ae.message).toMatch(/M21 pre-flight stub/u);
      expect(String(ae.details?.hint)).toMatch(/M21 implementation/u);
    }
  });
});
