/**
 * Unit tests for `monday status` orchestration — drives the network-
 * probe matrix branches without binding to real DNS / TCP / TLS / fetch.
 *
 * The action body in `src/commands/status.ts` factors out the probe
 * matrix into `orchestrateStatusProbes`, which takes a `runners` slot
 * for per-test substitution. Production wires the real runners; these
 * tests substitute fakes that return canned `ProbeResult`s so every
 * short-circuit + overall path lands.
 */
import { describe, it, expect } from 'vitest';
import {
  orchestrateStatusProbes,
  deriveOverall,
  resolveStatusTransport,
  type StatusProbeRunners,
} from '../../../src/commands/status.js';
import type { RunContext } from '../../../src/cli/run.js';
import { createMetaBuilder } from '../../../src/cli/envelope-out.js';
import type { ProbeName, ProbeResult } from '../../../src/api/probes.js';
import type { Transport } from '../../../src/api/transport.js';

const okProbe = (probe: ProbeName, details: Record<string, unknown> = {}): ProbeResult => ({
  kind: 'ok',
  probe,
  elapsed_ms: 1,
  details,
});

const failProbe = (
  probe: ProbeName,
  reason: string,
  message = 'probe failed',
): ProbeResult => ({
  kind: 'fail',
  probe,
  elapsed_ms: 1,
  reason,
  message,
  details: {},
});

const fakeTransport = { request: () => Promise.resolve({ status: 200, headers: {}, body: {} }) } as unknown as Transport;

const buildRunners = (overrides: Partial<StatusProbeRunners> = {}): Partial<StatusProbeRunners> => ({
  runDnsProbe: () => Promise.resolve(okProbe('dns', { address: '1.2.3.4', family: 4 })),
  runTcpProbe: () => Promise.resolve(okProbe('tcp', { host: 'api.monday.com', port: 443 })),
  runTlsProbe: () => Promise.resolve(okProbe('tls', { subject: '*.monday.com', issuer: 'X', valid_to: 'Y' })),
  runAuthProbe: () => Promise.resolve(okProbe('auth', { me_id: '102927371', api_version: '2026-01' })),
  runCacheWritabilityProbe: () => Promise.resolve(okProbe('cache_writability', { path: '/tmp', mode: '0700' })),
  runRedactionSelfTest: () => Promise.resolve(okProbe('redaction_self_test', { fixture_count: 6 })),
  summariseEnvVarPickup: () => Promise.resolve(okProbe('env_var_pickup', { set: {} })),
  ...overrides,
});

describe('orchestrateStatusProbes — happy path', () => {
  it('runs every probe when no --no-probe and all succeed', async () => {
    const result = await orchestrateStatusProbes({
      noProbe: false,
      env: {},
      runtimeSecrets: [],
      transportResolution: { transport: fakeTransport, apiVersion: '2026-01' },
      runners: buildRunners(),
    });
    expect(result.apiVersion).toBe('2026-01');
    for (const probe of ['dns', 'tcp', 'tls', 'auth', 'cache_writability', 'redaction_self_test', 'env_var_pickup'] as const) {
      expect(result.probes[probe].kind).toBe('ok');
    }
  });
});

describe('orchestrateStatusProbes — --no-probe', () => {
  it('skips all four network probes; runs local probes', async () => {
    const result = await orchestrateStatusProbes({
      noProbe: true,
      env: {},
      runtimeSecrets: [],
      transportResolution: { transport: fakeTransport, apiVersion: '2026-01' },
      runners: buildRunners(),
    });
    for (const probe of ['dns', 'tcp', 'tls', 'auth'] as const) {
      expect(result.probes[probe].kind).toBe('skipped');
      const skipped = result.probes[probe] as Extract<ProbeResult, { kind: 'skipped' }>;
      expect(skipped.reason).toBe('no_probe_flag');
    }
    expect(result.probes.cache_writability.kind).toBe('ok');
    expect(result.probes.redaction_self_test.kind).toBe('ok');
    expect(result.probes.env_var_pickup.kind).toBe('ok');
  });
});

