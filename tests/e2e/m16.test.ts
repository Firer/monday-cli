/**
 * M16 E2E suite — spawns the compiled binary against a fixture server
 * for `monday board column-*` lifecycle verbs (`v0.2-plan.md` §3 M16).
 *
 * One spawn per verb. The M16 verbs introduce the §8 eager-
 * invalidation contract; the integration suite (board.test.ts)
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

describe('M16 e2e — board column-create (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips create_column; envelope carries the projected column + no warning for canonical type', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ColumnCreate',
          response: {
            data: {
              create_column: {
                id: 'text_1',
                title: 'Notes',
                type: 'text',
                description: null,
                archived: false,
                settings_str: null,
                width: null,
              },
            },
          },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: ['board', 'column-create', '12345', '--type', 'text', '--title', 'Notes', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { id: string; title: string; type: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('text_1');
    expect(env.data.type).toBe('text');
    // Canonical type → no noncanonical_column_type warning.
    expect(env.warnings ?? []).toEqual([]);
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});

describe('M16 e2e — board column-update (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips change_column_title; envelope carries the projected column', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ColumnChangeTitle',
          response: {
            data: {
              change_column_title: {
                id: 'status_4',
                title: 'Priority',
                type: 'status',
                description: null,
                archived: false,
                settings_str: null,
                width: 120,
              },
            },
          },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: ['board', 'column-update', '12345', 'status_4', '--title', 'Priority', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { id: string; title: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('status_4');
    expect(env.data.title).toBe('Priority');
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});
