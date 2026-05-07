/**
 * Integration tests for `monday board *` (M3 §3).
 *
 * Same FixtureTransport drive as the workspace + account suites.
 * Coverage:
 *   - board list — happy path, --all paging, error-meta on 401.
 *   - board get — happy path, not_found on missing, parse boundary.
 *   - board find — exact, ambiguous_name, --first warning, not_found.
 *   - board describe — example_set per writable column type.
 *   - board subscribers / columns / groups — happy + cache flow.
 *   - M15 lifecycle: create / update / archive / delete / duplicate /
 *     add-users (each in its own describe block).
 *
 * Each board describe / columns / groups test uses an isolated
 * tmp XDG cache so cache-write side effects don't bleed across tests.
 */
import { describe, expect, it } from 'vitest';
import type { Interaction } from '../../fixtures/load.js';
import {
  assertEnvelopeContract,
  parseEnvelope,
  useCachedIntegrationEnv,
  type EnvelopeShape,
} from '../helpers.js';

// `board.test.ts` exercises cache-aware reads (`board describe` /
// `columns` / `groups`); each `drive` call needs a per-test isolated
// `XDG_CACHE_HOME`. R11 lifted the wrapper into helpers.ts during
// the M5b cleanup so this file no longer carries its own copy.
const { drive } = useCachedIntegrationEnv('monday-cli-board-int-');

const sampleBoard = {
  id: '111',
  name: 'Tasks',
  description: null,
  state: 'active',
  board_kind: 'public',
  board_folder_id: null,
  workspace_id: '5',
  url: 'https://x.monday.com/boards/111',
  items_count: 7,
  updated_at: '2026-04-30T10:00:00Z',
};

