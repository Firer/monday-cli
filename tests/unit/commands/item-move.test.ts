/**
 * Unit tests for `src/commands/item/move.ts` `planColumnMappings`
 * helper (M11).
 *
 * The helper is the strict-default + mapping-merge logic at the heart
 * of cross-board `item move`. Integration tests (item-move.test.ts)
 * cover the end-to-end shape; this file isolates the planner so each
 * branch (verbatim match, mapping override, unmatched, empty-mapping
 * opt-in) gets a focused assertion.
 */
import { describe, expect, it } from 'vitest';
import { planColumnMappings } from '../../../src/commands/item/move.js';
import { UsageError } from '../../../src/utils/errors.js';

const sourceCol = (id: string, title = id, type = 'text') => ({
  id,
  title,
  type,
});

describe('planColumnMappings', () => {
  it('passes through verbatim ID matches without a mapping', () => {
    const plan = planColumnMappings({
      sourceColumnIds: ['status_4', 'date4'],
      sourceColumnsById: new Map([
        ['status_4', sourceCol('status_4', 'Status', 'status')],
        ['date4', sourceCol('date4', 'Due', 'date')],
      ]),
      targetColumnIds: new Set(['status_4', 'date4', 'extra']),
      mapping: undefined,
    });
    expect(plan.columnsMapping).toEqual([
      { source: 'status_4', target: 'status_4' },
      { source: 'date4', target: 'date4' },
    ]);
    // Echo matches the wire payload — agents reading the dry-run
    // see the same array Monday will receive.
    expect(plan.echo).toEqual(plan.columnsMapping);
  });

  it('applies an explicit mapping over verbatim ID match', () => {
    // Even when the source ID exists on target, an explicit mapping
    // entry wins. Agents can deliberately rename a same-ID column —
    // e.g., `status_4` on source maps to `archived_status_4` on
    // target where the agent wants the old data isolated.
    const plan = planColumnMappings({
      sourceColumnIds: ['status_4'],
      sourceColumnsById: new Map([
        ['status_4', sourceCol('status_4', 'Status', 'status')],
      ]),
      targetColumnIds: new Set(['status_4', 'archived_status_4']),
      mapping: { status_4: 'archived_status_4' },
    });
    expect(plan.columnsMapping).toEqual([
      { source: 'status_4', target: 'archived_status_4' },
    ]);
  });

  it('bridges unmatched columns via the mapping', () => {
    const plan = planColumnMappings({
      sourceColumnIds: ['status_4'],
      sourceColumnsById: new Map([
        ['status_4', sourceCol('status_4', 'Status', 'status')],
      ]),
      targetColumnIds: new Set(['status_42']),
      mapping: { status_4: 'status_42' },
    });
    expect(plan.columnsMapping).toEqual([
      { source: 'status_4', target: 'status_42' },
    ]);
  });

  it('throws usage_error with details.unmatched when a source has no target match', () => {
    try {
      planColumnMappings({
        sourceColumnIds: ['status_4', 'date4'],
        sourceColumnsById: new Map([
          ['status_4', sourceCol('status_4', 'Status', 'status')],
          ['date4', sourceCol('date4', 'Due date', 'date')],
        ]),
        targetColumnIds: new Set(['date4']),
        mapping: undefined,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const usageErr = err as UsageError;
      const details = usageErr.details as {
        unmatched?: readonly {
          source_col_id: string;
          source_title: string;
          source_type: string;
        }[];
        example_mapping?: Record<string, string>;
      };
      expect(details.unmatched).toEqual([
        {
          source_col_id: 'status_4',
          source_title: 'Status',
          source_type: 'status',
        },
      ]);
      // Example mapping seeds the agent's next call.
      expect(details.example_mapping).toEqual({
        status_4: '<target_col_id>',
      });
    }
  });

  it('falls back to id+unknown when source metadata is missing for an unmatched column', () => {
    // Defence-in-depth: the source-columns-by-id map is built from
    // the source board metadata. If the item carries a value in a
    // column that's no longer in the metadata (rare — archived
    // mid-flight), the unmatched detail still surfaces with the ID,
    // and falls back to "unknown" for title/type. The error message
    // still tells the agent which IDs need bridging.
    try {
      planColumnMappings({
        sourceColumnIds: ['ghost_col'],
        sourceColumnsById: new Map(),
        targetColumnIds: new Set(),
        mapping: undefined,
      });
      throw new Error('expected throw');
    } catch (err) {
      const details = (err as UsageError).details as {
        unmatched?: readonly {
          source_col_id: string;
          source_title: string;
          source_type: string;
        }[];
      };
      expect(details.unmatched?.[0]).toEqual({
        source_col_id: 'ghost_col',
        source_title: 'ghost_col',
        source_type: 'unknown',
      });
    }
  });

  it("--columns-mapping {} bypasses the unmatched check entirely (Monday's permissive default)", () => {
    // The opt-in: empty mapping means agents asked for Monday's
    // silent-drop behaviour. No unmatched check fires; the wire
    // mapping array is empty.
    const plan = planColumnMappings({
      sourceColumnIds: ['status_4'],
      sourceColumnsById: new Map([
        ['status_4', sourceCol('status_4', 'Status', 'status')],
      ]),
      targetColumnIds: new Set(['some_other_col']),
      mapping: {},
    });
    expect(plan.columnsMapping).toEqual([]);
    expect(plan.echo).toEqual([]);
  });

  it('returns an empty plan when the source has no column values', () => {
    // Items with no column data — the move can proceed unconditionally;
    // there's nothing to map.
    const plan = planColumnMappings({
      sourceColumnIds: [],
      sourceColumnsById: new Map(),
      targetColumnIds: new Set(['status_4']),
      mapping: undefined,
    });
    expect(plan.columnsMapping).toEqual([]);
    expect(plan.echo).toEqual([]);
  });

  it('aggregates multiple unmatched columns into one usage_error', () => {
    // The error decoration enumerates every unmatched column at
    // once — agents fix all the gaps in one revised --columns-mapping
    // rather than re-running iteratively per missing column.
    try {
      planColumnMappings({
        sourceColumnIds: ['a', 'b', 'c'],
        sourceColumnsById: new Map([
          ['a', sourceCol('a')],
          ['b', sourceCol('b')],
          ['c', sourceCol('c')],
        ]),
        targetColumnIds: new Set(['c']),
        mapping: undefined,
      });
      throw new Error('expected throw');
    } catch (err) {
      const details = (err as UsageError).details as {
        unmatched?: readonly { source_col_id: string }[];
      };
      expect(details.unmatched?.map((u) => u.source_col_id)).toEqual([
        'a',
        'b',
      ]);
    }
  });
});
