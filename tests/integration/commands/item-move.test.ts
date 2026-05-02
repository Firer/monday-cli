/**
 * Integration tests for `monday item move` (M11).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6). Coverage:
 *
 *   Same-board path (`move_item_to_group`):
 *     - live happy path,
 *     - live not_found (mutation returns null),
 *     - --dry-run reports source-item snapshot via `ItemMoveRead`,
 *     - --dry-run not_found.
 *
 *   Cross-board path (`move_item_to_board`):
 *     - live happy path with verbatim ID match (no --columns-mapping),
 *     - live with explicit --columns-mapping bridging unmatched columns,
 *     - live with --columns-mapping {} ("drop everything" opt-in),
 *     - live with divergent IDs and no mapping → usage_error
 *       (strict default per cli-design §8 decision 5),
 *     - live not_found (move_item_to_board returns null),
 *     - --dry-run reports column_mappings + source snapshot.
 *
 *   Argv + parse boundary:
 *     - non-numeric item ID → usage_error,
 *     - --columns-mapping without --to-board → usage_error,
 *     - malformed --columns-mapping JSON → usage_error,
 *     - --columns-mapping with non-string values → usage_error.
 *
 *   Idempotency:
 *     - CommandModule.idempotent === false (verb-level conservative
 *       bound across same-board + cross-board).
 *
 *   Token redaction:
 *     - canary absent across error envelopes.
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
  LEAK_CANARY,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import {
  sampleBoardMetadata,
  sampleItem,
  useItemTestEnv,
} from './_item-fixtures.js';

const { drive } = useItemTestEnv();

describe('monday item move (integration, M11)', () => {
  // The moved item Monday returns: same id (`12345`), same board for
  // same-board moves, new board for cross-board. Same shape `item get`
  // reads via `ITEM_FIELDS_FRAGMENT` so the projection mirrors a
  // normal read.
  const movedSameBoard = {
    ...sampleItem,
    group: { id: 'new_group', title: 'New group' },
  };

  // Target board with one new column (`status_42`) plus a column whose
  // ID matches the source's `date4` (so the verbatim-ID-match path is
  // exercised). The status column has a different ID — agents must
  // either rename their source data via mapping or accept the drop.
  const targetBoardMetadata = {
    ...sampleBoardMetadata,
    id: '222',
    name: 'Tasks (new)',
    columns: [
      {
        id: 'status_42',
        title: 'Status',
        type: 'status',
        description: null,
        archived: false,
        settings_str: '{}',
        width: null,
      },
      {
        // Same ID as source's `date4` — verbatim match path.
        id: 'date4',
        title: 'Due date',
        type: 'date',
        description: null,
        archived: false,
        settings_str: null,
        width: null,
      },
    ],
  };

  const targetBoardMetadataInteraction = {
    operation_name: 'BoardMetadata',
    match_variables: { ids: ['222'] },
    response: { data: { boards: [targetBoardMetadata] } },
  };

  const sourceBoardMetadataInteraction = {
    operation_name: 'BoardMetadata',
    match_variables: { ids: ['111'] },
    response: { data: { boards: [sampleBoardMetadata] } },
  };

  // ─── Same-board (group) path ─────────────────────────────────────

  it('same-board live: moves the item to a new group and returns the projected envelope', async () => {
    const out = await drive(
      ['item', 'move', '12345', '--to-group', 'new_group', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemMoveToGroup',
            match_variables: {
              itemId: '12345',
              groupId: 'new_group',
            },
            response: { data: { move_item_to_group: movedSameBoard } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(1);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; group_id: string; board_id: string };
    };
    assertEnvelopeContract(env);
    expect(env.data.id).toBe('12345');
    expect(env.data.group_id).toBe('new_group');
    expect(env.data.board_id).toBe('111');
    expect(env.meta.source).toBe('live');
  });

  it('same-board live: not_found when move_item_to_group returns null', async () => {
    const out = await drive(
      ['item', 'move', '99999', '--to-group', 'new_group', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemMoveToGroup',
            response: { data: { move_item_to_group: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
    expect((env.error?.details as { item_id?: string }).item_id).toBe('99999');
  });

  it('same-board --dry-run: emits §6.4 envelope with item snapshot, no mutation fires', async () => {
    const out = await drive(
      ['item', 'move', '12345', '--to-group', 'new_group', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(1);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        item_id: string;
        to_group_id: string;
        item: { id: string };
      }[];
    };
    expect(env.data).toBeNull();
    expect((env.meta as { dry_run?: boolean }).dry_run).toBe(true);
    expect(env.meta.source).toBe('live');
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('move_item_to_group');
    expect(plan?.item_id).toBe('12345');
    expect(plan?.to_group_id).toBe('new_group');
    expect(plan?.item.id).toBe('12345');
  });

  it('same-board --dry-run: not_found when source-item read returns empty', async () => {
    const out = await drive(
      ['item', 'move', '99999', '--to-group', 'g', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  // ─── Cross-board path ────────────────────────────────────────────

  it('cross-board live: bridges unmatched columns via --columns-mapping', async () => {
    // Source item has a `status_4` column value; target board has
    // `status_42` (different ID). Without --columns-mapping this would
    // fail strict-default; with it, the mapping plumbs through to
    // Monday's `columns_mapping` parameter.
    const movedCrossBoard = {
      ...sampleItem,
      board: { id: '222' },
    };
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'topics',
        '--to-board',
        '222',
        '--columns-mapping',
        '{"status_4": "status_42"}',
        '--json',
      ],
      {
        interactions: [
          // Leg 1: source item read (always live).
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
          // Leg 2 + 3: source + target metadata (parallel; either may
          // be served live). Order is arbitrary — the cassette matches
          // by operation_name + match_variables.
          sourceBoardMetadataInteraction,
          targetBoardMetadataInteraction,
          // Leg 4: the mutation. `match_variables` pins the wire shape
          // — the cassette throws `internal_error` if variables drift.
          {
            operation_name: 'ItemMoveToBoard',
            match_variables: {
              itemId: '12345',
              boardId: '222',
              groupId: 'topics',
              columnsMapping: [
                { source: 'status_4', target: 'status_42' },
                // date4 → date4 (verbatim match — the planner
                // surfaces it explicitly so Monday gets the full
                // mapping).
                { source: 'date4', target: 'date4' },
              ],
            },
            response: { data: { move_item_to_board: movedCrossBoard } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; board_id: string };
    };
    expect(env.data.id).toBe('12345');
    expect(env.data.board_id).toBe('222');
  });

  it('cross-board live: succeeds without --columns-mapping when source IDs match target verbatim', async () => {
    // Use a source item whose only column (`date4`) matches a target
    // column verbatim. No --columns-mapping needed, no unmatched check
    // raises.
    const sourceItemDateOnly = {
      ...sampleItem,
      column_values: [
        {
          id: 'date4',
          type: 'date',
          text: '2026-05-01',
          value: '{"date":"2026-05-01","time":null}',
          column: { title: 'Due date' },
        },
      ],
    };
    const movedCrossBoard = {
      ...sourceItemDateOnly,
      board: { id: '222' },
    };
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'topics',
        '--to-board',
        '222',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sourceItemDateOnly] } },
          },
          sourceBoardMetadataInteraction,
          targetBoardMetadataInteraction,
          {
            operation_name: 'ItemMoveToBoard',
            match_variables: {
              itemId: '12345',
              boardId: '222',
              groupId: 'topics',
              // `--columns-mapping` absent → variable is null
              // (Monday's "use defaults" signal).
              columnsMapping: null,
            },
            response: { data: { move_item_to_board: movedCrossBoard } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it("cross-board live: --columns-mapping {} accepts Monday's permissive default (drop everything)", async () => {
    // The opt-in: agents who genuinely want Monday's silent-drop
    // behaviour pass `{}`. The unmatched check is bypassed, and
    // an empty mapping array goes on the wire.
    const movedCrossBoard = { ...sampleItem, board: { id: '222' } };
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'topics',
        '--to-board',
        '222',
        '--columns-mapping',
        '{}',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
          sourceBoardMetadataInteraction,
          targetBoardMetadataInteraction,
          {
            operation_name: 'ItemMoveToBoard',
            match_variables: {
              itemId: '12345',
              boardId: '222',
              groupId: 'topics',
              columnsMapping: [],
            },
            response: { data: { move_item_to_board: movedCrossBoard } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('cross-board: usage_error when source columns are unmatched and no mapping is supplied', async () => {
    // Source has `status_4`; target only has `status_42` + `date4`.
    // Without --columns-mapping, the strict default rejects.
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'topics',
        '--to-board',
        '222',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
          sourceBoardMetadataInteraction,
          targetBoardMetadataInteraction,
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    const details = env.error?.details as {
      unmatched?: readonly { source_col_id: string }[];
      example_mapping?: Record<string, string>;
    };
    expect(details.unmatched?.length).toBe(1);
    expect(details.unmatched?.[0]?.source_col_id).toBe('status_4');
    // Example mapping: agents copy this pattern into their next run.
    expect(details.example_mapping).toEqual({ status_4: '<target_col_id>' });
  });

  it('cross-board live: not_found when move_item_to_board returns null', async () => {
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'topics',
        '--to-board',
        '222',
        '--columns-mapping',
        '{"status_4": "status_42"}',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
          sourceBoardMetadataInteraction,
          targetBoardMetadataInteraction,
          {
            operation_name: 'ItemMoveToBoard',
            response: { data: { move_item_to_board: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('cross-board --dry-run: emits planned_changes with column_mappings echo, no mutation fires', async () => {
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'topics',
        '--to-board',
        '222',
        '--columns-mapping',
        '{"status_4": "status_42"}',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
          sourceBoardMetadataInteraction,
          targetBoardMetadataInteraction,
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    // Three legs (read + 2x metadata); no mutation.
    expect(out.requests).toBe(3);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        operation: string;
        item_id: string;
        to_board_id: string;
        to_group_id: string;
        column_mappings: readonly { source: string; target: string }[];
        item: { id: string };
      }[];
    };
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('move_item_to_board');
    expect(plan?.item_id).toBe('12345');
    expect(plan?.to_board_id).toBe('222');
    expect(plan?.to_group_id).toBe('topics');
    expect(plan?.column_mappings).toEqual([
      { source: 'status_4', target: 'status_42' },
      { source: 'date4', target: 'date4' },
    ]);
    expect(plan?.item.id).toBe('12345');
  });

  it('cross-board --dry-run: usage_error on unmatched columns (does not just preview)', async () => {
    // v0.2-plan §3 M11 explicit: "--dry-run still raises usage_error"
    // on unmatched so the agent doesn't have to interpret a
    // would-fail dry-run shape.
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'topics',
        '--to-board',
        '222',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
          sourceBoardMetadataInteraction,
          targetBoardMetadataInteraction,
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  // ─── Argv + parse boundary ───────────────────────────────────────

  it('rejects non-numeric item ID as usage_error at the parse boundary', async () => {
    const out = await drive(
      ['item', 'move', 'not-a-number', '--to-group', 'g', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--columns-mapping without --to-board → usage_error', async () => {
    // Mapping is cross-board-only; a same-board call with mapping is a
    // user mistake. cli-design §3.1 rejects loud rather than silently
    // dropping the flag.
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'g',
        '--columns-mapping',
        '{"a":"b"}',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('malformed --columns-mapping JSON → usage_error', async () => {
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'g',
        '--to-board',
        '222',
        '--columns-mapping',
        'not-json',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--columns-mapping with non-string values → usage_error (rich form deferred to v0.3)', async () => {
    // The plan's richer `{id, value?}` form is deferred — agents who
    // hand-craft that shape see a typed usage_error pointing at the
    // deferral, rather than a confusing wire-time failure.
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'g',
        '--to-board',
        '222',
        '--columns-mapping',
        '{"status_4": {"id": "status_42"}}',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--columns-mapping array → usage_error (root must be an object)', async () => {
    const out = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'g',
        '--to-board',
        '222',
        '--columns-mapping',
        '["a", "b"]',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  // ─── Idempotency + redaction ─────────────────────────────────────

  it('CommandModule.idempotent is false (verb-level conservative bound)', async () => {
    const { itemMoveCommand } = await import(
      '../../../src/commands/item/move.js'
    );
    expect(itemMoveCommand.idempotent).toBe(false);
  });

  it('token never leaks across error envelopes (M11 regression)', async () => {
    // Same-board not_found path.
    const sameBoardOut = await drive(
      ['item', 'move', '99999', '--to-group', 'g', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemMoveToGroup',
            response: { data: { move_item_to_group: null } },
          },
        ],
      },
    );
    expect(sameBoardOut.stdout).not.toContain(LEAK_CANARY);
    expect(sameBoardOut.stderr).not.toContain(LEAK_CANARY);

    // Cross-board unmatched-column usage_error path.
    const crossBoardOut = await drive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'topics',
        '--to-board',
        '222',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
          sourceBoardMetadataInteraction,
          targetBoardMetadataInteraction,
        ],
      },
    );
    expect(crossBoardOut.stdout).not.toContain(LEAK_CANARY);
    expect(crossBoardOut.stderr).not.toContain(LEAK_CANARY);

    // Parse-boundary path (no wire call).
    const usageOut = await drive(
      ['item', 'move', 'not-a-number', '--to-group', 'g', '--json'],
      { interactions: [] },
    );
    expect(usageOut.stdout).not.toContain(LEAK_CANARY);
    expect(usageOut.stderr).not.toContain(LEAK_CANARY);
  });
});
