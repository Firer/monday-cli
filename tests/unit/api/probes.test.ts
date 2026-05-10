/**
 * Surface tests for `src/api/probes.ts` — the M22 pre-flight contract
 * diff (cli-design §11.5).
 *
 * Scope: the constants + schemas + ProbeName enum pinned at pre-flight.
 * The runtime probe bodies are stubs (reject with `internal_error`)
 * and are exercised at M22 implementation alongside the real DNS / TCP
 * / TLS / fetch / fs / redaction work.
 */
import { describe, it, expect } from 'vitest';
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
  type ProbeName,
} from '../../../src/api/probes.js';
import { ApiError } from '../../../src/utils/errors.js';
import type { Transport } from '../../../src/api/transport.js';

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
    // Pre-flight contract: the fixture is deliberately distinctive so a
    // leak-test assertion can scan every emitted byte for it. It must
    // NOT look like a real Monday OAuth token (eyJ-prefixed base64-JWT).
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
    // Required-key drift catch: a future runtime that omits a probe
    // slot must fail parse so the regression surfaces immediately.
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
    // Additive-only per cli-design §6.1: a new probe slot lands as an
    // extension WITHOUT a schema-version bump.
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

describe('probe stubs (pre-flight)', () => {
  // Each probe runner ships as a Promise.reject(internal_error) stub.
  // The runtime body lands at M22 implementation; these tests confirm
  // the stubs are reachable + carry the expected error code so the
  // command-level integration test gets a stable failure shape.

  const fakeTransport = {} as unknown as Transport;
  const probes: { name: ProbeName; call: () => Promise<unknown> }[] = [
    { name: 'dns', call: () => runDnsProbe() },
    { name: 'tcp', call: () => runTcpProbe() },
    { name: 'tls', call: () => runTlsProbe() },
    { name: 'auth', call: () => runAuthProbe({ transport: fakeTransport }) },
    {
      name: 'cache_writability',
      call: () => runCacheWritabilityProbe({ env: {} }),
    },
    {
      name: 'redaction_self_test',
      call: () => runRedactionSelfTest({ env: {}, runtimeSecrets: [] }),
    },
    {
      name: 'env_var_pickup',
      call: () => summariseEnvVarPickup({ env: {} }),
    },
  ];

  for (const { name, call } of probes) {
    it(`${name} probe stub rejects with internal_error`, async () => {
      await expect(call()).rejects.toBeInstanceOf(ApiError);
      await expect(call()).rejects.toMatchObject({ code: 'internal_error' });
    });
  }
});
