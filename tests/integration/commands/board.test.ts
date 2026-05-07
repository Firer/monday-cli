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

  it('surfaces internal_error when Monday returns a missing create_board key (root-key absent — schema-drift)', async () => {
    // Codex M15 implementation round-2 F1: missing-root-key
    // distinct from null payload. Both surface as
    // internal_error, but the message + hint distinguish
    // schema-drift from "Monday returned no board". The hint
    // pin lets agents diagnose the root cause without reading
    // implementation prose.
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
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string; board_name?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.hint).toMatch(/schema-drift/);
    expect(env.error?.details?.board_name).toBe('X');
  });

  it('surfaces internal_error when Monday returns a present-but-null create_board (no schema-drift hint)', async () => {
    // Distinct from missing-root-key — the key is present but
    // value null. Same code (internal_error since create's
    // contract requires a Board), different hint.
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
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    // The schema-drift hint is for missing-root-key. A null-
    // payload landed via projectCreatedBoard's null guard,
    // which uses the default hint (no schema-drift wording).
    expect(env.error?.details?.hint ?? '').not.toMatch(/schema-drift/);
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

  it('live: per-field failure surfaces whole-call error (no partial-success leak; stable error code)', async () => {
    // Per cli-design §6.4 board-update partial-application caveat:
    // server-side state is non-transactional, so when call #1
    // succeeds and call #2 fails the envelope is ok:false with
    // call #2's mapped error code (not a partial-success envelope).
    // Earlier successful fields stay applied server-side. Codex
    // round-1 F3 pinned: assert the stable code, not just ok:false.
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
    expect(env.ok).toBe(false);
    // Stable mapped code — InvalidArgumentException re-maps per
    // §6.5 to validation_failed. Agents key off this, not prose.
    expect(env.error?.code).toBe('validation_failed');
    // No final read fired — the per-field failure aborts before
    // BoardUpdateFinalRead. Implicit: only 2 of 2 expected
    // interactions consumed (no third final-read interaction).
    expect(out.requests).toBe(2);
  });

  it('live: surfaces internal_error when update_board returns a null payload with no errors[]', async () => {
    // Codex M15 implementation round-1 F1: a 200 response with
    // `update_board: null` and no GraphQL errors[] is NOT a
    // per-field success — Monday rare server-side path. Pre-fix,
    // the per-field loop would have proceeded to the final read
    // and emitted ok:true with stale pre-update data (the final
    // read could even succeed). Fix: null-payload guard surfaces
    // internal_error and aborts before the final read fires.
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
            // Null payload with NO errors[] — the bug shape that
            // would have papered over as illusory ok:true.
            response: { data: { update_board: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
    // No final read fired — only 1 of 1 interaction consumed.
    expect(out.requests).toBe(1);
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

  // ---------------------------------------------------------------
  // M16 retrofit — invalidateBoard post-success per cli-design §8
  // ---------------------------------------------------------------

  it('M16 retrofit: cache invalidation round-trip — board update → board describe sees renamed board with source: live + no stale_cache_refreshed warning', async () => {
    // Per cli-design §8 fan-out call-site contract: invalidate ONCE
    // after the per-attribute loop settles iff at least one leg
    // succeeded. Round-trip pins the three §8 invariants:
    // post-mutation read sees live state; meta.source: 'live'; no
    // stale_cache_refreshed warning (the backstop is the path-not-
    // under-test).
    const renamedBoard = {
      id: '111',
      name: 'Renamed',
      description: null,
      state: 'active',
      board_kind: 'public',
      board_folder_id: null,
      workspace_id: '5',
      url: null,
      hierarchy_type: 'top_level',
      is_leaf: true,
      updated_at: '2026-05-07T11:00:00Z',
      groups: [],
      columns: [],
    };
    // Seed cache via board describe.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([])] },
    );
    // Update the board name.
    const updated = await drive(
      ['board', 'update', '111', '--name', 'Renamed', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardUpdate',
            match_variables: { boardId: '111', boardAttribute: 'name', newValue: 'Renamed' },
            response: { data: { update_board: 'Renamed' } },
          },
          {
            operation_name: 'BoardUpdateFinalRead',
            response: {
              data: {
                boards: [
                  {
                    id: '111',
                    name: 'Renamed',
                    description: null,
                    state: 'active',
                    board_kind: 'public',
                    board_folder_id: null,
                    workspace_id: '5',
                    url: null,
                    items_count: 0,
                    updated_at: '2026-05-07T11:00:00Z',
                    permissions: 'everyone',
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(updated.exitCode).toBe(0);
    // Post-update describe — clean cache miss → live fetch.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [{ ...metadataResponse([]), response: { data: { boards: [renamedBoard] } } }] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { name: string };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.name).toBe('Renamed');
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });

  it('M16 retrofit: zero-legs-succeeded (very first per-attribute call fails) does NOT invalidate per §8', async () => {
    // §8 fan-out contract: zero-legs-succeeded skips invalidation
    // because server state didn't change.
    // Seed cache.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([])] },
    );
    // Update fails on first per-attribute call (null payload →
    // internal_error per the M15 round-1 F1 distinction).
    const updated = await drive(
      ['board', 'update', '111', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardUpdate',
            response: { data: { update_board: null } },
          },
        ],
      },
    );
    expect(updated.exitCode).toBe(2);
    // Post-update describe — cache hit (source: 'cache') because
    // invalidation was correctly skipped (server state didn't
    // change). Empty interactions: a cache hit needs no live fetch;
    // if invalidation incorrectly fired the test would fail with an
    // exhausted cassette.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout);
    expect(postEnv.meta.source).toBe('cache');
  });

  it('M16 retrofit: partial-application failure (call #2 fails after call #1 succeeded) STILL invalidates per §8 high-water-mark rule', async () => {
    // §8 fan-out contract: invalidation fires after the loop
    // settles iff at least one leg succeeded. Whole-call failure
    // after call N succeeded MUST still invalidate because the
    // cache must reflect the partially-applied server state.
    // Mirror M16 column-update's partial-application round-trip.
    const renamedPartial = {
      id: '111',
      name: 'Renamed',
      description: 'old description',
      state: 'active',
      board_kind: 'public',
      board_folder_id: null,
      workspace_id: '5',
      url: null,
      hierarchy_type: 'top_level',
      is_leaf: true,
      updated_at: '2026-05-07T11:00:00Z',
      groups: [],
      columns: [],
    };
    // Seed cache with the original snapshot.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([])] },
    );
    // Update fans out: call #1 (name) succeeds, call #2 (description)
    // fails with a null payload → internal_error.
    const updated = await drive(
      [
        'board', 'update', '111',
        '--name', 'Renamed',
        '--description', 'X',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardUpdate',
            match_variables: { boardAttribute: 'name', newValue: 'Renamed' },
            response: { data: { update_board: 'Renamed' } },
          },
          {
            operation_name: 'BoardUpdate',
            match_variables: { boardAttribute: 'description', newValue: 'X' },
            response: { data: { update_board: null } },
          },
        ],
      },
    );
    // Whole-call failure → exit 2.
    expect(updated.exitCode).toBe(2);
    // Post-failure describe — invalidation fired despite the whole-
    // call failure (succeededLegs=1), so this is a clean cache miss.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      {
        interactions: [
          { ...metadataResponse([]), response: { data: { boards: [renamedPartial] } } },
        ],
      },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { name: string };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.name).toBe('Renamed');
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });

  it('M16 retrofit: final-read failure after per-attribute calls succeeded STILL invalidates per §8', async () => {
    // §8 fan-out contract pin: a final-read failure (very unusual —
    // the board can't have been deleted between mutation and read
    // in normal flow) STILL must invalidate if the per-attribute
    // mutations already changed server state. The implementation
    // wraps the final read inside the same try/catch as the per-
    // attribute loop so the partial-application invalidate fires.
    // Seed cache.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([])] },
    );
    // Update: per-attribute call succeeds, final read returns
    // empty boards (the projectMutationBoard null guard surfaces
    // internal_error).
    const updated = await drive(
      ['board', 'update', '111', '--name', 'Renamed', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardUpdate',
            response: { data: { update_board: 'Renamed' } },
          },
          {
            operation_name: 'BoardUpdateFinalRead',
            response: { data: { boards: [] } },
          },
        ],
      },
    );
    expect(updated.exitCode).toBe(2);
    // Post-failure describe — invalidation MUST have fired even
    // though the whole-call failed (per-attribute call already
    // committed the rename server-side). The next describe is a
    // clean cache miss → live fetch sees the renamed state.
    const renamedFixture = {
      id: '111',
      name: 'Renamed',
      description: null,
      state: 'active',
      board_kind: 'public',
      board_folder_id: null,
      workspace_id: '5',
      url: null,
      hierarchy_type: 'top_level',
      is_leaf: true,
      updated_at: '2026-05-07T11:00:00Z',
      groups: [],
      columns: [],
    };
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      {
        interactions: [
          { ...metadataResponse([]), response: { data: { boards: [renamedFixture] } } },
        ],
      },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { name: string };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.name).toBe('Renamed');
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
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
    const plan = env.planned_changes[0] as {
      operation: string;
      board_id: string;
      board: {
        id: string;
        name: string;
        state: string;
        items_count: number | null;
        permissions: string | null;
      };
    } | undefined;
    expect(plan?.operation).toBe('archive_board');
    expect(plan?.board_id).toBe('12345');
    expect(plan?.board.id).toBe('12345');
    expect(plan?.board.name).toBe('Engineering');
    // Snapshot reflects pre-archive state (state: 'active').
    expect(plan?.board.state).toBe('active');
    // Codex round-2 F3: items_count + permissions must be
    // present in the snapshot per cli-design §6.2 board
    // projection shape. The fixture omits them so they coerce
    // to null via `?? null` (regression test for the schema
    // additions in round-1 F2).
    expect(plan?.board.items_count).toBeNull();
    expect(plan?.board.permissions).toBeNull();
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

  // ---------------------------------------------------------------
  // M16 retrofit — invalidateBoard post-success per cli-design §8
  // ---------------------------------------------------------------

  it('M16 retrofit: cache invalidation round-trip — board archive → board describe sees archived state with source: live + no stale_cache_refreshed warning', async () => {
    // Per cli-design §8 single-leg call-site contract: invalidate
    // AFTER `data` projection on success. Round-trip pins the three
    // §8 invariants per cassette: post-mutation read sees live state
    // (state: archived); meta.source: 'live'; no stale_cache_
    // refreshed warning. Without the retrofit, a same-process
    // describe after the archive would return state: 'active' until
    // TTL eviction.
    const archivedFixture = {
      id: '111',
      name: 'Tasks',
      description: null,
      state: 'archived',
      board_kind: 'public',
      board_folder_id: null,
      workspace_id: '5',
      url: null,
      hierarchy_type: 'top_level',
      is_leaf: true,
      updated_at: '2026-05-07T11:00:00Z',
      groups: [],
      columns: [],
    };
    // Seed cache with the active state.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([])] },
    );
    // Archive.
    const archived = await drive(
      ['board', 'archive', '111', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardArchive',
            response: {
              data: {
                archive_board: {
                  id: '111',
                  name: 'Tasks',
                  description: null,
                  state: 'archived',
                  board_kind: 'public',
                  board_folder_id: null,
                  workspace_id: '5',
                  url: null,
                  items_count: 0,
                  updated_at: '2026-05-07T11:00:00Z',
                  permissions: 'everyone',
                },
              },
            },
          },
        ],
      },
    );
    expect(archived.exitCode).toBe(0);
    // Post-archive describe — clean cache miss → live fetch sees
    // state: archived. Source: live; no stale_cache_refreshed
    // warning.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      {
        interactions: [
          { ...metadataResponse([]), response: { data: { boards: [archivedFixture] } } },
        ],
      },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { state: string };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.state).toBe('archived');
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });

  it('M16 retrofit: error path skips invalidation (failed archive didn\'t change board state)', async () => {
    // §8 single-leg contract: skip invalidation on error path. A
    // failed archive (Monday returns null = not_found) didn't
    // change server state; the cache remains valid.
    // Seed cache.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([])] },
    );
    // Archive fails.
    const archived = await drive(
      ['board', 'archive', '111', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardArchive',
            response: { data: { archive_board: null } },
          },
        ],
      },
    );
    expect(archived.exitCode).toBe(2);
    // Post-failure describe — cache hit (source: 'cache') because
    // invalidation was skipped on the error path.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      // Empty interactions: cache hit needs no live fetch.
      { interactions: [] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout);
    expect(postEnv.meta.source).toBe('cache');
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

  // ---------------------------------------------------------------
  // M16 retrofit — invalidateBoard post-success per cli-design §8
  // ---------------------------------------------------------------

  it('M16 retrofit: cache invalidation round-trip — board delete → board describe sees post-delete live state with source: live + no stale_cache_refreshed warning', async () => {
    // Per cli-design §8 single-leg call-site contract: invalidate
    // AFTER `data` projection on success. The retrofit's
    // invalidation deletes the cache file so the next read cleanly
    // cache-misses to the live state — Monday's post-delete
    // `boards(ids:)` may return either an empty array (which the
    // CLI surfaces as not_found) OR a `state: 'deleted'` projection,
    // depending on whether the deletion has fully propagated. This
    // test pins the cache-invalidation invariant by driving the
    // deleted-state variant and asserting the success envelope's
    // §8 pins: meta.source: 'live'; no stale_cache_refreshed warning
    // (the backstop is the path-not-under-test). The not_found
    // variant is exercised by board describe's existing test
    // surface — what's M16-specific is the cache-invalidation
    // round-trip, not which post-delete shape Monday returns.
    // Seed cache.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([])] },
    );
    // Delete.
    const deleted = await drive(
      ['board', 'delete', '111', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDelete',
            response: {
              data: {
                delete_board: {
                  id: '111',
                  name: 'Tasks',
                  description: null,
                  state: 'deleted',
                  board_kind: 'public',
                  board_folder_id: null,
                  workspace_id: '5',
                  url: null,
                  items_count: 0,
                  updated_at: '2026-05-07T11:00:00Z',
                  permissions: 'everyone',
                },
              },
            },
          },
        ],
      },
    );
    expect(deleted.exitCode).toBe(0);
    // Post-delete describe — but Monday returns the deleted board
    // for a different post-delete read. Surface the live state via
    // a follow-up board describe that returns a deleted-flagged
    // board. The post-read MUST satisfy the §8 envelope pins:
    // meta.source: 'live'; no stale_cache_refreshed warning (the
    // backstop is the path-not-under-test). Codex M16 round-1 F3
    // pinned: assert the public agent-facing shape, not just
    // request count.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            match_variables: { ids: ['111'] },
            response: {
              data: {
                boards: [
                  {
                    id: '111',
                    name: 'Tasks',
                    description: null,
                    state: 'deleted',
                    board_kind: 'public',
                    board_folder_id: null,
                    workspace_id: '5',
                    url: null,
                    hierarchy_type: 'top_level',
                    is_leaf: true,
                    updated_at: '2026-05-07T11:00:00Z',
                    groups: [],
                    columns: [],
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { state: string };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.state).toBe('deleted');
    // Eager-invalidation happy path: clean cache miss → live fetch.
    // The backstop (cache-miss-refresh path) emits stale_cache_
    // refreshed when it fires; assert it did NOT (otherwise the
    // test passes for the wrong reason).
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });

  it('M16 retrofit: error path skips invalidation (failed delete didn\'t change board state)', async () => {
    // §8 single-leg contract: skip invalidation on error path. A
    // failed delete (Monday returns null = not_found) didn't change
    // server state; the cache remains valid.
    // Seed cache.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([])] },
    );
    // Delete fails.
    const deleted = await drive(
      ['board', 'delete', '111', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDelete',
            response: { data: { delete_board: null } },
          },
        ],
      },
    );
    expect(deleted.exitCode).toBe(2);
    // Post-failure describe — cache hit (source: 'cache') because
    // invalidation was correctly skipped.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      // Empty interactions: cache hit needs no live fetch.
      { interactions: [] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout);
    expect(postEnv.meta.source).toBe('cache');
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
        board: {
          id: string;
          name: string;
          items_count: number | null;
          permissions: string | null;
        };
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
    // Codex round-2 F3: items_count + permissions must be in
    // the snapshot per cli-design §6.2 board projection shape.
    expect(plan?.board.items_count).toBeNull();
    expect(plan?.board.permissions).toBeNull();
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
    // Stable per-record code per cli-design §6.5 — the
    // VALIDATION extension code re-maps to validation_failed.
    // Codex round-2 F2: regression in Monday-error mapping
    // would pass without this assertion while agents lose the
    // stable code.
    expect(envOut.data.results[1]?.error?.code).toBe('validation_failed');
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

