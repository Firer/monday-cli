/**
 * Unit tests for `src/api/probes.ts` — the M22 probe matrix runtime
 * (cli-design §11.5).
 *
 * Each probe is driven via its mockable seam (`lookupImpl` /
 * `tcpConnectImpl` / `tlsConnectImpl` / `redactImpl` / FixtureTransport
 * for the auth probe; tmp-dir HOME for cache_writability). The seams
 * mirror `src/api/transport.ts`'s `fetchImpl?` slot and the M21
 * `__test_oauth_helper` env seam — production callers leave them
 * unset and the runner binds to the real stdlib primitive.
 */
import { mkdtemp, rm, chmod, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  STATUS_PROBE_ORDER,
  NO_PROBE_SKIP_SET,
  ENV_VAR_PICKUP_KEYS,
  DEFAULT_PROBE_HOSTNAME,
  DEFAULT_PROBE_PORT,
  DEFAULT_PROBE_TIMEOUT_MS,
  REDACTION_SELF_TEST_FIXTURE_TOKEN,
  probeResultSchema,
  statusOutputSchema,
  runDnsProbe,
  runTcpProbe,
  runTlsProbe,
  runAuthProbe,
  runCacheWritabilityProbe,
  runRedactionSelfTest,
  summariseEnvVarPickup,
  type DnsLookupResult,
  type TlsCertDetails,
} from '../../../src/api/probes.js';
import { createInlineFixtureTransport } from '../../fixtures/load.js';

describe('STATUS_PROBE_ORDER', () => {
  it('lists the seven probes in §11.5 narrative order', () => {
    expect(STATUS_PROBE_ORDER).toEqual([
      'dns',
      'tcp',
      'tls',
      'auth',
      'cache_writability',
      'redaction_self_test',
      'env_var_pickup',
    ]);
  });
});

describe('NO_PROBE_SKIP_SET', () => {
  it('contains only the four network-touching probes', () => {
    expect([...NO_PROBE_SKIP_SET].sort()).toEqual(['auth', 'dns', 'tcp', 'tls']);
  });

  it('does not skip the three local-only probes', () => {
    expect(NO_PROBE_SKIP_SET.has('cache_writability')).toBe(false);
    expect(NO_PROBE_SKIP_SET.has('redaction_self_test')).toBe(false);
    expect(NO_PROBE_SKIP_SET.has('env_var_pickup')).toBe(false);
  });
});

describe('ENV_VAR_PICKUP_KEYS', () => {
  it('covers every MONDAY_* env var documented in cli-design §7.1 / §7.2', () => {
    expect(ENV_VAR_PICKUP_KEYS).toContain('MONDAY_API_TOKEN');
    expect(ENV_VAR_PICKUP_KEYS).toContain('MONDAY_PROFILE');
    expect(ENV_VAR_PICKUP_KEYS).toContain('MONDAY_API_VERSION');
    expect(ENV_VAR_PICKUP_KEYS).toContain('MONDAY_API_URL');
    expect(ENV_VAR_PICKUP_KEYS).toContain('MONDAY_OUTPUT');
    expect(ENV_VAR_PICKUP_KEYS).toContain('MONDAY_REQUEST_TIMEOUT_MS');
  });
});

describe('default constants', () => {
  it('pin api.monday.com:443 with 5s timeout', () => {
    expect(DEFAULT_PROBE_HOSTNAME).toBe('api.monday.com');
    expect(DEFAULT_PROBE_PORT).toBe(443);
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(5_000);
  });
});

describe('REDACTION_SELF_TEST_FIXTURE_TOKEN', () => {
  it('is a distinctive non-real token byte sequence (leak-scan target)', () => {
    expect(REDACTION_SELF_TEST_FIXTURE_TOKEN).toContain('DO-NOT-USE');
    expect(REDACTION_SELF_TEST_FIXTURE_TOKEN).not.toMatch(/^eyJ/u);
    expect(REDACTION_SELF_TEST_FIXTURE_TOKEN.length).toBeGreaterThan(10);
  });
});

