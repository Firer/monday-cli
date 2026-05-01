/**
 * Unit tests for the dry-run engine (`src/api/dry-run.ts`).
 *
 * Two layers:
 *   - Per-branch unit coverage for resolution / translation /
 *     diff-cell assembly across each writable column type.
 *   - **Snapshot test against the cli-design.md §6.4 sample
 *     byte-for-byte**, the load-bearing M5a exit gate. If the
 *     engine's output diverges from the documented sample even by
 *     trailing whitespace, that's a contract drift — fix the
 *     engine, not the snapshot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planChanges,
  type PlanChangesResult,
} from '../../../src/api/dry-run.js';
import type { MondayClient, MondayResponse } from '../../../src/api/client.js';
import { ApiError } from '../../../src/utils/errors.js';

let tmpRoot: string;
const xdgEnv = (): NodeJS.ProcessEnv => ({ XDG_CACHE_HOME: tmpRoot });

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-dryrun-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

interface Stats {
  calls: number;
  operations: string[];
}

const buildClient = (
  responses: readonly unknown[],
  stats: Stats,
): MondayClient => {
  let cursor = 0;
  const fake = {
    raw: <T>(
      _query: string,
      _vars: unknown,
      opts?: { operationName?: string },
    ): Promise<MondayResponse<T>> => {
      stats.calls++;
      stats.operations.push(opts?.operationName ?? '<unknown>');
      const next = responses[cursor];
      cursor = Math.min(cursor + 1, responses.length - 1);
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve({
        data: next as T,
        complexity: null,
        stats: { attempts: 1, totalSleepMs: 0 },
      });
    },
  };
  return fake as unknown as MondayClient;
};

const board67890 = (): { boards: unknown[] } => ({
  boards: [
    {
      id: '67890',
      name: 'Sprint',
      description: null,
      state: 'active',
      board_kind: 'public',
      board_folder_id: null,
      workspace_id: null,
      url: null,
      hierarchy_type: 'top_level',
      is_leaf: true,
      updated_at: null,
      groups: [],
      columns: [
        {
          id: 'status_4',
          title: 'Status',
          type: 'status',
          description: null,
          archived: false,
          settings_str: null,
          width: null,
        },
        {
          id: 'date4',
          title: 'Due',
          type: 'date',
          description: null,
          archived: false,
          settings_str: null,
          width: null,
        },
        {
          id: 'owner_4',
          title: 'Owner',
          type: 'people',
          description: null,
          archived: false,
          settings_str: null,
          width: null,
        },
        {
          id: 'notes',
          title: 'Notes',
          type: 'text',
          description: null,
          archived: false,
          settings_str: null,
          width: null,
        },
        {
          id: 'mirror_1',
          title: 'Mirrored',
          type: 'mirror',
          description: null,
          archived: false,
          settings_str: null,
          width: null,
        },
        {
          id: 'description',
          title: 'Description',
          type: 'long_text',
          description: null,
          archived: false,
          settings_str: null,
          width: null,
        },
      ],
    },
  ],
});

const itemAtBacklog = (over: { columnValues?: unknown[] } = {}): { items: unknown[] } => ({
  items: [
    {
      id: '12345',
      name: 'Build it',
      state: 'active',
      url: null,
      created_at: null,
      updated_at: null,
      board: { id: '67890' },
      group: null,
      parent_item: null,
      column_values: over.columnValues ?? [
        {
          id: 'status_4',
          type: 'status',
          text: 'Backlog',
          value: '{"label":"Backlog","index":0}',
          column: { title: 'Status' },
        },
        {
          id: 'date4',
          type: 'date',
          text: '',
          value: null,
          column: { title: 'Due' },
        },
      ],
    },
  ],
});

describe('planChanges — happy path: status + date relative-token', () => {
  it('produces the §6.4 sample shape byte-compatible', async () => {
    // The cli-design §6.4 sample is the canonical contract. We
    // build an input that should produce the *same* planned_change
    // entry the sample shows (single-item status + date update),
    // then assert via deep-equal against the literal §6.4 shape.
    // Drift here = contract drift; fix the engine, not the test.
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [
        { token: 'status', value: 'Working on it' },
        { token: 'due', value: '+1w' },
      ],
      env: xdgEnv(),
      dateResolution: {
        // Pinned 2026-04-25 14:00 Europe/London (BST) so the relative
        // +1w resolves to 2026-05-02. Matches the cli-design sample
        // line 1214 + 786 byte-for-byte.
        now: () => new Date('2026-04-25T14:00:00+01:00'),
        timezone: 'Europe/London',
      },
    });

    expect(result.plannedChanges).toHaveLength(1);
    const change = result.plannedChanges[0]!;
    expect(change).toEqual({
      operation: 'change_multiple_column_values',
      board_id: '67890',
      item_id: '12345',
      resolved_ids: { status: 'status_4', due: 'date4' },
      diff: {
        status_4: {
          from: { label: 'Backlog', index: 0 },
          to: { label: 'Working on it' },
        },
        date4: {
          from: null,
          to: { date: '2026-05-02' },
          details: {
            resolved_from: {
              input: '+1w',
              timezone: 'Europe/London',
              now: '2026-04-25T14:00:00+01:00',
            },
          },
        },
      },
    });
  });

  it('JSON.stringify byte-snapshot pins the engine output literally', async () => {
    // Codex pass-1 finding: my prior version of this test
    // stringified a hand-built `expected` object, not the engine's
    // result — so reordering fields in dry-run.ts would still pass
    // (the deep-equal `toEqual` is order-agnostic). The fix:
    // stringify the actual engine output. If the build order in
    // `PlannedChange` shifts (e.g. someone reorders the spread to
    // emit `resolved_ids` before `item_id`), this assertion fails.
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [
        { token: 'status', value: 'Working on it' },
        { token: 'due', value: '+1w' },
      ],
      env: xdgEnv(),
      dateResolution: {
        now: () => new Date('2026-04-25T14:00:00+01:00'),
        timezone: 'Europe/London',
      },
    });
    expect(JSON.stringify(result.plannedChanges[0])).toBe(
      '{"operation":"change_multiple_column_values","board_id":"67890",' +
        '"item_id":"12345","resolved_ids":{"status":"status_4","due":"date4"},' +
        '"diff":{"status_4":{"from":{"label":"Backlog","index":0},' +
        '"to":{"label":"Working on it"}},"date4":{"from":null,' +
        '"to":{"date":"2026-05-02"},"details":{"resolved_from":' +
        '{"input":"+1w","timezone":"Europe/London","now":"2026-04-25T14:00:00+01:00"}}}}}',
    );
  });
});

describe('planChanges — operation selection per cli-design §5.3 step 5', () => {
  it('single simple type → change_simple_column_value', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'notes', value: 'meeting at 3' }],
      env: xdgEnv(),
    });
    expect(result.plannedChanges[0]?.operation).toBe('change_simple_column_value');
    expect(result.plannedChanges[0]?.diff.notes).toEqual({
      from: null,
      to: 'meeting at 3',
    });
  });

  it('single rich type → change_column_value', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'status', value: 'Done' }],
      env: xdgEnv(),
    });
    expect(result.plannedChanges[0]?.operation).toBe('change_column_value');
    expect(result.plannedChanges[0]?.diff.status_4).toEqual({
      from: { label: 'Backlog', index: 0 },
      to: { label: 'Done' },
    });
  });

  it('multiple --set entries → change_multiple_column_values', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [
        { token: 'status', value: 'Done' },
        { token: 'notes', value: 'shipped' },
      ],
      env: xdgEnv(),
    });
    expect(result.plannedChanges[0]?.operation).toBe(
      'change_multiple_column_values',
    );
  });

  it('long_text in multi: diff `to` reflects the wire re-wrap (Codex pass-1)', async () => {
    // cli-design §5.3 step 5 spec gap: long_text inside
    // change_multiple_column_values uses {text: <value>} per-column
    // blob, NOT the bare string change_simple_column_value
    // accepts. Pre-fix, the dry-run engine emitted `to: <bare string>`
    // for long_text in multi — the diff lied about the wire shape.
    // Post-fix: routing through selectMutation's columnValues map
    // means the diff `to` reflects the same re-wrap the live
    // mutation would apply.
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [
        { token: 'notes', value: 'note text' },
        { token: 'description', value: 'long body\nwith newlines' },
      ],
      env: xdgEnv(),
    });
    expect(result.plannedChanges[0]?.operation).toBe('change_multiple_column_values');
    // text stays as bare string in multi:
    expect(result.plannedChanges[0]?.diff.notes?.to).toBe('note text');
    // long_text gets wrapped to {text: <value>} in multi:
    expect(result.plannedChanges[0]?.diff.description?.to).toEqual({
      text: 'long body\nwith newlines',
    });
  });

  it('long_text in single: diff `to` is the bare string (no re-wrap)', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'description', value: 'short body' }],
      env: xdgEnv(),
    });
    expect(result.plannedChanges[0]?.operation).toBe('change_simple_column_value');
    expect(result.plannedChanges[0]?.diff.description?.to).toBe('short body');
  });
});

describe('planChanges — resolved_from echo per kind', () => {
  it('omits details on non-relative dates and non-people types', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [
        { token: 'status', value: 'Done' },
        { token: 'due', value: '2026-05-01' },
      ],
      env: xdgEnv(),
    });
    expect(result.plannedChanges[0]?.diff.status_4?.details).toBeUndefined();
    expect(result.plannedChanges[0]?.diff.date4?.details).toBeUndefined();
  });

  it('emits details.resolved_from for people inputs (token-by-token)', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'owner', value: 'me,alice@example.com' }],
      env: xdgEnv(),
      peopleResolution: {
        resolveMe: () => Promise.resolve('7'),
        resolveEmail: (email: string) => {
          if (email === 'alice@example.com') return Promise.resolve('42');
          return Promise.reject(new ApiError('user_not_found', `unknown: ${email}`));
        },
      },
    });
    expect(result.plannedChanges[0]?.diff.owner_4).toEqual({
      from: null,
      to: { personsAndTeams: [
        { id: 7, kind: 'person' },
        { id: 42, kind: 'person' },
      ] },
      details: {
        resolved_from: {
          tokens: [
            { input: 'me', resolved_id: '7' },
            { input: 'alice@example.com', resolved_id: '42' },
          ],
        },
      },
    });
  });

  it('emits details.resolved_from for relative date tokens', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'due', value: 'today' }],
      env: xdgEnv(),
      dateResolution: {
        now: () => new Date('2026-04-30T10:00:00+01:00'),
        timezone: 'Europe/London',
      },
    });
    const cell = result.plannedChanges[0]?.diff.date4;
    expect(cell?.to).toEqual({ date: '2026-04-30' });
    expect(cell?.details?.resolved_from).toEqual({
      input: 'today',
      timezone: 'Europe/London',
      now: '2026-04-30T10:00:00+01:00',
    });
  });
});

describe('planChanges — all-or-nothing on resolution failure', () => {
  it('column_not_found: aborts the batch, no second leg', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    // Two responses for two metadata reads (initial + refresh
    // attempt); both stale — neither holds "missing_col". Engine
    // bubbles column_not_found.
    const client = buildClient(
      [board67890(), board67890()],
      stats,
    );
    await expect(
      planChanges({
        client,
        boardId: '67890',
        itemId: '12345',
        setEntries: [{ token: 'missing_col', value: 'x' }],
        env: xdgEnv(),
      }),
    ).rejects.toMatchObject({ code: 'column_not_found' });
    // Item read should not have happened — abort came before item fetch.
    expect(stats.operations).not.toContain('ItemDryRunRead');
  });

  it('ambiguous_column: aborts before item fetch', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient(
      [
        {
          boards: [
            {
              ...board67890().boards[0] as object,
              columns: [
                { id: 'col_a', title: 'Owner', type: 'people', description: null, archived: false, settings_str: null, width: null },
                { id: 'col_b', title: 'Owner', type: 'people', description: null, archived: false, settings_str: null, width: null },
              ],
            },
          ],
        },
      ],
      stats,
    );
    await expect(
      planChanges({
        client,
        boardId: '67890',
        itemId: '12345',
        setEntries: [{ token: 'Owner', value: 'me' }],
        env: xdgEnv(),
        peopleResolution: {
          resolveMe: () => Promise.resolve('7'),
          resolveEmail: () => Promise.reject(new Error('unused')),
        },
      }),
    ).rejects.toMatchObject({ code: 'ambiguous_column' });
    expect(stats.operations).not.toContain('ItemDryRunRead');
  });

  it('unsupported_column_type: surfaces with read-only-forever details (mirror)', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    let caught: unknown;
    try {
      await planChanges({
        client,
        boardId: '67890',
        itemId: '12345',
        setEntries: [{ token: 'mirror_1', value: 'whatever' }],
        env: xdgEnv(),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('unsupported_column_type');
    expect((caught as ApiError).details).toMatchObject({
      column_id: 'mirror_1',
      type: 'mirror',
      // Codex M5b cleanup re-review #1: mirror is on the
      // read-only-forever roadmap row — Monday computes the value
      // server-side and the API never lets you write to it. The
      // error says so explicitly instead of falsely deferring to v0.2.
      read_only: true,
    });
    expect((caught as ApiError).details).not.toHaveProperty('deferred_to');
    expect(stats.operations).not.toContain('ItemDryRunRead');
  });

  it('user_not_found: bubbles from people translator', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    await expect(
      planChanges({
        client,
        boardId: '67890',
        itemId: '12345',
        setEntries: [{ token: 'owner', value: 'ghost@example.com' }],
        env: xdgEnv(),
        peopleResolution: {
          resolveMe: () => Promise.reject(new Error('unused')),
          resolveEmail: () =>
            Promise.reject(
              new ApiError('user_not_found', 'No Monday user matches email "ghost@example.com"', {
                details: { email: 'ghost@example.com' },
              }),
            ),
        },
      }),
    ).rejects.toMatchObject({ code: 'user_not_found' });
    expect(stats.operations).not.toContain('ItemDryRunRead');
  });

  it('column_archived: surfaces typed error before item read (Codex pass-1)', async () => {
    // cli-design §5.3 step 6: "Mutations against archived columns
    // return `column_archived` regardless". Pre-fix, the dry-run
    // engine reused the read-side resolver default that filters
    // archived columns out — producing `column_not_found` for an
    // archived target. Pin the typed code + that the item read
    // doesn't fire.
    const stats: Stats = { calls: 0, operations: [] };
    const archivedBoard = {
      boards: [
        {
          ...board67890().boards[0] as object,
          columns: [
            {
              id: 'status_4',
              title: 'Status',
              type: 'status',
              description: null,
              archived: true,
              settings_str: null,
              width: null,
            },
          ],
        },
      ],
    };
    const client = buildClient([archivedBoard, itemAtBacklog()], stats);
    let caught: unknown;
    try {
      await planChanges({
        client,
        boardId: '67890',
        itemId: '12345',
        setEntries: [{ token: 'status', value: 'Done' }],
        env: xdgEnv(),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('column_archived');
    expect((caught as ApiError).details).toMatchObject({
      column_id: 'status_4',
      column_type: 'status',
      board_id: '67890',
    });
    expect(stats.operations).not.toContain('ItemDryRunRead');
  });

  it('item not found: surfaces after column resolution', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), { items: null }], stats);
    await expect(
      planChanges({
        client,
        boardId: '67890',
        itemId: '99999',
        setEntries: [{ token: 'status', value: 'Done' }],
        env: xdgEnv(),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('item lives on a different board than --board: surfaces usage_error', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const wrongBoardItem = {
      items: [
        {
          ...itemAtBacklog().items[0] as object,
          board: { id: '99999' }, // different from --board=67890
        },
      ],
    };
    const client = buildClient([board67890(), wrongBoardItem], stats);
    await expect(
      planChanges({
        client,
        boardId: '67890',
        itemId: '12345',
        setEntries: [{ token: 'status', value: 'Done' }],
        env: xdgEnv(),
      }),
    ).rejects.toMatchObject({ code: 'usage_error' });
  });
});

describe('planChanges — duplicate tokens / IDs', () => {
  it('two --set entries with the same token: usage_error', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient(
      [board67890(), board67890(), itemAtBacklog()],
      stats,
    );
    await expect(
      planChanges({
        client,
        boardId: '67890',
        itemId: '12345',
        setEntries: [
          { token: 'status', value: 'Done' },
          { token: 'status', value: 'Working on it' },
        ],
        env: xdgEnv(),
      }),
    ).rejects.toMatchObject({ code: 'usage_error' });
  });

  it('two --set entries that resolve to the same column ID: usage_error', async () => {
    // `status` (case-fold title) and `id:status_4` (id prefix) both
    // resolve to status_4. Catch this before assembling a half-built
    // diff.
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient(
      [board67890(), board67890(), itemAtBacklog()],
      stats,
    );
    await expect(
      planChanges({
        client,
        boardId: '67890',
        itemId: '12345',
        setEntries: [
          { token: 'Status', value: 'Done' },
          { token: 'id:status_4', value: 'Working on it' },
        ],
        env: xdgEnv(),
      }),
    ).rejects.toMatchObject({ code: 'usage_error' });
  });
});

describe('planChanges — diff `from` decoding', () => {
  it('text/numbers cells with null value but populated text → from=text', async () => {
    // Monday occasionally returns `value: null` with the human-form
    // `text` populated for simple-type cells (legacy / cross-board
    // boards). decodeFrom prefers text in that case so the diff's
    // `from` reflects the actual cell state.
    const stats: Stats = { calls: 0, operations: [] };
    const itemNumberPopulated = {
      items: [
        {
          ...itemAtBacklog().items[0] as object,
          column_values: [
            { id: 'notes', type: 'text', text: 'existing note', value: null, column: { title: 'Notes' } },
          ],
        },
      ],
    };
    const client = buildClient([board67890(), itemNumberPopulated], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'notes', value: 'updated' }],
      env: xdgEnv(),
    });
    expect(result.plannedChanges[0]?.diff.notes).toEqual({
      from: 'existing note',
      to: 'updated',
    });
  });

  it('text cells with empty-string value but populated text → from=text (Codex pass-2)', async () => {
    // Same branch as the `value: null` case but exercises the
    // `value: ""` (empty-string) arm specifically — Monday returns
    // empty-string `value` for some legacy text columns. Without
    // this branch, the diff would emit `from: null` for a
    // populated cell.
    const stats: Stats = { calls: 0, operations: [] };
    const itemEmptyValueOnly = {
      items: [
        {
          ...itemAtBacklog().items[0] as object,
          column_values: [
            { id: 'notes', type: 'text', text: 'still here', value: '', column: { title: 'Notes' } },
          ],
        },
      ],
    };
    const client = buildClient([board67890(), itemEmptyValueOnly], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'notes', value: 'updated' }],
      env: xdgEnv(),
    });
    expect(result.plannedChanges[0]?.diff.notes?.from).toBe('still here');
  });

  it('completely empty cell → from=null (both value AND text empty)', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const itemEmptyNotes = {
      items: [
        {
          ...itemAtBacklog().items[0] as object,
          column_values: [
            { id: 'notes', type: 'text', text: '', value: null, column: { title: 'Notes' } },
          ],
        },
      ],
    };
    const client = buildClient([board67890(), itemEmptyNotes], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'notes', value: 'updated' }],
      env: xdgEnv(),
    });
    expect(result.plannedChanges[0]?.diff.notes?.from).toBeNull();
  });
});

describe('planChanges — parse-boundary discipline (R17 pattern)', () => {
  it('malformed item response: typed internal_error with details.issues (Codex pass-1)', async () => {
    // validation.md "Never bubble raw ZodError out of a parse
    // boundary" — the dry-run engine's own rawItemSchema.parse
    // boundary needs the same safeParse + ApiError wrap that R17
    // applied to userByEmail. Pre-fix, a malformed Monday response
    // bubbled raw ZodError to the runner's catch-all (which mapped
    // to internal_error but lost details.issues). Pin the typed
    // wrap so an agent debugging a malformed Monday response sees
    // the failing field path.
    const stats: Stats = { calls: 0, operations: [] };
    const malformedItem = {
      items: [
        {
          // Missing required `name` field; rawItemSchema rejects.
          id: '12345',
          state: null,
          url: null,
          created_at: null,
          updated_at: null,
          board: { id: '67890' },
          column_values: [],
        },
      ],
    };
    const client = buildClient([board67890(), malformedItem], stats);
    let caught: unknown;
    try {
      await planChanges({
        client,
        boardId: '67890',
        itemId: '12345',
        setEntries: [{ token: 'status', value: 'Done' }],
        env: xdgEnv(),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiErr = caught as ApiError;
    expect(apiErr.code).toBe('internal_error');
    expect(apiErr.message).toMatch(/malformed item response/u);
    const details = apiErr.details as { issues: readonly { path: string }[] };
    expect(details.issues.length).toBeGreaterThan(0);
    // Codex pass-2 tightening: assert the failing field path so an
    // agent debugging a malformed Monday response sees which field
    // tripped the schema, AND assert the cause is preserved for
    // stack-trace debugging.
    expect(details.issues.some((i) => i.path === 'name')).toBe(true);
    expect(apiErr.cause).toBeDefined();
  });
});

describe('planChanges — defensive guards', () => {
  it('zero --set entries: internal_error (programmer wiring bug)', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([], stats);
    await expect(
      planChanges({
        client,
        boardId: '67890',
        itemId: '12345',
        setEntries: [],
        env: xdgEnv(),
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(stats.calls).toBe(0);
  });
});

describe('planChanges — meta aggregation', () => {
  it('aggregates source as `live` when item read happens (every dry-run is at least partly live in v0.1)', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([board67890(), itemAtBacklog()], stats);
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'status', value: 'Done' }],
      env: xdgEnv(),
    });
    expect(result.source).toBe('live');
    expect(result.cacheAgeSeconds).toBeNull();
  });

  it('returns aggregate as `mixed` when column resolution refreshed and item read live', async () => {
    // First call seeds the metadata cache. Second call: cache hit on
    // the stale metadata, miss on the new column → refresh → resolve.
    // The dry-run engine sees `mixed` from the column leg; folds into
    // aggregate `mixed`.
    const stats: Stats = { calls: 0, operations: [] };
    const stale = board67890();
    const fresh = {
      boards: [
        {
          ...board67890().boards[0] as object,
          columns: [
            ...(board67890().boards[0] as { columns: unknown[] }).columns,
            {
              id: 'priority',
              title: 'Priority',
              type: 'numbers',
              description: null,
              archived: false,
              settings_str: null,
              width: null,
            },
          ],
        },
      ],
    };
    // Sequence: first call reads stale board metadata (1) + item (2);
    // second call hits cache for column (no fetch — same metadata),
    // misses on Priority, refreshes (3) = fresh, resolves; reads
    // item (4).
    const client = buildClient(
      [stale, itemAtBacklog(), fresh, itemAtBacklog()],
      stats,
    );
    // First seed the cache:
    await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'status', value: 'Done' }],
      env: xdgEnv(),
    });
    // Now look up Priority — only in the fresh payload. Engine refreshes.
    const result: PlanChangesResult = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'priority', value: '5' }],
      env: xdgEnv(),
    });
    expect(result.source).toBe('mixed');
    // stale_cache_refreshed warning surfaced:
    expect(result.warnings.some((w) => w.code === 'stale_cache_refreshed')).toBe(true);
  });

  it('mergeCacheAge takes the max across multiple cached column legs (Codex pass-2)', async () => {
    // Two columns resolved from cache → mergeCacheAge picks the
    // older age (worst-case staleness per §6.1). Without this test
    // the Math.max branch was uncovered by the existing suite. We
    // seed the cache with one call, then run a two-column dry-run
    // that hits cache for both columns.
    const stats: Stats = { calls: 0, operations: [] };
    // Sequence: seed (call 1) + item (call 2), then two-column
    // dry-run hits cache (no fetch) + item (call 3).
    const client = buildClient(
      [board67890(), itemAtBacklog(), itemAtBacklog()],
      stats,
    );
    // Seed: one column lookup → cache write.
    await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [{ token: 'status', value: 'Done' }],
      env: xdgEnv(),
    });
    // Now dry-run with two columns; both legs hit the same cached
    // metadata (same on-disk file → same age). mergeCacheAge runs
    // Math.max over (age, age) → returns the same age. Branch
    // covered without needing a per-column distinct age.
    const result = await planChanges({
      client,
      boardId: '67890',
      itemId: '12345',
      setEntries: [
        { token: 'status', value: 'Done' },
        { token: 'notes', value: 'shipped' },
      ],
      env: xdgEnv(),
    });
    // Both column legs hit cache; aggregate source is mixed
    // (cache + live item) and cacheAgeSeconds is non-null.
    expect(result.source).toBe('mixed');
    expect(result.cacheAgeSeconds).not.toBeNull();
    expect(typeof result.cacheAgeSeconds).toBe('number');
  });
});