// =============================================================================
// M16 — board column-create (cli-design §4.3 + §6.4 + §8 eager invalidation)
// =============================================================================

describe('monday board column-create (integration, M16)', () => {
  const createdTextColumn = {
    id: 'text_1',
    title: 'Notes',
    type: 'text',
    description: null,
    archived: false,
    settings_str: null,
    width: null,
  };
  const createdStatusColumn = {
    id: 'status_4',
    title: 'Priority',
    type: 'status',
    description: 'Owner-set urgency',
    archived: false,
    settings_str: '{"labels":["Low","Med","High"]}',
    width: 120,
  };
  const createdCountryColumn = {
    id: 'country_1',
    title: 'Region',
    type: 'country',
    description: null,
    archived: false,
    settings_str: null,
    width: null,
  };

  it('live: --type text --title fires create_column with required wire args + columnType', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'text', '--title', 'Notes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            // Wire-shape pin: column_type maps to --type, title to
            // --title, board_id to the positional. The CLI must use
            // `column_type` (Monday's wire arg name), not `type`.
            match_variables: {
              boardId: '12345',
              columnType: 'text',
              title: 'Notes',
            },
            // Pin the GraphQL surface so a future regression that
            // renames `column_type` → `type` (or `defaults` →
            // `settings_str`) fails here.
            match_query: /create_column\(\s*board_id: \$boardId,\s*column_type: \$columnType/,
            response: { data: { create_column: createdTextColumn } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; type: string; title: string };
      warnings?: readonly { code: string }[];
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('text_1');
    expect(env.data.type).toBe('text');
    expect(env.data.title).toBe('Notes');
    assertEnvelopeContract(env);
    expect(env.meta.source).toBe('live');
    // Canonical type → no noncanonical_column_type warning.
    expect(env.warnings ?? []).toEqual([]);
  });

  it('live: --type status --title --settings forwards defaults: JSON (not settings_str)', async () => {
    const out = await drive(
      [
        'board', 'column-create', '12345',
        '--type', 'status',
        '--title', 'Priority',
        '--description', 'Owner-set urgency',
        '--settings', '{"labels":["Low","Med","High"]}',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            match_variables: {
              boardId: '12345',
              columnType: 'status',
              title: 'Priority',
              description: 'Owner-set urgency',
              defaults: { labels: ['Low', 'Med', 'High'] },
            },
            // Wire-shape pin: the variable name MUST be `defaults`, not
            // `settings_str` — `settings_str` is the read-side
            // serialisation and a regression that mis-maps the flag
            // would silently lose the column settings on the wire.
            match_query: /defaults: \$defaults/,
            response: { data: { create_column: createdStatusColumn } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; type: string };
    };
    expect(env.data.id).toBe('status_4');
    expect(env.data.type).toBe('status');
  });

  it('live: --type country fires create_column AND emits noncanonical_column_type warning (raw_writable category)', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'country', '--title', 'Region', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            match_variables: {
              boardId: '12345',
              columnType: 'country',
              title: 'Region',
            },
            response: { data: { create_column: createdCountryColumn } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; type: string };
      warnings: readonly {
        code: string;
        message: string;
        details?: {
          column_type?: string;
          category?: string;
          suggested_write_path?: string | null;
        };
      }[];
    };
    expect(env.data.type).toBe('country');
    expect(env.warnings.length).toBe(1);
    const warn = env.warnings[0];
    expect(warn?.code).toBe('noncanonical_column_type');
    expect(warn?.details?.column_type).toBe('country');
    expect(warn?.details?.category).toBe('raw_writable');
    expect(warn?.details?.suggested_write_path).toBe('--set-raw <col>=<json>');
    expect(warn?.message).toMatch(/--set-raw/);
  });

  it('live: --type mirror emits noncanonical_column_type warning with read_only_forever category + null suggested_write_path', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'mirror', '--title', 'Mirror', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            match_variables: { columnType: 'mirror' },
            response: {
              data: {
                create_column: { ...createdTextColumn, id: 'mirror_1', title: 'Mirror', type: 'mirror' },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      warnings: readonly {
        code: string;
        details?: {
          category?: string;
          suggested_write_path?: string | null;
        };
      }[];
    };
    expect(env.warnings[0]?.code).toBe('noncanonical_column_type');
    expect(env.warnings[0]?.details?.category).toBe('read_only_forever');
    expect(env.warnings[0]?.details?.suggested_write_path).toBeNull();
  });

  it('live: --type file emits noncanonical_column_type warning with files_shaped category + v0.4 hint', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'file', '--title', 'Attachments', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            match_variables: { columnType: 'file' },
            response: {
              data: {
                create_column: { ...createdTextColumn, id: 'file_1', title: 'Attachments', type: 'file' },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      warnings: readonly {
        code: string;
        details?: {
          category?: string;
          suggested_write_path?: string | null;
        };
      }[];
    };
    expect(env.warnings[0]?.details?.category).toBe('files_shaped');
    expect(env.warnings[0]?.details?.suggested_write_path).toMatch(/add_file_to_column/);
  });

  it('live: omits description/defaults from the wire when those flags are absent', async () => {
    // Pre-fix, an inadvertent `description: undefined` /
    // `defaults: undefined` in the variables map would have been
    // serialised as `null` on the wire. Mirror M15 board-create's
    // omits-when-absent regression test.
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'text', '--title', 'Bare', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            match_variables: {
              boardId: '12345',
              columnType: 'text',
              title: 'Bare',
            },
            response: { data: { create_column: { ...createdTextColumn, title: 'Bare' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    // We can't easily inspect the request directly here (the helpers
    // suite doesn't expose the full request body), but match_variables
    // above only matches subset; the omission discipline is enforced
    // by the action body and unit-tested via parseSettingsFlag.
  });

  it('rejects --type unknown as usage_error at argv parse', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'not-a-type', '--title', 'X', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --title (after trim) as usage_error', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'text', '--title', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects missing --type as usage_error', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--title', 'X', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects missing --title as usage_error', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'text', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric boardId at argv parse', async () => {
    const out = await drive(
      ['board', 'column-create', 'abc', '--type', 'text', '--title', 'X', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects malformed --settings JSON as usage_error (no network call)', async () => {
    const out = await drive(
      [
        'board', 'column-create', '12345',
        '--type', 'status',
        '--title', 'Priority',
        '--settings', '{labels:bad',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { column_type?: string; hint?: string } };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.details?.column_type).toBe('status');
  });

  it('rejects --settings non-object JSON (array / string / number) as usage_error', async () => {
    const out = await drive(
      [
        'board', 'column-create', '12345',
        '--type', 'status',
        '--title', 'Priority',
        '--settings', '[]',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { column_type?: string; hint?: string } };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.details?.hint).toMatch(/JSON object/);
  });

  it('rejects --settings null (top-level null) as usage_error', async () => {
    // Drives the `parsed === null` branch in the non-object guard
    // (distinct from the JSON.parse-failed branch above and the
    // array branch).
    const out = await drive(
      [
        'board', 'column-create', '12345',
        '--type', 'status',
        '--title', 'X',
        '--settings', 'null',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects --settings primitive (number / string / boolean) as usage_error', async () => {
    // Drives the `typeof parsed` fallback branch (number / string /
    // boolean — none are JSON objects per cli-design §6.4 + the
    // wire's `defaults: JSON` requires an object).
    const out = await drive(
      [
        'board', 'column-create', '12345',
        '--type', 'status',
        '--title', 'X',
        '--settings', '42',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--settings against a raw-writable type accepts well-formed JSON without per-type schema (Monday validates server-side)', async () => {
    // Per cli-design §4.3 column-create: raw-writable / read-only-
    // forever / files-shaped types skip type-specific validation —
    // well-formed JSON only. The `country` type carries
    // `{country_code: 'US'}` etc. as defaults; the CLI doesn't model
    // those keys, so it forwards the JSON verbatim and lets Monday
    // validate. Drives the `parseSettingsFlag` non-writable branch.
    const out = await drive(
      [
        'board', 'column-create', '12345',
        '--type', 'country',
        '--title', 'Region',
        '--settings', '{"country_code":"US"}',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            match_variables: {
              boardId: '12345',
              columnType: 'country',
              defaults: { country_code: 'US' },
            },
            response: {
              data: {
                create_column: {
                  id: 'country_1',
                  title: 'Region',
                  type: 'country',
                  description: null,
                  archived: false,
                  settings_str: null,
                  width: null,
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { type: string };
      warnings: readonly { code: string; details?: { category?: string } }[];
    };
    expect(env.data.type).toBe('country');
    // Still emits the noncanonical warning (raw_writable category).
    expect(env.warnings[0]?.details?.category).toBe('raw_writable');
  });

  it('rejects type-mismatched --settings as usage_error with details.{column_type, expected_keys, actual_keys}', async () => {
    // text columns accept no settings keys via M16; passing
    // {"labels":[]} surfaces usage_error with the per-type schema
    // mismatch — agents read expected_keys to fix the call without
    // round-tripping through Monday's validation_failed.
    const out = await drive(
      [
        'board', 'column-create', '12345',
        '--type', 'text',
        '--title', 'Notes',
        '--settings', '{"labels":["Low","Med"]}',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          column_type?: string;
          expected_keys?: readonly string[];
          actual_keys?: readonly string[];
          hint?: string;
        };
      };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.details?.column_type).toBe('text');
    expect(env.error?.details?.expected_keys).toEqual([]);
    expect(env.error?.details?.actual_keys).toEqual(['labels']);
    expect(env.error?.details?.hint).toMatch(/no --settings keys/);
  });

  it('rejects status with bad-shape --settings (drives expected_keys.length > 0 branch)', async () => {
    // status accepts `labels`; passing `labels: 7` (a number, not
    // array/record) drives the per-type schema's union-of-shapes
    // mismatch and surfaces the "accepts these --settings keys"
    // hint variant (expected_keys.length > 0).
    const out = await drive(
      [
        'board', 'column-create', '12345',
        '--type', 'status',
        '--title', 'Priority',
        '--settings', '{"labels":7}',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          column_type?: string;
          expected_keys?: readonly string[];
          hint?: string;
        };
      };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.details?.column_type).toBe('status');
    expect(env.error?.details?.expected_keys).toEqual(['labels']);
    expect(env.error?.details?.hint).toMatch(/accepts these --settings keys: labels/);
  });

  it('--settings argv-parse fires BEFORE config_error (token-missing) — usage_error has higher priority', async () => {
    // Mirrors the destructive-gate ordering invariant: argv-shape
    // failures (usage_error) MUST surface before config errors so a
    // missing token doesn't mask a malformed flag.
    const out = await drive(
      [
        'board', 'column-create', '12345',
        '--type', 'status',
        '--title', 'X',
        '--settings', '{not-json',
        '--json',
      ],
      { interactions: [] },
      { env: { MONDAY_API_URL: 'https://api.monday.com/v2' } },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: emits planned_changes with operation create_column; no mutation fires', async () => {
    const out = await drive(
      [
        'board', 'column-create', '12345',
        '--type', 'status',
        '--title', 'Priority',
        '--description', 'Owner-set urgency',
        '--settings', '{"labels":["Low","Med","High"]}',
        '--dry-run', '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        board_id: string;
        type: string;
        title: string;
        description?: string;
        settings?: { labels?: readonly string[] };
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.meta.source).toBe('none');
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('create_column');
    expect(plan?.board_id).toBe('12345');
    expect(plan?.type).toBe('status');
    expect(plan?.title).toBe('Priority');
    expect(plan?.description).toBe('Owner-set urgency');
    expect(plan?.settings).toEqual({ labels: ['Low', 'Med', 'High'] });
  });

  it('--dry-run: omits optional slots when flags are not set', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'text', '--title', 'Notes', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Record<string, unknown>[];
    };
    expect(env.planned_changes[0]).toEqual({
      operation: 'create_column',
      board_id: '12345',
      type: 'text',
      title: 'Notes',
    });
  });

  it('--dry-run: noncanonical_column_type warning fires on dry-run too (so the live call is predictable)', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'country', '--title', 'Region', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      warnings: readonly { code: string; details?: { category?: string } }[];
    };
    expect(env.warnings[0]?.code).toBe('noncanonical_column_type');
    expect(env.warnings[0]?.details?.category).toBe('raw_writable');
  });

  it('surfaces internal_error when Monday returns a missing create_column key (schema-drift)', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'text', '--title', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string; board_id?: string; title?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.hint).toMatch(/schema-drift/);
    expect(env.error?.details?.board_id).toBe('12345');
    expect(env.error?.details?.title).toBe('X');
  });

  it('surfaces internal_error when Monday returns a present-but-null create_column (no schema-drift hint)', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'text', '--title', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            response: { data: { create_column: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string; board_id?: string; title?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.board_id).toBe('12345');
    expect(env.error?.details?.title).toBe('X');
    // No schema-drift hint — null payload is a different signal than
    // missing-root-key. Mirrors M15 board-create round-2 F1 distinction.
    expect(env.error?.details?.hint ?? '').not.toMatch(/schema-drift/);
  });

  it('cache invalidation round-trip: column-create → board describe sees new column with source: live + no stale_cache_refreshed warning', async () => {
    // Per cli-design §8 + the M16 milestone test plan: the round-
    // trip MUST satisfy three pins per cassette to prove eager
    // invalidation worked (rather than the cache-miss-refresh
    // backstop saving us):
    //   1. post-mutation read sees the live state;
    //   2. meta.source: 'live' (not 'cache' / 'mixed');
    //   3. NO stale_cache_refreshed warning (the backstop is the
    //      path-not-under-test).
    const preMutationColumn = {
      ...baseColumn,
      id: 'col_x',
      title: 'X',
      type: 'text',
    };
    const newColumn = {
      ...baseColumn,
      id: 'priority_1',
      title: 'Priority',
      type: 'status',
      settings_str: '{"labels":["Low","Med","High"]}',
    };
    const out = await drive(
      ['board', 'describe', '111', '--json'],
      {
        // Cassette ordering: pre-mutation describe seeds the cache,
        // column-create fires (which invalidates the cache entry),
        // post-mutation describe re-fetches live.
        interactions: [
          metadataResponse([preMutationColumn]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    // Now the cache holds the pre-mutation snapshot. Fire column-
    // create — it MUST invalidate the cache file before returning.
    const created = await drive(
      [
        'board', 'column-create', '111',
        '--type', 'status',
        '--title', 'Priority',
        '--settings', '{"labels":["Low","Med","High"]}',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            match_variables: { boardId: '111', columnType: 'status', title: 'Priority' },
            response: { data: { create_column: newColumn } },
          },
        ],
      },
    );
    expect(created.exitCode).toBe(0);
    // Post-mutation describe — if invalidation worked, this is a
    // clean cache miss → live fetch. meta.source: 'live'; no
    // stale_cache_refreshed warning. If invalidation FAILED, the
    // pre-mutation snapshot would be served (source: 'cache') and
    // the new column wouldn't appear.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([preMutationColumn, newColumn])] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { columns: readonly { id: string; type: string }[] };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.columns.map((c) => c.id)).toContain('priority_1');
    // The backstop (cache-miss-refresh path) emits stale_cache_
    // refreshed when it fires. Eager invalidation should land in a
    // clean miss instead — assert the backstop did NOT fire.
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });
});

// =============================================================================
// M16 — board column-update (cli-design §4.3 + §6.4 + §8 fan-out invalidation)
// =============================================================================

describe('monday board column-update (integration, M16)', () => {
  // Board metadata fixture for the dry-run preflight read — column
  // `status_4` exists on board 12345.
  const columnUpdateBoardMetadata: Interaction = {
    operation_name: 'BoardMetadata',
    match_variables: { ids: ['12345'] },
    response: {
      data: {
        boards: [
          {
            id: '12345',
            name: 'Engineering',
            description: null,
            state: 'active',
            board_kind: 'public',
            board_folder_id: null,
            workspace_id: '5',
            url: null,
            hierarchy_type: 'top_level',
            is_leaf: true,
            updated_at: '2026-05-07T11:00:00Z',
            groups: [],
            columns: [
              {
                id: 'status_4',
                title: 'Status',
                type: 'status',
                description: null,
                archived: false,
                settings_str: '{"labels":["Backlog","Done"]}',
                width: 120,
              },
            ],
          },
        ],
      },
    },
  };

  const renamedColumn = {
    id: 'status_4',
    title: 'Priority',
    type: 'status',
    description: null,
    archived: false,
    settings_str: '{"labels":["Backlog","Done"]}',
    width: 120,
  };
  const annotatedColumn = {
    ...renamedColumn,
    description: 'Owner-set urgency',
  };

  it('rejects zero-flag invocation as usage_error at argv parse', async () => {
    const out = await drive(
      ['board', 'column-update', '12345', 'status_4', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty <columnId> at argv parse', async () => {
    const out = await drive(
      ['board', 'column-update', '12345', '', '--title', 'X', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --title (whitespace-only) as usage_error', async () => {
    const out = await drive(
      ['board', 'column-update', '12345', 'status_4', '--title', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('live: --title fires change_column_title and emits the projected column', async () => {
    const out = await drive(
      ['board', 'column-update', '12345', 'status_4', '--title', 'Priority', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnChangeTitle',
            match_variables: {
              boardId: '12345',
              columnId: 'status_4',
              title: 'Priority',
            },
            // Pin the wire surface so a future regression that
            // re-routes --title through change_column_metadata
            // (which would lose the more-specific Monday surface)
            // fails here.
            match_query: /change_column_title\(board_id: \$boardId/,
            response: { data: { change_column_title: renamedColumn } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; title: string };
    };
    expect(env.data.id).toBe('status_4');
    expect(env.data.title).toBe('Priority');
    expect(env.meta.source).toBe('live');
    assertEnvelopeContract(env);
  });

  it('live: --description fires change_column_metadata({column_property: description}) and projects the response', async () => {
    const out = await drive(
      ['board', 'column-update', '12345', 'status_4', '--description', 'Owner-set urgency', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnChangeMetadata',
            match_variables: {
              boardId: '12345',
              columnId: 'status_4',
              columnProperty: 'description',
              value: 'Owner-set urgency',
            },
            // Pin the column_property: description routing — a
            // regression that swapped to column_property: title
            // would silently overwrite the column's title.
            match_query: /change_column_metadata\(/,
            response: { data: { change_column_metadata: annotatedColumn } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { description: string };
    };
    expect(env.data.description).toBe('Owner-set urgency');
  });

  it('live: --title --description fans out two sequential calls; data projects from the trailing call', async () => {
    // Per §8 decision 8: sequential. Per cli-design §4.3 column-
    // update: trailing call's response is authoritative because
    // Monday's column mutations return the full Maybe<Column>
    // post-mutation. No force-live final read leg fires —
    // distinguishes column-update from board-update.
    const out = await drive(
      [
        'board', 'column-update', '12345', 'status_4',
        '--title', 'Priority',
        '--description', 'Owner-set urgency',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ColumnChangeTitle',
            match_variables: { title: 'Priority' },
            response: { data: { change_column_title: renamedColumn } },
          },
          {
            operation_name: 'ColumnChangeMetadata',
            match_variables: {
              columnProperty: 'description',
              value: 'Owner-set urgency',
            },
            response: { data: { change_column_metadata: annotatedColumn } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(2);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { title: string; description: string };
    };
    // Trailing call (change_column_metadata) returned annotatedColumn,
    // which carries both the renamed title AND the new description.
    expect(env.data.title).toBe('Priority');
    expect(env.data.description).toBe('Owner-set urgency');
  });

  it('live: per-attribute failure surfaces the failed call code; no envelope partial-success leak', async () => {
    // Whole-call envelope is `ok: false` on any per-field failure;
    // mirrors `board update`'s contract.
    const out = await drive(
      [
        'board', 'column-update', '12345', 'status_4',
        '--title', 'Priority',
        '--description', 'X',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ColumnChangeTitle',
            response: { data: { change_column_title: renamedColumn } },
          },
          {
            operation_name: 'ColumnChangeMetadata',
            response: { data: { change_column_metadata: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.ok).toBe(false);
    // change_column_metadata's null path uses not_found per the R45
    // helper's column-update mapping.
    expect(env.error?.code).toBe('not_found');
  });

  it('live: surfaces internal_error when the title response is missing the root key (schema-drift)', async () => {
    const out = await drive(
      ['board', 'column-update', '12345', 'status_4', '--title', 'Priority', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnChangeTitle',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.hint).toMatch(/schema-drift/);
  });

  it('live: surfaces internal_error when the metadata response is missing the root key (schema-drift)', async () => {
    const out = await drive(
      ['board', 'column-update', '12345', 'status_4', '--description', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnChangeMetadata',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.hint).toMatch(/schema-drift/);
  });

  it('--dry-run: emits update_column planned change with field-level diff via BoardMetadata preflight', async () => {
    const out = await drive(
      [
        'board', 'column-update', '12345', 'status_4',
        '--title', 'Priority',
        '--description', 'Owner-set urgency',
        '--dry-run', '--json',
      ],
      { interactions: [columnUpdateBoardMetadata] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        board_id: string;
        column_id: string;
        diff: Record<string, { from: unknown; to: unknown }>;
      }[];
    };
    expect(env.data).toBeNull();
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('update_column');
    expect(plan?.board_id).toBe('12345');
    expect(plan?.column_id).toBe('status_4');
    expect(plan?.diff.title).toEqual({ from: 'Status', to: 'Priority' });
    expect(plan?.diff.description).toEqual({ from: null, to: 'Owner-set urgency' });
  });

  it('--dry-run: --title only emits diff with only the title field', async () => {
    const out = await drive(
      ['board', 'column-update', '12345', 'status_4', '--title', 'Priority', '--dry-run', '--json'],
      { interactions: [columnUpdateBoardMetadata] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly { diff: Record<string, unknown> }[];
    };
    expect(Object.keys(env.planned_changes[0]?.diff ?? {})).toEqual(['title']);
  });

  it('--dry-run: --description only emits diff with only the description field', async () => {
    const out = await drive(
      ['board', 'column-update', '12345', 'status_4', '--description', 'X', '--dry-run', '--json'],
      { interactions: [columnUpdateBoardMetadata] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly { diff: Record<string, unknown> }[];
    };
    expect(Object.keys(env.planned_changes[0]?.diff ?? {})).toEqual(['description']);
  });

  it('--dry-run: not_found when the column ID is missing on the board (details.column_id pinned)', async () => {
    // Board-level read succeeds but the column ID isn't present —
    // surface not_found with details.column_id so agents distinguish
    // "wrong board id" from "wrong column id" without re-reading.
    const out = await drive(
      [
        'board', 'column-update', '12345', 'ghost_col',
        '--title', 'X',
        '--dry-run', '--json',
      ],
      { interactions: [columnUpdateBoardMetadata] },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { column_id?: string; board_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.column_id).toBe('ghost_col');
    expect(env.error?.details?.board_id).toBe('12345');
  });

  it('--dry-run: not_found when the board itself is missing (preflight bubble)', async () => {
    const out = await drive(
      ['board', 'column-update', '99999', 'status_4', '--title', 'X', '--dry-run', '--json'],
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

  it('cache invalidation round-trip: column-update → board describe sees renamed column with source: live + no stale_cache_refreshed warning', async () => {
    // Per §8 fan-out call-site contract: invalidate ONCE after the
    // loop settles. The round-trip MUST satisfy three pins per
    // cassette to prove eager invalidation worked (rather than the
    // cache-miss-refresh backstop saving us): post-mutation read
    // sees live state; meta.source: 'live'; NO stale_cache_refreshed
    // warning.
    const preMutationColumn = {
      ...baseColumn,
      id: 'status_4',
      title: 'Status',
      type: 'status',
    };
    const renamedPostMutation = {
      ...preMutationColumn,
      title: 'Priority',
    };
    // Seed cache.
    const seed = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([preMutationColumn])] },
    );
    expect(seed.exitCode).toBe(0);
    // Fan-out single-leg (just --title) — invalidation fires after
    // loop settle iff at least one leg succeeded.
    const updated = await drive(
      ['board', 'column-update', '111', 'status_4', '--title', 'Priority', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnChangeTitle',
            match_variables: { boardId: '111', columnId: 'status_4', title: 'Priority' },
            response: {
              data: { change_column_title: renamedPostMutation },
            },
          },
        ],
      },
    );
    expect(updated.exitCode).toBe(0);
    // Post-mutation describe — clean cache miss → live fetch.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([renamedPostMutation])] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { columns: readonly { id: string; title: string }[] };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.columns.find((c) => c.id === 'status_4')?.title).toBe('Priority');
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });

  it('cache invalidation round-trip: partial-application (call #2 fails after call #1 succeeded) STILL invalidates per §8 high-water-mark rule', async () => {
    // The §8 fan-out contract: invalidation fires after the loop
    // settles iff at least one leg succeeded. Whole-call failure
    // after call N succeeded MUST still invalidate because the
    // cache must reflect the partially-applied server state.
    const preMutationColumn = {
      ...baseColumn,
      id: 'status_4',
      title: 'Status',
      type: 'status',
    };
    const renamedPartial = { ...preMutationColumn, title: 'Priority' };
    // Seed cache.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([preMutationColumn])] },
    );
    // Fan-out: call #1 (title) succeeds, call #2 (description) fails.
    const updated = await drive(
      [
        'board', 'column-update', '111', 'status_4',
        '--title', 'Priority',
        '--description', 'X',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ColumnChangeTitle',
            response: { data: { change_column_title: renamedPartial } },
          },
          {
            operation_name: 'ColumnChangeMetadata',
            response: { data: { change_column_metadata: null } },
          },
        ],
      },
    );
    // Whole-call failure → exit 2.
    expect(updated.exitCode).toBe(2);
    // Post-mutation describe — invalidation fired despite the whole-
    // call failure (succeededLegs=1), so this is a clean cache miss.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([renamedPartial])] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { columns: readonly { id: string; title: string }[] };
      warnings?: readonly { code: string }[];
    };
    // The cache served the renamed column (partial-application
    // committed server-side). source: live proves the cache file
    // was unlinked between calls; absent stale_cache_refreshed
    // proves the eager-invalidation path landed cleanly rather
    // than the backstop firing.
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.columns.find((c) => c.id === 'status_4')?.title).toBe('Priority');
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });

  it('cache invalidation: zero-legs-succeeded (very first call fails) does NOT invalidate per §8', async () => {
    // §8: when zero legs succeeded (the very first call failed
    // before any state changed), invalidation is skipped — Monday's
    // per-attribute mutations are not transactional, but a failed-
    // first-call is server-state-unchanged just like a single-leg
    // error.
    const preMutationColumn = {
      ...baseColumn,
      id: 'status_4',
      title: 'Status',
      type: 'status',
    };
    // Seed cache with the pre-mutation snapshot.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([preMutationColumn])] },
    );
    // Fan-out: call #1 (title) fails → loop exits with succeededLegs=0.
    const updated = await drive(
      ['board', 'column-update', '111', 'status_4', '--title', 'Priority', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnChangeTitle',
            response: { data: { change_column_title: null } },
          },
        ],
      },
    );
    expect(updated.exitCode).toBe(2);
    // Cache was NOT invalidated — the next describe should hit the
    // cache (source: 'cache') because the pre-mutation snapshot is
    // still valid (server state didn't change).
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      // Empty interactions: if the cache WAS invalidated, the live
      // fetch would have nothing to read and the test would fail
      // with an exhausted cassette. The cache hit is what proves
      // invalidation was correctly skipped.
      { interactions: [] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout);
    expect(postEnv.meta.source).toBe('cache');
  });
});

// =============================================================================
// M16 — board column-delete (cli-design §4.3 + §6.4 + §8 single-leg invalidation)
// =============================================================================

describe('monday board column-delete (integration, M16)', () => {
  const deletedColumn = {
    id: 'status_4',
    title: 'Status',
    type: 'status',
    description: null,
    archived: false,
    settings_str: null,
    width: 120,
  };

  it('rejects without --yes — confirmation_required carries both board_id AND column_id (two-tuple shape)', async () => {
    // Per cli-design §6.5 single-target shape: column-delete's wire
    // signature is two-tuple, so the confirmation envelope echoes
    // both ids. The R29 helper's `extraDetails` slot carries
    // board_id alongside the canonical column_id detailKey.
    const out = await drive(
      ['board', 'column-delete', '12345', 'status_4', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { board_id?: string; column_id?: string; hint?: string };
      };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.board_id).toBe('12345');
    expect(env.error?.details?.column_id).toBe('status_4');
    expect(env.error?.details?.hint).toMatch(/delete-only/);
    // Gate fires before resolveClient — meta.source stays 'none'.
    expect(env.meta.source).toBe('none');
  });

  it('confirmation gate fires before resolveClient — missing token still surfaces confirmation_required (M10 round-1 P2 ordering)', async () => {
    const out = await drive(
      ['board', 'column-delete', '12345', 'status_4', '--json'],
      { interactions: [] },
      { env: { MONDAY_API_URL: 'https://api.monday.com/v2' } },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('confirmation_required');
  });

  it('--dry-run bypasses the confirmation gate (per cli-design §3.1 #7)', async () => {
    // dry-run is non-executing and the gate is for live destructive
    // writes only — the contract pin: column-delete <bid> <cid>
    // --dry-run without --yes emits the dry-run envelope.
    const out = await drive(
      ['board', 'column-delete', '12345', 'status_4', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly { operation: string; board_id: string; column_id: string }[];
    };
    expect(env.data).toBeNull();
    expect(env.meta.source).toBe('none');
    expect(env.planned_changes[0]).toEqual({
      operation: 'delete_column',
      board_id: '12345',
      column_id: 'status_4',
    });
  });

  it('live: --yes fires delete_column and returns the projected (last-look) column', async () => {
    const out = await drive(
      ['board', 'column-delete', '12345', 'status_4', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnDelete',
            match_variables: { boardId: '12345', columnId: 'status_4' },
            // Pin the wire surface so a future regression that
            // dropped column_id from the mutation declaration would
            // fail here.
            match_query: /delete_column\(board_id: \$boardId, column_id: \$columnId\)/,
            response: { data: { delete_column: deletedColumn } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; title: string };
    };
    expect(env.data.id).toBe('status_4');
    expect(env.data.title).toBe('Status');
    expect(env.meta.source).toBe('live');
    assertEnvelopeContract(env);
  });

  it('live: not_found when delete_column returns null payload (Monday "id was bogus / already deleted")', async () => {
    const out = await drive(
      ['board', 'column-delete', '12345', 'ghost_col', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnDelete',
            response: { data: { delete_column: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { board_id?: string; column_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.board_id).toBe('12345');
    expect(env.error?.details?.column_id).toBe('ghost_col');
  });

  it('live: surfaces internal_error when delete_column response is missing the root key (schema-drift)', async () => {
    const out = await drive(
      ['board', 'column-delete', '12345', 'status_4', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnDelete',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.hint).toMatch(/schema-drift/);
  });

  it('rejects non-numeric boardId at argv parse', async () => {
    const out = await drive(
      ['board', 'column-delete', 'abc', 'status_4', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty <columnId> at argv parse', async () => {
    const out = await drive(
      ['board', 'column-delete', '12345', '', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('cache invalidation round-trip: column-delete → board describe sees absent column with source: live + no stale_cache_refreshed warning', async () => {
    // §8 single-leg call-site contract: invalidation fires AFTER
    // data projection on success. Round-trip pins: post-mutation
    // read sees live state (column absent); meta.source: 'live';
    // no stale_cache_refreshed warning.
    const preColumn = {
      ...baseColumn,
      id: 'status_4',
      title: 'Status',
      type: 'status',
    };
    // Seed cache.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([preColumn])] },
    );
    // Delete the column.
    const deleted = await drive(
      ['board', 'column-delete', '111', 'status_4', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnDelete',
            response: { data: { delete_column: preColumn } },
          },
        ],
      },
    );
    expect(deleted.exitCode).toBe(0);
    // Post-delete describe — clean cache miss → live fetch sees no
    // status_4 column.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([])] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { columns: readonly { id: string }[] };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.columns.find((c) => c.id === 'status_4')).toBeUndefined();
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });

  it('cache invalidation: error path skips invalidation (failed delete didn\'t change board state)', async () => {
    // §8 single-leg contract: skip invalidation on the error path.
    // A delete that returns null (not_found) didn't change server
    // state; the cache remains valid. Mirror M16's column-update
    // zero-legs-succeeded test.
    const preColumn = {
      ...baseColumn,
      id: 'status_4',
      title: 'Status',
      type: 'status',
    };
    // Seed cache.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([preColumn])] },
    );
    // Delete fails (Monday returns null = not_found).
    const deleted = await drive(
      ['board', 'column-delete', '111', 'ghost_col', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnDelete',
            response: { data: { delete_column: null } },
          },
        ],
      },
    );
    expect(deleted.exitCode).toBe(2);
    // Post-delete describe — cache hit (source: 'cache') because
    // invalidation was skipped on the error path.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      // Empty interactions: a cache hit needs no live fetch. If
      // invalidation incorrectly fired, the test fails with an
      // exhausted cassette.
      { interactions: [] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout);
    expect(postEnv.meta.source).toBe('cache');
  });
});

// =============================================================================
// M17 — board group-create (cli-design §4.3 + §6.4 + §8 eager invalidation)
// =============================================================================

describe('monday board group-create (integration, M17)', () => {
  const createdGroup = {
    id: 'sprint_42',
    title: 'Sprint 42',
    color: 'blue',
    position: '1.0',
    archived: false,
    deleted: false,
  };
  const createdGroupNoColor = {
    ...createdGroup,
    id: 'topics',
    title: 'Topics',
    color: null,
  };

  it('live: --name fires create_group with required wire args + group_name', async () => {
    const out = await drive(
      ['board', 'group-create', '12345', '--name', 'Topics', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupCreate',
            // Wire-shape pin: group_name maps to --name (NOT
            // `name`); board_id to the positional. Pre-existing
            // SDK 14.0.0 wire arg name.
            match_variables: {
              boardId: '12345',
              groupName: 'Topics',
            },
            // Pin the GraphQL surface so a future regression that
            // renames `group_name` → `name` (or moves the wire to
            // a different mutation root) fails here.
            match_query: /create_group\(\s*board_id: \$boardId,\s*group_name: \$groupName/,
            response: { data: { create_group: createdGroupNoColor } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; title: string; color: string | null };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('topics');
    expect(env.data.title).toBe('Topics');
    expect(env.data.color).toBeNull();
    assertEnvelopeContract(env);
    expect(env.meta.source).toBe('live');
  });

  it('live: --name --color forwards group_color to the wire', async () => {
    const out = await drive(
      ['board', 'group-create', '12345', '--name', 'Sprint 42', '--color', 'blue', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupCreate',
            match_variables: {
              boardId: '12345',
              groupName: 'Sprint 42',
              groupColor: 'blue',
            },
            // Pin the wire arg name — `group_color` is what Monday
            // accepts; a regression renaming to `color` would lose
            // the colour on the wire.
            match_query: /group_color: \$groupColor/,
            response: { data: { create_group: createdGroup } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; color: string | null };
    };
    expect(env.data.id).toBe('sprint_42');
    expect(env.data.color).toBe('blue');
  });

  it('live: omits group_color from the wire when --color is absent (no null leak)', async () => {
    // Pre-fix, an inadvertent `groupColor: undefined` in the
    // variables map would have been serialised as `null` on the
    // wire, explicitly clearing Monday's server-side default.
    // Mirrors M16 column-create's omits-when-absent regression.
    const out = await drive(
      ['board', 'group-create', '12345', '--name', 'Bare', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupCreate',
            match_variables: {
              boardId: '12345',
              groupName: 'Bare',
            },
            response: {
              data: { create_group: { ...createdGroupNoColor, title: 'Bare' } },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('rejects empty --name (after trim) as usage_error', async () => {
    const out = await drive(
      ['board', 'group-create', '12345', '--name', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects missing --name as usage_error', async () => {
    const out = await drive(
      ['board', 'group-create', '12345', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --color (whitespace-only) as usage_error', async () => {
    const out = await drive(
      ['board', 'group-create', '12345', '--name', 'X', '--color', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric boardId at argv parse', async () => {
    const out = await drive(
      ['board', 'group-create', 'abc', '--name', 'X', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: emits planned_changes with operation create_group; no mutation fires', async () => {
    const out = await drive(
      [
        'board', 'group-create', '12345',
        '--name', 'Sprint 42',
        '--color', 'blue',
        '--dry-run', '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        board_id: string;
        name: string;
        color?: string;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.meta.source).toBe('none');
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('create_group');
    expect(plan?.board_id).toBe('12345');
    expect(plan?.name).toBe('Sprint 42');
    expect(plan?.color).toBe('blue');
  });

  it('--dry-run: omits color from the planned change when --color is absent', async () => {
    const out = await drive(
      ['board', 'group-create', '12345', '--name', 'Topics', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Record<string, unknown>[];
    };
    expect(env.planned_changes[0]).toEqual({
      operation: 'create_group',
      board_id: '12345',
      name: 'Topics',
    });
  });

  it('surfaces internal_error when Monday returns a missing create_group key (schema-drift)', async () => {
    const out = await drive(
      ['board', 'group-create', '12345', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupCreate',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string; board_id?: string; name?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.hint).toMatch(/schema-drift/);
    expect(env.error?.details?.board_id).toBe('12345');
    expect(env.error?.details?.name).toBe('X');
  });

  it('surfaces internal_error when Monday returns a present-but-null create_group (no schema-drift hint)', async () => {
    const out = await drive(
      ['board', 'group-create', '12345', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupCreate',
            response: { data: { create_group: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string; board_id?: string; name?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.board_id).toBe('12345');
    expect(env.error?.details?.name).toBe('X');
    // No schema-drift hint — null payload is a different signal
    // than missing-root-key. Mirrors M15 board-create / M16 column-
    // create round-2 F1 distinction.
    expect(env.error?.details?.hint ?? '').not.toMatch(/schema-drift/);
  });

  it('cache invalidation round-trip: group-create → board describe sees new group with source: live + no stale_cache_refreshed warning', async () => {
    // Per cli-design §8 single-leg call-site contract: invalidate
    // AFTER the success envelope's data projection. The round-trip
    // MUST satisfy three pins per cassette to prove eager
    // invalidation worked (rather than the cache-miss-refresh
    // backstop saving us): post-mutation read sees live state;
    // meta.source: 'live'; NO stale_cache_refreshed warning.
    const preMutationGroup = {
      id: 'topics',
      title: 'Topics',
      color: 'blue',
      position: '1.0',
      archived: false,
      deleted: false,
    };
    const newGroup = {
      id: 'sprint_42',
      title: 'Sprint 42',
      color: 'red',
      position: '2.0',
      archived: false,
      deleted: false,
    };
    // Seed cache.
    const seed = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([], [preMutationGroup])] },
    );
    expect(seed.exitCode).toBe(0);
    // Now the cache holds the pre-mutation snapshot. Fire group-
    // create — it MUST invalidate the cache file before returning.
    const created = await drive(
      [
        'board', 'group-create', '111',
        '--name', 'Sprint 42',
        '--color', 'red',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'GroupCreate',
            match_variables: { boardId: '111', groupName: 'Sprint 42' },
            response: { data: { create_group: newGroup } },
          },
        ],
      },
    );
    expect(created.exitCode).toBe(0);
    // Post-mutation describe — clean cache miss → live fetch.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([], [preMutationGroup, newGroup])] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { groups: readonly { id: string }[] };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.groups.map((g) => g.id)).toContain('sprint_42');
    // The backstop emits stale_cache_refreshed when it fires.
    // Eager invalidation should land in a clean miss instead.
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });

  it('cache invalidation: error path skips invalidation (failed create didn\'t change board state)', async () => {
    // §8 single-leg contract: skip invalidation on the error path.
    // A create that returns null (internal_error) didn't change
    // server state; the cache remains valid. Mirror M16 column-
    // create's error-path test.
    const preGroup = {
      id: 'topics',
      title: 'Topics',
      color: 'blue',
      position: '1.0',
      archived: false,
      deleted: false,
    };
    // Seed cache.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([], [preGroup])] },
    );
    // Create fails (Monday returns null = internal_error).
    const created = await drive(
      ['board', 'group-create', '111', '--name', 'Sprint 42', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupCreate',
            response: { data: { create_group: null } },
          },
        ],
      },
    );
    expect(created.exitCode).toBe(2);
    // Post-create describe — cache hit (source: 'cache') because
    // invalidation was skipped on the error path.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      // Empty interactions: a cache hit needs no live fetch. If
      // invalidation incorrectly fired, the test fails with an
      // exhausted cassette.
      { interactions: [] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout);
    expect(postEnv.meta.source).toBe('cache');
  });
});

// =============================================================================
// M17 — board group-update (cli-design §4.3 + §6.4 + §8 fan-out invalidation)
// =============================================================================

describe('monday board group-update (integration, M17)', () => {
  // Board metadata fixture for the dry-run preflight read — group
  // `topics` exists on board 12345.
  const groupUpdateBoardMetadata: Interaction = {
    operation_name: 'BoardMetadata',
    match_variables: { ids: ['12345'] },
    response: {
      data: {
        boards: [
          {
            id: '12345',
            name: 'Engineering',
            description: null,
            state: 'active',
            board_kind: 'public',
            board_folder_id: null,
            workspace_id: '5',
            url: null,
            hierarchy_type: 'top_level',
            is_leaf: true,
            updated_at: '2026-05-07T11:00:00Z',
            groups: [
              {
                id: 'topics',
                title: 'Topics',
                color: 'blue',
                position: '1.0',
                archived: false,
                deleted: false,
              },
            ],
            columns: [],
          },
        ],
      },
    },
  };

  const renamedGroup = {
    id: 'topics',
    title: 'Sprint 42',
    color: 'blue',
    position: '1.0',
    archived: false,
    deleted: false,
  };
  const recolouredGroup = {
    ...renamedGroup,
    color: 'red',
  };

  it('rejects zero-flag invocation as usage_error at argv parse', async () => {
    const out = await drive(
      ['board', 'group-update', '12345', 'topics', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty <groupId> at argv parse', async () => {
    const out = await drive(
      ['board', 'group-update', '12345', '', '--name', 'X', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --name (whitespace-only) as usage_error', async () => {
    const out = await drive(
      ['board', 'group-update', '12345', 'topics', '--name', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --color (whitespace-only) as usage_error', async () => {
    const out = await drive(
      ['board', 'group-update', '12345', 'topics', '--color', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('live: --name fires update_group with group_attribute: title and projects the response', async () => {
    const out = await drive(
      ['board', 'group-update', '12345', 'topics', '--name', 'Sprint 42', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupUpdate',
            match_variables: {
              boardId: '12345',
              groupId: 'topics',
              groupAttribute: 'title',
              newValue: 'Sprint 42',
            },
            // Pin the wire arg name `group_attribute` (NOT `attribute`) and
            // the GraphQL surface — a regression renaming would silently
            // drop the field on the wire.
            match_query: /update_group\(\s*board_id: \$boardId,\s*group_id: \$groupId/,
            response: { data: { update_group: renamedGroup } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; title: string };
    };
    expect(env.data.id).toBe('topics');
    expect(env.data.title).toBe('Sprint 42');
    expect(env.meta.source).toBe('live');
    assertEnvelopeContract(env);
  });

  it('live: --color fires update_group with group_attribute: color', async () => {
    const out = await drive(
      ['board', 'group-update', '12345', 'topics', '--color', 'red', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupUpdate',
            match_variables: {
              boardId: '12345',
              groupId: 'topics',
              groupAttribute: 'color',
              newValue: 'red',
            },
            response: { data: { update_group: recolouredGroup } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { color: string };
    };
    expect(env.data.color).toBe('red');
  });

  it('live: --name --color fans out two sequential calls; data projects from the trailing call', async () => {
    // Per §8 decision 8: sequential. Per cli-design §4.3 group-
    // update: trailing call's response is authoritative because
    // Monday's update_group returns the full Maybe<Group> post-
    // mutation. No force-live final read leg fires —
    // distinguishes group-update from board-update.
    const out = await drive(
      [
        'board', 'group-update', '12345', 'topics',
        '--name', 'Sprint 42',
        '--color', 'red',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'GroupUpdate',
            match_variables: { groupAttribute: 'title', newValue: 'Sprint 42' },
            response: { data: { update_group: renamedGroup } },
          },
          {
            operation_name: 'GroupUpdate',
            match_variables: { groupAttribute: 'color', newValue: 'red' },
            // Trailing call returns recolouredGroup (renamed AND
            // recoloured) — the trailing response is authoritative
            // for every field per the M17 pre-flight load-bearing
            // finding.
            response: { data: { update_group: recolouredGroup } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(2);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { title: string; color: string };
    };
    expect(env.data.title).toBe('Sprint 42');
    expect(env.data.color).toBe('red');
  });

  it('live: per-attribute failure surfaces the failed call code; no envelope partial-success leak', async () => {
    // Whole-call envelope is `ok: false` on any per-field failure;
    // mirrors `column-update` / `board-update` contract.
    const out = await drive(
      [
        'board', 'group-update', '12345', 'topics',
        '--name', 'Sprint 42',
        '--color', 'red',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'GroupUpdate',
            match_variables: { groupAttribute: 'title' },
            response: { data: { update_group: renamedGroup } },
          },
          {
            operation_name: 'GroupUpdate',
            match_variables: { groupAttribute: 'color' },
            response: { data: { update_group: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.ok).toBe(false);
    // null path uses not_found per the R48 helper's group-update
    // mapping.
    expect(env.error?.code).toBe('not_found');
  });

  it('live: surfaces internal_error when the response is missing the update_group root field (schema-drift)', async () => {
    const out = await drive(
      ['board', 'group-update', '12345', 'topics', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupUpdate',
            response: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.hint).toMatch(/schema-drift/);
  });

  it('--dry-run: emits update_group planned change with field-level diff via BoardMetadata preflight', async () => {
    const out = await drive(
      [
        'board', 'group-update', '12345', 'topics',
        '--name', 'Sprint 42',
        '--color', 'red',
        '--dry-run', '--json',
      ],
      { interactions: [groupUpdateBoardMetadata] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        board_id: string;
        group_id: string;
        diff: Record<string, { from: unknown; to: unknown }>;
      }[];
    };
    expect(env.data).toBeNull();
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('update_group');
    expect(plan?.board_id).toBe('12345');
    expect(plan?.group_id).toBe('topics');
    // Diff key is `name` (CLI-flag-side), `from` is current.title.
    expect(plan?.diff.name).toEqual({ from: 'Topics', to: 'Sprint 42' });
    expect(plan?.diff.color).toEqual({ from: 'blue', to: 'red' });
  });

  it('--dry-run: --name only emits diff with only the name field', async () => {
    const out = await drive(
      ['board', 'group-update', '12345', 'topics', '--name', 'Sprint 42', '--dry-run', '--json'],
      { interactions: [groupUpdateBoardMetadata] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly { diff: Record<string, unknown> }[];
    };
    expect(Object.keys(env.planned_changes[0]?.diff ?? {})).toEqual(['name']);
  });

  it('--dry-run: --color only emits diff with only the color field', async () => {
    const out = await drive(
      ['board', 'group-update', '12345', 'topics', '--color', 'red', '--dry-run', '--json'],
      { interactions: [groupUpdateBoardMetadata] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly { diff: Record<string, unknown> }[];
    };
    expect(Object.keys(env.planned_changes[0]?.diff ?? {})).toEqual(['color']);
  });

  it('--dry-run: not_found when the group ID is missing on the board (details.group_id pinned)', async () => {
    // Board-level read succeeds but the group ID isn't present —
    // surface not_found with details.group_id so agents distinguish
    // "wrong board id" from "wrong group id" without re-reading.
    const out = await drive(
      [
        'board', 'group-update', '12345', 'ghost_group',
        '--name', 'X',
        '--dry-run', '--json',
      ],
      { interactions: [groupUpdateBoardMetadata] },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { group_id?: string; board_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.group_id).toBe('ghost_group');
    expect(env.error?.details?.board_id).toBe('12345');
  });

  it('--dry-run: not_found when the board itself is missing (preflight bubble)', async () => {
    const out = await drive(
      ['board', 'group-update', '99999', 'topics', '--name', 'X', '--dry-run', '--json'],
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

  it('cache invalidation round-trip: group-update → board describe sees renamed group with source: live + no stale_cache_refreshed warning', async () => {
    // Per §8 fan-out call-site contract: invalidate ONCE after the
    // loop settles. The round-trip MUST satisfy three pins per
    // cassette to prove eager invalidation worked: post-mutation
    // read sees live state; meta.source: 'live'; NO
    // stale_cache_refreshed warning.
    const preMutationGroup = {
      id: 'topics',
      title: 'Topics',
      color: 'blue',
      position: '1.0',
      archived: false,
      deleted: false,
    };
    const renamedPostMutation = {
      ...preMutationGroup,
      title: 'Sprint 42',
    };
    // Seed cache.
    const seed = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([], [preMutationGroup])] },
    );
    expect(seed.exitCode).toBe(0);
    // Fan-out single-leg (just --name) — invalidation fires after
    // loop settle iff at least one leg succeeded.
    const updated = await drive(
      ['board', 'group-update', '111', 'topics', '--name', 'Sprint 42', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupUpdate',
            match_variables: {
              boardId: '111',
              groupId: 'topics',
              groupAttribute: 'title',
              newValue: 'Sprint 42',
            },
            response: { data: { update_group: renamedPostMutation } },
          },
        ],
      },
    );
    expect(updated.exitCode).toBe(0);
    // Post-mutation describe — clean cache miss → live fetch.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([], [renamedPostMutation])] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { groups: readonly { id: string; title: string }[] };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.groups.find((g) => g.id === 'topics')?.title).toBe('Sprint 42');
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });

  it('cache invalidation round-trip: partial-application (call #2 fails after call #1 succeeded) STILL invalidates per §8 high-water-mark rule', async () => {
    // The §8 fan-out contract: invalidation fires after the loop
    // settles iff at least one leg succeeded. Whole-call failure
    // after call N succeeded MUST still invalidate because the
    // cache must reflect the partially-applied server state.
    const preMutationGroup = {
      id: 'topics',
      title: 'Topics',
      color: 'blue',
      position: '1.0',
      archived: false,
      deleted: false,
    };
    const renamedPartial = { ...preMutationGroup, title: 'Sprint 42' };
    // Seed cache.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([], [preMutationGroup])] },
    );
    // Fan-out: call #1 (name) succeeds, call #2 (color) fails.
    const updated = await drive(
      [
        'board', 'group-update', '111', 'topics',
        '--name', 'Sprint 42',
        '--color', 'red',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'GroupUpdate',
            match_variables: { groupAttribute: 'title' },
            response: { data: { update_group: renamedPartial } },
          },
          {
            operation_name: 'GroupUpdate',
            match_variables: { groupAttribute: 'color' },
            response: { data: { update_group: null } },
          },
        ],
      },
    );
    // Whole-call failure → exit 2.
    expect(updated.exitCode).toBe(2);
    // Post-mutation describe — invalidation fired despite the
    // whole-call failure (succeededLegs=1), so this is a clean
    // cache miss.
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([], [renamedPartial])] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout) as EnvelopeShape & {
      data: { groups: readonly { id: string; title: string }[] };
      warnings?: readonly { code: string }[];
    };
    expect(postEnv.meta.source).toBe('live');
    expect(postEnv.data.groups.find((g) => g.id === 'topics')?.title).toBe('Sprint 42');
    const warningCodes = (postEnv.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain('stale_cache_refreshed');
  });

  it('cache invalidation: zero-legs-succeeded (very first call fails) does NOT invalidate per §8', async () => {
    // §8: when zero legs succeeded (the very first call failed
    // before any state changed), invalidation is skipped — Monday's
    // per-attribute mutations are not transactional, but a failed-
    // first-call is server-state-unchanged just like a single-leg
    // error.
    const preMutationGroup = {
      id: 'topics',
      title: 'Topics',
      color: 'blue',
      position: '1.0',
      archived: false,
      deleted: false,
    };
    // Seed cache with the pre-mutation snapshot.
    await drive(
      ['board', 'describe', '111', '--json'],
      { interactions: [metadataResponse([], [preMutationGroup])] },
    );
    // Fan-out: call #1 (name) fails → loop exits with succeededLegs=0.
    const updated = await drive(
      ['board', 'group-update', '111', 'topics', '--name', 'Sprint 42', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupUpdate',
            response: { data: { update_group: null } },
          },
        ],
      },
    );
    expect(updated.exitCode).toBe(2);
    // Cache was NOT invalidated — the next describe should hit the
    // cache (source: 'cache') because the pre-mutation snapshot is
    // still valid (server state didn't change).
    const postOut = await drive(
      ['board', 'describe', '111', '--json'],
      // Empty interactions: if the cache WAS invalidated, the live
      // fetch would have nothing to read and the test would fail
      // with an exhausted cassette.
      { interactions: [] },
    );
    expect(postOut.exitCode).toBe(0);
    const postEnv = parseEnvelope(postOut.stdout);
    expect(postEnv.meta.source).toBe('cache');
  });
});
