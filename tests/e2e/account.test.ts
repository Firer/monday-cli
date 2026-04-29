/**
 * E2E suite for `monday account *` (`v0.1-plan.md` §3 M2 + §5.3).
 *
 * Each test:
 *   1. Builds a `FixtureServer` (in-process HTTP) loaded with a
 *      cassette.
 *   2. Spawns `dist/cli/index.js` via `spawnCli()` with
 *      `MONDAY_API_URL=http://127.0.0.1:<port>` and
 *      `MONDAY_API_TOKEN=<canary>`.
 *   3. Asserts on stdout/stderr/exit code.
 *
 * The whole stack runs end-to-end here — argv → commander → command
 * action → `resolveClient` → `FetchTransport` → real `fetch` →
 * fixture server → response → `mapResponse` → envelope renderer →
 * stdout. The integration suite mocks the transport boundary; this
 * one only mocks the network bytes.
 *
 * Build dependency: the binary at `dist/cli/index.js` must be
 * up-to-date. CI runs `npm run build` before `test:e2e`; for local
 * runs the spawn helper fails fast with a clear message if the
 * binary is missing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnCli } from './spawn.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';
import type { Cassette, Interaction } from '../fixtures/load.js';

const LEAK_CANARY = 'tok-leakcheck-deadbeef-canary';

const fixtureEnv = (server: FixtureServer): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  MONDAY_API_TOKEN: LEAK_CANARY,
  MONDAY_API_URL: server.url,
});

const whoamiInteraction: Interaction = {
  operation_name: 'Whoami',
  expect_headers: {
    Authorization: LEAK_CANARY,
    'API-Version': '2026-01',
    'Content-Type': 'application/json',
  },
  response: {
    data: {
      me: {
        id: '1',
        name: 'Alice',
        email: 'alice@example.test',
        account: { id: '99', name: 'Org', slug: 'org' },
      },
    },
  },
};

interface EnvelopeShape {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string };
  readonly meta: Readonly<Record<string, unknown>>;
}

const parseEnvelope = (s: string): EnvelopeShape => JSON.parse(s) as EnvelopeShape;

describe('monday account whoami (e2e)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('happy path — exit 0, JSON envelope on stdout', async () => {
    server = await startFixtureServer({
      cassette: { interactions: [whoamiInteraction] },
    });
    const result = await spawnCli({
      args: ['account', 'whoami', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout);
    expect(env.ok).toBe(true);
    expect(env.meta).toMatchObject({
      schema_version: '1',
      api_version: '2026-01',
      source: 'live',
    });
    expect(result.stderr).toBe('');
    expect(server.remaining()).toBe(0);
    // The fixture server enforces Authorization + API-Version
    // header values via expect_headers — if the FetchTransport ever
    // dropped them, the request would fail server-side.
  });

  it('FetchTransport sends Authorization without `Bearer ` prefix', async () => {
    server = await startFixtureServer({
      cassette: { interactions: [whoamiInteraction] },
    });
    await spawnCli({
      args: ['account', 'whoami', '--json'],
      env: fixtureEnv(server),
    });
    const headers = server.requests[0]?.headers ?? {};
    expect(headers.authorization).toBe(LEAK_CANARY);
    expect(headers['api-version']).toBe('2026-01');
    // sanity: no `Bearer ` prefix (Monday API rejects that).
    expect(headers.authorization?.startsWith('Bearer ')).toBeFalsy();
  });

  it('--api-version overrides the wire header', async () => {
    server = await startFixtureServer({
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            expect_headers: { 'API-Version': '2026-04' },
            response: whoamiInteraction.response,
          },
        ],
      },
    });
    const result = await spawnCli({
      args: ['--api-version', '2026-04', 'account', 'whoami', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
  });

  it('exit 3 — config_error when MONDAY_API_TOKEN is missing', async () => {
    // No fixture server needed — the action throws ConfigError
    // before any transport call.
    const result = await spawnCli({
      args: ['account', 'whoami', '--json'],
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.exitCode).toBe(3);
    const env = parseEnvelope(result.stderr);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('config_error');
    expect(result.stdout).toBe('');
  });

  it('exit 1 — usage_error on bad flag combination', async () => {
    const result = await spawnCli({
      args: ['account', 'whoami', '--json', '--table'],
      env: { PATH: process.env.PATH ?? '', MONDAY_API_TOKEN: LEAK_CANARY },
    });
    expect(result.exitCode).toBe(1);
    const env = parseEnvelope(result.stderr);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('usage_error');
  });

  it('exit 2 — surfaces unauthorized when fixture server returns 401', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'Whoami',
          http_status: 401,
          response: {},
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: ['account', 'whoami', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(2);
    const env = parseEnvelope(result.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(result.stdout).toBe('');
  });

  it('exit 2 — timeout when the server stalls past --timeout', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'Whoami',
          delay_ms: 2_000,
          response: whoamiInteraction.response,
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    // --timeout 200 then a 2s server delay; FetchTransport raises
    // ApiError(timeout). --retry 0 keeps the test under 1s.
    const result = await spawnCli({
      args: ['--timeout', '200', '--retry', '0', 'account', 'whoami', '--json'],
      env: fixtureEnv(server),
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(2);
    const env = parseEnvelope(result.stderr);
    expect(env.error?.code).toBe('timeout');
  });

  it('redaction — token never appears in any byte of stdout/stderr across paths', async () => {
    // Drives both success and error paths and asserts the leak
    // canary is absent from every emitted byte.
    server = await startFixtureServer({
      cassette: {
        interactions: [
          // First request: success (token may transiently end up in
          // graphql-request's `cause` chain on a parse error; we
          // assert it stays scrubbed).
          whoamiInteraction,
          // Second request: a 401 with a hostile body that mimics
          // Monday echoing the token in the error message — the
          // value-scan layer of redact() must catch this.
          {
            operation_name: 'Whoami',
            http_status: 401,
            response: {
              errors: [
                {
                  message: `Bad token: ${LEAK_CANARY}`,
                  extensions: { code: 'AUTHENTICATION_ERROR' },
                },
              ],
            },
          },
        ],
      },
    });
    const ok = await spawnCli({
      args: ['account', 'whoami', '--json'],
      env: fixtureEnv(server),
    });
    expect(ok.stdout).not.toContain(LEAK_CANARY);
    expect(ok.stderr).not.toContain(LEAK_CANARY);

    const fail = await spawnCli({
      args: ['account', 'whoami', '--json'],
      env: fixtureEnv(server),
    });
    expect(fail.stdout).not.toContain(LEAK_CANARY);
    expect(fail.stderr).not.toContain(LEAK_CANARY);
  });
});

describe('monday account info (e2e)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('happy path returns the projected account fields', async () => {
    server = await startFixtureServer({
      cassette: {
        interactions: [
          {
            operation_name: 'AccountInfo',
            response: {
              data: {
                account: {
                  id: '99',
                  name: 'Org',
                  slug: 'org',
                  country_code: 'GB',
                  first_day_of_the_week: 'monday',
                  active_members_count: 7,
                  logo: null,
                  plan: { version: 1, tier: 'pro', max_users: 100, period: 'annual' },
                },
              },
            },
          },
        ],
      },
    });
    const result = await spawnCli({
      args: ['account', 'info', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout);
    expect(env.data).toMatchObject({ id: '99', name: 'Org', country_code: 'GB' });
  });
});

describe('monday account version (e2e)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('reports SDK pin + server-reported versions', async () => {
    server = await startFixtureServer({
      cassette: {
        interactions: [
          {
            operation_name: 'Versions',
            response: {
              data: {
                versions: [
                  { display_name: '2026-01', kind: 'current', value: '2026-01' },
                ],
              },
            },
          },
        ],
      },
    });
    const result = await spawnCli({
      args: ['account', 'version', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { pinned: { value: string; sdk_default: string } };
    };
    expect(env.data.pinned.value).toBe('2026-01');
    expect(env.data.pinned.sdk_default).toBe('2026-01');
  });
});

describe('monday account complexity (e2e)', () => {
  let server: FixtureServer | undefined;
  beforeEach(() => {
    server = undefined;
  });
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
    }
  });

  it('reports the budget snapshot', async () => {
    server = await startFixtureServer({
      cassette: {
        interactions: [
          {
            operation_name: 'ComplexityProbe',
            response: {
              data: {
                complexity: { before: 5_000_000, after: 4_999_999, query: 1, reset_in_x_seconds: 30 },
              },
            },
          },
        ],
      },
    });
    const result = await spawnCli({
      args: ['account', 'complexity', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { used: number; remaining: number; reset_in_seconds: number };
    };
    expect(env.data).toEqual({
      before: 5_000_000,
      used: 1,
      remaining: 4_999_999,
      reset_in_seconds: 30,
    });
  });
});

describe('e2e — exit code coverage', () => {
  // Concise sweep against a single fixture-server instance per case.
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('exit 0 — happy path', async () => {
    server = await startFixtureServer({ cassette: { interactions: [whoamiInteraction] } });
    const r = await spawnCli({
      args: ['account', 'whoami', '--json'],
      env: fixtureEnv(server),
    });
    expect(r.exitCode).toBe(0);
  });

  it('exit 1 — usage error', async () => {
    const r = await spawnCli({
      args: ['account', 'whoami', '--json', '--table'],
      env: { PATH: process.env.PATH ?? '', MONDAY_API_TOKEN: LEAK_CANARY },
    });
    expect(r.exitCode).toBe(1);
  });

  it('exit 2 — API error', async () => {
    server = await startFixtureServer({
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            http_status: 401,
            response: {},
          },
        ],
      },
    });
    const r = await spawnCli({
      args: ['account', 'whoami', '--json'],
      env: fixtureEnv(server),
    });
    expect(r.exitCode).toBe(2);
  });

  it('exit 3 — config error', async () => {
    const r = await spawnCli({
      args: ['account', 'whoami', '--json'],
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(r.exitCode).toBe(3);
  });
});
