/**
 * M9 E2E suite — spawns the compiled binary against a fixture server
 * for `monday item create` (`v0.2-plan.md` §3 M9).
 *
 * Two scenarios per the §M9 exit criteria:
 *   1. Top-level happy path — `--board 111 --name "Test" --set
 *      status=Done` round-trips against fixtures and the projected
 *      envelope carries `data: { id, name, board_id, group_id }` +
 *      `resolved_ids: { status: status_4 }`.
 *   2. Subitem happy path — `--parent 12345 --name "Subtask"` round-
 *      trips through the parent-lookup → create_subitem chain and the
 *      envelope carries `parent_id` per the cli-design §6.4 subitem
 *      variant.
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

const newItem = {
  id: '99001',
  name: 'New task',
  board: { id: '111' },
  group: { id: 'topics' },
};

const newSubitem = {
  id: '99100',
  name: 'Subtask 1',
  board: { id: '333' },
  group: { id: 'subitems_topic' },
  parent_item: { id: '12345' },
};

interface EnvelopeShape {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string };
  readonly meta: Readonly<Record<string, unknown>>;
}

const parseEnvelope = (s: string): EnvelopeShape =>
  JSON.parse(s) as EnvelopeShape;

describe('M9 e2e — item create top-level (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips --board + --name + --set; envelope carries the projected new item + resolved_ids', async () => {
    const cassette: Cassette = {
      interactions: [
        // First --set token resolution → BoardMetadata fetch.
        {
          operation_name: 'BoardMetadata',
          response: { data: { boards: [sampleBoardMetadata] } },
        },
        {
          operation_name: 'ItemCreateTopLevel',
          response: { data: { create_item: newItem } },
        },
      ],
    };
    const xdg = await mkdtemp(join(tmpdir(), 'monday-cli-e2e-create-'));
    try {
      server = await startFixtureServer({ cassette });
      const result = await spawnCli({
        args: [
          'item',
          'create',
          '--board',
          '111',
          '--name',
          'New task',
          '--set',
          'status=Done',
          '--json',
          '--no-cache',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(result.exitCode).toBe(0);
      const env = parseEnvelope(result.stdout) as EnvelopeShape & {
        data: {
          id: string;
          name: string;
          board_id: string;
          group_id: string | null;
        };
        resolved_ids?: Readonly<Record<string, string>>;
      };
      expect(env.ok).toBe(true);
      expect(env.data).toEqual({
        id: '99001',
        name: 'New task',
        board_id: '111',
        group_id: 'topics',
      });
      expect(env.resolved_ids).toEqual({ status: 'status_4' });
      // Token never leaks into stdout / stderr.
      expect(result.stdout).not.toContain(LEAK_CANARY);
      expect(result.stderr).not.toContain(LEAK_CANARY);
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

describe('M9 e2e — item create subitem (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips --parent + --name; envelope carries parent_id (no --set, no metadata fetches)', async () => {
    const cassette: Cassette = {
      interactions: [
        // 1) parent lookup → board id + hierarchy_type (classic).
        {
          operation_name: 'ItemParentLookup',
          response: {
            data: {
              items: [
                {
                  id: '12345',
                  board: { id: '111', hierarchy_type: 'classic' },
                },
              ],
            },
          },
        },
        // 2) the create_subitem mutation.
        {
          operation_name: 'ItemCreateSubitem',
          response: { data: { create_subitem: newSubitem } },
        },
      ],
    };
    const xdg = await mkdtemp(join(tmpdir(), 'monday-cli-e2e-create-sub-'));
    try {
      server = await startFixtureServer({ cassette });
      const result = await spawnCli({
        args: [
          'item',
          'create',
          '--parent',
          '12345',
          '--name',
          'Subtask 1',
          '--json',
          '--no-cache',
        ],
        env: fixtureEnv(server, { XDG_CACHE_HOME: xdg }),
      });
      expect(result.exitCode).toBe(0);
      const env = parseEnvelope(result.stdout) as EnvelopeShape & {
        data: {
          id: string;
          name: string;
          board_id: string;
          group_id: string | null;
          parent_id?: string;
        };
        resolved_ids?: Readonly<Record<string, string>>;
      };
      expect(env.ok).toBe(true);
      expect(env.data).toMatchObject({
        id: '99100',
        name: 'Subtask 1',
        board_id: '333',
        parent_id: '12345',
      });
      // No --set tokens → empty resolved_ids echo.
      expect(env.resolved_ids).toEqual({});
      expect(result.stdout).not.toContain(LEAK_CANARY);
      expect(result.stderr).not.toContain(LEAK_CANARY);
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});