describe('orchestrateStatusProbes — short-circuit cascade', () => {
  it('DNS fail → TCP/TLS/auth surface upstream_failed:dns', async () => {
    const result = await orchestrateStatusProbes({
      noProbe: false,
      env: {},
      runtimeSecrets: [],
      transportResolution: { transport: fakeTransport, apiVersion: '2026-01' },
      runners: buildRunners({
        runDnsProbe: () => Promise.resolve(failProbe('dns', 'not_found')),
      }),
    });
    expect(result.probes.dns.kind).toBe('fail');
    for (const probe of ['tcp', 'tls', 'auth'] as const) {
      const p = result.probes[probe] as Extract<ProbeResult, { kind: 'fail' }>;
      expect(p.kind).toBe('fail');
      expect(p.reason).toBe('upstream_failed');
      expect(p.details).toMatchObject({ upstream: 'dns' });
    }
  });

  it('TCP fail → TLS/auth surface upstream_failed:tcp', async () => {
    const result = await orchestrateStatusProbes({
      noProbe: false,
      env: {},
      runtimeSecrets: [],
      transportResolution: { transport: fakeTransport, apiVersion: '2026-01' },
      runners: buildRunners({
        runTcpProbe: () => Promise.resolve(failProbe('tcp', 'connection_refused')),
      }),
    });
    expect(result.probes.dns.kind).toBe('ok');
    expect(result.probes.tcp.kind).toBe('fail');
    for (const probe of ['tls', 'auth'] as const) {
      const p = result.probes[probe] as Extract<ProbeResult, { kind: 'fail' }>;
      expect(p.reason).toBe('upstream_failed');
      expect(p.details).toMatchObject({ upstream: 'tcp' });
    }
  });

  it('TLS fail → auth surfaces upstream_failed:tls', async () => {
    const result = await orchestrateStatusProbes({
      noProbe: false,
      env: {},
      runtimeSecrets: [],
      transportResolution: { transport: fakeTransport, apiVersion: '2026-01' },
      runners: buildRunners({
        runTlsProbe: () => Promise.resolve(failProbe('tls', 'cert_expired')),
      }),
    });
    expect(result.probes.tcp.kind).toBe('ok');
    expect(result.probes.tls.kind).toBe('fail');
    const auth = result.probes.auth as Extract<ProbeResult, { kind: 'fail' }>;
    expect(auth.reason).toBe('upstream_failed');
    expect(auth.details).toMatchObject({ upstream: 'tls' });
  });

  it('no-token transport resolution → auth surfaces no_token', async () => {
    const result = await orchestrateStatusProbes({
      noProbe: false,
      env: {},
      runtimeSecrets: [],
      transportResolution: { noToken: true, apiVersion: '2026-01' },
      runners: buildRunners(),
    });
    expect(result.probes.tls.kind).toBe('ok');
    const auth = result.probes.auth as Extract<ProbeResult, { kind: 'fail' }>;
    expect(auth.kind).toBe('fail');
    expect(auth.reason).toBe('no_token');
  });

  it('threads signal through to every network probe runner', async () => {
    const captured: { dns?: AbortSignal; tcp?: AbortSignal; tls?: AbortSignal; auth?: AbortSignal } = {};
    const ctrl = new AbortController();
    await orchestrateStatusProbes({
      noProbe: false,
      env: {},
      runtimeSecrets: [],
      signal: ctrl.signal,
      transportResolution: { transport: fakeTransport, apiVersion: '2026-01' },
      runners: buildRunners({
        runDnsProbe: (inputs) => {
          if (inputs.signal !== undefined) captured.dns = inputs.signal;
          return Promise.resolve(okProbe('dns'));
        },
        runTcpProbe: (inputs) => {
          if (inputs.signal !== undefined) captured.tcp = inputs.signal;
          return Promise.resolve(okProbe('tcp'));
        },
        runTlsProbe: (inputs) => {
          if (inputs.signal !== undefined) captured.tls = inputs.signal;
          return Promise.resolve(okProbe('tls'));
        },
        runAuthProbe: (inputs) => {
          if (inputs.signal !== undefined) captured.auth = inputs.signal;
          return Promise.resolve(okProbe('auth'));
        },
      }),
    });
    expect(captured.dns).toBe(ctrl.signal);
    expect(captured.tcp).toBe(ctrl.signal);
    expect(captured.tls).toBe(ctrl.signal);
    expect(captured.auth).toBe(ctrl.signal);
  });
});