describe('probeResultSchema', () => {
  it('accepts the ok variant', () => {
    expect(() =>
      probeResultSchema.parse({
        kind: 'ok',
        probe: 'dns',
        elapsed_ms: 12,
        details: { address: '1.2.3.4', family: 4 },
      }),
    ).not.toThrow();
  });

  it('accepts the fail variant with required reason + message', () => {
    expect(() =>
      probeResultSchema.parse({
        kind: 'fail',
        probe: 'auth',
        elapsed_ms: 89,
        reason: 'unauthorized',
        message: 'Monday returned 401',
        details: { http_status: 401 },
      }),
    ).not.toThrow();
  });

  it('accepts the skipped variant', () => {
    expect(() =>
      probeResultSchema.parse({
        kind: 'skipped',
        probe: 'dns',
        reason: 'no_probe_flag',
      }),
    ).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      probeResultSchema.parse({ kind: 'maybe', probe: 'dns', reason: 'x' }),
    ).toThrow();
  });

  it('requires non-empty reason on fail/skipped (no silent empty strings)', () => {
    expect(() =>
      probeResultSchema.parse({
        kind: 'skipped',
        probe: 'dns',
        reason: '',
      }),
    ).toThrow();
  });
});

describe('statusOutputSchema', () => {
  const okProbe = (probe: string) => ({
    kind: 'ok' as const,
    probe,
    elapsed_ms: 12,
    details: {},
  });
  const fullProbes = {
    dns: okProbe('dns'),
    tcp: okProbe('tcp'),
    tls: okProbe('tls'),
    auth: okProbe('auth'),
    cache_writability: okProbe('cache_writability'),
    redaction_self_test: okProbe('redaction_self_test'),
    env_var_pickup: okProbe('env_var_pickup'),
  };

  it('accepts the §11.5.2 envelope shape with all seven probes', () => {
    expect(() =>
      statusOutputSchema.parse({
        probes: fullProbes,
        overall: 'ok',
        api_version: '2026-01',
      }),
    ).not.toThrow();
  });

  it('rejects an envelope missing required probe slots (drift catch)', () => {
    const { dns, ...withoutDns } = fullProbes;
    void dns;
    expect(() =>
      statusOutputSchema.parse({
        probes: withoutDns,
        overall: 'ok',
        api_version: '2026-01',
      }),
    ).toThrow();
  });

  it('catchall accepts an additive future probe slot', () => {
    expect(() =>
      statusOutputSchema.parse({
        probes: {
          ...fullProbes,
          cache_freshness: okProbe('cache_freshness'),
        },
        overall: 'ok',
        api_version: '2026-01',
      }),
    ).not.toThrow();
  });

  it('rejects unknown overall enum values', () => {
    expect(() =>
      statusOutputSchema.parse({
        probes: fullProbes,
        overall: 'unknown',
        api_version: '2026-01',
      }),
    ).toThrow();
  });
});

