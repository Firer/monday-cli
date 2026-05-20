/**
 * Agent-flow E2E (`v0.1-plan.md` §3 M6 exit criterion + `v0.2-plan.md`
 * §3 M18 "agent-flow extended with v0.2 verb").
 *
 * Replays the v0.1 fallback path from `examples.md` §1 — the workflow
 * an agent runs to "pick up a task and finish it" — extended at M18
 * with `item create` so the smoke spans a v0.1 + v0.2 mix:
 *
 *   1. `monday item create --board <bid> --name "..." --set status=Backlog`
 *      → file the new task (v0.2, M9). The created item's ID feeds
 *      every subsequent step — the spawn is **load-bearing**, not a
 *      smoke-only addition.
 *   2. `monday item list --board <bid> --where status=Backlog --where owner=me`
 *      → ranked list of agent's open tasks. Verifies the just-
 *      created item is reachable through the M3 read path.
 *   3. `monday item set <iid> status='Working on it'`
 *      → mark the picked task in-progress (M5b mutation).
 *   4. `monday item set <iid> status=Done`
 *      → mark the task complete (M5b mutation).
 *   5. `monday update create <iid> --body "..."`
 *      → post a result comment narrating what shipped (M5b mutation).
 *
 * Each step spawns the compiled binary against an in-process fixture
 * server, asserting the §6 envelope contract holds end-to-end across
 * five invocations spanning M3 (item list) + M5b (item set, update
 * create) + M9 (item create). If the binary survives this test the
 * contract holds for the most common agent loop AND the v0.1+v0.2
 * mix.
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

describe('M6 e2e — agent flow (v0.1 fallback path + M18 v0.2 extension)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  // 5 sequential spawns at ~1.2s each push the wall-clock cost
  // of this test close to the 5s vitest default. Bumping to 30s
  // gives headroom against system-load flakes (the agent-flow E2E
  // runs on Node 22/24 in CI and occasionally trips the default
  // when tsx import + commander registration are both warming up).
  // Pre-M9 this passed at ~4.8s; M9 added one more registered
  // command (item.create) and tipped the scale by ~50ms. M10 Session
  // B added duplicate (registry now 40 entries vs 39); under heavy
  // concurrent test load the 10s budget started flaking, so the
  // ceiling lifted to 15s; M18 added a 5th spawn (item create) and
  // the 15s ceiling held until M21-prep when full-suite-under-load
  // crossed it (registry now 72 entries — every spawn pays the
  // commander registration cost; 5x sequential under contention
  // exceeded 15s on a multi-worker run). The headroom bump to 30s
  // continues the documented response. `retry: 1` is the
  // belt-and-braces — wall-clock-under-load flakes are
  // non-deterministic by definition, and a deterministic test bug
  // would still fail both attempts. In isolation the test runs in
  // ~2s, so retry budget is generous against the 30s ceiling.
  it('create → list backlog → start → done → comment, contract holds across 5 spawns spanning v0.1+v0.2', { timeout: 30000, retry: 1 }, async () => {
    // M18 release-prep: `item create` (v0.2 / M9) is the new
    // first step. The created item's ID `5001` flows into every
    // subsequent step — the spawn is load-bearing, not smoke-only
    // (Codex M18 pre-flight P3-4: re-using the returned ID
    // in `item set` / `update create` proves the v0.2 envelope's
    // `data.id` slot is contract-correct, not just present).
    const cassette: Cassette = {
      interactions: [
        // Step 1: `monday item create --board 111 --name "Refactor login"
        //          --set status=Backlog`
        // Order: BoardMetadata (resolves --set status token) →
        // ItemCreateTopLevel (creates the item).
        {
          operation_name: 'BoardMetadata',
          response: { data: { boards: [sampleBoardMetadata] } },
        },
        {
          operation_name: 'ItemCreateTopLevel',
          response: {
            data: {
              create_item: buildItem('Backlog', 0),
            },
          },
        },
        // Step 2: `monday item list --board 111 --where status=Backlog --where owner=me`
        // Order: cache hit on metadata (warmed by step 1) →
        // Whoami (resolves `owner=me`) → ItemList.
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
        // Step 3: `monday item set 5001 status='Working on it' --board 111`
        // Order: cache hit on metadata → ItemSetRich (the live mutation).
        {
          operation_name: 'ItemSetRich',
          response: {
            data: {
              change_column_value: buildItem('Working on it', 1),
            },
          },
        },
        // Step 4: `monday item set 5001 status=Done --board 111`
        {
          operation_name: 'ItemSetRich',
          response: {
            data: {
              change_column_value: buildItem('Done', 2),
            },
          },
        },
        // Step 5: `monday update create 5001 --body "..."`
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

      // ── Spawn 1: create (M9 / v0.2) ─────────────────────────────
      const createResult = await spawnCli({
        args: [
          'item',
          'create',
          '--board',
          '111',
          '--name',
          'Refactor login',
          '--set',
          'status=Backlog',
          '--json',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(createResult.exitCode).toBe(0);
      const createEnv = parseEnvelope(createResult.stdout) as EnvelopeShape & {
        data: { id: string; name: string };
      };
      // Cold-start `item create` — no cache yet. M38 IMPL added
      // `preCheckM38FileDispatch` upstream of the standard translator
      // path: the pre-check's BoardMetadata fetch is live and warms
      // the cache; the downstream `planChanges` re-resolve hits cache;
      // the mutation is live. M3 source aggregation reports
      // `meta.source: 'mixed'` because the cache leg is now counted.
      assertEnvelopeContract(createEnv, { source: 'mixed' });
      expect(createEnv.data.id).toBe('5001');
      expect(createEnv.data.name).toBe('Refactor login');
      expect(createResult.stdout).not.toContain(LEAK_CANARY);
      expect(createResult.stderr).not.toContain(LEAK_CANARY);

      // The created ID is now the "picked task" for every
      // downstream step — load-bearing, not just smoke.
      const createdItemId = createEnv.data.id;

      // ── Spawn 2: list ───────────────────────────────────────────
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
      // Step 1 warmed the cache; step 2's metadata leg is cache-
      // backed. Items page leg stays live → meta.source: 'mixed'.
      assertEnvelopeContract(listEnv, { source: 'mixed' });
      expect(listEnv.data).toHaveLength(1);
      // Pin: the listed item is the one we just created — proves
      // the v0.2 create's `data.id` round-trips through the v0.1
      // read path.
      expect(listEnv.data[0]?.id).toBe(createdItemId);
      expect(listEnv.data[0]?.name).toBe('Refactor login');
      expect(listResult.stdout).not.toContain(LEAK_CANARY);
      expect(listResult.stderr).not.toContain(LEAK_CANARY);

      // ── Spawn 3: start (status=Working on it) ───────────────────
      const startResult = await spawnCli({
        args: [
          'item',
          'set',
          createdItemId,
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
      // per cli-design §6.4.
      assertEnvelopeContract(startEnv, { source: 'mixed' });
      expect(startEnv.data.id).toBe(createdItemId);
      expect(startEnv.data.columns.status_4).toMatchObject({
        type: 'status',
        label: 'Working on it',
      });
      expect(startResult.stdout).not.toContain(LEAK_CANARY);
      expect(startResult.stderr).not.toContain(LEAK_CANARY);

      // ── Spawn 4: done (status=Done) ─────────────────────────────
      const doneResult = await spawnCli({
        args: [
          'item',
          'set',
          createdItemId,
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
      expect(doneEnv.data.id).toBe(createdItemId);
      expect(doneEnv.data.columns.status_4).toMatchObject({
        type: 'status',
        label: 'Done',
      });

      // ── Spawn 5: comment (update create) ────────────────────────
      const commentResult = await spawnCli({
        args: [
          'update',
          'create',
          createdItemId,
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
      expect(commentEnv.data.item_id).toBe(createdItemId);

      // ── Cassette fully consumed in expected order ───────────────
      expect(server.remaining()).toBe(0);
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});
