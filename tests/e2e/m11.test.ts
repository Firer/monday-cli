/**
 * M11 E2E suite — spawns the compiled binary against a fixture server
 * for `monday item move` (`v0.2-plan.md` §3 M11).
 *
 * One scenario: cross-board happy path with `--columns-mapping`. The
 * cross-board flow is the most design-loaded path in M11 (four wire
 * legs + the strict-default unmatched check + the columns_mapping
 * payload), so a binary spawn proves the four legs really thread
 * through the compiled artefact. Same-board (`move_item_to_group`)
 * coverage stays at the integration layer — the four-leg metadata-
 * loading + planner is unique to cross-board, and the same-board
 * single-mutation path mirrors archive/delete.
 *
 * Build dependency: `dist/cli/index.js` must be current (CI runs
 * `npm run build` before `test:e2e`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const sourceItem = {
  id: '12345',
  name: 'Refactor login',
  state: 'active',
  url: 'https://example.monday.com/items/12345',
  created_at: '2026-04-29T10:00:00Z',
  updated_at: '2026-04-29T11:00:00Z',
  board: { id: '111' },
  group: { id: 'topics', title: 'Topics' },
  parent_item: null,
  column_values: [
    {
      id: 'status_4',
      type: 'status',
      text: 'Done',
      value: '{"label":"Done","index":1}',
      column: { title: 'Status' },
    },
  ],
};

const sourceBoardMetadata = {
  id: '111',
  name: 'Tasks (source)',
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
      id: 'status_4',
      title: 'Status',
      type: 'status',
      description: null,
      archived: false,
      settings_str: '{}',
      width: null,
    },
  ],
};

const targetBoardMetadata = {
  id: '222',
  name: 'Tasks (target)',
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
      // Different ID from source — tests the explicit mapping path.
      id: 'status_42',
      title: 'Status',
      type: 'status',
      description: null,
      archived: false,
      settings_str: '{}',
      width: null,
    },
  ],
};

const movedItem = {
  ...sourceItem,
  board: { id: '222' },
  group: { id: 'topics', title: 'Topics' },
};

interface EnvelopeShape {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string };
  readonly meta: Readonly<Record<string, unknown>>;
}

const parseEnvelope = (s: string): EnvelopeShape =>
  JSON.parse(s) as EnvelopeShape;

describe('M11 e2e — item move cross-board with --columns-mapping (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips ItemMoveRead + 2x BoardMetadata + ItemMoveToBoard; envelope carries the projected item on the target board', async () => {
    // Four legs against the fixture server — no parallelism issues
    // because the fixture server matches on (operation_name +
    // match_variables) and serves whichever request lands. The
    // cassette ordering here is just for readability.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ItemMoveRead',
          response: { data: { items: [sourceItem] } },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['111'] },
          response: { data: { boards: [sourceBoardMetadata] } },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['222'] },
          response: { data: { boards: [targetBoardMetadata] } },
        },
        {
          operation_name: 'ItemMoveToBoard',
          match_variables: {
            itemId: '12345',
            boardId: '222',
            groupId: 'topics',
            columnsMapping: [{ source: 'status_4', target: 'status_42' }],
          },
          response: { data: { move_item_to_board: movedItem } },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    // Isolate XDG_CACHE_HOME so the metadata cache from a prior local
    // run doesn't pollute the spawned binary's view. `--no-cache`
    // belt-and-braces — even with a fresh dir, it skips the on-disk
    // read+write entirely (mirrors m5b/m9 e2e pattern).
    const xdg = await mkdtemp(join(tmpdir(), 'monday-cli-e2e-move-'));
    let result;
    try {
      result = await spawnCli({
        args: [
          'item',
          'move',
          '12345',
          '--to-group',
          'topics',
          '--to-board',
          '222',
          '--columns-mapping',
          '{"status_4": "status_42"}',
          '--no-cache',
          '--json',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { id: string; board_id: string; name: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      id: '12345',
      board_id: '222',
      name: 'Refactor login',
    });
    // Token never leaks across the four-leg flow (M11 regression).
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});