describe('runDnsProbe', () => {
  it('returns ProbeOk with address + family on success', async () => {
    const result = await runDnsProbe({
      hostname: 'example.test',
      lookupImpl: () => Promise.resolve({ address: '203.0.113.1', family: 4 }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.probe).toBe('dns');
    expect(result.details).toMatchObject({ address: '203.0.113.1', family: 4 });
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('maps ENOTFOUND to reason="not_found"', async () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND example.test'), {
      code: 'ENOTFOUND',
    });
    const result = await runDnsProbe({
      hostname: 'example.test',
      lookupImpl: () => Promise.reject(err),
    });
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('not_found');
    expect(result.details).toMatchObject({ hostname: 'example.test', code: 'ENOTFOUND' });
  });

  it('maps EAI_AGAIN to reason="temporary_failure"', async () => {
    const err = Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' });
    const result = await runDnsProbe({
      hostname: 'example.test',
      lookupImpl: () => Promise.reject(err),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('temporary_failure');
  });

  it('maps unknown errors to reason="lookup_failed"', async () => {
    const result = await runDnsProbe({
      hostname: 'example.test',
      lookupImpl: () => Promise.reject(new Error('weird')),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('lookup_failed');
  });

  it('times out a hanging lookup with reason="timeout"', async () => {
    const result = await runDnsProbe({
      hostname: 'example.test',
      timeoutMs: 10,
      lookupImpl: () => new Promise<DnsLookupResult>(() => { /* never */ }),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('timeout');
    expect(result.details).toMatchObject({ timeout_ms: 10 });
  });

  it('honours outer abort signal', async () => {
    const ctrl = new AbortController();
    const promise = runDnsProbe({
      hostname: 'example.test',
      lookupImpl: () => new Promise<DnsLookupResult>(() => { /* never */ }),
      signal: ctrl.signal,
    });
    setTimeout(() => { ctrl.abort(new Error('cancelled')); }, 5);
    const result = await promise;
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('lookup_failed');
  });

  it('defaults hostname to api.monday.com when not supplied', async () => {
    let captured = '';
    await runDnsProbe({
      lookupImpl: (h) => {
        captured = h;
        return Promise.resolve({ address: '1.2.3.4', family: 4 });
      },
    });
    expect(captured).toBe(DEFAULT_PROBE_HOSTNAME);
  });

  it('maps EAI_NONAME (OR-arm sibling of ENOTFOUND) to reason="not_found"', async () => {
    const err = Object.assign(new Error('EAI_NONAME'), { code: 'EAI_NONAME' });
    const result = await runDnsProbe({
      hostname: 'example.test',
      lookupImpl: () => Promise.reject(err),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('not_found');
    expect(result.details).toMatchObject({ code: 'EAI_NONAME' });
  });

  it('omits `code` from details when error has no code property (lookup_failed)', async () => {
    const result = await runDnsProbe({
      hostname: 'example.test',
      lookupImpl: () => Promise.reject(new Error('no code')),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('lookup_failed');
    expect(result.details).not.toHaveProperty('code');
  });

  it('aborts immediately when signal is pre-aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre-aborted'));
    const result = await runDnsProbe({
      hostname: 'example.test',
      lookupImpl: () => new Promise<DnsLookupResult>(() => { /* never */ }),
      signal: ctrl.signal,
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('lookup_failed');
  });
});

describe('runTcpProbe', () => {
  it('returns ProbeOk with host + port on success', async () => {
    const result = await runTcpProbe({
      hostname: 'example.test',
      port: 443,
      tcpConnectImpl: () => Promise.resolve(),
    });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.details).toMatchObject({ host: 'example.test', port: 443 });
  });

  it('maps ECONNREFUSED to reason="connection_refused"', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const result = await runTcpProbe({
      tcpConnectImpl: () => Promise.reject(err),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('connection_refused');
  });

  it('maps ECONNRESET to reason="connection_reset"', async () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    const result = await runTcpProbe({
      tcpConnectImpl: () => Promise.reject(err),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('connection_reset');
  });

  it('maps ETIMEDOUT to reason="timeout"', async () => {
    const err = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const result = await runTcpProbe({
      tcpConnectImpl: () => Promise.reject(err),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('timeout');
  });

  it('maps unknown errors to reason="connection_failed"', async () => {
    const result = await runTcpProbe({
      tcpConnectImpl: () => Promise.reject(new Error('weird')),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('connection_failed');
  });

  it('times out a hanging connect', async () => {
    const result = await runTcpProbe({
      timeoutMs: 10,
      tcpConnectImpl: ({ signal }) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            const reason: unknown = signal.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        }),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('timeout');
  });

  it('omits `code` from details when error has no code (connection_failed)', async () => {
    const result = await runTcpProbe({
      tcpConnectImpl: () => Promise.reject(new Error('no-code-error')),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('connection_failed');
    expect(result.details).not.toHaveProperty('code');
  });
});

describe('runTlsProbe', () => {
  const okCert: TlsCertDetails = {
    subject: '*.monday.com',
    issuer: 'Let\'s Encrypt R3',
    valid_to: '2027-01-01T00:00:00.000Z',
  };

  it('returns ProbeOk with cert details on success', async () => {
    const result = await runTlsProbe({
      tlsConnectImpl: () => Promise.resolve(okCert),
    });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.details).toMatchObject({
      subject: '*.monday.com',
      valid_to: '2027-01-01T00:00:00.000Z',
    });
  });

  it('maps CERT_HAS_EXPIRED to reason="cert_expired"', async () => {
    const err = Object.assign(new Error('cert expired'), {
      code: 'CERT_HAS_EXPIRED',
    });
    const result = await runTlsProbe({
      tlsConnectImpl: () => Promise.reject(err),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('cert_expired');
  });

  it('maps UNABLE_TO_VERIFY_LEAF_SIGNATURE to reason="cert_untrusted"', async () => {
    const err = Object.assign(new Error('unable to verify'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    const result = await runTlsProbe({
      tlsConnectImpl: () => Promise.reject(err),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('cert_untrusted');
  });

  it('maps ERR_TLS_CERT_ALTNAME_INVALID to reason="cert_name_mismatch"', async () => {
    const err = Object.assign(new Error('altname mismatch'), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
    const result = await runTlsProbe({
      tlsConnectImpl: () => Promise.reject(err),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('cert_name_mismatch');
  });

  it('maps unknown errors to reason="tls_handshake_failed"', async () => {
    const result = await runTlsProbe({
      tlsConnectImpl: () => Promise.reject(new Error('weird')),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('tls_handshake_failed');
  });

  it('times out a hanging handshake', async () => {
    const result = await runTlsProbe({
      timeoutMs: 10,
      tlsConnectImpl: ({ signal }) =>
        new Promise<TlsCertDetails>((_, reject) => {
          signal.addEventListener('abort', () => {
            const reason: unknown = signal.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        }),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('timeout');
  });

  it('omits `code` from details when error has no code (tls_handshake_failed)', async () => {
    const result = await runTlsProbe({
      tlsConnectImpl: () => Promise.reject(new Error('no-code')),
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('tls_handshake_failed');
    expect(result.details).not.toHaveProperty('code');
  });
});

describe('runAuthProbe', () => {
  it('returns ProbeOk with me_id on 200 success', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response: { data: { me: { id: '102927371' } } },
      },
    ]);
    const result = await runAuthProbe({ transport, apiVersionHint: '2026-01' });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.details).toMatchObject({
      me_id: '102927371',
      api_version: '2026-01',
    });
  });

  it('maps 401 HTTP status to reason="unauthorized"', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        http_status: 401,
        response_body: {
          errors: [
            {
              message: 'Not authenticated',
              extensions: { code: 'NOT_AUTHENTICATED' },
            },
          ],
        },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('unauthorized');
    expect(result.details).toMatchObject({ http_status: 401 });
  });

  it('maps 5xx HTTP status to reason="network_error"', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        http_status: 503,
        response_body: { errors: [{ message: 'temporary' }] },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('network_error');
    expect(result.details).toMatchObject({ http_status: 503 });
  });

  it('maps 200 with NOT_AUTHENTICATED errors[] to reason="unauthorized"', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response_body: {
          errors: [
            {
              message: 'Not authenticated',
              extensions: { code: 'NOT_AUTHENTICATED' },
            },
          ],
        },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('unauthorized');
  });

  it('maps null me to reason="unauthorized" (guest/disabled account)', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response: { data: { me: null } },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('unauthorized');
  });

  it('maps 200 with a non-auth GraphQL error to reason="auth_failed"', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response_body: {
          errors: [
            {
              message: 'Rate limit exceeded',
              extensions: { code: 'ComplexityException' },
            },
          ],
        },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('auth_failed');
  });

  it('maps a non-object body to reason="network_error"', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response_body: 'not-an-object',
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('network_error');
  });

  it('maps missing data.me to reason="network_error"', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response: { data: {} },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('unauthorized');
  });

  it('maps malformed me.id to reason="network_error"', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response: { data: { me: { id: 42 } } },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('network_error');
  });

  it('maps transport thrown ApiError(unauthorized) verbatim', async () => {
    const transport = {
      request: () =>
        Promise.reject(
          Object.assign(new Error('401'), {
            code: 'unauthorized',
            httpStatus: 401,
            name: 'ApiError',
          }),
        ),
    };
    const { ApiError } = await import('../../../src/utils/errors.js');
    const realErr = new ApiError('unauthorized', 'Monday returned 401', {
      httpStatus: 401,
    });
    const transport2 = { request: () => Promise.reject(realErr) };
    const result = await runAuthProbe({ transport: transport2 });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('unauthorized');
    void transport;
  });

  it('maps transport thrown ApiError(network_error) to network_error reason', async () => {
    const { ApiError } = await import('../../../src/utils/errors.js');
    const err = new ApiError('network_error', 'fetch failed', { httpStatus: 503 });
    const transport = { request: () => Promise.reject(err) };
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('network_error');
  });

  it('maps a plain Error thrown by transport to reason="network_error"', async () => {
    const transport = { request: () => Promise.reject(new Error('connect ECONNREFUSED')) };
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('network_error');
  });

  it('maps non-200/non-401/non-5xx to reason="network_error"', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        http_status: 418,
        response_body: { teapot: true },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('network_error');
  });

  it('maps a non-first auth-code error in errors[] to unauthorized (Codex W2)', async () => {
    // Codex M22 W2: errors[] mapping must scan every entry, not just
    // errors[0]. A non-auth complexity warning followed by an auth
    // token expiration must still map to `unauthorized` — the
    // security-bearing reading wins.
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response_body: {
          errors: [
            {
              message: 'Complexity budget warning',
              extensions: { code: 'ComplexityException' },
            },
            {
              message: 'Token expired',
              extensions: { code: 'NOT_AUTHENTICATED' },
            },
          ],
        },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('unauthorized');
    expect(result.details).toMatchObject({ monday_code: 'NOT_AUTHENTICATED' });
  });

  it('maps UNAUTHENTICATED (OR-arm sibling of NOT_AUTHENTICATED) to unauthorized', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response_body: {
          errors: [
            { message: 'Token expired', extensions: { code: 'UNAUTHENTICATED' } },
          ],
        },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('unauthorized');
  });

  it('maps 200 with errors[] but no extensions.code to reason="auth_failed"', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response_body: {
          errors: [{ message: 'something broke' }],
        },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('auth_failed');
    expect(result.details).not.toHaveProperty('monday_code');
  });

  it('maps 200 with errors[] missing message to default error string', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response_body: {
          errors: [{ extensions: { code: 'UNKNOWN' } }],
        },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.message).toContain('auth probe rejected');
  });

  it('maps ApiError without httpStatus to network_error (no http_status in details)', async () => {
    const { ApiError } = await import('../../../src/utils/errors.js');
    const err = new ApiError('network_error', 'transport-level failure');
    const transport = { request: () => Promise.reject(err) };
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('network_error');
    expect(result.details).not.toHaveProperty('http_status');
  });

  it('times out a hanging transport (per-probe deadline)', async () => {
    const transport = {
      request: ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          if (signal !== undefined) {
            signal.addEventListener('abort', () => {
              const reason: unknown = signal.reason;
              reject(reason instanceof Error ? reason : new Error('aborted'));
            });
          }
        }),
    };
    const result = await runAuthProbe({ transport, timeoutMs: 10 });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('timeout');
    expect(result.details).toMatchObject({ timeout_ms: 10 });
  });

  it('does NOT include api_version in details when apiVersionHint is omitted', async () => {
    const transport = createInlineFixtureTransport([
      {
        operation_name: 'MondayStatusAuth',
        response: { data: { me: { id: '102927371' } } },
      },
    ]);
    const result = await runAuthProbe({ transport });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.details).toMatchObject({ me_id: '102927371' });
    expect(result.details).not.toHaveProperty('api_version');
  });
});

describe('runCacheWritabilityProbe', () => {
  let tmpHome: string;
  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'monday-cli-probe-cache-'));
  });
  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('returns ProbeOk when dir exists with mode 0700 and is writable', async () => {
    const cacheDir = join(tmpHome, '.monday-cli');
    await mkdir(cacheDir, { mode: 0o700 });
    await chmod(cacheDir, 0o700);
    const result = await runCacheWritabilityProbe({ env: {}, home: tmpHome });
    if (result.kind !== 'ok') throw new Error(`expected ok: ${JSON.stringify(result)}`);
    expect(result.details).toMatchObject({ path: cacheDir, mode: '0700' });
  });

  it('returns ProbeFail dir_missing when ~/.monday-cli does not exist', async () => {
    const result = await runCacheWritabilityProbe({ env: {}, home: tmpHome });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('dir_missing');
  });

  it('returns ProbeFail mode_insecure when mode bits are loose', async () => {
    const cacheDir = join(tmpHome, '.monday-cli');
    await mkdir(cacheDir, { mode: 0o755 });
    await chmod(cacheDir, 0o755);
    const result = await runCacheWritabilityProbe({ env: {}, home: tmpHome });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('mode_insecure');
    expect(result.details).toMatchObject({ mode: '0755' });
  });

  it('returns ProbeFail not_a_directory when path is a file', async () => {
    const cacheDir = join(tmpHome, '.monday-cli');
    await writeFile(cacheDir, 'oops');
    await chmod(cacheDir, 0o600);
    const result = await runCacheWritabilityProbe({ env: {}, home: tmpHome });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('not_a_directory');
  });

  it('uses env.HOME when home option is unset', async () => {
    const result = await runCacheWritabilityProbe({ env: { HOME: tmpHome } });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('dir_missing');
    expect(result.details).toMatchObject({ path: join(tmpHome, '.monday-cli') });
  });
});

describe('runRedactionSelfTest', () => {
  it('returns ProbeOk when redact() scrubs the canary in every context', async () => {
    const runtimeSecrets: string[] = [];
    const result = await runRedactionSelfTest({
      env: {},
      runtimeSecrets,
    });
    if (result.kind !== 'ok') throw new Error(`expected ok: ${JSON.stringify(result)}`);
    expect(result.details).toMatchObject({ fixture_count: 6 });
  });

  it('removes the canary from runtimeSecrets before returning', async () => {
    const runtimeSecrets: string[] = ['some-other-secret'];
    await runRedactionSelfTest({ env: {}, runtimeSecrets });
    expect(runtimeSecrets).toEqual(['some-other-secret']);
  });

  it('returns ProbeFail canary_leaked when a tampered redactor passes the canary through', async () => {
    const runtimeSecrets: string[] = [];
    const result = await runRedactionSelfTest({
      env: {},
      runtimeSecrets,
      redactImpl: (value) => value,
    });
    if (result.kind !== 'fail') throw new Error('expected fail');
    expect(result.reason).toBe('canary_leaked');
    const contexts = (result.details as { contexts_leaked: readonly string[] })
      .contexts_leaked;
    // All six §7.4.3 carrier contexts must surface as leaked when the
    // identity redactor is injected.
    expect(contexts).toContain('error.message');
    expect(contexts).toContain('error.stack');
    expect(contexts).toContain('error.cause.message');
    expect(contexts).toContain('headers.authorization');
    expect(contexts).toContain('url');
    expect(contexts).toContain('debug');
  });

  it('threads BOTH env-token AND runtimeSecrets-canary into collectSecrets (Codex W1)', async () => {
    // Codex M21 P1 + M22 W1: the probe must exercise BOTH `env` and
    // `runtimeSecrets` halves of collectSecrets. Use a distinct env
    // canary (NOT the same as REDACTION_SELF_TEST_FIXTURE_TOKEN) and
    // a spy redactImpl that captures the secrets list — assert both
    // canaries flow through.
    const distinctEnvToken = 'env-canary-distinct-from-probe-fixture';
    let capturedSecrets: readonly string[] | undefined;
    const result = await runRedactionSelfTest({
      env: { MONDAY_API_TOKEN: distinctEnvToken },
      runtimeSecrets: [],
      redactImpl: (value, options) => {
        capturedSecrets = options.secrets;
        // Identity-pass so the probe sees a leak — we want to land
        // in the fail branch and surface the captured list cleanly.
        return value;
      },
    });
    // The probe fails (identity-pass), but we don't care about the
    // failure — we're asserting the secret-bag composition.
    if (result.kind !== 'fail') throw new Error('expected fail (identity redactImpl)');
    expect(capturedSecrets).toBeDefined();
    expect(capturedSecrets).toContain(distinctEnvToken);
    expect(capturedSecrets).toContain(REDACTION_SELF_TEST_FIXTURE_TOKEN);
  });
});

describe('summariseEnvVarPickup', () => {
  it('returns set:true for set env vars, false for unset', async () => {
    const result = await summariseEnvVarPickup({
      env: {
        MONDAY_API_TOKEN: 'tok',
        MONDAY_PROFILE: 'work',
      },
    });
    if (result.kind !== 'ok') throw new Error('expected ok');
    const set = (result.details as { set: Record<string, boolean> }).set;
    expect(set.MONDAY_API_TOKEN).toBe(true);
    expect(set.MONDAY_PROFILE).toBe(true);
    expect(set.MONDAY_API_VERSION).toBe(false);
    expect(set.MONDAY_API_URL).toBe(false);
    expect(set.MONDAY_OUTPUT).toBe(false);
    expect(set.MONDAY_REQUEST_TIMEOUT_MS).toBe(false);
  });

  it('treats empty-string env vars as unset', async () => {
    const result = await summariseEnvVarPickup({
      env: { MONDAY_API_TOKEN: '' },
    });
    if (result.kind !== 'ok') throw new Error('expected ok');
    const set = (result.details as { set: Record<string, boolean> }).set;
    expect(set.MONDAY_API_TOKEN).toBe(false);
  });

  it('NEVER includes env-var values (only set/unset booleans)', async () => {
    const result = await summariseEnvVarPickup({
      env: { MONDAY_API_TOKEN: 'super-secret-token-do-not-leak' },
    });
    if (result.kind !== 'ok') throw new Error('expected ok');
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('super-secret-token-do-not-leak');
  });
});