describe('monday board list — null-data resilience', () => {
  it('handles a missing `boards` field gracefully', async () => {
    const out = await drive(
      ['board', 'list', '--json'],
      {
        interactions: [
          { operation_name: 'BoardList', response_body: { data: {} } },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual([]);
  });
});

describe('monday board list', () => {
  it('returns the projected list', async () => {
    const out = await drive(
      ['board', 'list', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardList',
            response: { data: { boards: [sampleBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    assertEnvelopeContract(env);
    expect(env.data).toEqual([sampleBoard]);
    expect(env.meta.total_returned).toBe(1);
  });

  it('--api-version reaches the error envelope on HTTP 401', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'board', 'list', '--json'],
      {
        interactions: [
          { operation_name: 'BoardList', http_status: 401, response: {} },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
  });
});

describe('monday board get', () => {
  it('returns the projected board', async () => {
    const out = await drive(
      ['board', 'get', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardGet',
            match_variables: { ids: ['111'] },
            response: {
              data: { boards: [{ ...sampleBoard, permissions: 'collaborators' }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toMatchObject({ id: '111', permissions: 'collaborators' });
  });

  it('not_found when boards is empty', async () => {
    const out = await drive(
      ['board', 'get', '999', '--json'],
      {
        interactions: [
          { operation_name: 'BoardGet', response: { data: { boards: [] } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('not_found when Monday returns a non-object data slot (defensive)', async () => {
    // Drives the run-by-id-lookup helper's structural guards
    // (`isObject(data)` false → null collection → undefined first →
    // not_found). Defensive against a malformed proxy / version-skew
    // response. Without the guards, the runner would surface
    // internal_error from a TypeError.
    const out = await drive(
      ['board', 'get', '111', '--json'],
      {
        interactions: [
          { operation_name: 'BoardGet', response_body: { data: null } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('rejects a non-numeric id at the parse boundary (usage_error)', async () => {
    const out = await drive(['board', 'get', 'abc', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});

describe('monday board find — null-data resilience', () => {
  it('treats a missing `boards` field on the response as empty (not_found)', async () => {
    // Drives the `r.data.boards ?? []` ?? branch — Monday returning
    // `{ data: {} }` from BoardFind (no boards selection) shouldn't
    // crash the walker; the empty array surfaces as not_found per
    // the unique-match contract.
    const out = await drive(
      ['board', 'find', 'Tasks', '--json'],
      {
        interactions: [
          { operation_name: 'BoardFind', response_body: { data: {} } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });
});

describe('monday board find', () => {
  // The BoardFind GraphQL document only selects a narrow projection
  // — match the fixture to it (real GraphQL would never return
  // unrequested fields).
  const findFixture = (
    over: Partial<Readonly<Record<string, unknown>>> = {},
  ): Readonly<Record<string, unknown>> => ({
    id: '111',
    name: 'Tasks',
    description: null,
    state: 'active',
    board_kind: 'public',
    workspace_id: '5',
    url: null,
    ...over,
  });

  const findInteraction = (
    boards: readonly unknown[],
    page = 1,
  ): Interaction => ({
    operation_name: 'BoardFind',
    match_variables: { page },
    response: { data: { boards } },
  });

  it('returns a single board on unique match', async () => {
    const out = await drive(
      ['board', 'find', 'Tasks', '--json'],
      { interactions: [findInteraction([findFixture()])] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toMatchObject({ id: '111', name: 'Tasks' });
    expect(env.warnings ?? []).toEqual([]);
  });

  it('raises ambiguous_name with candidates on multi-match', async () => {
    const out = await drive(
      ['board', 'find', 'Tasks', '--json'],
      {
        interactions: [
          findInteraction([findFixture(), findFixture({ id: '112' })]),
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error: {
        readonly code: string;
        readonly details: { readonly candidates: readonly { id: string }[] };
      };
    };
    expect(env.error.code).toBe('ambiguous_name');
    expect(env.error.details.candidates.map((c) => c.id)).toEqual([
      '111',
      '112',
    ]);
  });

  it('--first picks lowest-ID and emits a first_of_many warning', async () => {
    const out = await drive(
      ['board', 'find', 'Tasks', '--first', '--json'],
      {
        interactions: [
          findInteraction([
            findFixture({ id: '300' }),
            findFixture({ id: '200' }),
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('200');
    expect(env.warnings).toBeDefined();
    expect(env.warnings?.[0]?.code).toBe('first_of_many');
  });

  it('not_found when nothing matches', async () => {
    const out = await drive(
      ['board', 'find', 'Missing', '--json'],
      { interactions: [findInteraction([findFixture()])] },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('walks pages until it sees a short page (default cap = 5)', async () => {
    // Page 1 returns exactly 100 boards (full page) → walker continues.
    // Page 2 returns < 100 → walker stops.
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      findFixture({ id: String(1000 + i), name: `Other ${String(i)}` }),
    );
    const shortPage = [findFixture({ id: '777', name: 'Tasks' })];
    const out = await drive(
      ['board', 'find', 'Tasks', '--json'],
      {
        interactions: [
          findInteraction(fullPage, 1),
          findInteraction(shortPage, 2),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & { data: { id: string } };
    expect(env.data.id).toBe('777');
    expect(out.requests).toBe(2);
  });

  it('walks multiple pages with --workspace + --state filters threaded through', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      findFixture({ id: String(2000 + i), name: `Other ${String(i)}` }),
    );
    const shortPage = [findFixture({ id: '888', name: 'Tasks' })];
    const out = await drive(
      [
        'board',
        'find',
        'Tasks',
        '--workspace',
        '5',
        '--state',
        'archived',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardFind',
            match_variables: {
              page: 1,
              workspaceIds: ['5'],
              state: 'archived',
            },
            response: { data: { boards: fullPage } },
          },
          {
            operation_name: 'BoardFind',
            match_variables: {
              page: 2,
              workspaceIds: ['5'],
              state: 'archived',
            },
            response: { data: { boards: shortPage } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('888');
    expect(out.requests).toBe(2);
  });

  it('--limit-pages caps the walk', async () => {
    // The walker stops after `--limit-pages` even if every page is full.
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      findFixture({ id: String(2000 + i), name: `Z ${String(i)}` }),
    );
    const out = await drive(
      ['board', 'find', 'Tasks', '--limit-pages', '2', '--json'],
      {
        interactions: [
          findInteraction(fullPage, 1),
          findInteraction(fullPage, 2),
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
    expect(out.requests).toBe(2);
  });
});

const metadataResponse = (
  columns: readonly Readonly<Record<string, unknown>>[],
  groups: readonly Readonly<Record<string, unknown>>[] = [],
): Interaction => ({
  operation_name: 'BoardMetadata',
  match_variables: { ids: ['111'] },
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
          groups,
          columns,
        },
      ],
    },
  },
});

const baseColumn = {
  id: 'col_x',
  title: 'X',
  type: 'text',
  description: null,
  archived: false,
  settings_str: null,
  width: null,
};

describe('monday board describe', () => {
  it('emits example_set per writable column type', async () => {
    const out = await drive(
      ['board', 'describe', '111', '--json'],
      {
        interactions: [
          metadataResponse([
            { ...baseColumn, id: 'name_text', title: 'Notes', type: 'text' },
            {
              ...baseColumn,
              id: 'status_4',
              title: 'Status',
              type: 'status',
              settings_str: JSON.stringify({
                labels: { '0': 'Backlog', '1': 'Done' },
              }),
            },
            {
              ...baseColumn,
              id: 'mirror_x',
              title: 'Mirror',
              type: 'mirror',
            },
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        hierarchy_type: string | null;
        is_leaf: boolean | null;
        columns: readonly {
          id: string;
          type: string;
          writable: boolean;
          example_set: readonly string[] | null;
        }[];
      };
    };
    assertEnvelopeContract(env);
    expect(env.data.hierarchy_type).toBe('top_level');
    expect(env.data.is_leaf).toBe(true);
    const text = env.data.columns.find((c) => c.id === 'name_text');
    const status = env.data.columns.find((c) => c.id === 'status_4');
    const mirror = env.data.columns.find((c) => c.id === 'mirror_x');
    expect(text?.writable).toBe(true);
    expect(text?.example_set).toEqual([`--set name_text='Refactor login'`]);
    expect(status?.writable).toBe(true);
    expect(status?.example_set).toEqual([
      `--set status_4='Backlog'`,
      `--set status_4=0   # by index`,
    ]);
    expect(mirror?.writable).toBe(false);
    expect(mirror?.example_set).toBeNull();
  });

  it('serves from cache on the second call', async () => {
    const out1 = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([baseColumn])] },
    );
    expect(out1.exitCode).toBe(0);
    const env1 = parseEnvelope(out1.stdout);
    expect(env1.meta.source).toBe('live');

    const out2 = await drive(
      ['board', 'describe', '111', '--json'],
      // Cassette returns nothing; the cache must serve.
      { interactions: [] },
    );
    expect(out2.exitCode).toBe(0);
    const env2 = parseEnvelope(out2.stdout);
    expect(env2.meta.source).toBe('cache');
    expect(env2.meta.cache_age_seconds).toBeGreaterThanOrEqual(0);
    expect(out2.requests).toBe(0);
  });

  it('default (no --include-archived) excludes archived AND deleted groups', async () => {
    // Pins describe.ts:227 — the default-path groups filter callback.
    // Existing default-path tests use only live groups, so the
    // `g.archived !== true && g.deleted !== true` predicate's truthy
    // arm fires but its falsy arms (filter-it-out for archived OR
    // deleted) didn't until this test landed. Mirror of the
    // `--include-archived` test directly below.
    const cols = [{ ...baseColumn, id: 'live', title: 'Live' }];
    const groups = [
      { id: 'g1', title: 'G1', color: null, position: '1', archived: false, deleted: false },
      { id: 'g2', title: 'G2', color: null, position: '2', archived: true, deleted: false },
      { id: 'g3', title: 'G3', color: null, position: '3', archived: false, deleted: true },
    ];
    const out = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse(cols, groups)] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { groups: readonly { id: string }[] };
    };
    // Only the live group survives; archived + deleted both filtered.
    expect(env.data.groups.map((g) => g.id)).toEqual(['g1']);
  });

  it('--include-archived shows archived columns and deleted groups', async () => {
    const cols = [
      { ...baseColumn, id: 'live', title: 'Live' },
      { ...baseColumn, id: 'gone', title: 'Gone', archived: true },
    ];
    const groups = [
      { id: 'g1', title: 'G1', color: null, position: '1', archived: false, deleted: false },
      { id: 'g2', title: 'G2', color: null, position: '2', archived: true, deleted: false },
    ];
    const out = await drive(
      ['board', 'describe', '111', '--include-archived', '--json'],
      { interactions: [metadataResponse(cols, groups)] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        columns: readonly { id: string }[];
        groups: readonly { id: string }[];
      };
    };
    expect(env.data.columns.map((c) => c.id)).toEqual(['live', 'gone']);
    expect(env.data.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
  });

  it('--no-cache always fetches live', async () => {
    // First call seeds the cache.
    const live1 = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([baseColumn])] },
    );
    expect(live1.exitCode).toBe(0);

    const live2 = await drive(
      ['--no-cache', 'board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([baseColumn])] },
    );
    expect(live2.exitCode).toBe(0);
    const env = parseEnvelope(live2.stdout);
    expect(env.meta.source).toBe('live');
    expect(live2.requests).toBe(1);
  });
});

describe('monday board list — variable threading', () => {
  it('--workspace + --state become workspaceIds + state on the wire', async () => {
    const out = await drive(
      ['board', 'list', '--workspace', '5', '--state', 'archived', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardList',
            match_variables: { workspaceIds: ['5'], state: 'archived' },
            response: { data: { boards: [sampleBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('--all + --page is a usage_error', async () => {
    const out = await drive(
      ['board', 'list', '--all', '--page', '2', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--all + --limit-pages caps with pagination_cap_reached warning', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => ({
      ...sampleBoard,
      id: String(1000 + i),
    }));
    const out = await drive(
      ['board', 'list', '--all', '--limit', '25', '--limit-pages', '2', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardList',
            match_variables: { page: 1 },
            response: { data: { boards: fullPage } },
          },
          {
            operation_name: 'BoardList',
            match_variables: { page: 2 },
            response: { data: { boards: fullPage } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      warnings: readonly { readonly code: string }[];
    };
    expect(env.meta.has_more).toBe(true);
    expect(env.warnings[0]?.code).toBe('pagination_cap_reached');
  });
});

describe('monday board subscribers — extended', () => {
  it('not_found when the board does not exist', async () => {
    const out = await drive(
      ['board', 'subscribers', '999', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardSubscribers',
            response: { data: { boards: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('rejects a non-numeric board id at the parse boundary', async () => {
    const out = await drive(
      ['board', 'subscribers', 'abc', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('emits has_more=false on the single-fetch payload', async () => {
    const out = await drive(
      ['board', 'subscribers', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardSubscribers',
            response: {
              data: {
                boards: [
                  {
                    id: '111',
                    subscribers: [],
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.has_more).toBe(false);
    expect(env.meta.total_returned).toBe(0);
  });
});

describe('monday board groups — extended', () => {
  it('--include-archived reveals archived/deleted groups', async () => {
    const groups = [
      {
        id: 'g1',
        title: 'Live',
        color: 'red',
        position: '1.000',
        archived: false,
        deleted: false,
      },
      {
        id: 'g2',
        title: 'Old',
        color: null,
        position: '2.000',
        archived: true,
        deleted: false,
      },
      {
        id: 'g3',
        title: 'Gone',
        color: null,
        position: '3.000',
        archived: false,
        deleted: true,
      },
    ];
    const out1 = await drive(
      ['board', 'groups', '111', '--json'],
      { interactions: [metadataResponse([], groups)] },
    );
    const env1 = parseEnvelope(out1.stdout) as EnvelopeShape & {
      data: readonly { id: string }[];
    };
    expect(env1.data.map((g) => g.id)).toEqual(['g1']);

    const out2 = await drive(
      ['--no-cache', 'board', 'groups', '111', '--include-archived', '--json'],
      { interactions: [metadataResponse([], groups)] },
    );
    const env2 = parseEnvelope(out2.stdout) as EnvelopeShape & {
      data: readonly { id: string }[];
    };
    expect(env2.data.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
  });
});

describe('monday board subscribers', () => {
  it('returns subscribers list', async () => {
    const out = await drive(
      ['board', 'subscribers', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardSubscribers',
            response: {
              data: {
                boards: [
                  {
                    id: '111',
                    subscribers: [
                      {
                        id: '1',
                        name: 'Alice',
                        email: 'alice@example.test',
                        is_guest: false,
                        enabled: true,
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: readonly { id: string }[];
    };
    expect(env.data).toEqual([
      {
        id: '1',
        name: 'Alice',
        email: 'alice@example.test',
        is_guest: false,
        enabled: true,
      },
    ]);
  });
});

describe('monday board columns + groups', () => {
  it('board columns hides archived by default and reveals with --include-archived', async () => {
    const cols = [
      { ...baseColumn, id: 'a', title: 'A' },
      { ...baseColumn, id: 'b', title: 'B', archived: true },
    ];
    const out1 = await drive(
      ['board', 'columns', '111', '--json'],
      { interactions: [metadataResponse(cols)] },
    );
    const env1 = parseEnvelope(out1.stdout) as EnvelopeShape & {
      data: readonly { id: string }[];
    };
    expect(env1.data.map((c) => c.id)).toEqual(['a']);

    const out2 = await drive(
      ['--no-cache', 'board', 'columns', '111', '--include-archived', '--json'],
      { interactions: [metadataResponse(cols)] },
    );
    const env2 = parseEnvelope(out2.stdout) as EnvelopeShape & {
      data: readonly { id: string }[];
    };
    expect(env2.data.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('board groups returns the projected groups', async () => {
    const groups = [
      {
        id: 'topics',
        title: 'Topics',
        color: 'red',
        position: '1.000',
        archived: false,
        deleted: false,
      },
    ];
    const out = await drive(
      ['board', 'groups', '111', '--json'],
      { interactions: [metadataResponse([], groups)] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual(groups);
  });
});

describe('monday board create (integration, M15)', () => {
  const createdBoard = {
    id: '67890',
    name: 'Engineering',
    description: 'Eng team board',
    state: 'active',
    board_kind: 'public',
    board_folder_id: null,
    workspace_id: '5',
    url: 'https://x.monday.com/boards/67890',
    items_count: 0,
    updated_at: '2026-05-07T11:00:00Z',
    permissions: 'everyone',
  };

  it('live: --name posts create_board with default kind=public and emits the projected board', async () => {
    const out = await drive(
      ['board', 'create', '--name', 'Engineering', '--workspace', '5', '--description', 'Eng team board', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardCreate',
            // Wire-shape pin: kind is always sent (Monday's signature
            // pins board_kind: BoardKind!), defaulting to "public" when
            // the agent omits --kind. workspace_id + description
            // forwarded verbatim.
            match_variables: {
              boardName: 'Engineering',
              boardKind: 'public',
              workspaceId: '5',
              description: 'Eng team board',
            },
            // Pin the GraphQL surface so a future regression that
            // drops `board_kind` from the mutation declaration would
            // fail here.
            match_query: /create_board\(\s*board_name: \$boardName,\s*board_kind: \$boardKind/,
            response: { data: { create_board: createdBoard } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string; board_kind: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('67890');
    expect(env.data.name).toBe('Engineering');
    expect(env.data.board_kind).toBe('public');
    assertEnvelopeContract(env);
    expect(env.meta.source).toBe('live');
  });

  it('live: --kind private forwards kind through to the wire', async () => {
    const privateBoard = { ...createdBoard, board_kind: 'private' };
    const out = await drive(
      ['board', 'create', '--name', 'Confidential', '--kind', 'private', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardCreate',
            match_variables: { boardName: 'Confidential', boardKind: 'private' },
            response: { data: { create_board: privateBoard } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { board_kind: string };
    };
    expect(env.data.board_kind).toBe('private');
  });

  it('live: --template forwards templateId through to the wire', async () => {
    // The CLI doesn't pre-validate template-ness — Monday surfaces
    // a validation_failed wire error if the ID isn't a template.
    // This test pins the templateId variable lands on the wire.
    const out = await drive(
      ['board', 'create', '--name', 'Roadmap', '--template', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardCreate',
            match_variables: {
              boardName: 'Roadmap',
              boardKind: 'public',
              templateId: '99999',
            },
            response: { data: { create_board: createdBoard } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('live: --workspace, --description, --template all omitted → only required args sent', async () => {
    // Pre-fix, an inadvertent `description: undefined` /
    // `workspace_id: undefined` in the variables map would have been
    // serialised as `null` on the wire. The action body filters
    // undefined out; this fixture asserts the wire-side variables
    // shape carries only the agent-provided fields.
    const out = await drive(
      ['board', 'create', '--name', 'Bare', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardCreate',
            match_variables: { boardName: 'Bare', boardKind: 'public' },
            response: { data: { create_board: createdBoard } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('rejects --kind unknown as usage_error at argv parse', async () => {
    const out = await drive(
      ['board', 'create', '--name', 'X', '--kind', 'open', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --name as usage_error (after trim)', async () => {
    const out = await drive(
      ['board', 'create', '--name', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects missing --name as usage_error (commander requiredOption)', async () => {
    const out = await drive(
      ['board', 'create', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric --workspace as usage_error (BoardId/WorkspaceId argv-parse)', async () => {
    const out = await drive(
      ['board', 'create', '--name', 'X', '--workspace', 'not-numeric', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric --template as usage_error', async () => {
    const out = await drive(
      ['board', 'create', '--name', 'X', '--template', 'not-numeric', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: emits planned_changes with operation create_board; no mutation fires', async () => {
    const out = await drive(
      [
        'board', 'create', '--name', 'Preview',
        '--workspace', '5',
        '--kind', 'private',
        '--description', 'Preview desc',
        '--template', '99999',
        '--dry-run', '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        name: string;
        kind: string;
        workspace_id?: string;
        description?: string;
        template_id?: string;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.meta.source).toBe('none');
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('create_board');
    expect(plan?.name).toBe('Preview');
    expect(plan?.kind).toBe('private');
    expect(plan?.workspace_id).toBe('5');
    expect(plan?.description).toBe('Preview desc');
    expect(plan?.template_id).toBe('99999');
    expect(out.requests).toBe(0);
  });

  it('--dry-run: omits optional slots when flags are not set; defaults kind to public', async () => {
    const out = await drive(
      ['board', 'create', '--name', 'Minimal', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Record<string, unknown>[];
    };
    const plan = env.planned_changes[0];
    expect(plan).toEqual({
      operation: 'create_board',
      name: 'Minimal',
      kind: 'public',
    });
  });

  it('surfaces internal_error when Monday returns a null create_board payload', async () => {
    // Drives the projectCreatedBoard null-guard. Mirrors the
    // null-payload regression test on workspace create.
    const out = await drive(
      ['board', 'create', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardCreate',
            response: { data: { create_board: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('surfaces internal_error when Monday returns a missing create_board key (root-key absent)', async () => {
    // Distinguishes missing-root-key (internal_error) from null
    // payload (also internal_error here since create has no
    // partial-success per-record envelope). Both surface as
    // whole-call internal_error — verifies the responseSchema
    // catches the missing-root-key shape.
    const out = await drive(
      ['board', 'create', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardCreate',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });
});

describe('monday board update (integration, M15)', () => {
  const currentBoard = {
    id: '12345',
    name: 'Engineering',
    description: 'Eng team',
    state: 'active',
    board_kind: 'public',
    board_folder_id: null,
    workspace_id: '5',
    url: 'https://x.monday.com/boards/12345',
    items_count: 7,
    updated_at: '2026-05-07T11:00:00Z',
    permissions: 'everyone',
  };
  const renamedBoard = { ...currentBoard, name: 'Engineering — EU' };

  // BoardMetadata fixture matches the loadBoardMetadata wire shape.
  const boardMetadataInteraction: Interaction = {
    operation_name: 'BoardMetadata',
    match_variables: { ids: ['12345'] },
    response: {
      data: {
        boards: [
          {
            id: '12345',
            name: 'Engineering',
            description: 'Eng team',
            state: 'active',
            board_kind: 'public',
            board_folder_id: null,
            workspace_id: '5',
            url: 'https://x.monday.com/boards/12345',
            hierarchy_type: 'top_level',
            is_leaf: true,
            updated_at: '2026-05-07T11:00:00Z',
            groups: [],
            columns: [],
          },
        ],
      },
    },
  };

  it('live: --name fires update_board(name) then BoardUpdateFinalRead and emits the projected board', async () => {
    const out = await drive(
      ['board', 'update', '12345', '--name', 'Engineering — EU', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardUpdate',
            // Wire-shape pin: per-attribute mutation, not multi-
            // attribute attributes input. board_attribute is a
            // BoardAttributes enum value sent verbatim as 'name'.
            match_variables: {
              boardId: '12345',
              boardAttribute: 'name',
              newValue: 'Engineering — EU',
            },
            match_query: /update_board\(\s*board_id: \$boardId,\s*board_attribute: \$boardAttribute,\s*new_value: \$newValue/,
            response: { data: { update_board: 'Engineering — EU' } },
          },
          {
            operation_name: 'BoardUpdateFinalRead',
            match_variables: { ids: ['12345'] },
            response: { data: { boards: [renamedBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string };
    };
    expect(env.data.id).toBe('12345');
    expect(env.data.name).toBe('Engineering — EU');
    // Force-live final read pin: success envelope reflects post-
    // mutation state, not stale cached metadata. meta.source: live.
    expect(env.meta.source).toBe('live');
    assertEnvelopeContract(env);
  });

  it('live: multi-flag --name + --description fires two sequential update_board calls + final read', async () => {
    const updatedBoard = {
      ...currentBoard,
      name: 'Renamed',
      description: 'Updated',
    };
    const out = await drive(
      [
        'board', 'update', '12345',
        '--name', 'Renamed',
        '--description', 'Updated',
        '--json',
      ],
      {
        interactions: [
          // Per-field fan-out — name first per FIELD_DISPATCH_ORDER.
          {
            operation_name: 'BoardUpdate',
            match_variables: {
              boardId: '12345',
              boardAttribute: 'name',
              newValue: 'Renamed',
            },
            response: { data: { update_board: 'Renamed' } },
          },
          {
            operation_name: 'BoardUpdate',
            match_variables: {
              boardId: '12345',
              boardAttribute: 'description',
              newValue: 'Updated',
            },
            response: { data: { update_board: 'Updated' } },
          },
          // Single final read for the success envelope's data.
          {
            operation_name: 'BoardUpdateFinalRead',
            match_variables: { ids: ['12345'] },
            response: { data: { boards: [updatedBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { name: string; description: string };
    };
    expect(env.data.name).toBe('Renamed');
    expect(env.data.description).toBe('Updated');
  });

  it('live: per-field failure surfaces whole-call error (no partial-success leak)', async () => {
    // Per cli-design §6.4 board-update partial-application caveat:
    // server-side state is non-transactional, so when call #1
    // succeeds and call #2 fails the envelope is ok:false with
    // call #2's error code (not a partial-success envelope).
    // Earlier successful fields stay applied server-side.
    const out = await drive(
      [
        'board', 'update', '12345',
        '--name', 'Renamed',
        '--description', 'Updated',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardUpdate',
            match_variables: {
              boardId: '12345',
              boardAttribute: 'name',
              newValue: 'Renamed',
            },
            response: { data: { update_board: 'Renamed' } },
          },
          {
            operation_name: 'BoardUpdate',
            match_variables: {
              boardId: '12345',
              boardAttribute: 'description',
              newValue: 'Updated',
            },
            response: {
              data: { update_board: null },
              errors: [
                {
                  message: 'Description too long',
                  extensions: { code: 'InvalidArgumentException' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    // Whole-call envelope is ok:false; agent re-reads to see
    // what landed and retries the unapplied tail.
    expect(env.ok).toBe(false);
  });

  it('rejects zero-flag invocation as usage_error at argv parse', async () => {
    const out = await drive(
      ['board', 'update', '12345', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --name (whitespace-only) as usage_error', async () => {
    const out = await drive(
      ['board', 'update', '12345', '--name', '  ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric boardId at argv parse', async () => {
    const out = await drive(
      ['board', 'update', 'not-numeric', '--name', 'X', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: --name emits diff with from/to via BoardMetadata preflight', async () => {
    const out = await drive(
      ['board', 'update', '12345', '--name', 'Engineering — EU', '--dry-run', '--json'],
      { interactions: [boardMetadataInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        board_id: string;
        diff: Record<string, { from: unknown; to: unknown }>;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('update_board');
    expect(plan?.board_id).toBe('12345');
    expect(plan?.diff).toEqual({
      name: { from: 'Engineering', to: 'Engineering — EU' },
    });
  });

  it('--dry-run: multi-flag emits combined diff with name + description from/to', async () => {
    const out = await drive(
      [
        'board', 'update', '12345',
        '--name', 'Renamed',
        '--description', 'New description',
        '--dry-run', '--json',
      ],
      { interactions: [boardMetadataInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        diff: Record<string, { from: unknown; to: unknown }>;
      }[];
    };
    const plan = env.planned_changes[0];
    expect(plan?.diff).toEqual({
      name: { from: 'Engineering', to: 'Renamed' },
      description: { from: 'Eng team', to: 'New description' },
    });
  });

  it('--dry-run: surfaces not_found when preflight returns empty boards list', async () => {
    const out = await drive(
      ['board', 'update', '99999', '--name', 'X', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            match_variables: { ids: ['99999'] },
            response: { data: { boards: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('surfaces internal_error when update_board response is missing the root key', async () => {
    // Codex M14 round-2/round-3 distinction landed proactively for
    // M15: missing-root-key is a schema-drift internal_error,
    // distinct from a null per-attribute response value.
    const out = await drive(
      ['board', 'update', '12345', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardUpdate',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('surfaces internal_error when final read returns no board for the just-updated id', async () => {
    // Defensive: per-field calls succeeded but the final read
    // can't find the board. Should NOT be silently swallowed —
    // surfaces as internal_error so the agent sees a contract
    // anomaly rather than a no-op success.
    const out = await drive(
      ['board', 'update', '12345', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardUpdate',
            match_variables: {
              boardId: '12345',
              boardAttribute: 'name',
              newValue: 'X',
            },
            response: { data: { update_board: 'X' } },
          },
          {
            operation_name: 'BoardUpdateFinalRead',
            match_variables: { ids: ['12345'] },
            response: { data: { boards: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });
});

describe('monday board archive (integration, M15)', () => {
  const archivedBoard = {
    id: '12345',
    name: 'Engineering',
    description: 'Eng team',
    state: 'archived',
    board_kind: 'public',
    board_folder_id: null,
    workspace_id: '5',
    url: 'https://x.monday.com/boards/12345',
    items_count: 0,
    updated_at: '2026-05-07T11:00:00Z',
    permissions: 'everyone',
  };

  // BoardMetadata fixture for the dry-run preflight read.
  const boardMetadataInteraction: Interaction = {
    operation_name: 'BoardMetadata',
    match_variables: { ids: ['12345'] },
    response: {
      data: {
        boards: [
          {
            id: '12345',
            name: 'Engineering',
            description: 'Eng team',
            state: 'active',
            board_kind: 'public',
            board_folder_id: null,
            workspace_id: '5',
            url: 'https://x.monday.com/boards/12345',
            hierarchy_type: 'top_level',
            is_leaf: true,
            updated_at: '2026-05-07T11:00:00Z',
            groups: [],
            columns: [],
          },
        ],
      },
    },
  };

  it('rejects without --yes — confirmation_required carries board_id', async () => {
    const out = await drive(
      ['board', 'archive', '12345', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { board_id?: string; hint?: string } };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.board_id).toBe('12345');
    expect(env.error?.details?.hint).toMatch(/30 days/);
    // Gate fires before resolveClient — meta.source stays 'none'.
    expect(env.meta.source).toBe('none');
  });

  it('confirmation gate fires before resolveClient — missing token still surfaces confirmation_required, not config_error', async () => {
    // R29 helper preserves the M10 round-1 P2 ordering: a missing
    // --yes MUST surface as confirmation_required regardless of
    // whether the token is present. Same regression test the M14
    // workspace-delete pinned.
    const out = await drive(
      ['board', 'archive', '12345', '--json'],
      { interactions: [] },
      {
        env: {
          // No MONDAY_API_TOKEN — pre-fix this would have surfaced
          // config_error instead of confirmation_required.
          MONDAY_API_URL: 'https://api.monday.com/v2',
        },
      },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('confirmation_required');
  });

  it('live: --yes fires archive_board and returns the projected board', async () => {
    const out = await drive(
      ['board', 'archive', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardArchive',
            match_variables: { boardId: '12345' },
            match_query: /archive_board\(board_id: \$boardId\)/,
            response: { data: { archive_board: archivedBoard } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; state: string };
    };
    expect(env.data.id).toBe('12345');
    expect(env.data.state).toBe('archived');
    expect(env.meta.source).toBe('live');
    assertEnvelopeContract(env);
  });

  it('live: --yes surfaces not_found when archive_board returns null', async () => {
    const out = await drive(
      ['board', 'archive', '99999', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardArchive',
            match_variables: { boardId: '99999' },
            response: { data: { archive_board: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { board_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.board_id).toBe('99999');
  });

  it('live: surfaces internal_error when archive_board response is missing the root key', async () => {
    // Schema-drift distinction landed proactively — missing-root-key
    // is an internal_error, not a not_found.
    const out = await drive(
      ['board', 'archive', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardArchive',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('--dry-run: emits archive_board planned-change with snapshot via BoardMetadata preflight', async () => {
    const out = await drive(
      ['board', 'archive', '12345', '--dry-run', '--json'],
      { interactions: [boardMetadataInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        board_id: string;
        board: { id: string; name: string; state: string };
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('archive_board');
    expect(plan?.board_id).toBe('12345');
    expect(plan?.board.id).toBe('12345');
    expect(plan?.board.name).toBe('Engineering');
    // Snapshot reflects pre-archive state (state: 'active').
    expect(plan?.board.state).toBe('active');
  });

  it('--dry-run: not_found when preflight returns empty boards list', async () => {
    const out = await drive(
      ['board', 'archive', '99999', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            match_variables: { ids: ['99999'] },
            response: { data: { boards: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('rejects non-numeric boardId at argv parse', async () => {
    const out = await drive(
      ['board', 'archive', 'not-numeric', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});

describe('monday board delete (integration, M15)', () => {
  const deletedBoard = {
    id: '12345',
    name: 'Engineering',
    description: 'Eng team',
    state: 'deleted',
    board_kind: 'public',
    board_folder_id: null,
    workspace_id: '5',
    url: 'https://x.monday.com/boards/12345',
    items_count: 0,
    updated_at: '2026-05-07T11:00:00Z',
    permissions: 'everyone',
  };

  it('rejects without --yes — confirmation_required carries board_id', async () => {
    const out = await drive(
      ['board', 'delete', '12345', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { board_id?: string; hint?: string } };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.board_id).toBe('12345');
    expect(env.error?.details?.hint).toMatch(/30 days/);
    expect(env.meta.source).toBe('none');
  });

  it('confirmation gate fires before resolveClient — missing token still surfaces confirmation_required', async () => {
    const out = await drive(
      ['board', 'delete', '12345', '--json'],
      { interactions: [] },
      { env: { MONDAY_API_URL: 'https://api.monday.com/v2' } },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('confirmation_required');
  });

  it('live: --yes fires delete_board and returns the projected board', async () => {
    const out = await drive(
      ['board', 'delete', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDelete',
            match_variables: { boardId: '12345' },
            match_query: /delete_board\(board_id: \$boardId\)/,
            response: { data: { delete_board: deletedBoard } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; state: string };
    };
    expect(env.data.id).toBe('12345');
    expect(env.data.state).toBe('deleted');
    expect(env.meta.source).toBe('live');
    assertEnvelopeContract(env);
  });

  it('live: not_found when delete_board returns null payload', async () => {
    const out = await drive(
      ['board', 'delete', '99999', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDelete',
            match_variables: { boardId: '99999' },
            response: { data: { delete_board: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { board_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.board_id).toBe('99999');
  });

  it('live: surfaces internal_error when delete_board response is missing the root key', async () => {
    const out = await drive(
      ['board', 'delete', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDelete',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('--dry-run: emits minimal delete_board planned change; no mutation fires', async () => {
    const out = await drive(
      ['board', 'delete', '12345', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly { operation: string; board_id: string }[];
    };
    expect(env.data).toBeNull();
    expect(env.meta.source).toBe('none');
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    // Minimal shape — no `board: <snapshot>` slot, no `diff`. Same
    // shape (modulo board_id) as workspace-delete dry-run.
    expect(plan).toEqual({
      operation: 'delete_board',
      board_id: '12345',
    });
  });

  it('rejects non-numeric boardId at argv parse', async () => {
    const out = await drive(
      ['board', 'delete', 'not-numeric', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});

describe('monday board duplicate (integration, M15)', () => {
  // Source board (existing); duplicated board returns a fresh id.
  const duplicatedBoard = {
    id: '67890',
    name: 'Engineering (Copy)',
    description: 'Eng team',
    state: 'active',
    board_kind: 'public',
    board_folder_id: null,
    workspace_id: '5',
    url: 'https://x.monday.com/boards/67890',
    items_count: 7,
    updated_at: '2026-05-07T11:00:00Z',
    permissions: 'everyone',
  };

  const boardMetadataInteraction: Interaction = {
    operation_name: 'BoardMetadata',
    match_variables: { ids: ['12345'] },
    response: {
      data: {
        boards: [
          {
            id: '12345',
            name: 'Engineering',
            description: 'Eng team',
            state: 'active',
            board_kind: 'public',
            board_folder_id: null,
            workspace_id: '5',
            url: 'https://x.monday.com/boards/12345',
            hierarchy_type: 'top_level',
            is_leaf: true,
            updated_at: '2026-05-07T11:00:00Z',
            groups: [],
            columns: [],
          },
        ],
      },
    },
  };

  it('live: defaults to duplicate_board_with_pulses (no --with-updates) and emits the wrapped envelope', async () => {
    const out = await drive(
      ['board', 'duplicate', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDuplicate',
            // Wire-shape pin: duplicate_type: 'duplicate_board_with_pulses'
            // when --with-updates is absent.
            match_variables: {
              boardId: '12345',
              duplicateType: 'duplicate_board_with_pulses',
            },
            match_query: /duplicate_board\(\s*board_id: \$boardId,\s*duplicate_type: \$duplicateType/,
            response: {
              data: {
                duplicate_board: {
                  board: duplicatedBoard,
                  is_async: false,
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { board: { id: string; name: string }; is_async: boolean };
    };
    // §6.4 board-duplicate variant: data wraps because BoardDuplication
    // carries is_async — the only M15 verb whose data isn't a flat
    // projection.
    expect(env.data.board.id).toBe('67890');
    expect(env.data.board.name).toBe('Engineering (Copy)');
    expect(env.data.is_async).toBe(false);
    expect(env.meta.source).toBe('live');
    assertEnvelopeContract(env);
  });

  it('live: --with-updates flips duplicate_type to duplicate_board_with_pulses_and_updates', async () => {
    const out = await drive(
      ['board', 'duplicate', '12345', '--with-updates', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDuplicate',
            match_variables: {
              boardId: '12345',
              duplicateType: 'duplicate_board_with_pulses_and_updates',
            },
            response: {
              data: {
                duplicate_board: {
                  board: duplicatedBoard,
                  is_async: false,
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('live: --name and --workspace forward through to the wire variables', async () => {
    const out = await drive(
      [
        'board', 'duplicate', '12345',
        '--name', 'Engineering — EU',
        '--workspace', '99',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardDuplicate',
            match_variables: {
              boardId: '12345',
              duplicateType: 'duplicate_board_with_pulses',
              boardName: 'Engineering — EU',
              workspaceId: '99',
            },
            response: {
              data: {
                duplicate_board: {
                  board: { ...duplicatedBoard, name: 'Engineering — EU', workspace_id: '99' },
                  is_async: false,
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('live: is_async=true is preserved in the envelope (agents poll for terminal state)', async () => {
    const out = await drive(
      ['board', 'duplicate', '12345', '--with-updates', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDuplicate',
            response: {
              data: {
                duplicate_board: {
                  board: duplicatedBoard,
                  is_async: true,
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { is_async: boolean };
    };
    expect(env.data.is_async).toBe(true);
  });

  it('live: not_found when duplicate_board returns null payload', async () => {
    const out = await drive(
      ['board', 'duplicate', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDuplicate',
            match_variables: {
              boardId: '99999',
              duplicateType: 'duplicate_board_with_pulses',
            },
            response: { data: { duplicate_board: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('live: surfaces internal_error when BoardDuplicate response is missing the root key', async () => {
    const out = await drive(
      ['board', 'duplicate', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDuplicate',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('live: surfaces internal_error when BoardDuplication has null inner board', async () => {
    // Defensive: response says duplicate_board returned a wrapper
    // but the wrapper's board field is null. Should NOT silently
    // emit an envelope with no board projection.
    const out = await drive(
      ['board', 'duplicate', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDuplicate',
            response: {
              data: {
                duplicate_board: {
                  board: null,
                  is_async: false,
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('rejects empty --name (whitespace-only) as usage_error', async () => {
    const out = await drive(
      ['board', 'duplicate', '12345', '--name', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric boardId at argv parse', async () => {
    const out = await drive(
      ['board', 'duplicate', 'not-numeric', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric --workspace at argv parse', async () => {
    const out = await drive(
      ['board', 'duplicate', '12345', '--workspace', 'not-numeric', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: emits duplicate_board planned change with snapshot + with_updates flag', async () => {
    const out = await drive(
      [
        'board', 'duplicate', '12345',
        '--name', 'Engineering — EU',
        '--workspace', '99',
        '--with-updates',
        '--dry-run', '--json',
      ],
      { interactions: [boardMetadataInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        board_id: string;
        with_updates: boolean;
        target_workspace_id?: string;
        target_name?: string;
        board: { id: string; name: string };
      }[];
    };
    expect(env.data).toBeNull();
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('duplicate_board');
    expect(plan?.board_id).toBe('12345');
    expect(plan?.with_updates).toBe(true);
    expect(plan?.target_workspace_id).toBe('99');
    expect(plan?.target_name).toBe('Engineering — EU');
    expect(plan?.board.id).toBe('12345');
    expect(plan?.board.name).toBe('Engineering');
  });

  it('--dry-run: omits target_workspace_id and target_name when flags are absent; defaults with_updates=false', async () => {
    const out = await drive(
      ['board', 'duplicate', '12345', '--dry-run', '--json'],
      { interactions: [boardMetadataInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Record<string, unknown>[];
    };
    const plan = env.planned_changes[0];
    expect(plan?.with_updates).toBe(false);
    expect(plan).not.toHaveProperty('target_workspace_id');
    expect(plan).not.toHaveProperty('target_name');
  });

  it('--dry-run: not_found when preflight returns empty boards list', async () => {
    const out = await drive(
      ['board', 'duplicate', '99999', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            match_variables: { ids: ['99999'] },
            response: { data: { boards: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });
});

describe('monday board add-users (integration, M15)', () => {
  // Cache-isolated drive() — the email resolution leg writes the
  // user-directory cache; tests must not interfere across runs.
  const addUsersEnv = useCachedIntegrationEnv('monday-cli-board-addusers-int-');
  const driveAddUsers = addUsersEnv.drive;

  const userById = (id: string) => ({
    id,
    name: `User ${id}`,
    email: `user${id}@example.test`,
  });

  it('live: all-numeric --users fires one wire call per user; envelope carries data.operation: add_users_to_board', async () => {
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--users', '67890,67891', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardAddUsers',
            // Wire-shape pin: per-user dispatch with single-element
            // user_ids array; board_id (not workspace_id).
            match_variables: { boardId: '12345', userIds: ['67890'] },
            match_query: /add_users_to_board\(board_id: \$boardId, user_ids: \$userIds\)/,
            response: { data: { add_users_to_board: [userById('67890')] } },
          },
          {
            operation_name: 'BoardAddUsers',
            match_variables: { boardId: '12345', userIds: ['67891'] },
            response: { data: { add_users_to_board: [userById('67891')] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const envOut = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        results: readonly { user_id: string; ok: boolean }[];
      };
    };
    expect(envOut.ok).toBe(true);
    // data.operation lives on `data` (not `meta`) — per cli-design
    // §6.4 upsert precedent. M14 round-1 P1 caught the workspace
    // version of this; M15 inherits the precedent verbatim.
    expect(envOut.data.operation).toBe('add_users_to_board');
    expect(envOut.data.results).toEqual([
      { user_id: '67890', ok: true },
      { user_id: '67891', ok: true },
    ]);
    // All-numeric live path: zero resolver legs + 2 dispatch legs
    // = source 'live' (the dispatch leg counts).
    expect(envOut.meta.source).toBe('live');
    assertEnvelopeContract(envOut);
  });

  it('live: mixed numeric + email — email resolves through userByEmail, both dispatch', async () => {
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--users', '67890,alice@example.test', '--no-cache', '--json'],
      {
        interactions: [
          {
            operation_name: 'UsersByEmail',
            match_variables: { emails: ['alice@example.test'] },
            response: {
              data: {
                users: [{ id: '99001', name: 'Alice', email: 'alice@example.test' }],
              },
            },
          },
          {
            operation_name: 'BoardAddUsers',
            match_variables: { boardId: '12345', userIds: ['67890'] },
            response: { data: { add_users_to_board: [userById('67890')] } },
          },
          {
            operation_name: 'BoardAddUsers',
            match_variables: { boardId: '12345', userIds: ['99001'] },
            response: { data: { add_users_to_board: [userById('99001')] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const envOut = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { results: readonly { user_id: string; ok: boolean }[] };
    };
    expect(envOut.data.results).toEqual([
      { user_id: '67890', ok: true },
      { user_id: '99001', ok: true },
    ]);
  });

  it('live: partial success — ghost email lands per-record while numeric dispatches OK', async () => {
    // Mixed numeric + ghost-email stays partial-success (M14
    // round-2 P1 boundary refinement: "no dispatchable user_id
    // remains" not "ALL emails failed"). Numeric still dispatches
    // even though one email resolution fails.
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--users', '67890,ghost@example.test', '--no-cache', '--json'],
      {
        interactions: [
          {
            operation_name: 'UsersByEmail',
            match_variables: { emails: ['ghost@example.test'] },
            response: { data: { users: [] } },
          },
          {
            operation_name: 'BoardAddUsers',
            match_variables: { boardId: '12345', userIds: ['67890'] },
            response: { data: { add_users_to_board: [userById('67890')] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const envOut = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        results: readonly {
          user_id: string;
          ok: boolean;
          error?: { code: string; message: string };
        }[];
      };
    };
    expect(envOut.ok).toBe(true);
    expect(envOut.data.operation).toBe('add_users_to_board');
    expect(envOut.data.results).toHaveLength(2);
    expect(envOut.data.results[0]).toEqual({ user_id: '67890', ok: true });
    // Ghost email's user_id carries the input token verbatim so
    // agents can correlate retries.
    expect(envOut.data.results[1]?.user_id).toBe('ghost@example.test');
    expect(envOut.data.results[1]?.ok).toBe(false);
    expect(envOut.data.results[1]?.error?.code).toBe('user_not_found');
  });

  it('live: per-target dispatch failure lands per-record (envelope stays ok: true)', async () => {
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--users', '67890,67891', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardAddUsers',
            match_variables: { boardId: '12345', userIds: ['67890'] },
            response: { data: { add_users_to_board: [userById('67890')] } },
          },
          {
            operation_name: 'BoardAddUsers',
            match_variables: { boardId: '12345', userIds: ['67891'] },
            response: {
              data: { add_users_to_board: null },
              errors: [
                {
                  message: 'User 67891 cannot be added',
                  extensions: { code: 'VALIDATION' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const envOut = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        results: readonly { user_id: string; ok: boolean; error?: { code: string } }[];
      };
    };
    expect(envOut.ok).toBe(true);
    expect(envOut.data.results[0]?.ok).toBe(true);
    expect(envOut.data.results[1]?.ok).toBe(false);
    expect(envOut.data.results[1]?.error).toBeDefined();
  });

  it('live: surfaces internal_error when add_users_to_board response is missing the root key', async () => {
    // M14 round-2 F1 / round-3 F1 distinction: missing-root-key is
    // a schema-drift internal_error (whole-call), distinct from
    // null payload (per-record not_found). dispatchSequential
    // re-throws internal_error so it doesn't paper over.
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--users', '67890', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardAddUsers',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const envOut = parseEnvelope(out.stderr);
    expect(envOut.error?.code).toBe('internal_error');
  });

  it('whole-call user_not_found when ALL email tokens fail resolution and no numeric remains', async () => {
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--users', 'a@example.test,b@example.test', '--no-cache', '--json'],
      {
        interactions: [
          { operation_name: 'UsersByEmail', response: { data: { users: [] } } },
          { operation_name: 'UsersByEmail', response: { data: { users: [] } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const envOut = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { board_id?: string; failed_tokens?: readonly string[] };
      };
    };
    expect(envOut.error?.code).toBe('user_not_found');
    expect(envOut.error?.details?.board_id).toBe('12345');
    expect(envOut.error?.details?.failed_tokens).toEqual([
      'a@example.test',
      'b@example.test',
    ]);
  });

  it('rejects malformed --users tokens as usage_error at argv-parse', async () => {
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--users', 'not-a-real-token', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const envOut = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { malformed_tokens?: readonly string[] } };
    };
    expect(envOut.error?.code).toBe('usage_error');
    expect(envOut.error?.details?.malformed_tokens).toEqual(['not-a-real-token']);
  });

  it('rejects empty --users entries as usage_error', async () => {
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--users', ',67890', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const envOut = parseEnvelope(out.stderr);
    expect(envOut.error?.code).toBe('usage_error');
  });

  it('rejects missing --users as usage_error (commander requiredOption)', async () => {
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const envOut = parseEnvelope(out.stderr);
    expect(envOut.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric boardId at argv parse', async () => {
    const out = await driveAddUsers(
      ['board', 'add-users', 'not-numeric', '--users', '67890', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const envOut = parseEnvelope(out.stderr);
    expect(envOut.error?.code).toBe('usage_error');
  });

  it('--dry-run: all-numeric → results with would_apply, source: "none" (no resolver leg fires)', async () => {
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--users', '67890,67891', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(0);
    const envOut = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        board_id: string;
        results: readonly { user_id: string; would_apply: boolean }[];
      }[];
    };
    expect(envOut.data).toBeNull();
    expect(envOut.meta.source).toBe('none');
    const plan = envOut.planned_changes[0];
    expect(plan?.operation).toBe('add_users_to_board');
    expect(plan?.board_id).toBe('12345');
    expect(plan?.results).toEqual([
      { user_id: '67890', would_apply: true },
      { user_id: '67891', would_apply: true },
    ]);
  });

  it('--dry-run: email resolution fires; ghost email lands as would_apply: false with error', async () => {
    const out = await driveAddUsers(
      ['board', 'add-users', '12345', '--users', '67890,ghost@example.test', '--no-cache', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'UsersByEmail',
            match_variables: { emails: ['ghost@example.test'] },
            response: { data: { users: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const envOut = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        results: readonly {
          user_id: string;
          would_apply: boolean;
          error?: { code: string };
        }[];
      }[];
    };
    // Resolver leg fired → meta.source: 'live'.
    expect(envOut.meta.source).toBe('live');
    const plan = envOut.planned_changes[0];
    expect(plan?.results[0]).toEqual({ user_id: '67890', would_apply: true });
    expect(plan?.results[1]?.would_apply).toBe(false);
    expect(plan?.results[1]?.error?.code).toBe('user_not_found');
  });
});
