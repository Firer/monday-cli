/**
 * Integration tests for `monday item update` single-item path (M5b
 * atomic multi-column write to a single resolved item).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6) + per-verb fixture module (R14). Coverage:
 *   - multi `--set` + `--name`, mutation selection
 *     (`change_simple_column_value` / `change_column_value` /
 *     `change_multiple_column_values`)
 *   - implicit `--board` lookup via `ItemBoardLookup` when the agent
 *     omits the flag
 *   - `--dry-run` planned_changes for every shape (single, multi,
 *     name-only, name + columns, relative dates with
 *     `MONDAY_TIMEZONE`)
 *   - F4 `validation_failed` → `column_archived` remap on
 *     cache-sourced resolution
 *   - source / cache-age aggregation across resolution + mutation
 *     legs
 *
 * Bulk `--where` / `--filter-json` path lives in
 * `item-update-bulk.test.ts`. The split happened at HEAD `2c30c66`'s
 * pre-M7 sweep — the original combined file was 2,609 lines, well
 * past §15's 1,500-line threshold; the per-mode split mirrors R14's
 * per-verb split of the original `item.test.ts` (M5b session 4).
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
  FIXTURE_API_URL,
  LEAK_CANARY,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import {
  boardMetadataInteraction,
  sampleBoardMetadata,
  sampleItem,
  useItemTestEnv,
} from './_item-fixtures.js';

const { drive, xdgRoot } = useItemTestEnv();

describe('monday item update (integration, M5b — single-item path)', () => {
  // Sample item post-update with two columns set + name renamed.
  const updatedMultiItem = {
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
      {
        id: 'date4',
        type: 'date',
        text: '2026-05-15',
        value: '{"date":"2026-05-15","time":null}',
        column: { title: 'Due date' },
      },
    ],
  };

  it('live: multi --set bundles into change_multiple_column_values (atomic)', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--set',
        'date4=2026-05-15',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          // First column resolution → live BoardMetadata fetch
          // (cache miss). Second column resolution hits the cache
          // populated by the first call, so only one BoardMetadata
          // interaction is needed.
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpdateMulti',
            response: {
              data: { change_multiple_column_values: updatedMultiItem },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    assertEnvelopeContract(env);
    expect(env.data.id).toBe('12345');
    // Both tokens echo their resolved column IDs per cli-design
    // §5.3 step 2.
    expect(env.resolved_ids).toEqual({ status: 'status_4', date4: 'date4' });
  });

  it('live: single --set (one column) → change_simple_column_value or change_column_value', async () => {
    const updatedSingle = {
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
    const out = await drive(
      ['item', 'update', '12345', '--set', 'status=Done', '--board', '111', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: updatedSingle } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('live: --name only → change_simple_column_value(column_id: "name", ...)', async () => {
    const renamedItem = { ...sampleItem, name: 'New title' };
    const out = await drive(
      ['item', 'update', '12345', '--name', 'New title', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemUpdateSimple',
            response: { data: { change_simple_column_value: renamedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { name: string };
    };
    expect(env.data.name).toBe('New title');
  });

  it('live: --name + --set bundles into change_multiple_column_values', async () => {
    const out = await drive(
      [
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
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpdateMulti',
            response: {
              data: { change_multiple_column_values: updatedMultiItem },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { name: string };
    };
    expect(env.data.name).toBe('New title');
  });

  it('rejects empty call (no --set, no --name) as usage_error', async () => {
    const out = await drive(
      ['item', 'update', '12345', '--board', '111', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects malformed --set expression (no =) as usage_error', async () => {
    const out = await drive(
      ['item', 'update', '12345', '--set', 'no-equals', '--board', '111', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('live: column_not_found surfaces typed error envelope', async () => {
    const out = await drive(
      ['item', 'update', '12345', '--set', 'NotAColumn=x', '--board', '111', '--json'],
      {
        interactions: [boardMetadataInteraction],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('column_not_found');
  });

  it('live: --create-labels-if-missing flag threads through to mutation params', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--create-labels-if-missing',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpdateRich',
            response: {
              data: {
                change_column_value: {
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
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('--dry-run: single --set emits a §6.4 PlannedChange', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        diff: Readonly<Record<string, unknown>>;
        resolved_ids: Readonly<Record<string, string>>;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('change_column_value');
    expect(plan?.resolved_ids).toEqual({ status: 'status_4' });
  });

  it('--dry-run: multi --set emits change_multiple_column_values with both columns in diff', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--set',
        'date4=2026-05-15',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        operation: string;
        diff: Readonly<Record<string, unknown>>;
      }[];
    };
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('change_multiple_column_values');
    expect(plan?.diff).toHaveProperty('status_4');
    expect(plan?.diff).toHaveProperty('date4');
  });

  it('--dry-run: --name + --set emits multi with name key alongside columns', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--name',
        'New title',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        operation: string;
        diff: Readonly<Record<string, { from: unknown; to: unknown }>>;
      }[];
    };
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('change_multiple_column_values');
    expect(plan?.diff.name).toEqual({
      from: 'Refactor login',
      to: 'New title',
    });
    expect(plan?.diff).toHaveProperty('status_4');
  });

  it('--dry-run: relative date in single-path with MONDAY_TIMEZONE override resolves correctly', async () => {
    // Covers update.ts:418 — the timezone-set branch in the
    // dateResolution context build for the single-item path.
    // Mirrors the equivalent item set test.
    const dateBoard = {
      ...sampleBoardMetadata,
      columns: [
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
    const itemWithDate = {
      ...sampleItem,
      column_values: [
        {
          id: 'date4',
          type: 'date',
          text: '',
          value: null,
          column: { title: 'Due date' },
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'date4=tomorrow',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [dateBoard] } },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [itemWithDate] } },
          },
        ],
      },
      {
        env: {
          MONDAY_API_TOKEN: LEAK_CANARY,
          MONDAY_API_URL: FIXTURE_API_URL,
          XDG_CACHE_HOME: xdgRoot(),
          MONDAY_TIMEZONE: 'Europe/London',
        },
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        diff: Readonly<Record<string, {
          details?: { resolved_from?: { input: string; timezone: string } };
        }>>;
      }[];
    };
    const cell = env.planned_changes[0]?.diff.date4;
    expect(cell?.details?.resolved_from?.input).toBe('tomorrow');
    expect(cell?.details?.resolved_from?.timezone).toBe('Europe/London');
  });

  it('--dry-run: --name only emits change_simple_column_value with name diff', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--name',
        'New title',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        operation: string;
        diff: Readonly<Record<string, { from: unknown; to: unknown }>>;
      }[];
    };
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('change_simple_column_value');
    expect(plan?.diff.name).toEqual({
      from: 'Refactor login',
      to: 'New title',
    });
  });

  it('selectMutation rejects duplicate column tokens in multi-set as usage_error', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--set',
        'status=Doing',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('token never leaks in error envelopes (M5b regression)', async () => {
    const out = await drive(
      ['item', 'update', '12345', '--set', 'NotAColumn=x', '--board', '111', '--json'],
      {
        interactions: [boardMetadataInteraction],
      },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });

  it('user-input canary: malformed --set expression echoing the token is redacted', async () => {
    // Codex M5b finding #4 (P2): coverage proof for the value-
    // scanning redactor on user-input echo paths. update.ts:300
    // splits each --set expr on `=` and surfaces a UsageError that
    // echoes the malformed input via `JSON.stringify(raw)` and
    // `details.input: raw`. Drive a malformed `--set` whose value
    // literally contains the canary bytes; verify the redactor
    // scrubs them before any envelope reaches stdout/stderr.
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        LEAK_CANARY, // no `=` → splitSetExpression rejects
        '--board',
        '111',
        '--json',
      ],
      { interactions: [] },
    );
    // No `=` triggers splitSetExpression's UsageError before any
    // network call fires → usage_error, exit 1.
    expect(out.exitCode).toBe(1);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });

  it('rejects empty bulk-shape (no positional, no --where, no --filter-json) as usage_error', async () => {
    // validateInputShape's "no item ID + no filter" arm — covers
    // the second UsageError branch. The zod refinement requires
    // --set or --name first, so we provide --set; the dispatch
    // discriminator then rejects because neither single nor bulk
    // shape is satisfied.
    const out = await drive(
      ['item', 'update', '--set', 'status=Done', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; message: string };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/positional <itemId> or --where/);
  });

  it('live: implicit --board lookup surfaces not_found when item is missing', async () => {
    // --board omitted → ItemBoardLookup fires; lookup returns no
    // item → surfaces not_found per resolveBoardId's
    // `first === undefined` branch.
    const out = await drive(
      ['item', 'update', '99999', '--set', 'status=Done', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string };
    };
    expect(env.error?.code).toBe('not_found');
  });

  it('live: implicit --board lookup surfaces not_found when item.board is null', async () => {
    // Lookup returns the item but with no readable board (no
    // permission / deleted board) → resolveBoardId's
    // `first.board === null` branch fires.
    const out = await drive(
      ['item', 'update', '12345', '--set', 'status=Done', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: { data: { items: [{ id: '12345', board: null }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string };
    };
    expect(env.error?.code).toBe('not_found');
  });

  it('live: column_archived surfaces with details (single-path archived branch)', async () => {
    // Single path's per-entry `column.archived === true` branch.
    // Live metadata fetch returns the column already archived; the
    // mutation never fires.
    const archivedMeta = {
      ...sampleBoardMetadata,
      columns: [
        {
          ...sampleBoardMetadata.columns[0],
          archived: true,
        },
      ],
    };
    const out = await drive(
      ['item', 'update', '12345', '--set', 'status=Done', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [archivedMeta] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { column_id?: string } };
    };
    expect(env.error?.code).toBe('column_archived');
    expect(env.error?.details?.column_id).toBe('status_4');
  });

  it('live: --set against an unsupported column type surfaces with v0.2 deferral', async () => {
    // Single-path translation-error branch: column resolves OK, but
    // translateColumnValueAsync throws ApiError(unsupported_column_type)
    // for non-allowlisted types. Covers update.ts:521 idx 0 (the
    // err instanceof MondayCliError check after translation).
    // Path B (M5b cleanup): the error advertises v0.2's writer-
    // expansion milestone instead of a dead --set-raw suggestion.
    const tagsMeta = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'tags_42',
          title: 'Tags',
          type: 'tags',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'tags_42=Backend',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [tagsMeta] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          deferred_to?: string;
          set_raw_example?: string;
          hint?: string;
        };
      };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
    expect(env.error?.details?.deferred_to).toBe('v0.2');
    expect(env.error?.details).not.toHaveProperty('set_raw_example');
  });

  it('F4 (single path): validation_failed after cache-sourced resolution remaps to column_archived', async () => {
    // Single-path equivalent of the F3 bulk test. Covers update.ts
    // single-path catch branches: 558 (instanceof check on mutation
    // failure), 568 idx 1 (translated[0] defined → enter remap),
    // 583 idx 0 (aggregateSource defined → use it as resolutionSource).
    const cachedActive = {
      ...sampleBoardMetadata,
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
    const refreshedArchived = {
      ...cachedActive,
      columns: [
        {
          ...cachedActive.columns[0],
          archived: true,
        },
      ],
    };
    // Seed cache via item list.
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [cachedActive] } },
          },
          {
            operation_name: 'ItemsPage',
            response: {
              data: { boards: [{ items_page: { cursor: null, items: [] } }] },
            },
          },
        ],
      },
    );
    const out = await drive(
      ['item', 'update', '12345', '--set', 'status=Done', '--board', '111', '--json'],
      {
        interactions: [
          // Cache hit on metadata.
          {
            operation_name: 'ItemUpdateRich',
            http_status: 400,
            response: {
              errors: [
                {
                  message: 'column is archived',
                  extensions: { code: 'INVALID_ARGUMENT' },
                },
              ],
            },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedArchived] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { remapped_from?: string } };
    };
    expect(env.error?.code).toBe('column_archived');
    expect(env.error?.details?.remapped_from).toBe('validation_failed');
  });

  it('F4 (multi-column single path): later-archived column still remaps via probe-all', async () => {
    // Codex M5b finding #3: the remap helper used to probe only the
    // FIRST translated column. A multi-column update where the
    // first target stays active and a LATER target was archived
    // after a stale cache read would surface `validation_failed`,
    // not `column_archived`. This test pins the fix: probe every
    // translated column id; remap surfaces the archived one.
    const cachedActive = {
      ...sampleBoardMetadata,
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
        {
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
    const refreshedSecondArchived = {
      ...cachedActive,
      columns: [
        // status_4 stayed active.
        cachedActive.columns[0],
        // date4 archived after the cache snapshot.
        { ...cachedActive.columns[1], archived: true },
      ],
    };
    // Seed cache via item list.
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [cachedActive] } },
          },
          {
            operation_name: 'ItemsPage',
            response: {
              data: { boards: [{ items_page: { cursor: null, items: [] } }] },
            },
          },
        ],
      },
    );
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--set',
        'date4=2026-05-15',
        '--board',
        '111',
        '--json',
      ],
      {
        // Cache hit on both column resolutions; live multi mutation
        // fails as validation_failed (Monday rejected the archived
        // column); forced refresh confirms date4 is archived.
        interactions: [
          {
            operation_name: 'ItemUpdateMulti',
            http_status: 400,
            response: {
              errors: [
                {
                  message: 'column is archived',
                  extensions: { code: 'INVALID_ARGUMENT' },
                },
              ],
            },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedSecondArchived] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          column_id?: string;
          column_title?: string;
          remapped_from?: string;
        };
      };
    };
    expect(env.error?.code).toBe('column_archived');
    // Pre-fix the helper picked translated[0] (status_4) as the
    // probe target and would not remap because status_4 was still
    // active. The fix probes both translated columns and surfaces
    // the archived one (date4).
    expect(env.error?.details?.column_id).toBe('date4');
    expect(env.error?.details?.column_title).toBe('Due date');
    expect(env.error?.details?.remapped_from).toBe('validation_failed');
  });

  it('live: implicit --board lookup + successful mutation completes (covers lookup-success branch)', async () => {
    // Implicit lookup happy path: ItemBoardLookup returns the item's
    // board, then resolveColumnWithRefresh + executeMutation fire
    // against that board. Covers the `first.board === null` false
    // branch in resolveBoardId (board is non-null, lookup succeeds).
    const out = await drive(
      ['item', 'update', '12345', '--set', 'status=Done', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: {
              data: { items: [{ id: '12345', board: { id: '111' } }] },
            },
          },
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpdateRich',
            response: {
              data: {
                change_column_value: {
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
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('12345');
  });

  it('live: --name only + mutation failure → folded error without remap target', async () => {
    // --name only → setEntries empty → translated[] empty. When
    // executeMutation throws, the catch's `first === undefined`
    // branch fires (no remap target) and the error throws as the
    // folded MondayCliError without bulk-progress decoration.
    // Also exercises the `aggregateSource ?? 'live'` fallback
    // (aggregateSource never set when no setEntries).
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--name',
        'New title',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemUpdateSimple',
            http_status: 400,
            response: {
              errors: [
                {
                  message: 'invalid name',
                  extensions: { code: 'INVALID_ARGUMENT' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string };
    };
    expect(env.error?.code).toBe('validation_failed');
  });

  it('live: cache-sourced resolution surfaces source: "mixed" with cache_age_seconds (single-item)', async () => {
    // Codex M5b finding #2: single-item update derived `meta.source`
    // from warning presence and hardcoded `cacheAgeSeconds: null`.
    // A warmed-cache resolution + live mutation is structurally
    // 'mixed' (cache resolution + live wire call) — pre-fix it
    // surfaced as 'live' with no cache age, contradicting item set,
    // item clear, and bulk item update which all aggregated correctly.
    //
    // Setup: warm the metadata cache via a list call, then run a
    // single-item update with no BoardMetadata interaction (cache hit).
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: { boards: [{ items_page: { cursor: null, items: [] } }] },
            },
          },
        ],
      },
    );
    const updatedSingle = {
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
    const out = await drive(
      ['item', 'update', '12345', '--set', 'status=Done', '--board', '111', '--json'],
      {
        // No BoardMetadata interaction — cache serves it.
        interactions: [
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: updatedSingle } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.source).toBe('mixed');
    expect(env.meta.cache_age_seconds).not.toBeNull();
  });

  it('live: multi --set with cache-sourced resolution aggregates source + cache age', async () => {
    // Multi-token variant of the test above. The aggregator must
    // walk all setEntries (not just one), tracking the max
    // cache_age_seconds across the legs. With every leg cache-served,
    // source: 'mixed' (cache + live mutation), cache_age_seconds set.
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: { boards: [{ items_page: { cursor: null, items: [] } }] },
            },
          },
        ],
      },
    );
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--set',
        'date4=2026-05-15',
        '--board',
        '111',
        '--json',
      ],
      {
        // No BoardMetadata interaction — cache serves both legs.
        interactions: [
          {
            operation_name: 'ItemUpdateMulti',
            response: {
              data: {
                change_multiple_column_values: updatedMultiItem,
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.source).toBe('mixed');
    expect(env.meta.cache_age_seconds).not.toBeNull();
  });
});

describe('monday item update — --set-raw escape hatch (M8, single-item path)', () => {
  it('--set-raw alone (single column) → change_column_value with parsed JsonObject', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set-raw',
        'status={"label":"Done"}',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpdateRich',
            // Wire payload pin — value reaches Monday verbatim.
            match_variables: {
              itemId: '12345',
              boardId: '111',
              columnId: 'status_4',
              value: { label: 'Done' },
            },
            response: {
              data: {
                change_column_value: {
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
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('12345');
  });

  it('--set + --set-raw (different columns) → change_multiple_column_values bundle', async () => {
    // Mixed friendly + raw bundles into one atomic multi-column
    // mutation per cli-design §5.3 step 5. Both translated values
    // land in change_multiple_column_values.column_values.
    const tagsBoard = {
      ...sampleBoardMetadata,
      columns: [
        ...sampleBoardMetadata.columns,
        {
          id: 'tags_1',
          title: 'Tags',
          type: 'tags',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--set-raw',
        'tags_1={"tag_ids":[1,2]}',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [tagsBoard] } },
          },
          {
            operation_name: 'ItemUpdateMulti',
            // Wire pin: both columns appear in the column_values map.
            match_variables: {
              itemId: '12345',
              boardId: '111',
              columnValues: {
                status_4: { label: 'Done' },
                tags_1: { tag_ids: [1, 2] },
              },
            },
            response: {
              data: {
                change_multiple_column_values: {
                  ...sampleItem,
                  column_values: [
                    {
                      id: 'status_4',
                      type: 'status',
                      text: 'Done',
                      value: '{"label":"Done","index":1}',
                      column: { title: 'Status' },
                    },
                    {
                      id: 'tags_1',
                      type: 'tags',
                      text: 'Backend, Frontend',
                      value: '{"tag_ids":[1,2]}',
                      column: { title: 'Tags' },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.data.id).toBe('12345');
    // Both tokens echoed in resolved_ids.
    expect(env.resolved_ids).toMatchObject({
      status: 'status_4',
      tags_1: 'tags_1',
    });
  });

  it('--set and --set-raw against the same resolved column → usage_error', async () => {
    // cli-design §5.3 line 961-972: mutual exclusion is resolution-
    // time enforced. selectMutation owns the duplicate-column-id
    // check; the agent sees usage_error with the column_id.
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--set-raw',
        'status={"label":"Doing"}',
        '--board',
        '111',
        '--json',
      ],
      { interactions: [boardMetadataInteraction] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('mutual-exclusion across distinct tokens (--set <title> + --set-raw <id:colid>) fires pre-translation', async () => {
    // Different token strings, same resolved column ID — the
    // cross-token duplicate-resolved-ID check (pass b) catches
    // this even when the same-token check (pass a) doesn't.
    // Validates the new resolution-before-translation pipeline
    // covers the cli-design §5.3 line 961-972 mutual-exclusion
    // contract for the title-vs-id-prefix alias case.
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--set-raw',
        'id:status_4={"label":"Doing"}',
        '--board',
        '111',
        '--json',
      ],
      { interactions: [boardMetadataInteraction] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; message: string; details?: { tokens?: string[] } };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/resolve to the same column ID/);
    // M9.5 redactor fix: `details.tokens` (plural) now surfaces
    // verbatim — pre-fix the secrets-scrubber's
    // `(token|secret|password|api[-_]?key)` regex caught the plural
    // and emitted `[REDACTED]`. The `(?!s)` lookahead now excludes
    // plural container keys; singular `apiToken` / `accessToken` /
    // etc. still redact via DEFAULT_SENSITIVE_KEYS + the regex.
    expect(env.error?.details?.tokens).toEqual(['status', 'id:status_4']);
  });

  it('mutual-exclusion fires before translation when friendly value would error (Codex M8 finding #2)', async () => {
    // Pre-fix, translation ran inline with resolution: a `--set
    // date4=not-a-real-date --set-raw date4='{...}'` surfaced the
    // date translator's `usage_error` because the friendly entry
    // translated FIRST, and the raw entry's same-token duplicate
    // check never fired. Post-fix, all tokens resolve before any
    // translation, so the same-token duplicate check on the raw
    // pass surfaces the mutual-exclusion `usage_error` per
    // cli-design §5.3 line 961-972 instead of the translator's
    // bad-input error.
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'date4=not-a-real-date',
        '--set-raw',
        'date4={"date":"2026-05-15"}',
        '--board',
        '111',
        '--json',
      ],
      { interactions: [boardMetadataInteraction] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; message: string };
    };
    expect(env.error?.code).toBe('usage_error');
    // Mutual-exclusion message (not the date-translator's
    // bad-input message). The token name "date4" appears in the
    // mutual-exclusion message too, so the discriminating signal
    // is the prefix and the absence of translator-specific phrases
    // ("not a valid", "relative token", etc.).
    expect(env.error?.message).toMatch(/Multiple --set/);
    expect(env.error?.message).not.toMatch(/not a valid|relative token|ISO date/);
  });

  it('--set-raw with --dry-run echoes parsed JsonObject in diff `to`', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set-raw',
        'status={"label":"Done"}',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemDryRunRead',
            response: {
              data: {
                items: [
                  {
                    ...sampleItem,
                    column_values: [
                      {
                        id: 'status_4',
                        type: 'status',
                        text: 'Backlog',
                        value: '{"label":"Backlog","index":0}',
                        column: { title: 'Status' },
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes?: readonly {
        operation: string;
        diff: Readonly<Record<string, { to: unknown }>>;
      }[];
    };
    expect(env.planned_changes?.[0]?.operation).toBe('change_column_value');
    expect(env.planned_changes?.[0]?.diff.status_4?.to).toEqual({
      label: 'Done',
    });
  });

  it('--set-raw against read-only-forever column (mirror) → unsupported_column_type', async () => {
    const mirrorBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'mirror_1',
          title: 'Sprint mirror',
          type: 'mirror',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set-raw',
        'mirror_1={"whatever":1}',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [mirrorBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { read_only?: boolean } };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
    expect(env.error?.details?.read_only).toBe(true);
  });

  it('--set-raw with malformed JSON fails fast — no GraphQL request fires', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set-raw',
        'status={broken',
        '--board',
        '111',
        '--json',
      ],
      // Empty cassette: an exhausted-cassette error from the
      // FixtureTransport would surface as `internal_error` with a
      // recognisable shape; usage_error means the parse failed
      // pre-network as designed.
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--set-raw with malformed JSON fails fast even without --board (Codex M8 finding #4)', async () => {
    // Pre-fix, the single-item path ran `resolveBoardId` BEFORE
    // parsing `--set-raw`, so omitting `--board` paid an
    // `ItemBoardLookup` GraphQL round-trip even when the JSON was
    // obviously malformed. Argv-parse-time failures should fire
    // pre-network — same contract as `item set` and the bulk path.
    // Empty cassette: any GraphQL request would surface as a
    // distinct error; `usage_error` proves the parse fired first.
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set-raw',
        'status={broken',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('empty call (no --set / --set-raw / --name) → usage_error', async () => {
    const out = await drive(
      ['item', 'update', '12345', '--board', '111', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});
