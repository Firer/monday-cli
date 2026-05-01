/**
 * Agent-flow E2E (`v0.1-plan.md` §3 M6 exit criterion).
 *
 * Replays the v0.1 fallback path from `examples.md` §1 — the workflow
 * an agent runs to "pick up a task and finish it" using only v0.1
 * commands (the `monday dev …` namespace ships in v0.3):
 *
 *   1. `monday item list --board <bid> --where status=Backlog --where owner=me`
 *      → ranked list of agent's open tasks.
 *   2. `monday item set <iid> status='Working on it'`
 *      → mark the picked task in-progress.
 *   3. `monday item set <iid> status=Done`
 *      → mark the task complete (after the work is done).
 *   4. `monday update create <iid> --body "..."`
 *      → post a result comment narrating what shipped.
 *
 * Each step spawns the compiled binary against an in-process fixture
 * server, asserting the §6 envelope contract holds end-to-end across
 * four invocations. This is the agent flow the v0.1 contract was
 * designed for; if the binary survives this test the contract holds
 * for the most common agent loop.
 *
 * Build dependency: `dist/cli/index.js` must be current. CI runs
 * `npm run build` before `test:e2e`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnCli } from './spawn.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';
import type { Cassette, Interaction } from '../fixtures/load.js';

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

const sampleBoardMetadata = {
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
      id: 'status_4',
      title: 'Status',
      type: 'status',
      description: null,
      archived: false,
      // Status with three labels: Backlog (0) / Working on it (1) /
      // Done (2). Pinned via settings_str so the resolver matches
      // `--where status=Backlog` against the label form.
      settings_str: JSON.stringify({
        labels: { '0': 'Backlog', '1': 'Working on it', '2': 'Done' },
      }),
      width: null,
    },
    {
      id: 'person',
      title: 'Owner',
      type: 'people',
      description: null,
      archived: false,
      settings_str: '{}',
      width: null,
    },
  ],
};

const buildItem = (
  statusLabel: 'Backlog' | 'Working on it' | 'Done',
  statusIndex: 0 | 1 | 2,
): Readonly<Record<string, unknown>> => ({
  id: '5001',
  name: 'Refactor login',
  state: 'active',
  url: 'https://example.monday.com/items/5001',
  created_at: '2026-04-29T10:00:00Z',
  updated_at: '2026-04-30T10:00:00Z',
  board: { id: '111' },
  group: { id: 'topics', title: 'Topics' },
  parent_item: null,
  column_values: [
    {
      id: 'status_4',
      type: 'status',
      text: statusLabel,
      value: JSON.stringify({ label: statusLabel, index: statusIndex }),
      column: { title: 'Status' },
    },
  ],
});

interface EnvelopeShape {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string };
  readonly meta: Readonly<Record<string, unknown>>;
}

const parseEnvelope = (s: string): EnvelopeShape =>
  JSON.parse(s) as EnvelopeShape;

const whoamiInteraction: Interaction = {
  // `--where owner=me` resolves `me` via account.whoami; the fixture
  // server replays this one as part of the `item list` step.
  operation_name: 'Whoami',
  response: {
    data: {
      me: {
        id: '7',
        name: 'Alice',
        email: 'alice@example.test',
        account: { id: '99', name: 'Org', slug: 'org' },
      },
    },
  },
};

describe('M6 e2e — agent flow (v0.1 fallback path from examples.md §1)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('list backlog → start → done → comment, contract holds across 4 spawns', async () => {
    const cassette: Cassette = {
      interactions: [
        // Step 1: `monday item list --board 111 --where status=Backlog --where owner=me`
        // Order: BoardMetadata (filter resolves `status` token) →
        // Whoami (resolves `owner=me`) → ItemList (fetches matched items).
        {
          operation_name: 'BoardMetadata',
          response: { data: { boards: [sampleBoardMetadata] } },
        },
        whoamiInteraction,
        {
          operation_name: 'ItemsPage',
          response: {
            data: {
              boards: [
                {
                  items_page: {
                    cursor: null,
                    items: [buildItem('Backlog', 0)],
                  },
                },
              ],
            },
          },
        },
        // Step 2: `monday item set 5001 status='Working on it' --board 111`
        // Order: cache hit on metadata → ItemSetRich (the live mutation).
        {
          operation_name: 'ItemSetRich',
          response: {
            data: {
              change_column_value: buildItem('Working on it', 1),
            },
          },
        },
        // Step 3: `monday item set 5001 status=Done --board 111`
        {
          operation_name: 'ItemSetRich',
          response: {
            data: {
              change_column_value: buildItem('Done', 2),
            },
          },
        },
        // Step 4: `monday update create 5001 --body "..."`
        {
          operation_name: 'UpdateCreate',
          response: {
            data: {
              create_update: {
                id: '777',
                body: '<p>Shipped in PR #1234</p>',
                text_body: 'Shipped in PR #1234',
                creator_id: '7',
                creator: {
                  id: '7',
                  name: 'Alice',
                  email: 'alice@example.test',
                },
                item_id: '5001',
                created_at: '2026-04-30T11:30:00Z',
                updated_at: '2026-04-30T11:30:00Z',
              },
            },
          },
        },
      ],
    };
    const xdg = await mkdtemp(join(tmpdir(), 'monday-cli-e2e-agentflow-'));
    try {
      server = await startFixtureServer({ cassette });

      // ── Spawn 1: list ───────────────────────────────────────────
      const listResult = await spawnCli({
        args: [
          'item',
          'list',
          '--board',
          '111',
          '--where',
          'status=Backlog',
          '--where',
          'owner=me',
          '--json',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(listResult.exitCode).toBe(0);
      const listEnv = parseEnvelope(listResult.stdout) as EnvelopeShape & {
        data: readonly { id: string; name: string }[];
      };
      expect(listEnv.ok).toBe(true);
      expect(listEnv.data).toHaveLength(1);
      expect(listEnv.data[0]?.id).toBe('5001');
      expect(listEnv.data[0]?.name).toBe('Refactor login');
      // Token never leaks across the whole flow.
      expect(listResult.stdout).not.toContain(LEAK_CANARY);
      expect(listResult.stderr).not.toContain(LEAK_CANARY);

      // ── Spawn 2: start (status=Working on it) ───────────────────
      const startResult = await spawnCli({
        args: [
          'item',
          'set',
          '5001',
          'status=Working on it',
          '--board',
          '111',
          '--json',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(startResult.exitCode).toBe(0);
      const startEnv = parseEnvelope(startResult.stdout) as EnvelopeShape & {
        data: {
          id: string;
          columns: Readonly<Record<string, { type: string; label?: string }>>;
        };
      };
      expect(startEnv.ok).toBe(true);
      expect(startEnv.data.id).toBe('5001');
      expect(startEnv.data.columns.status_4).toMatchObject({
        type: 'status',
        label: 'Working on it',
      });
      expect(startResult.stdout).not.toContain(LEAK_CANARY);
      expect(startResult.stderr).not.toContain(LEAK_CANARY);

      // ── Spawn 3: done (status=Done) ─────────────────────────────
      const doneResult = await spawnCli({
        args: [
          'item',
          'set',
          '5001',
          'status=Done',
          '--board',
          '111',
          '--json',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(doneResult.exitCode).toBe(0);
      const doneEnv = parseEnvelope(doneResult.stdout) as EnvelopeShape & {
        data: {
          id: string;
          columns: Readonly<Record<string, { type: string; label?: string }>>;
        };
      };
      expect(doneEnv.ok).toBe(true);
      expect(doneEnv.data.columns.status_4).toMatchObject({
        type: 'status',
        label: 'Done',
      });

      // ── Spawn 4: comment (update create) ────────────────────────
      const commentResult = await spawnCli({
        args: [
          'update',
          'create',
          '5001',
          '--body',
          'Shipped in PR #1234',
          '--json',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(commentResult.exitCode).toBe(0);
      const commentEnv = parseEnvelope(commentResult.stdout) as EnvelopeShape & {
        data: { id: string; text_body: string | null; item_id: string | null };
      };
      expect(commentEnv.ok).toBe(true);
      expect(commentEnv.data.id).toBe('777');
      expect(commentEnv.data.text_body).toBe('Shipped in PR #1234');
      expect(commentEnv.data.item_id).toBe('5001');

      // ── Cassette fully consumed in expected order ───────────────
      expect(server.remaining()).toBe(0);
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});
