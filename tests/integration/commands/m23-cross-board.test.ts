/**
 * Integration tests for the v0.3-M23 cross-board `monday item search`
 * action (cli-design §13 v0.3 entry; v0.3-plan §3 M23).
 *
 * Two test surfaces here:
 *
 *   1. **Parse-boundary tests** — `--max-boards` cap enforcement +
 *      scoping-lever mutual exclusion. Don't need a transport (the
 *      cap rejection fires before any network call).
 *   2. **Cassette-backed action tests** — drive the runtime cross-
 *      board action with fixture transports for each scoping lever
 *      (`--workspace` / `--favorites` / all-accessible) + the
 *      stable warning codes (inaccessible_boards,
 *      column_not_found_on_board, cross_board_truncated).
 *
 * The v0.1 single-board path is covered separately by
 * `tests/integration/commands/item-search.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../../src/cli/run.js';
import { baseOptions, parseEnvelope, LEAK_CANARY } from '../helpers.js';
import {
  createFixtureTransport,
  type Cassette,
} from '../../fixtures/load.js';
import { HARD_CAP_MAX_BOARDS } from '../../../src/api/cross-board-search.js';

let xdgRoot: string;
beforeEach(async () => {
  xdgRoot = await mkdtemp(join(tmpdir(), 'monday-cli-m23-int-'));
});
afterEach(async () => {
  await rm(xdgRoot, { recursive: true, force: true });
});

const driveNoTransport = async (
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    isTTY: false,
  });
  const result = await run(options);
  return {
    exitCode: result.exitCode,
    stdout: captured.stdout(),
    stderr: captured.stderr(),
  };
};

/**
 * Per-test cassette driver. The `xdgRoot` `mkdtemp` per-test
 * isolates the board-metadata cache layer (each test runs against
 * an empty cache directory; cassette interactions exercise the
 * live-fetch path as written).
 */
const driveM23 = async (
  argv: readonly string[],
  cassette: Cassette,
  overrides: Partial<RunOptions> = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  requests: number;
}> => {
  const transport = createFixtureTransport(cassette);
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    transport,
    env: {
      MONDAY_API_TOKEN: LEAK_CANARY,
      MONDAY_API_URL: 'https://api.monday.com/v2',
      XDG_CACHE_HOME: xdgRoot,
    },
    ...overrides,
  });
  const result = await run(options);
  return {
    exitCode: result.exitCode,
    stdout: captured.stdout(),
    stderr: captured.stderr(),
    requests: transport.requests.length,
  };
};

const wireBoard = (
  id: string,
  name: string,
  items: readonly {
    id: string;
    name: string;
    state?: string | null;
    column_values?: readonly { id: string; text: string | null }[];
  }[],
  cursor: string | null = null,
): {
  id: string;
  name: string;
  items_page: {
    cursor: string | null;
    items: readonly Record<string, unknown>[];
  };
} => ({
  id,
  name,
  items_page: {
    cursor,
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      state: i.state ?? null,
      column_values: i.column_values ?? [],
    })),
  },
});

const boardMetadataResponse = (
  id: string,
  name: string,
  columns: readonly { id: string; title: string; type: string }[],
): Record<string, unknown> => ({
  boards: [
    {
      id,
      name,
      description: null,
      state: 'active',
      board_kind: 'public',
      board_folder_id: null,
      workspace_id: null,
      url: null,
      hierarchy_type: null,
      is_leaf: null,
      items_count: 0,
      permissions: null,
      updated_at: null,
      groups: [],
      columns: columns.map((c) => ({
        id: c.id,
        title: c.title,
        type: c.type,
        description: null,
        archived: false,
        settings_str: null,
        width: null,
      })),
    },
  ],
});

