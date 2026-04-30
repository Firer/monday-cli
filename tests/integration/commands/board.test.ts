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
 *
 * Each board describe / columns / groups test uses an isolated
 * tmp XDG cache so cache-write side effects don't bleed across tests.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cassette, Interaction } from '../../fixtures/load.js';
import {
  assertEnvelopeContract,
  drive as driveBase,
  parseEnvelope,
  FIXTURE_API_URL,
  LEAK_CANARY,
  type DriveResult,
  type EnvelopeShape,
} from '../helpers.js';
import type { RunOptions } from '../../../src/cli/run.js';

let xdgRoot: string;

beforeEach(async () => {
  xdgRoot = await mkdtemp(join(tmpdir(), 'monday-cli-board-int-'));
});

afterEach(async () => {
  await rm(xdgRoot, { recursive: true, force: true });
});

/**
 * `board.test.ts` exercises cache-aware reads (`board describe` /
 * `columns` / `groups`) so each `drive` call needs a per-test
 * isolated `XDG_CACHE_HOME`. The wrapper reads `xdgRoot` from the
 * `beforeEach` closure so the helper signature stays the same as
 * `tests/integration/helpers.ts` `drive(...)`.
 */
const drive = async (
  argv: readonly string[],
  cassette: Cassette,
  overrides: Partial<RunOptions> = {},
): Promise<DriveResult> => {
  const env = {
    MONDAY_API_TOKEN: LEAK_CANARY,
    MONDAY_API_URL: FIXTURE_API_URL,
    XDG_CACHE_HOME: xdgRoot,
  };
  return driveBase(argv, cassette, { env, ...overrides });
};

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

  it('rejects a non-numeric id at the parse boundary (usage_error)', async () => {
    const out = await drive(['board', 'get', 'abc', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
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
