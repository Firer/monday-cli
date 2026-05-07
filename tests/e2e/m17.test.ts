/**
 * M17 E2E suite — spawns the compiled binary against a fixture server
 * for `monday board group-*` lifecycle verbs (`v0.2-plan.md` §3 M17).
 *
 * One spawn per verb. The M17 verbs reuse the §8 eager-invalidation
 * contract M16 introduced; the integration suite (board.test.ts)
 * exercises the contract against an in-process FixtureTransport,
 * the E2E spawn proves the compiled binary wires the same path
 * end-to-end (token plumbing through env, schema export emit,
 * exit-code mapping, redaction of the fixture LEAK_CANARY).
 *
 * Build dependency: `dist/cli/index.js` must be current (CI runs
 * `npm run build` before `test:e2e`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnCli } from './spawn.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';
import type { Cassette } from '../fixtures/load.js';

const LEAK_CANARY = 'tok-leakcheck-deadbeef-canary';

const fixtureEnv = (
  server: FixtureServer,
  extras: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  MONDAY_API_TOKEN: LEAK_CANARY,
  MONDAY_API_URL: server.url,
  ...extras,
});

interface EnvelopeShape {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string };
  readonly meta: Readonly<Record<string, unknown>>;
  readonly warnings?: readonly { code: string; details?: Readonly<Record<string, unknown>> }[];
}

const parseEnvelope = (s: string): EnvelopeShape =>
  JSON.parse(s) as EnvelopeShape;

const sampleGroup = {
  id: 'sprint_42',
  title: 'Sprint 42',
  color: 'blue',
  position: '1.0',
  archived: false,
  deleted: false,
};

describe('M17 e2e — board group-create (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips create_group; envelope carries the projected group', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GroupCreate',
          response: {
            data: { create_group: sampleGroup },
          },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: ['board', 'group-create', '12345', '--name', 'Sprint 42', '--color', 'blue', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { id: string; title: string; color: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('sprint_42');
    expect(env.data.title).toBe('Sprint 42');
    expect(env.data.color).toBe('blue');
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});

describe('M17 e2e — board group-update (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips update_group with --name; envelope carries the projected (renamed) group', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GroupUpdate',
          response: {
            data: {
              update_group: {
                id: 'topics',
                title: 'Sprint 42',
                color: 'blue',
                position: '1.0',
                archived: false,
                deleted: false,
              },
            },
          },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: ['board', 'group-update', '12345', 'topics', '--name', 'Sprint 42', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { id: string; title: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('topics');
    expect(env.data.title).toBe('Sprint 42');
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});

describe('M17 e2e — board group-archive (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips archive_group with --yes; envelope carries the projected (archived) group', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GroupArchive',
          response: {
            data: {
              archive_group: {
                id: 'topics',
                title: 'Topics',
                color: 'blue',
                position: '1.0',
                archived: true,
                deleted: false,
              },
            },
          },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: ['board', 'group-archive', '12345', 'topics', '--yes', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { id: string; archived: boolean | null };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('topics');
    expect(env.data.archived).toBe(true);
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});