describe('monday item search cross-board — --workspace happy path', () => {
  it('enumerates workspace boards, runs per-board column resolution + fan-out walker', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CrossBoardEnumerate',
          match_variables: { workspaceIds: ['999'] },
          response: {
            data: {
              boards: [
                { id: '100', name: 'Tasks' },
                { id: '200', name: 'Sprint' },
              ],
            },
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['100'] },
          response: {
            data: boardMetadataResponse('100', 'Tasks', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['200'] },
          response: {
            data: boardMetadataResponse('200', 'Sprint', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '100' },
          response: {
            data: {
              boards: [
                wireBoard('100', 'Tasks', [
                  {
                    id: 'i1',
                    name: 'Task 1',
                    state: 'active',
                    column_values: [{ id: 'status', text: 'Done' }],
                  },
                ]),
              ],
            },
          },
        },
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '200' },
          response: {
            data: {
              boards: [
                wireBoard('200', 'Sprint', [
                  {
                    id: 'i2',
                    name: 'Task 2',
                    state: 'active',
                    column_values: [{ id: 'status', text: 'Done' }],
                  },
                ]),
              ],
            },
          },
        },
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--workspace',
        '999',
        '--where',
        'status=Done',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success envelope');
    const data = envelope.data as readonly {
      id: string;
      board: { id: string; name: string };
    }[];
    expect(data.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(data[0]?.board).toEqual({ id: '100', name: 'Tasks' });
    expect(data[1]?.board).toEqual({ id: '200', name: 'Sprint' });
    expect(envelope.meta.source).toBe('live');
    expect(envelope.warnings ?? []).toEqual([]);
  });
});

describe('monday item search cross-board — --favorites happy path', () => {
  it('resolves favorites then fans out across the favorited boards', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: {
            data: {
              favorites: [
                { id: 'h1', object: { id: '100', type: 'Board' }, position: 1 },
              ],
            },
          },
        },
        {
          operation_name: 'BoardFavoritesStage2',
          response: {
            data: {
              boards: [
                {
                  id: '100',
                  name: 'Tasks',
                  state: 'active',
                  workspace_id: null,
                  url: null,
                },
              ],
            },
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['100'] },
          response: {
            data: boardMetadataResponse('100', 'Tasks', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '100' },
          response: {
            data: {
              boards: [
                wireBoard('100', 'Tasks', [
                  {
                    id: 'i1',
                    name: 'Task 1',
                    state: 'active',
                    column_values: [{ id: 'status', text: 'Done' }],
                  },
                ]),
              ],
            },
          },
        },
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--favorites',
        '--where',
        'status=Done',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    if (!envelope.ok) throw new Error('expected success envelope');
    const data = envelope.data as readonly { id: string }[];
    expect(data.map((i) => i.id)).toEqual(['i1']);
  });

  it('short-circuits with empty data when --favorites has no Board entries', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: { data: { favorites: [] } },
        },
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--favorites',
        '--where',
        'status=Done',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    if (!envelope.ok) throw new Error('expected success envelope');
    expect(envelope.data).toEqual([]);
  });
});

describe('monday item search cross-board — inaccessible boards', () => {
  it('surfaces inaccessible_boards when one board is silently omitted at the walker', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CrossBoardEnumerate',
          match_variables: { workspaceIds: ['999'] },
          response: {
            data: {
              boards: [
                { id: '100', name: 'Tasks' },
                { id: '200', name: 'Sprint' },
              ],
            },
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['100'] },
          response: {
            data: boardMetadataResponse('100', 'Tasks', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['200'] },
          response: {
            data: boardMetadataResponse('200', 'Sprint', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '100' },
          response: {
            data: {
              boards: [
                wireBoard('100', 'Tasks', [
                  {
                    id: 'i1',
                    name: 'Task 1',
                    state: 'active',
                    column_values: [],
                  },
                ]),
              ],
            },
          },
        },
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '200' },
          response: { data: { boards: [] } },
        },
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--workspace',
        '999',
        '--where',
        'status=Done',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    if (!envelope.ok) throw new Error('expected success envelope');
    const data = envelope.data as readonly { id: string }[];
    expect(data.map((i) => i.id)).toEqual(['i1']);
    const warnings = envelope.warnings as readonly {
      code: string;
      details: { missing_board_ids: readonly string[] };
    }[];
    const inaccessible = warnings.find((w) => w.code === 'inaccessible_boards');
    expect(inaccessible).toBeDefined();
    expect(inaccessible?.details.missing_board_ids).toEqual(['200']);
  });
});

