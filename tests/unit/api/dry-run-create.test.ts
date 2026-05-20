/**
 * Unit tests for `planCreate` (M9 dry-run engine sibling to
 * `planChanges`). Covers paths the integration suite can't reach:
 *
 *   - No-set short-circuit (`source: 'none'`, no API calls).
 *   - Direct invocation without `env` / `noCache` so the spread
 *     defaults exercise (the command layer always passes these,
 *     so integration tests don't reach the `=== undefined` branch).
 *
 * Branch-coverage focused — happy-path bundling + planned-change
 * shapes are pinned by the integration suite + envelope snapshots.
 */
import { describe, expect, it, vi } from 'vitest';
import { planCreate } from '../../../src/api/dry-run.js';
import type { MondayClient } from '../../../src/api/client.js';

const fakeClient = (): MondayClient =>
  ({
    raw: vi.fn(),
    whoami: vi.fn(),
  }) as unknown as MondayClient;

describe('planCreate — no-set short-circuit', () => {
  it('top-level item, no --set / --set-raw → source: none, empty diff/resolved_ids, no API calls', async () => {
    const client = fakeClient();
    const result = await planCreate({
      client,
      mode: { kind: 'item', boardId: '111' },
      name: 'Test',
      setEntries: [],
    });
    expect(result.source).toBe('none');
    expect(result.cacheAgeSeconds).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.plannedChanges).toHaveLength(1);
    const plan = result.plannedChanges[0]!;
    expect(plan).toEqual({
      operation: 'create_item',
      board_id: '111',
      name: 'Test',
      resolved_ids: {},
      diff: {},
    });
    // No client.raw or whoami calls because no resolution fired.
    expect((client.raw as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it('subitem, no --set → source: none, omits board_id, hoists parent_item_id', async () => {
    const client = fakeClient();
    const result = await planCreate({
      client,
      mode: { kind: 'subitem', parentItemId: '12345', subitemsBoardId: '333' },
      name: 'Subtask',
      setEntries: [],
    });
    expect(result.source).toBe('none');
    const plan = result.plannedChanges[0]!;
    expect(plan).toEqual({
      operation: 'create_subitem',
      parent_item_id: '12345',
      name: 'Subtask',
      resolved_ids: {},
      diff: {},
    });
    expect(plan).not.toHaveProperty('board_id');
  });

  it('item with --group + --position omitted from no-set planned change correctly', async () => {
    // No --set means no resolution fires; the non-set inputs (group,
    // position) still populate the planned change's hoisted slots.
    const client = fakeClient();
    const result = await planCreate({
      client,
      mode: {
        kind: 'item',
        boardId: '111',
        groupId: 'topics',
        position: { method: 'before', relativeTo: '99999' },
      },
      name: 'Test',
      setEntries: [],
    });
    const plan = result.plannedChanges[0]!;
    expect(plan).toMatchObject({
      operation: 'create_item',
      group_id: 'topics',
      position: { method: 'before', relative_to: '99999' },
    });
  });
});

describe('planCreate — tags translator dry-run echo (M19)', () => {
  it('emits details.resolved_from for tags inputs in buildCreateDiffCell', async () => {
    // Covers the buildCreateDiffCell `tagResolution !== null` branch
    // (`from: null`, `to: { tag_ids: [...] }`, `details.resolved_from
    // .tokens` per cli-design §5.3 design Q5). Mirrors the planChanges
    // tags echo test in dry-run.test.ts.
    const tagsBoard: { boards: unknown[] } = {
      boards: [
        {
          id: '111',
          name: 'Sprint',
          description: null,
          state: 'active',
          board_kind: 'public',
          board_folder_id: null,
          workspace_id: null,
          url: null,
          hierarchy_type: 'top_level',
          updated_at: null,
          groups: [],
          columns: [
            {
              id: 'tags_1',
              title: 'Tags',
              type: 'tags',
              description: null,
              archived: false,
              settings_str: null,
              width: null,
            },
          ],
        },
      ],
    };
    const client = {
      raw: vi.fn().mockResolvedValue({
        data: tagsBoard,
        complexity: null,
        stats: { attempts: 1, totalSleepMs: 0 },
      }),
    } as unknown as MondayClient;
    const result = await planCreate({
      client,
      mode: { kind: 'item', boardId: '111' },
      name: 'Launch task',
      setEntries: [{ token: 'tags_1', value: 'launch,priority' }],
      tagResolution: {
        resolveTags: () =>
          Promise.resolve({
            ids: [101, 202],
            misses: [],
            source: 'live',
            cacheAgeSeconds: null,
          }),
      },
    });
    const plan = result.plannedChanges[0]!;
    expect(plan.diff.tags_1).toEqual({
      from: null,
      to: { tag_ids: [101, 202] },
      details: {
        resolved_from: {
          tokens: [
            { input: 'launch', resolved_id: '101' },
            { input: 'priority', resolved_id: '202' },
          ],
        },
      },
    });
  });
});

describe('planCreate — board_relation translator dry-run echo (M19 Commit 3)', () => {
  it('emits details.resolved_from for board_relation inputs in buildCreateDiffCell', async () => {
    // Covers the buildCreateDiffCell `relationResolution !== null`
    // branch (`from: null`, `to: { item_ids: [...] }`,
    // `details.resolved_from: {context, allowed_boards, items}` per
    // cli-design §5.3 design Q5). Mirrors the planChanges board_
    // relation echo path through item-set.test.ts integration.
    const relationBoard: { boards: unknown[] } = {
      boards: [
        {
          id: '111',
          name: 'Sprint',
          description: null,
          state: 'active',
          board_kind: 'public',
          board_folder_id: null,
          workspace_id: null,
          url: null,
          hierarchy_type: 'top_level',
          updated_at: null,
          groups: [],
          columns: [
            {
              id: 'rel_1',
              title: 'Linked Items',
              type: 'board_relation',
              description: null,
              archived: false,
              settings_str: JSON.stringify({ boardIds: [222] }),
              width: null,
            },
          ],
        },
      ],
    };
    const client = {
      raw: vi.fn().mockResolvedValue({
        data: relationBoard,
        complexity: null,
        stats: { attempts: 1, totalSleepMs: 0 },
      }),
    } as unknown as MondayClient;
    const result = await planCreate({
      client,
      mode: { kind: 'item', boardId: '111' },
      name: 'Launch task',
      setEntries: [{ token: 'rel_1', value: '12345,67890' }],
      relationResolution: {
        validateItems: () =>
          Promise.resolve({
            ok: true,
            items: [
              { itemId: 12345, boardId: 222 },
              { itemId: 67890, boardId: 222 },
            ],
          }),
      },
    });
    const plan = result.plannedChanges[0]!;
    expect(plan.diff.rel_1).toEqual({
      from: null,
      to: { item_ids: [12345, 67890] },
      details: {
        resolved_from: {
          context: 'board_relation',
          allowed_boards: [222],
          items: [
            { input: '12345', resolved_board_id: '222' },
            { input: '67890', resolved_board_id: '222' },
          ],
        },
      },
    });
  });
});
