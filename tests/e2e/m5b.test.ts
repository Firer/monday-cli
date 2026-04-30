/**
 * M5b E2E suite — spawns the compiled binary against a fixture
 * server for `monday item set` (`v0.1-plan.md` §3 M5b).
 *
 * The integration suite covers per-command branch logic; this E2E
 * verifies the binary round-trips: argv parses, FetchTransport sends
 * the right headers, the envelope renderer emits valid JSON on
 * stdout, exit codes match the §3.1 contract, and (most
 * importantly) the dry-run envelope matches the §6.4 sample
 * literally.
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
      settings_str: '{}',
      width: null,
    },
  ],
};

const sampleItem = {
  id: '12345',
  name: 'Refactor login',
  state: 'active',
  url: 'https://example.monday.com/items/12345',
  created_at: '2026-04-29T10:00:00Z',
  updated_at: '2026-04-30T10:00:00Z',
  board: { id: '111' },
  group: { id: 'topics', title: 'Topics' },
  parent_item: null,
  column_values: [
    {
      id: 'status_4',
      type: 'status',
      text: 'Backlog',
      value: '{"label":"Backlog","index":0}',
      column: { title: 'Status' },
    },
  ],
};

const updatedItem = {
  ...sampleItem,
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

interface EnvelopeShape {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string };
  readonly meta: Readonly<Record<string, unknown>>;
}

const parseEnvelope = (s: string): EnvelopeShape =>
  JSON.parse(s) as EnvelopeShape;

describe('M5b e2e — item set (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips status=Done; envelope carries the projected item', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardMetadata',
          response: { data: { boards: [sampleBoardMetadata] } },
        },
        {
          operation_name: 'ItemSetRich',
          response: { data: { change_column_value: updatedItem } },
        },
      ],
    };
    const xdg = await mkdtemp(join(tmpdir(), 'monday-cli-e2e-set-'));
    try {
      server = await startFixtureServer({ cassette });
      const result = await spawnCli({
        args: [
          'item',
          'set',
          '12345',
          'status=Done',
          '--board',
          '111',
          '--json',
          '--no-cache',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(result.exitCode).toBe(0);
      const env = parseEnvelope(result.stdout) as EnvelopeShape & {
        data: {
          id: string;
          columns: Readonly<Record<string, { type: string; label?: string }>>;
        };
      };
      expect(env.ok).toBe(true);
      expect(env.data.id).toBe('12345');
      expect(env.data.columns.status_4).toMatchObject({
        type: 'status',
        label: 'Done',
      });
      // Pass-1 finding F1: cli-design §5.3 step 2 promises the
      // resolved column ID is echoed in mutation output. The live
      // mutation envelope's `resolved_ids` slot ships this.
      const withResolved = env as EnvelopeShape & {
        resolved_ids?: Readonly<Record<string, string>>;
      };
      expect(withResolved.resolved_ids).toEqual({ status: 'status_4' });
      // Token never leaks into stdout / stderr.
      expect(result.stdout).not.toContain(LEAK_CANARY);
      expect(result.stderr).not.toContain(LEAK_CANARY);
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

describe('M5b e2e — item clear (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips clearing status; envelope carries the projected item', async () => {
    const clearedItem = {
      ...sampleItem,
      column_values: [
        {
          id: 'status_4',
          type: 'status',
          text: '',
          value: null,
          column: { title: 'Status' },
        },
      ],
    };
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardMetadata',
          response: { data: { boards: [sampleBoardMetadata] } },
        },
        {
          operation_name: 'ItemClearRich',
          response: { data: { change_column_value: clearedItem } },
        },
      ],
    };
    const xdg = await mkdtemp(join(tmpdir(), 'monday-cli-e2e-clear-'));
    try {
      server = await startFixtureServer({ cassette });
      const result = await spawnCli({
        args: [
          'item',
          'clear',
          '12345',
          'status',
          '--board',
          '111',
          '--json',
          '--no-cache',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(result.exitCode).toBe(0);
      const env = parseEnvelope(result.stdout) as EnvelopeShape & {
        data: { id: string };
        resolved_ids?: Readonly<Record<string, string>>;
      };
      expect(env.ok).toBe(true);
      expect(env.data.id).toBe('12345');
      expect(env.resolved_ids).toEqual({ status: 'status_4' });
      expect(result.stdout).not.toContain(LEAK_CANARY);
      expect(result.stderr).not.toContain(LEAK_CANARY);
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

describe('M5b e2e — item update (multi --set + --name, atomic)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips --name + multi --set via change_multiple_column_values', async () => {
    const renamedAndUpdated = {
      ...sampleItem,
      name: 'New title',
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
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardMetadata',
          response: { data: { boards: [sampleBoardMetadata] } },
        },
        {
          operation_name: 'ItemUpdateMulti',
          response: {
            data: { change_multiple_column_values: renamedAndUpdated },
          },
        },
      ],
    };
    const xdg = await mkdtemp(join(tmpdir(), 'monday-cli-e2e-update-'));
    try {
      server = await startFixtureServer({ cassette });
      const result = await spawnCli({
        args: [
          'item',
          'update',
          '12345',
          '--name',
          'New title',
          '--set',
          'status=Done',
          '--board',
          '111',
          '--json',
          '--no-cache',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(result.exitCode).toBe(0);
      const env = parseEnvelope(result.stdout) as EnvelopeShape & {
        data: { id: string; name: string };
        resolved_ids?: Readonly<Record<string, string>>;
      };
      expect(env.ok).toBe(true);
      expect(env.data.name).toBe('New title');
      expect(env.resolved_ids).toEqual({ status: 'status_4' });
      expect(result.stdout).not.toContain(LEAK_CANARY);
      expect(result.stderr).not.toContain(LEAK_CANARY);
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

describe('M5b e2e — update create (post a comment)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips --body via create_update; envelope carries the projected update', async () => {
    const createdUpdate = {
      id: '88',
      body: '<p>Done</p>',
      text_body: 'Done',
      creator_id: '1',
      creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
      item_id: '12345',
      created_at: '2026-04-30T11:00:00Z',
      updated_at: '2026-04-30T11:00:00Z',
    };
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'UpdateCreate',
          response: { data: { create_update: createdUpdate } },
        },
      ],
    };
    const xdg = await mkdtemp(join(tmpdir(), 'monday-cli-e2e-update-create-'));
    try {
      server = await startFixtureServer({ cassette });
      const result = await spawnCli({
        args: [
          'update',
          'create',
          '12345',
          '--body',
          'Done',
          '--json',
          '--no-cache',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(result.exitCode).toBe(0);
      const env = parseEnvelope(result.stdout) as EnvelopeShape & {
        data: { id: string; item_id: string };
      };
      expect(env.ok).toBe(true);
      expect(env.data.id).toBe('88');
      expect(env.data.item_id).toBe('12345');
      expect(result.stdout).not.toContain(LEAK_CANARY);
      expect(result.stderr).not.toContain(LEAK_CANARY);
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

describe('M5b e2e — item set --dry-run', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('emits the §6.4 dry-run envelope; no mutation is fired', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardMetadata',
          response: { data: { boards: [sampleBoardMetadata] } },
        },
        {
          operation_name: 'ItemDryRunRead',
          response: { data: { items: [sampleItem] } },
        },
        // No ItemSetRich — dry-run must NOT fire any mutation.
      ],
    };
    const xdg = await mkdtemp(join(tmpdir(), 'monday-cli-e2e-dryrun-'));
    try {
      server = await startFixtureServer({ cassette });
      const result = await spawnCli({
        args: [
          'item',
          'set',
          '12345',
          'status=Done',
          '--board',
          '111',
          '--dry-run',
          '--json',
          '--no-cache',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(result.exitCode).toBe(0);
      const env = parseEnvelope(result.stdout) as EnvelopeShape & {
        data: null;
        meta: { dry_run?: boolean };
        planned_changes: readonly {
          operation: string;
          board_id: string;
          item_id: string;
          resolved_ids: Readonly<Record<string, string>>;
          diff: Readonly<Record<string, unknown>>;
        }[];
      };
      expect(env.data).toBeNull();
      expect(env.meta.dry_run).toBe(true);
      expect(env.planned_changes.length).toBe(1);
      const plan = env.planned_changes[0];
      expect(plan?.operation).toBe('change_column_value');
      expect(plan?.board_id).toBe('111');
      expect(plan?.item_id).toBe('12345');
      expect(plan?.resolved_ids).toEqual({ status: 'status_4' });
      expect(plan?.diff.status_4).toMatchObject({
        from: { label: 'Backlog', index: 0 },
        to: { label: 'Done' },
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});