describe('monday item search cross-board — column_not_found_on_board', () => {
  it('surfaces column_not_found_on_board warning + skips the board in the fan-out', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CrossBoardEnumerate',
          match_variables: { workspaceIds: ['999'] },
          response: {
            data: {
              boards: [
                { id: '100', name: 'Tasks' },
                { id: '200', name: 'NoStatusBoard' },
              ],
            },
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['100'] },
          response: {
            data: boardMetadataResponse('100', 'Tasks', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['200'] },
          // Board 200 has NO `status` column.
          response: {
            data: boardMetadataResponse('200', 'NoStatusBoard', [
              { id: 'name', title: 'Name', type: 'name' },
            ]),
          },
        },
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '100' },
          response: {
            data: {
              boards: [
                wireBoard('100', 'Tasks', [
                  {
                    id: 'i1',
                    name: 'Task 1',
                    state: 'active',
                    column_values: [{ id: 'status', text: 'Done' }],
                  },
                ]),
              ],
            },
          },
        },
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--workspace',
        '999',
        '--where',
        'status=Done',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    if (!envelope.ok) throw new Error('expected success envelope');
    const data = envelope.data as readonly { id: string }[];
    expect(data.map((i) => i.id)).toEqual(['i1']);
    const warnings = envelope.warnings as readonly {
      code: string;
      details: { board_id?: string; column?: string };
    }[];
    const notFound = warnings.find(
      (w) => w.code === 'column_not_found_on_board',
    );
    expect(notFound).toBeDefined();
    expect(notFound?.details.board_id).toBe('200');
    expect(notFound?.details.column).toBe('status');
  });
});

describe('monday item search cross-board — all-accessible mode (no scoping lever)', () => {
  it('enumerates all-accessible boards when neither --workspace nor --favorites is set', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CrossBoardEnumerate',
          // No workspace_ids variable → boards(limit:) only.
          response: {
            data: {
              boards: [{ id: '100', name: 'Tasks' }],
            },
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['100'] },
          response: {
            data: boardMetadataResponse('100', 'Tasks', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '100' },
          response: {
            data: {
              boards: [
                wireBoard('100', 'Tasks', [
                  {
                    id: 'i1',
                    name: 'Task 1',
                    state: 'active',
                    column_values: [{ id: 'status', text: 'Done' }],
                  },
                ]),
              ],
            },
          },
        },
      ],
    };
    const result = await driveM23(
      ['item', 'search', '--where', 'status=Done', '--json'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    if (!envelope.ok) throw new Error('expected success envelope');
    const data = envelope.data as readonly { id: string }[];
    expect(data.map((i) => i.id)).toEqual(['i1']);
  });
});

describe('monday item search cross-board — empty plans path', () => {
  it('emits empty data + column_not_found_on_board warnings when no board has the column', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CrossBoardEnumerate',
          match_variables: { workspaceIds: ['999'] },
          response: {
            data: {
              boards: [{ id: '100', name: 'NoStatusBoard' }],
            },
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['100'] },
          response: {
            data: boardMetadataResponse('100', 'NoStatusBoard', [
              { id: 'name', title: 'Name', type: 'name' },
            ]),
          },
        },
        // No CrossBoardSearch interaction — the walker shouldn't
        // fire when plans is empty.
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--workspace',
        '999',
        '--where',
        'status=Done',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    expect(result.requests).toBe(2);
    const envelope = parseEnvelope(result.stdout);
    if (!envelope.ok) throw new Error('expected success envelope');
    expect(envelope.data).toEqual([]);
    const warnings = envelope.warnings as readonly {
      code: string;
      details: { board_id?: string };
    }[];
    expect(warnings.find((w) => w.code === 'column_not_found_on_board')).toBeDefined();
  });
});

