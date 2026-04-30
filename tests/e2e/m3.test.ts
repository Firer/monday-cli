/**
 * M3 E2E suite — spawns the compiled binary against a fixture server
 * for one command per noun (`v0.1-plan.md` §3 M3 exit criteria).
 *
 * The integration suite covers per-command branch logic; here we
 * verify that argv parses, the FetchTransport sends the right
 * headers, the envelope renderer emits valid JSON on stdout, and
 * the exit codes match the §3.1 contract end-to-end.
 *
 * Build dependency: `dist/cli/index.js` must be current. CI runs
 * `npm run build` before `test:e2e`; the spawn helper fails fast
 * with a hint if the binary is missing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnCli } from './spawn.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';
import type { Interaction } from '../fixtures/load.js';

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

describe('M3 e2e — board describe', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('happy path includes example_set per writable column', async () => {
    const cassette: Interaction = {
      operation_name: 'BoardMetadata',
      response: {
        data: {
          boards: [
            {
              id: '111',
              name: 'Tasks',
              description: null,
              state: 'active',
              board_kind: 'public',
              board_folder_id: null,
              workspace_id: '5',
              url: null,
              hierarchy_type: 'top_level',
              is_leaf: true,
              updated_at: '2026-04-30T10:00:00Z',
              groups: [],
              columns: [
                {
                  id: 'name_text',
                  title: 'Notes',
                  type: 'text',
                  description: null,
                  archived: false,
                  settings_str: null,
                  width: null,
                },
                {
                  id: 'mirror_x',
                  title: 'Mirror',
                  type: 'mirror',
                  description: null,
                  archived: false,
                  settings_str: null,
                  width: null,
                },
              ],
            },
          ],
        },
      },
    };
    const xdg = await mkdtemp(join(tmpdir(), 'monday-cli-e2e-bd-'));
    try {
      server = await startFixtureServer({ cassette: { interactions: [cassette] } });
      const result = await spawnCli({
        args: ['board', 'describe', '111', '--json', '--no-cache'],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(result.exitCode).toBe(0);
      const env = parseEnvelope(result.stdout) as EnvelopeShape & {
        data: {
          columns: readonly { id: string; example_set: readonly string[] | null; writable: boolean }[];
        };
      };
      expect(env.meta.api_version).toBe('2026-01');
      expect(env.data.columns.find((c) => c.id === 'name_text')?.writable).toBe(true);
      expect(env.data.columns.find((c) => c.id === 'mirror_x')?.example_set).toBeNull();
      expect(result.stderr).toBe('');
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

describe('M3 e2e — board list', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('emits a collection envelope with total_returned', async () => {
    server = await startFixtureServer({
      cassette: {
        interactions: [
          {
            operation_name: 'BoardList',
            response: {
              data: {
                boards: [
                  {
                    id: '111',
                    name: 'Tasks',
                    description: null,
                    state: 'active',
                    board_kind: 'public',
                    board_folder_id: null,
                    workspace_id: '5',
                    url: null,
                    items_count: 7,
                    updated_at: '2026-04-30T10:00:00Z',
                  },
                ],
              },
            },
          },
        ],
      },
    });
    const result = await spawnCli({
      args: ['board', 'list', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: readonly { id: string }[];
    };
    expect(env.data.map((b) => b.id)).toEqual(['111']);
    expect(env.meta.total_returned).toBe(1);
  });
});

describe('M3 e2e — user me', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('returns the projected identity', async () => {
    server = await startFixtureServer({
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
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
          },
        ],
      },
    });
    const result = await spawnCli({
      args: ['user', 'me', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { me: { email: string } };
    };
    expect(env.data.me.email).toBe('alice@example.test');
  });
});

describe('M3 e2e — update list', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('returns updates for an item end-to-end', async () => {
    server = await startFixtureServer({
      cassette: {
        interactions: [
          {
            operation_name: 'UpdateList',
            response: {
              data: {
                items: [
                  {
                    id: '5001',
                    updates: [
                      {
                        id: '77',
                        body: '<p>Hi</p>',
                        text_body: 'Hi',
                        creator_id: '1',
                        creator: {
                          id: '1',
                          name: 'A',
                          email: 'a@x.test',
                        },
                        created_at: '2026-04-30T09:00:00Z',
                        updated_at: '2026-04-30T09:00:00Z',
                        edited_at: '2026-04-30T09:00:00Z',
                        replies: [],
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    });
    const result = await spawnCli({
      args: ['update', 'list', '5001', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: readonly { id: string }[];
    };
    expect(env.data).toHaveLength(1);
    expect(env.data[0]?.id).toBe('77');
  });
});

describe('M3 e2e — stale_cursor surfaces from any pagination cursor we expose later', () => {
  // M3 ships no cursor-paginated commands (`board list`, `workspace
  // list`, etc. all use page-based pagination — the §5.6 stale-cursor
  // contract applies to M4's `item list`). This regression test
  // pre-pins the contract: a stale-cursor GraphQL error from any
  // future cursor-based command must produce exit 2 + the
  // documented error code, with NO silent retry.
  //
  // We exercise the contract via the existing `account whoami`
  // operation because its query goes through the same error mapper.
  // When M4 ships `item list`, that command will reuse the same
  // mapping; this test guards against a regression where the mapper
  // forgot to surface `INVALID_CURSOR_EXCEPTION`.

  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('a stale-cursor GraphQL error surfaces as exit 2 + error.code=stale_cursor', async () => {
    server = await startFixtureServer({
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  message: 'Cursor expired',
                  extensions: { code: 'INVALID_CURSOR_EXCEPTION' },
                },
              ],
            },
          },
        ],
      },
    });
    const result = await spawnCli({
      args: ['account', 'whoami', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(2);
    const env = parseEnvelope(result.stderr);
    expect(env.error?.code).toBe('stale_cursor');
  });
});
