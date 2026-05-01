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

interface EnvelopeMeta {
  readonly schema_version: string;
  readonly api_version: string;
  readonly cli_version: string;
  readonly request_id: string;
  readonly source: 'live' | 'cache' | 'mixed' | 'none';
  readonly cache_age_seconds: number | null;
  readonly retrieved_at: string;
  readonly complexity: Readonly<Record<string, unknown>> | null;
}

interface EnvelopeShape {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string };
  readonly meta: EnvelopeMeta & Readonly<Record<string, unknown>>;
  readonly warnings?: readonly { readonly code: string }[];
}

const parseEnvelope = (s: string): EnvelopeShape =>
  JSON.parse(s) as EnvelopeShape;

const SOURCE_VALUES: readonly EnvelopeMeta['source'][] = [
  'live',
  'cache',
  'mixed',
  'none',
];

/**
 * Pin the §6.1 universal envelope contract on every spawn — the
 * point of an end-to-end test is that the envelope shape doesn't
 * drift between v0.1 and v0.2. Asserts every required `meta` slot
 * and the `source` enum that downstream agent code keys off.
 */
const assertEnvelopeContract = (
  env: EnvelopeShape,
  expected: {
    readonly source?: EnvelopeMeta['source'];
  },
): void => {
  expect(env.ok).toBe(true);
  expect(env.meta.schema_version).toBe('1');
  // The CLI runs against the SDK pin; M0 plumbed `MONDAY_API_VERSION`
  // override so this slot must always carry the resolved value.
  expect(env.meta.api_version).toMatch(/^\d{4}-\d{2}$/u);
  expect(typeof env.meta.cli_version).toBe('string');
  expect(env.meta.cli_version.length).toBeGreaterThan(0);
  expect(env.meta.request_id).toMatch(/^[0-9a-f-]{8,}/u);
  if (expected.source !== undefined) {
    expect(env.meta.source).toBe(expected.source);
  } else {
    expect(SOURCE_VALUES).toContain(env.meta.source);
  }
  // cache_age_seconds is `number | null` per §6.1; assert the type
  // contract (not the exact value, which depends on cache state).
  expect(
    env.meta.cache_age_seconds === null ||
      typeof env.meta.cache_age_seconds === 'number',
  ).toBe(true);
  expect(env.meta.retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  // §6.1: complexity is `object | null`. Always null without
  // `--verbose`; the agent flow doesn't pass verbose so the slot
  // must be `null` (not absent).
  expect(env.meta.complexity).toBeNull();
  // §6 says `warnings` is always delivered as part of the stdout
  // envelope. Pin the type-shape on every spawn so a v0.2 schema
  // drift that drops the slot fails loudly.
  expect(Array.isArray(env.warnings)).toBe(true);
};

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
      // Cold-start `item list` — no cache yet. Filter resolution
      // fetches metadata live (no stale-cache refresh path), and
      // items_page is also live; M3's source aggregation keeps
      // `meta.source` as `'live'` when there's nothing cache-sourced
      // in the call. The cache file gets populated as a side-effect,
      // which the next spawn picks up.
      assertEnvelopeContract(listEnv, { source: 'live' });
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
      // `item set` resolves `status_4` against board metadata. The
      // first spawn populated the cache; this spawn picks the cached
      // shape and the live mutation, so source should be `'mixed'`
      // and `meta.idempotent` is set per cli-design §6.4.
      assertEnvelopeContract(startEnv, { source: 'mixed' });
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
      assertEnvelopeContract(doneEnv, { source: 'mixed' });
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
      // `update create` doesn't touch board metadata — single live
      // mutation, no cache leg, so source stays `'live'`.
      assertEnvelopeContract(commentEnv, { source: 'live' });
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