describe('monday item search cross-board — NDJSON streaming', () => {
  it('streams items per-arrival + writes the §6.3 trailer', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CrossBoardEnumerate',
          match_variables: { workspaceIds: ['999'] },
          response: {
            data: {
              boards: [{ id: '100', name: 'Tasks' }],
            },
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['100'] },
          response: {
            data: boardMetadataResponse('100', 'Tasks', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '100' },
          response: {
            data: {
              boards: [
                wireBoard('100', 'Tasks', [
                  {
                    id: 'i1',
                    name: 'Task 1',
                    state: 'active',
                    column_values: [{ id: 'status', text: 'Done' }],
                  },
                  {
                    id: 'i2',
                    name: 'Task 2',
                    state: 'active',
                    column_values: [{ id: 'status', text: 'Done' }],
                  },
                ]),
              ],
            },
          },
        },
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--workspace',
        '999',
        '--where',
        'status=Done',
        '--output',
        'ndjson',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    // 2 items + 1 trailer = 3 NDJSON lines.
    expect(lines).toHaveLength(3);
    const item1 = JSON.parse(lines[0]!) as { id: string };
    const item2 = JSON.parse(lines[1]!) as { id: string };
    expect(item1.id).toBe('i1');
    expect(item2.id).toBe('i2');
    const trailer = JSON.parse(lines[2]!) as {
      _meta: { source: string; total_returned: number; has_more: boolean };
    };
    expect(trailer._meta.source).toBe('live');
    expect(trailer._meta.total_returned).toBe(2);
    expect(trailer._meta.has_more).toBe(false);
  });
});

describe('monday item search cross-board — cross_board_truncated', () => {
  it('surfaces cross_board_truncated.limit_hit when --limit short-circuits the fan-out', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CrossBoardEnumerate',
          response: {
            data: {
              boards: [
                { id: '100', name: 'A' },
                { id: '200', name: 'B' },
              ],
            },
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['100'] },
          response: {
            data: boardMetadataResponse('100', 'A', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['200'] },
          response: {
            data: boardMetadataResponse('200', 'B', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '100' },
          response: {
            data: {
              boards: [
                wireBoard(
                  '100',
                  'A',
                  [
                    { id: 'a1', name: 'a1', column_values: [] },
                    { id: 'a2', name: 'a2', column_values: [] },
                    { id: 'a3', name: 'a3', column_values: [] },
                  ],
                  'cursor-100',
                ),
              ],
            },
          },
        },
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--workspace',
        '999',
        '--where',
        'status=Done',
        '--limit',
        '2',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    if (!envelope.ok) throw new Error('expected success envelope');
    const data = envelope.data as readonly { id: string }[];
    expect(data).toHaveLength(2);
    const warnings = envelope.warnings as readonly {
      code: string;
      details: {
        reason?: string;
        per_board_state?: Record<string, string>;
      };
    }[];
    const truncated = warnings.find((w) => w.code === 'cross_board_truncated');
    expect(truncated).toBeDefined();
    expect(truncated?.details.reason).toBe('limit_hit');
    expect(truncated?.details.per_board_state).toEqual({
      '100': 'has_more',
      '200': 'not_started',
    });
    expect(envelope.meta.has_more).toBe(true);
  });
});

