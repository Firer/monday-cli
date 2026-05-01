/**
 * Shared fixtures + helpers for the per-verb `monday item *` integration
 * test files (R14, prescribed in v0.1-plan §17).
 *
 * The pre-R14 monolith (`item.test.ts`, ~5000 lines after M5b) repeated
 * the same `sampleItem` / `sampleBoardMetadata` / `boardMetadataInteraction`
 * / `item()` helper plus the `xdgRoot` + `drive` wrapper at the top.
 * Lifting them here lets each per-verb file (`item-{get,list,find,
 * search,subitems,set,clear,update}.test.ts`) reduce to one `import`
 * line for the shared shape.
 *
 * `useItemTestEnv()` registers a fresh per-test `XDG_CACHE_HOME` (the
 * cache-aware `loadBoardMetadata` writes there during `item list` /
 * `search` / set-with-cache-miss-refresh) and returns a `drive` bound
 * to that root. The function is called once at module top-level in
 * each per-verb file, mirroring what the monolith did inline.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { Cassette } from '../../fixtures/load.js';
import {
  drive as driveBase,
  FIXTURE_API_URL,
  LEAK_CANARY,
  type DriveResult,
} from '../helpers.js';
import type { RunOptions } from '../../../src/cli/run.js';

export const sampleColumnValues = [
  {
    id: 'status_4',
    type: 'status',
    text: 'Done',
    value: '{"label":"Done","index":1}',
    column: { title: 'Status' },
  },
  {
    id: 'date4',
    type: 'date',
    text: '2026-05-01',
    value: '{"date":"2026-05-01","time":null}',
    column: { title: 'Due date' },
  },
];

export const sampleItem = {
  id: '12345',
  name: 'Refactor login',
  state: 'active',
  url: 'https://example.monday.com/items/12345',
  created_at: '2026-04-29T10:00:00Z',
  updated_at: '2026-04-29T11:00:00Z',
  board: { id: '111' },
  group: { id: 'topics', title: 'Topics' },
  parent_item: null,
  column_values: sampleColumnValues,
};

export const sampleBoardMetadata = {
  id: '111',
  name: 'Tasks',
  description: null,
  state: 'active',
  board_kind: 'public',
  board_folder_id: null,
  workspace_id: '5',
  url: null,
  hierarchy_type: null,
  is_leaf: true,
  updated_at: null,
  groups: [],
  columns: [
    {
      id: 'status_4',
      title: 'Status',
      type: 'status',
      description: null,
      archived: null,
      settings_str: '{}',
      width: null,
    },
    {
      id: 'date4',
      title: 'Due date',
      type: 'date',
      description: null,
      archived: null,
      settings_str: null,
      width: null,
    },
  ],
};

export const boardMetadataInteraction = {
  operation_name: 'BoardMetadata',
  response: { data: { boards: [sampleBoardMetadata] } },
};

export const item = (id: string, name = `Item ${id}`): typeof sampleItem => ({
  ...sampleItem,
  id,
  name,
  // Item.board.id must match the board the test is querying so the
  // projector emits the right board_id.
  board: { id: '111' },
});

export interface ItemTestEnv {
  readonly drive: (
    argv: readonly string[],
    cassette: Cassette,
    overrides?: Partial<RunOptions>,
  ) => Promise<DriveResult>;
  /**
   * Accessor for the per-test `XDG_CACHE_HOME` root. Tests that need
   * to compose extra env vars (e.g. `MONDAY_TIMEZONE`) replace the
   * whole `env` override and read this getter to keep the cache root
   * pointed at the right tmp dir. Mirrors the pre-R14 module-level
   * `let xdgRoot: string` access pattern.
   */
  readonly xdgRoot: () => string;
}

/**
 * Registers per-test setup/teardown for an isolated `XDG_CACHE_HOME`
 * and returns a `drive(argv, cassette, overrides?)` bound to that
 * root. Mirrors the inline `xdgRoot` + `drive` shape the monolithic
 * `item.test.ts` shipped pre-R14 — each per-verb file calls this
 * once at module top-level.
 */
export const useItemTestEnv = (): ItemTestEnv => {
  let xdgRoot: string;
  beforeEach(async () => {
    xdgRoot = await mkdtemp(join(tmpdir(), 'monday-cli-item-int-'));
  });
  afterEach(async () => {
    await rm(xdgRoot, { recursive: true, force: true });
  });
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
  return { drive, xdgRoot: () => xdgRoot };
};