describe('resolveStatusTransport', () => {
  const buildCtx = (
    env: NodeJS.ProcessEnv,
    transport?: Transport,
  ): RunContext => ({
    env,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: false,
    clock: () => new Date('2026-04-30T10:00:00Z'),
    transport,
    requestId: 'fixed-req-id',
    cliVersion: '0.0.0-test',
    signal: new AbortController().signal,
    meta: createMetaBuilder(),
    runtimeSecrets: [],
  });

  it('returns the injected transport verbatim when ctx.transport is set', () => {
    const ctx = buildCtx(
      { MONDAY_API_TOKEN: 'tok-fixture-xxxx', MONDAY_API_URL: 'https://api.monday.com/v2' },
      fakeTransport,
    );
    const resolved = resolveStatusTransport(ctx, {});
    expect('noToken' in resolved).toBe(false);
    if ('noToken' in resolved) throw new Error('unexpected noToken');
    expect(resolved.transport).toBe(fakeTransport);
    expect(resolved.apiVersion).toBe('2026-01');
  });

  it('reads apiVersion from MONDAY_API_VERSION when set', () => {
    const ctx = buildCtx(
      {
        MONDAY_API_TOKEN: 'tok-fixture-xxxx',
        MONDAY_API_URL: 'https://api.monday.com/v2',
        MONDAY_API_VERSION: '2026-04',
      },
      fakeTransport,
    );
    const resolved = resolveStatusTransport(ctx, {});
    if ('noToken' in resolved) throw new Error('unexpected noToken');
    expect(resolved.apiVersion).toBe('2026-04');
  });

  it('returns {noToken: true} when loadConfig throws ConfigError (no token in env)', () => {
    const ctx = buildCtx({});
    const resolved = resolveStatusTransport(ctx, {});
    expect('noToken' in resolved).toBe(true);
    expect(resolved.apiVersion).toBe('2026-01');
  });

  it('re-throws ConfigError when failure is NOT the missing-token path (Codex F2)', () => {
    // Codex M22 F2: malformed MONDAY_API_URL is a real `config_error`
    // (exit 3) — burying it under a `no_token` auth-probe failure
    // would mislead agents into the wrong fix. The function must
    // re-throw non-missing-token ConfigErrors verbatim.
    const ctx = buildCtx({
      MONDAY_API_TOKEN: 'tok-fixture-xxxx',
      MONDAY_API_URL: 'not-a-url',
    });
    expect(() => resolveStatusTransport(ctx, {})).toThrow(/MONDAY_API_URL|invalid/);
  });

  it('re-throws on MIXED ConfigError (token missing AND URL malformed) per Codex round-2 P2', () => {
    // Codex round-2: when both MONDAY_API_TOKEN is missing AND
    // MONDAY_API_URL is malformed, the URL issue must NOT be hidden
    // under a `no_token` downgrade. The token-only allowlist requires
    // EVERY issue path to be MONDAY_API_TOKEN.
    const ctx = buildCtx({ MONDAY_API_URL: 'not-a-url' });
    expect(() => resolveStatusTransport(ctx, {})).toThrow(/MONDAY_API_URL|invalid/);
  });

  it('builds a FetchTransport from loadConfig when ctx.transport is undefined', () => {
    const ctx = buildCtx({
      MONDAY_API_TOKEN: 'tok-fixture-xxxx',
      MONDAY_API_URL: 'https://api.monday.com/v2',
    });
    const resolved = resolveStatusTransport(ctx, {});
    expect('noToken' in resolved).toBe(false);
    if ('noToken' in resolved) throw new Error('unexpected noToken');
    expect(resolved.transport).toBeDefined();
    expect(resolved.apiVersion).toBe('2026-01');
  });
});

