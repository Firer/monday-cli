/**
 * M14 E2E suite — spawns the compiled binary against a fixture
 * server for `monday workspace *` lifecycle verbs (`v0.2-plan.md`
 * §3 M14).
 *
 * One spawn per verb. Workspace lifecycle is admin-permission-
 * sensitive and the partial-success envelope (add-users / remove-
 * users) is M14's first own consumer of the M13 contract; both
 * surfaces benefit from end-to-end binary verification on top of
 * the integration suite's branch coverage.
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
}

const parseEnvelope = (s: string): EnvelopeShape =>
  JSON.parse(s) as EnvelopeShape;

describe('M14 e2e — workspace create (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips create_workspace; envelope carries the projected workspace', async () => {
    const createdWorkspace = {
      id: '12345',
      name: 'Marketing',
      description: 'EU campaigns',
      kind: 'open',
      state: 'active',
      is_default_workspace: false,
      created_at: '2026-05-07T11:00:00Z',
      settings: { icon: { color: '#0000FF', image: null } },
    };
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'WorkspaceCreate',
          response: { data: { create_workspace: createdWorkspace } },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: [
        'workspace',
        'create',
        '--name',
        'Marketing',
        '--description',
        'EU campaigns',
        '--json',
      ],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { id: string; name: string; kind: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('12345');
    expect(env.data.name).toBe('Marketing');
    expect(env.data.kind).toBe('open');
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});
