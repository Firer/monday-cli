/**
 * Unit tests for `src/api/oauth.ts` runtime bodies (v0.3-M21
 * implementation Part 1).
 */

import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  OAUTH_AUTHORIZE_URL,
  OAUTH_TOKEN_URL,
  OAUTH_DEFAULT_PORT,
  OAUTH_CALLBACK_PATH,
  OAUTH_DEFAULT_LISTENER_TIMEOUT_MS,
  OAUTH_SCOPES,
  OAUTH_DEFAULT_REQUESTED_SCOPES,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
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

  it('OAUTH_DEFAULT_LISTENER_TIMEOUT_MS is 5 minutes', () => {
    expect(OAUTH_DEFAULT_LISTENER_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it('OAUTH_SCOPES enumerates the documented Monday Apps OAuth scopes', () => {
    expect(OAUTH_SCOPES).toContain('boards:read');
    expect(OAUTH_SCOPES).toContain('boards:write');
    expect(OAUTH_SCOPES).toContain('users:read');
    expect(OAUTH_SCOPES).toContain('me:read');
    expect(OAUTH_SCOPES).toContain('updates:write');
    expect(OAUTH_SCOPES).toContain('webhooks:write');
    expect(new Set(OAUTH_SCOPES).size).toBe(OAUTH_SCOPES.length);
  });

  it('OAUTH_DEFAULT_REQUESTED_SCOPES is a working subset of OAUTH_SCOPES', () => {
    for (const scope of OAUTH_DEFAULT_REQUESTED_SCOPES) {
      expect(OAUTH_SCOPES).toContain(scope);
    }
    expect(OAUTH_DEFAULT_REQUESTED_SCOPES).toContain('boards:read');
  });

  it('OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are pinned in source (placeholders OK)', () => {
    // Type-level + presence check; the placeholder value lands in
    // production until the OAuth app is registered with Monday.
    expect(typeof OAUTH_CLIENT_ID).toBe('string');
    expect(OAUTH_CLIENT_ID.length).toBeGreaterThan(0);
    expect(typeof OAUTH_CLIENT_SECRET).toBe('string');
    expect(OAUTH_CLIENT_SECRET.length).toBeGreaterThan(0);
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

  it('TokenResponse pins accessToken + tokenType + scope', () => {
    const t: TokenResponse = {
      accessToken: 'tok-fixture-xxxx',
      tokenType: 'Bearer',
      scope: 'boards:read boards:write',
    };
    expect(t.accessToken).toBe('tok-fixture-xxxx');
    expect('expiresIn' in t).toBe(false);
  });

  it('RawTokenResponse pins access_token + token_type + scope', () => {
    const raw: RawTokenResponse = {
      access_token: 'tok-fixture-xxxx',
      token_type: 'Bearer',
      scope: 'boards:read boards:write',
    };
    expect(raw.access_token).toBe('tok-fixture-xxxx');
    expect('expires_in' in raw).toBe(false);
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
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('encodes 32 bytes (43 characters in base64url)', () => {
    const state = generateOAuthState();
    expect(state.length).toBe(43);
  });

  it('returns a fresh value on each call', () => {
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
    expect(verifyCsrf('short', 'much-longer-value')).toBe(false);
    expect(verifyCsrf('', 'nonempty')).toBe(false);
  });

  it('returns false on equal-length but-different content', () => {
    expect(verifyCsrf('aaaaaaaa', 'aaaaaaab')).toBe(false);
    expect(verifyCsrf('xyz', 'abc')).toBe(false);
  });

  it('returns false on both-empty input', () => {
    expect(verifyCsrf('', '')).toBe(false);
  });

  it('handles unicode bytes correctly', () => {
    const state = '€-state-€';
    expect(verifyCsrf(state, state)).toBe(true);
    expect(verifyCsrf(state, '€-state-?')).toBe(false);
  });
});

describe('bindOAuthListener (runtime)', () => {
  it('binds on a port and resolves a handle', async () => {
    const handle = await bindOAuthListener({ port: 0, timeoutMs: 1000 });
    try {
      expect(typeof handle.port).toBe('number');
      expect(handle.port).toBeGreaterThan(0);
      expect(typeof handle.awaitRedirect).toBe('function');
      expect(typeof handle.close).toBe('function');
    } finally {
      handle.close();
    }
  });

  it('parses code+state from the callback path', async () => {
    const handle = await bindOAuthListener({ port: 0, timeoutMs: 5_000 });
    try {
      const redirectPromise = handle.awaitRedirect();
      // Send the redirect to ourselves over loopback.
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: handle.port,
            path: `${OAUTH_CALLBACK_PATH}?code=fake-code&state=fake-state`,
            method: 'GET',
          },
          (res) => {
            res.resume();
            res.on('end', () => { resolve(); });
          },
        );
        req.on('error', reject);
        req.end();
      });
      const payload = await redirectPromise;
      expect(payload.kind).toBe('code');
      if (payload.kind === 'code') {
        expect(payload.code).toBe('fake-code');
        expect(payload.state).toBe('fake-state');
      }
    } finally {
      handle.close();
    }
  });

  it('parses error+state without error_description', async () => {
    const handle = await bindOAuthListener({ port: 0, timeoutMs: 5_000 });
    try {
      const redirectPromise = handle.awaitRedirect();
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: handle.port,
            path: `${OAUTH_CALLBACK_PATH}?error=access_denied&state=fake-state`,
            method: 'GET',
          },
          (res) => {
            res.resume();
            res.on('end', () => { resolve(); });
          },
        );
        req.on('error', reject);
        req.end();
      });
      const payload = await redirectPromise;
      expect(payload.kind).toBe('error');
      if (payload.kind === 'error') {
        expect(payload.error).toBe('access_denied');
        expect(payload.errorDescription).toBeUndefined();
      }
    } finally {
      handle.close();
    }
  });

  it('parses error+state on a denied redirect', async () => {
    const handle = await bindOAuthListener({ port: 0, timeoutMs: 5_000 });
    try {
      const redirectPromise = handle.awaitRedirect();
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: handle.port,
            path: `${OAUTH_CALLBACK_PATH}?error=access_denied&error_description=user%20denied&state=fake-state`,
            method: 'GET',
          },
          (res) => {
            res.resume();
            res.on('end', () => { resolve(); });
          },
        );
        req.on('error', reject);
        req.end();
      });
      const payload = await redirectPromise;
      expect(payload.kind).toBe('error');
      if (payload.kind === 'error') {
        expect(payload.error).toBe('access_denied');
        expect(payload.errorDescription).toBe('user denied');
      }
    } finally {
      handle.close();
    }
  });

  it('returns 400 for /callback with no code or error params (defensive)', async () => {
    const handle = await bindOAuthListener({ port: 0, timeoutMs: 5_000 });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: handle.port,
            path: OAUTH_CALLBACK_PATH,
            method: 'GET',
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(400);
    } finally {
      handle.close();
    }
  });

  it('returns 404 for non-callback paths', async () => {
    const handle = await bindOAuthListener({ port: 0, timeoutMs: 5_000 });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: handle.port,
            path: '/unknown',
            method: 'GET',
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(404);
    } finally {
      handle.close();
    }
  });

  it('rejects with oauth_failed.port_in_use when the port is already bound', async () => {
    // Bind once, then try again on the same port.
    const first = await bindOAuthListener({ port: 0, timeoutMs: 1_000 });
    try {
      await expect(
        bindOAuthListener({ port: first.port, timeoutMs: 1_000 }),
      ).rejects.toBeInstanceOf(ApiError);
      try {
        await bindOAuthListener({ port: first.port, timeoutMs: 1_000 });
        expect.fail('should have rejected');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const ae = err as ApiError;
        expect(ae.code).toBe('oauth_failed');
        expect(ae.details?.reason).toBe('port_in_use');
        expect(ae.details?.port).toBe(first.port);
      }
    } finally {
      first.close();
    }
  });

  it('rejects awaitRedirect with oauth_failed.timeout when the timer fires', async () => {
    const handle = await bindOAuthListener({ port: 0, timeoutMs: 50 });
    try {
      const promise = handle.awaitRedirect();
      await expect(promise).rejects.toBeInstanceOf(ApiError);
      try {
        await handle.awaitRedirect();
        expect.fail('should have rejected');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const ae = err as ApiError;
        expect(ae.code).toBe('oauth_failed');
        expect(ae.details?.reason).toBe('timeout');
        expect(ae.retryable).toBe(true);
      }
    } finally {
      handle.close();
    }
  });
});

