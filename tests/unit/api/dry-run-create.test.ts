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
