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

describe('M14 e2e — workspace add-users (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips add_users_to_workspace; envelope carries data.operation + per-user results', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'WorkspaceAddUsers',
          response: {
            data: {
              add_users_to_workspace: [
                { id: '67890', name: 'User 67890', email: 'u67890@example.test' },
              ],
            },
          },
        },
        {
          operation_name: 'WorkspaceAddUsers',
          response: {
            data: {
              add_users_to_workspace: [
                { id: '67891', name: 'User 67891', email: 'u67891@example.test' },
              ],
            },
          },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: ['workspace', 'add-users', '12345', '--users', '67890,67891', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        results: readonly { user_id: string; ok: boolean }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.operation).toBe('add_users_to_workspace');
    expect(env.data.results).toHaveLength(2);
    expect(env.data.results[0]?.ok).toBe(true);
    expect(env.data.results[1]?.ok).toBe(true);
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});

describe('M14 e2e — workspace delete --yes (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips delete_workspace; envelope carries the projected workspace with state=deleted', async () => {
    const deletedWorkspace = {
      id: '12345',
      name: 'Marketing',
      description: 'EU campaigns',
      kind: 'open',
      state: 'deleted',
      is_default_workspace: false,
      created_at: '2026-05-07T11:00:00Z',
      settings: { icon: { color: '#0000FF', image: null } },
    };
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'WorkspaceDelete',
          response: { data: { delete_workspace: deletedWorkspace } },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: ['workspace', 'delete', '12345', '--yes', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { id: string; state: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.state).toBe('deleted');
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});

describe('M14 e2e — workspace update (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips update_workspace; envelope carries the projected updated workspace', async () => {
    const updatedWorkspace = {
      id: '12345',
      name: 'Marketing — EU',
      description: 'EU campaigns',
      kind: 'closed',
      state: 'active',
      is_default_workspace: false,
      created_at: '2026-05-07T11:00:00Z',
      settings: { icon: { color: '#0000FF', image: null } },
    };
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'WorkspaceUpdate',
          response: { data: { update_workspace: updatedWorkspace } },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: [
        'workspace',
        'update',
        '12345',
        '--name',
        'Marketing — EU',
        '--kind',
        'closed',
        '--json',
      ],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { id: string; name: string; kind: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.name).toBe('Marketing — EU');
    expect(env.data.kind).toBe('closed');
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});

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