describe('monday item search --max-boards validation', () => {
  it('--max-boards above hard cap surfaces usage_error on the cross-board path', async () => {
    const { exitCode, stderr } = await driveNoTransport([
      'item',
      'search',
      '--favorites',
      '--max-boards',
      String(HARD_CAP_MAX_BOARDS + 1),
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
    expect(envelope.error.message).toMatch(
      /hard cap|wall-clock|--workspace|--favorites/,
    );
  });

  it('--max-boards = 0 rejected at the parse boundary', async () => {
    const { exitCode } = await driveNoTransport([
      'item',
      'search',
      '--favorites',
      '--max-boards',
      '0',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
  });

  it('--max-boards > hard cap accepted on the single-board path (Codex P2-2: flag ignored)', async () => {
    // The schema-level cap enforcement is CONDITIONAL — only the
    // cross-board path (--board absent) rejects above-cap values.
    // The single-board v0.1 path still runs; its runtime fails at
    // the network boundary (no fixture transport). exitCode != 1
    // confirms the parse layer accepted the call.
    const { exitCode } = await driveNoTransport([
      'item',
      'search',
      '--board',
      '111',
      '--max-boards',
      String(HARD_CAP_MAX_BOARDS + 100),
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).not.toBe(1);
  });
});

describe('monday item search scoping-lever mutual exclusion', () => {
  it('--board + --workspace surfaces usage_error', async () => {
    const { exitCode, stderr } = await driveNoTransport([
      'item',
      'search',
      '--board',
      '111',
      '--workspace',
      '999',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
    expect(envelope.error.message).toMatch(
      /at most one of --board.*--workspace.*--favorites/,
    );
  });

  it('--board + --favorites surfaces usage_error', async () => {
    const { exitCode, stderr } = await driveNoTransport([
      'item',
      'search',
      '--board',
      '111',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
  });

  it('--workspace + --favorites surfaces usage_error', async () => {
    const { exitCode, stderr } = await driveNoTransport([
      'item',
      'search',
      '--workspace',
      '999',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
  });

  it('all three scoping levers surfaces usage_error', async () => {
    const { exitCode, stderr } = await driveNoTransport([
      'item',
      'search',
      '--board',
      '111',
      '--workspace',
      '999',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
    expect(envelope.error.message).toMatch(/board, workspace, favorites/);
  });

  it('mutual-exclusion issue path is empty (Codex P2-3: error is about the combination)', async () => {
    // The .superRefine guard reports `path: []` on the issue so
    // the error envelope's `details.issues[].path` doesn't point
    // agents at one specific field — the conflict is about the
    // combination of scoping levers, not one of them.
    const { stderr } = await driveNoTransport([
      'item',
      'search',
      '--workspace',
      '999',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    const details = envelope.error.details as {
      issues: readonly { path: string; message: string }[];
    };
    const conflictIssue = details.issues.find((i) =>
      i.message.includes('at most one of --board'),
    );
    expect(conflictIssue).toBeDefined();
    expect(conflictIssue?.path).toBe('');
  });

  it('mutual-exclusion issue carries conflicting_flags in params (Codex round-2 P2-3)', async () => {
    const { stderr } = await driveNoTransport([
      'item',
      'search',
      '--workspace',
      '999',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    const details = envelope.error.details as {
      issues: readonly {
        path: string;
        message: string;
        params?: { conflicting_flags?: readonly string[] };
      }[];
    };
    const conflictIssue = details.issues.find((i) =>
      i.message.includes('at most one of --board'),
    );
    expect(conflictIssue).toBeDefined();
    expect(conflictIssue?.params?.conflicting_flags).toEqual([
      'workspace',
      'favorites',
    ]);
  });
});

describe('monday item search cross-board — buildPerBoardPlan branch coverage', () => {
  // The cross-board `=`-only operator restriction (item/search.ts
  // line 502). v0.1's single-board path applies the same rule;
  // cross-board re-asserts it inside buildPerBoardPlan per board
  // since the action threads clauses through unchanged.
  it('non-equals operator surfaces usage_error from the per-board plan walker', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CrossBoardEnumerate',
          match_variables: { workspaceIds: ['999'] },
          response: {
            data: { boards: [{ id: '100', name: 'Tasks' }] },
          },
        },
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--workspace',
        '999',
        '--where',
        'status~=Done',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(1);
    const envelope = parseEnvelope(result.stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
    expect(envelope.error.message).toMatch(/supports only the = operator/);
  });

  // me-resolution lazy cache (item/search.ts lines 546-549, 569).
  // The cross-board path memoises whoami per build call so multiple
  // `me` clauses across many boards only fire one whoami round-trip.
  it('--where Owner=me resolves through Whoami once and threads the resolved ID per board', async () => {
    const peopleColumn = { id: 'owner', title: 'Owner', type: 'people' };
    const whoamiResponse = {
      operation_name: 'Whoami' as const,
      response: {
        data: {
          me: {
            id: '777',
            name: 'Alice',
            email: 'alice@example.test',
            account: { id: '99', name: 'Org', slug: 'org' },
          },
        },
      },
    };
    const cassette: Cassette = {
      // Wire order: CrossBoardEnumerate → for-each board
      // (BoardMetadata → Whoami; cachedMe is scoped to one
      // buildPerBoardPlan call so each board re-fires whoami) →
      // for-each plan (CrossBoardSearch).
      interactions: [
        {
          operation_name: 'CrossBoardEnumerate',
          match_variables: { workspaceIds: ['999'] },
          response: {
            data: {
              boards: [
                { id: '100', name: 'Tasks' },
                { id: '200', name: 'Sprint' },
              ],
            },
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['100'] },
          response: {
            data: boardMetadataResponse('100', 'Tasks', [peopleColumn]),
          },
        },
        whoamiResponse,
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['200'] },
          response: {
            data: boardMetadataResponse('200', 'Sprint', [peopleColumn]),
          },
        },
        whoamiResponse,
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '100' },
          response: {
            data: {
              boards: [
                wireBoard('100', 'Tasks', [
                  {
                    id: 'i1',
                    name: 'Mine on 100',
                    state: 'active',
                    column_values: [{ id: 'owner', text: '777' }],
                  },
                ]),
              ],
            },
          },
        },
        {
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '200' },
          response: {
            data: {
              boards: [
                wireBoard('200', 'Sprint', [
                  {
                    id: 'i2',
                    name: 'Mine on 200',
                    state: 'active',
                    column_values: [{ id: 'owner', text: '777' }],
                  },
                ]),
              ],
            },
          },
        },
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--workspace',
        '999',
        '--where',
        'Owner=me',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    if (!envelope.ok) throw new Error('expected success envelope');
    const data = envelope.data as readonly { id: string }[];
    expect(data.map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  // Same-column-twice clause grouping (item/search.ts line 575).
  // Cross-board path collapses `--where status=Done --where status=Backlog`
  // into one `compare_values: [Done, Backlog]` per-board rule
  // (any_of semantics), same as v0.1's single-board path.
  it('two --where clauses on the same column collapse into compare_values: [a, b] per-board', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CrossBoardEnumerate',
          match_variables: { workspaceIds: ['999'] },
          response: {
            data: { boards: [{ id: '100', name: 'Tasks' }] },
          },
        },
        {
          operation_name: 'BoardMetadata',
          match_variables: { ids: ['100'] },
          response: {
            data: boardMetadataResponse('100', 'Tasks', [
              { id: 'status', title: 'Status', type: 'status' },
            ]),
          },
        },
        {
          // Match only on boardId — the wire variables include the
          // collapsed rules (`{column_id: 'status', compare_values:
          // ['Done','Backlog']}`) plus pagination + state filters
          // the fixture doesn't model. The data assertion below
          // pins the agent-facing contract (both items returned).
          operation_name: 'CrossBoardSearch',
          match_variables: { boardId: '100' },
          response: {
            data: {
              boards: [
                wireBoard('100', 'Tasks', [
                  {
                    id: 'i1',
                    name: 'Done item',
                    state: 'active',
                    column_values: [{ id: 'status', text: 'Done' }],
                  },
                  {
                    id: 'i2',
                    name: 'Backlog item',
                    state: 'active',
                    column_values: [{ id: 'status', text: 'Backlog' }],
                  },
                ]),
              ],
            },
          },
        },
      ],
    };
    const result = await driveM23(
      [
        'item',
        'search',
        '--workspace',
        '999',
        '--where',
        'status=Done',
        '--where',
        'status=Backlog',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    if (!envelope.ok) throw new Error('expected success envelope');
    const data = envelope.data as readonly { id: string }[];
    expect(data.map((i) => i.id)).toEqual(['i1', 'i2']);
  });
});