const buildResponse = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response => {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
};

describe('exchangeCode (runtime, mocked fetch)', () => {
  const baseInputs: Omit<ExchangeCodeInputs, 'fetchImpl'> = {
    code: 'fake-code',
    redirectUri: 'http://127.0.0.1:9876/callback',
    clientId: 'fake-client',
    clientSecret: 'fake-secret',
  };

  // Build a fresh Response per call — `Response.body` can only be
  // consumed once, and the tests await `exchangeCode` twice (once
  // via `expect().rejects`, once in a try/catch for detail
  // assertions).
  const stubFetch = (build: () => Response): typeof fetch => () =>
    Promise.resolve(build());

  it('returns a normalized TokenResponse on 200', async () => {
    const fetchImpl = stubFetch(() =>
      buildResponse(
        200,
        JSON.stringify({
          access_token: 'tok-from-monday',
          token_type: 'Bearer',
          scope: 'boards:read boards:write',
        }),
      ),
    );
    const result = await exchangeCode({ ...baseInputs, fetchImpl });
    expect(result.accessToken).toBe('tok-from-monday');
    expect(result.tokenType).toBe('Bearer');
    expect(result.scope).toBe('boards:read boards:write');
  });

  it('forwards the application/x-www-form-urlencoded body', async () => {
    let capturedBody: string | undefined;
    let capturedHeaders: Headers | undefined;
    const fetchImpl: typeof fetch = (_url, init) => {
      capturedBody = init?.body as string;
      capturedHeaders = new Headers(init?.headers);
      return Promise.resolve(
        buildResponse(
          200,
          JSON.stringify({
            access_token: 'tok',
            token_type: 'Bearer',
            scope: '',
          }),
        ),
      );
    };
    await exchangeCode({ ...baseInputs, fetchImpl });
    expect(capturedBody).toContain('grant_type=authorization_code');
    expect(capturedBody).toContain('code=fake-code');
    expect(capturedBody).toContain('client_id=fake-client');
    expect(capturedBody).toContain('client_secret=fake-secret');
    expect(capturedHeaders?.get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('throws oauth_failed.code_exchange_failed with monday_code on 400 (RFC 6749)', async () => {
    const fetchImpl = stubFetch(() =>
      buildResponse(
        400,
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'authorization code has expired',
        }),
      ),
    );
    await expect(
      exchangeCode({ ...baseInputs, fetchImpl }),
    ).rejects.toBeInstanceOf(ApiError);
    try {
      await exchangeCode({ ...baseInputs, fetchImpl });
      expect.fail('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const ae = err as ApiError;
      expect(ae.code).toBe('oauth_failed');
      expect(ae.httpStatus).toBe(400);
      expect(ae.mondayCode).toBe('invalid_grant');
      expect(ae.details?.reason).toBe('code_exchange_failed');
      expect(ae.details?.monday_code).toBe('invalid_grant');
      expect(ae.details?.monday_description).toMatch(/expired/u);
    }
  });

  it('handles 4xx with monday_code but no error_description (optional per RFC 6749)', async () => {
    const fetchImpl = stubFetch(() =>
      buildResponse(400, JSON.stringify({ error: 'invalid_grant' })),
    );
    try {
      await exchangeCode({ ...baseInputs, fetchImpl });
      expect.fail('should have rejected');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('oauth_failed');
      expect(ae.mondayCode).toBe('invalid_grant');
      expect(ae.details?.monday_code).toBe('invalid_grant');
      expect(ae.details?.monday_description).toBeUndefined();
    }
  });

  it('handles 4xx with non-JSON body (no monday_code in details)', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response('plain text error', {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    await expect(
      exchangeCode({ ...baseInputs, fetchImpl }),
    ).rejects.toBeInstanceOf(ApiError);
    try {
      await exchangeCode({ ...baseInputs, fetchImpl });
      expect.fail('should have rejected');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('oauth_failed');
      expect(ae.details?.reason).toBe('code_exchange_failed');
      expect(ae.details?.monday_code).toBeUndefined();
    }
  });

  it('throws network_error on 500', async () => {
    const fetchImpl = stubFetch(() =>
      buildResponse(500, JSON.stringify({ error: 'server_error' })),
    );
    await expect(
      exchangeCode({ ...baseInputs, fetchImpl }),
    ).rejects.toBeInstanceOf(ApiError);
    try {
      await exchangeCode({ ...baseInputs, fetchImpl });
      expect.fail('should have rejected');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('network_error');
      expect(ae.httpStatus).toBe(500);
    }
  });

  it('throws network_error on fetch rejection', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.reject(new Error('ECONNREFUSED'));
    await expect(
      exchangeCode({ ...baseInputs, fetchImpl }),
    ).rejects.toBeInstanceOf(ApiError);
    try {
      await exchangeCode({ ...baseInputs, fetchImpl });
      expect.fail('should have rejected');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('network_error');
    }
  });

  it('throws network_error on fetch rejection with non-Error reason (string)', async () => {
    // Covers the `err instanceof Error ? err.message : String(err)`
    // false branch in the catch body.
    const fetchImpl: typeof fetch = () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject('plain-string-reason');
    try {
      await exchangeCode({ ...baseInputs, fetchImpl });
      expect.fail('should have rejected');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('network_error');
      expect(ae.message).toMatch(/plain-string-reason/u);
    }
  });

  it('throws internal_error on success body that is not JSON', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      exchangeCode({ ...baseInputs, fetchImpl }),
    ).rejects.toBeInstanceOf(ApiError);
    try {
      await exchangeCode({ ...baseInputs, fetchImpl });
      expect.fail('should have rejected');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('internal_error');
    }
  });

  it('throws internal_error on success body missing required fields', async () => {
    const fetchImpl = stubFetch(() =>
      buildResponse(200, JSON.stringify({ unrelated: 'shape' })),
    );
    await expect(
      exchangeCode({ ...baseInputs, fetchImpl }),
    ).rejects.toBeInstanceOf(ApiError);
    try {
      await exchangeCode({ ...baseInputs, fetchImpl });
      expect.fail('should have rejected');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('internal_error');
    }
  });
});