describe('deriveOverall — §11.5.2 rules', () => {
  const buildProbes = (
    overrides: Partial<Record<ProbeName, ProbeResult>> = {},
  ): Record<ProbeName, ProbeResult> => ({
    dns: okProbe('dns'),
    tcp: okProbe('tcp'),
    tls: okProbe('tls'),
    auth: okProbe('auth'),
    cache_writability: okProbe('cache_writability'),
    redaction_self_test: okProbe('redaction_self_test'),
    env_var_pickup: okProbe('env_var_pickup'),
    ...overrides,
  });

  it('returns overall=ok when every probe succeeds', () => {
    const result = deriveOverall(buildProbes());
    expect(result.overall).toBe('ok');
    expect(result.errorCode).toBeNull();
  });

  it('redaction_self_test fail → overall=down regardless of network state', () => {
    const result = deriveOverall(
      buildProbes({
        redaction_self_test: failProbe('redaction_self_test', 'canary_leaked'),
      }),
    );
    expect(result.overall).toBe('down');
    expect(result.errorCode).toBe('internal_error');
  });

  it('DNS fail → overall=down, errorCode=network_error', () => {
    const result = deriveOverall(
      buildProbes({ dns: failProbe('dns', 'not_found') }),
    );
    expect(result.overall).toBe('down');
    expect(result.errorCode).toBe('network_error');
  });

  it('auth 401 → overall=down, errorCode=unauthorized', () => {
    const result = deriveOverall(
      buildProbes({ auth: failProbe('auth', 'unauthorized', 'Monday returned 401') }),
    );
    expect(result.overall).toBe('down');
    expect(result.errorCode).toBe('unauthorized');
  });

  it('auth no_token → overall=down, errorCode=unauthorized', () => {
    const result = deriveOverall(
      buildProbes({ auth: failProbe('auth', 'no_token', 'no token available') }),
    );
    expect(result.overall).toBe('down');
    expect(result.errorCode).toBe('unauthorized');
  });

  it('auth 5xx (network_error reason) → overall=down, errorCode=network_error', () => {
    const result = deriveOverall(
      buildProbes({ auth: failProbe('auth', 'network_error') }),
    );
    expect(result.overall).toBe('down');
    expect(result.errorCode).toBe('network_error');
  });

  it('auth ok + cache_writability fail → overall=degraded (soft)', () => {
    const result = deriveOverall(
      buildProbes({
        cache_writability: failProbe('cache_writability', 'mode_insecure'),
      }),
    );
    expect(result.overall).toBe('degraded');
    expect(result.errorCode).toBeNull();
  });

  it('all network skipped + cache_writability fail → overall=down (no auth signal)', () => {
    const skipped: ProbeResult = {
      kind: 'skipped',
      probe: 'dns',
      reason: 'no_probe_flag',
    };
    const result = deriveOverall(
      buildProbes({
        dns: { ...skipped, probe: 'dns' },
        tcp: { ...skipped, probe: 'tcp' },
        tls: { ...skipped, probe: 'tls' },
        auth: { ...skipped, probe: 'auth' },
        cache_writability: failProbe('cache_writability', 'dir_missing'),
      }),
    );
    expect(result.overall).toBe('down');
    expect(result.errorCode).toBe('config_error');
  });

  it('all network skipped + everything else ok → overall=ok', () => {
    const skipped: ProbeResult = {
      kind: 'skipped',
      probe: 'dns',
      reason: 'no_probe_flag',
    };
    const result = deriveOverall(
      buildProbes({
        dns: { ...skipped, probe: 'dns' },
        tcp: { ...skipped, probe: 'tcp' },
        tls: { ...skipped, probe: 'tls' },
        auth: { ...skipped, probe: 'auth' },
      }),
    );
    expect(result.overall).toBe('ok');
  });
});
