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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  createInlineMultipartFixtureTransport,
} from '../../fixtures/multipart-load.js';

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

  it('live: --set against an unsupported column type (battery) surfaces with future deferral', async () => {
    // Single-path translation-error branch: column resolves OK, but
    // translateColumnValueAsync throws ApiError(unsupported_column_type)
    // for non-allowlisted types. M19 close graduated the full v0.2
    // tentative row (`tags` / `board_relation` / `dependency`); the
    // v0_2_writer_expansion category is now dead code. Future-roadmap
    // types like `battery` route through the `future` category branch
    // with a --set-raw escape-hatch hint.
    const futureMeta = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'bat_42',
          title: 'Progress',
          type: 'battery',
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
        'bat_42=42',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [futureMeta] } },
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
    expect(env.error?.details?.deferred_to).toBe('future');
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

  describe('v0.6-M38 file-column dispatch (cli-design §5.3 step 5 "File-column dispatch leg")', () => {
    let workdir: string;
    let reportPath: string;
    let report2Path: string;
    const fileBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'attachments',
          title: 'Attachments',
          type: 'file',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
        {
          id: 'attachments_2',
          title: 'Second files',
          type: 'file',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
        {
          id: 'status_1',
          title: 'Status',
          type: 'status',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const sampleAsset = {
      id: '555000222',
      name: 'report.pdf',
      url: 'https://files.monday.com/x/report.pdf',
      public_url: 'https://share.monday.com/x',
      file_extension: 'pdf',
      file_size: 17,
      created_at: '2026-06-01T10:30:00Z',
      uploaded_by: { id: '1', name: 'Alice' },
      original_geometry: null,
      url_thumbnail: null,
    };

    beforeEach(async () => {
      workdir = await mkdtemp(join(tmpdir(), 'monday-cli-item-update-m38-'));
      reportPath = join(workdir, 'report.pdf');
      await writeFile(reportPath, 'PDF-bytes-fixture', 'utf8');
      report2Path = join(workdir, 'report2.pdf');
      await writeFile(report2Path, 'PDF-bytes-fixture-2', 'utf8');
    });
    afterEach(async () => {
      await rm(workdir, { recursive: true, force: true });
    });

    it('live single-item: dispatches add_file_to_column via M31 multipart wire + emits the M31-shaped envelope', async () => {
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            match_filename: 'report.pdf',
            response: { data: { add_file_to_column: sampleAsset } },
          },
        ],
        { assertExhaustive: false },
      );
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          `attachments=${reportPath}`,
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: {
          operation: string;
          column_id: string;
          asset: { id: string };
        };
      };
      expect(env.ok).toBe(true);
      expect(env.data).toMatchObject({
        operation: 'add_file_to_column',
        item_id: '12345',
        column_id: 'attachments',
        filename: 'report.pdf',
        file_size_bytes: 17,
      });
      expect(multipart.requests).toHaveLength(1);
    });

    it('v0.8-M47 stdin single-item live: `--set <file-col>=-` buffers stdin + dispatches add_file_to_column; --filename threads to the wire Asset.name', async () => {
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            match_filename: 'piped.pdf',
            response: { data: { add_file_to_column: sampleAsset } },
          },
        ],
        { assertExhaustive: false },
      );
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          'attachments=-',
          '--filename',
          'piped.pdf',
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
        {
          multipartTransport: multipart,
          stdin: Readable.from([Buffer.from('PIPED-pdf-bytes')]),
        },
      );
      expect(out.exitCode).toBe(0);
      expect(out.stdout).not.toContain('m47_preflight_stub');
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: {
          operation: string;
          column_id: string;
          filename: string;
          file_size_bytes: number;
          asset: { id: string };
        };
      };
      expect(env.ok).toBe(true);
      expect(env.data).toMatchObject({
        operation: 'add_file_to_column',
        item_id: '12345',
        column_id: 'attachments',
        filename: 'piped.pdf',
        file_size_bytes: 'PIPED-pdf-bytes'.length,
      });
      expect(env.meta.source).toBe('live');
      expect(multipart.requests).toHaveLength(1);
      const req = multipart.requests[0]!;
      expect(req.filename).toBe('piped.pdf');
      expect(Buffer.from(req.fileBytes).toString('utf8')).toBe(
        'PIPED-pdf-bytes',
      );
      expect(req.fileType).toBe('application/pdf');
    });

    it('v0.8-M47 stdin single-item dry-run: emits the D4 size-less echo (file_path "-", no file_size_bytes); no wire mutation', async () => {
      const multipart = createInlineMultipartFixtureTransport([], {
        assertExhaustive: false,
      });
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          'attachments=-',
          '--board',
          '111',
          '--dry-run',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
        {
          multipartTransport: multipart,
          stdin: Readable.from([Buffer.from('SHOULD-NOT-BE-READ')]),
        },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout);
      expect(env.ok).toBe(true);
      const meta = env.meta as EnvelopeShape['meta'] & { dry_run?: boolean };
      expect(meta.dry_run).toBe(true);
      expect(meta.source).toBe('none');
      const envWithPlanned = env as EnvelopeShape & {
        planned_changes?: readonly Record<string, unknown>[];
      };
      const entry = envWithPlanned.planned_changes?.[0] ?? {};
      expect(entry).toMatchObject({
        operation: 'add_file_to_column',
        item_id: '12345',
        column_id: 'attachments',
        file_path: '-',
        // --filename absent → default "blob".
        filename: 'blob',
      });
      expect(entry).not.toHaveProperty('file_size_bytes');
      expect(multipart.requests).toHaveLength(0);
    });

    it('v0.8-M47 stdin single-item live: empty stdin rejects usage_error (stdin_file_empty); no wire call fires', async () => {
      const multipart = createInlineMultipartFixtureTransport([], {
        assertExhaustive: false,
      });
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          'attachments=-',
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
        {
          multipartTransport: multipart,
          stdin: Readable.from([]),
        },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr);
      expect(env.error?.code).toBe('usage_error');
      expect(env.error?.details).toMatchObject({ reason: 'stdin_file_empty' });
      expect(multipart.requests).toHaveLength(0);
    });

    it('dry-run single-item: emits D4 planned_changes envelope (no wire mutation)', async () => {
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          `attachments=${reportPath}`,
          '--board',
          '111',
          '--dry-run',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout);
      expect(env.ok).toBe(true);
      const meta = env.meta as EnvelopeShape['meta'] & { dry_run?: boolean };
      expect(meta.dry_run).toBe(true);
      expect(meta.source).toBe('none');
      const envWithPlanned = env as EnvelopeShape & {
        planned_changes?: readonly Record<string, unknown>[];
      };
      expect(envWithPlanned.planned_changes).toEqual([
        {
          operation: 'add_file_to_column',
          item_id: '12345',
          column_id: 'attachments',
          file_path: reportPath,
          filename: 'report.pdf',
          file_size_bytes: 17,
        },
      ]);
    });

    it("rejects file --set + value --set with usage_error.details.reason: 'mixed_file_and_value_sets' (D2 mixed leg)", async () => {
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          `attachments=${reportPath}`,
          '--set',
          'status_1=Done',
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: { reason?: string } };
      };
      expect(env.error?.code).toBe('usage_error');
      expect(env.error?.details?.reason).toBe('mixed_file_and_value_sets');
    });

    it("rejects file --set + --name with usage_error.details.reason: 'mixed_file_and_value_sets'", async () => {
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          `attachments=${reportPath}`,
          '--name',
          'Renamed',
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: { reason?: string } };
      };
      expect(env.error?.code).toBe('usage_error');
      expect(env.error?.details?.reason).toBe('mixed_file_and_value_sets');
    });

    it('live single-item multi-file: dispatches N add_file_to_column legs sequentially + emits the add_files_to_columns envelope (v0.8-M46 D2 carve-out fold from v0.6-M38)', async () => {
      // v0.8-M46 IMPL. At v0.6-M38 + v0.7 this path rejected with
      // `usage_error.details.reason: 'multi_file_set_unsupported'`;
      // v0.8-M46 D2 carve-out fold lifts the gate on
      // `'item_update_single'` and routes to
      // `runItemUpdateSingleFileMultiDispatch` for the per-item
      // multi-leg fan-out (sequential within the item per D1). The
      // `'multi_file_set_unsupported'` + `'m46_preflight_stub'`
      // literals stay RESERVED across the codebase post-IMPL.
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            match_filename: 'report.pdf',
            response: { data: { add_file_to_column: sampleAsset } },
          },
          {
            operation_name: 'AddFileToColumn',
            match_filename: 'report2.pdf',
            response: {
              data: {
                add_file_to_column: { ...sampleAsset, id: '555000333' },
              },
            },
          },
        ],
        { assertExhaustive: true },
      );
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          `attachments=${reportPath}`,
          '--set',
          `attachments_2=${report2Path}`,
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: {
          operation: string;
          item_id: string;
          assets: { column_id: string; filename: string; asset: { id: string } }[];
          applied_file_columns: string[];
        };
      };
      expect(env.ok).toBe(true);
      expect(env.data.operation).toBe('add_files_to_columns');
      expect(env.data.item_id).toBe('12345');
      // Dispatch order is argv order (D1 sequential within-item).
      expect(env.data.applied_file_columns).toEqual([
        'attachments',
        'attachments_2',
      ]);
      expect(env.data.assets).toHaveLength(2);
      expect(env.data.assets[0]).toMatchObject({
        column_id: 'attachments',
        filename: 'report.pdf',
        asset: { id: '555000222' },
      });
      expect(env.data.assets[1]).toMatchObject({
        column_id: 'attachments_2',
        filename: 'report2.pdf',
        asset: { id: '555000333' },
      });
      // Two multipart legs fired in dispatch order.
      expect(multipart.requests).toHaveLength(2);
      expect(multipart.requests[0]?.filename).toBe('report.pdf');
      expect(multipart.requests[1]?.filename).toBe('report2.pdf');
      multipart.assertConsumed();
      // Reserved-literal regression guards (R-v0.7-NEW-4 checklist).
      expect(out.stderr).not.toContain('multi_file_set_unsupported');
      expect(out.stdout).not.toContain('multi_file_set_unsupported');
      expect(out.stderr).not.toContain('m46_preflight_stub');
      expect(out.stdout).not.toContain('m46_preflight_stub');
    });

    it("single-item multi-file partial failure: surfaces internal_error with 'multi_file_update_partial_failure' + applied_file_columns echo (length 0..N-1) after leg-2 fails mid-dispatch", async () => {
      // D2 closure (single-item leg). Leg-1 (attachments) lands;
      // leg-2 (attachments_2) fails wire-side. The applied_file_columns
      // slot echoes the columns that landed before the failure in
      // dispatch order; failed_file_column names the failing leg.
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            match_filename: 'report.pdf',
            response: { data: { add_file_to_column: sampleAsset } },
          },
          {
            operation_name: 'AddFileToColumn',
            match_filename: 'report2.pdf',
            response: {
              errors: [{ message: 'Internal server error' }],
            },
            http_status: 500,
          },
        ],
        { assertExhaustive: true },
      );
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          `attachments=${reportPath}`,
          '--set',
          `attachments_2=${report2Path}`,
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: {
          code: string;
          details?: {
            reason?: string;
            item_id?: string;
            applied_file_columns?: string[];
            failed_file_column?: string;
            cause?: { code?: string };
          };
        };
      };
      expect(env.error?.code).toBe('internal_error');
      expect(env.error?.details?.reason).toBe(
        'multi_file_update_partial_failure',
      );
      expect(env.error?.details?.item_id).toBe('12345');
      // Leg-1 landed before leg-2 failed — applied length N-1 = 1.
      expect(env.error?.details?.applied_file_columns).toEqual(['attachments']);
      expect(env.error?.details?.failed_file_column).toBe('attachments_2');
      expect(env.error?.details?.cause?.code).toBeDefined();
      expect(out.stderr).not.toContain('m46_preflight_stub');
    });

    it("single-item multi-file partial failure with length-0 applied_file_columns when the FIRST file leg fails (no columns landed)", async () => {
      // Boundary: leg-1 fails immediately, so applied_file_columns is
      // length 0 (mirrors M43's single-file leg-2-fails-immediately
      // case extended to the multi-file surface).
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            match_filename: 'report.pdf',
            response: { errors: [{ message: 'Internal server error' }] },
            http_status: 500,
          },
        ],
        { assertExhaustive: false },
      );
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          `attachments=${reportPath}`,
          '--set',
          `attachments_2=${report2Path}`,
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: {
          details?: {
            reason?: string;
            applied_file_columns?: string[];
            failed_file_column?: string;
          };
        };
      };
      expect(env.error?.details?.reason).toBe(
        'multi_file_update_partial_failure',
      );
      expect(env.error?.details?.applied_file_columns).toEqual([]);
      expect(env.error?.details?.failed_file_column).toBe('attachments');
      // Only one multipart leg fired — the loop stopped at leg-1.
      expect(multipart.requests).toHaveLength(1);
    });

    it("rejects multi-file --set when two distinct argv tokens resolve to the SAME file column ID with 'duplicate_resolved_file_columns' (guard fires at the enforcement layer, before any multi-file dispatch)", async () => {
      // v0.8-M46 pre-flight Codex round-2 P3-2 fix: pre-flight
      // round-1's P2-1 added a unit test at the
      // `routeFileColumnDispatch` layer, but no command-level test
      // exercised the duplicate-resolved-column guard through the
      // action body's pre-check. This integration test drives `--set
      // attachments=...` + `--set id:attachments=...` (two distinct
      // argv tokens — name vs `id:` prefix form — that resolve to the
      // same column ID) + asserts the rejection fires at the
      // enforcement layer, before the multi-file dispatch helper runs.
      // Mirrors the JSON path's cross-token duplicate-resolved-ID
      // contract at `src/api/resolution-pass.ts`.
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          `attachments=${reportPath}`,
          '--set',
          `id:attachments=${reportPath}`,
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: {
          code: string;
          details?: {
            reason?: string;
            column_id?: string;
            file_count?: number;
          };
        };
      };
      expect(env.error?.code).toBe('usage_error');
      expect(env.error?.details?.reason).toBe(
        'duplicate_resolved_file_columns',
      );
      expect(env.error?.details?.column_id).toBe('attachments');
      // Reserved-literal regression-guard: the transient pre-flight
      // `m46_preflight_stub` discriminator must NOT appear on this
      // path (the duplicate guard rejects before any dispatch).
      expect(out.stderr).not.toContain('m46_preflight_stub');
      expect(out.stdout).not.toContain('m46_preflight_stub');
      // Regression-guard: the v0.6 reserved literal stays absent.
      expect(out.stderr).not.toContain('multi_file_set_unsupported');
      expect(out.stdout).not.toContain('multi_file_set_unsupported');
    });

    it('dry-run single-item multi-file: emits N add_file_to_column planned_changes (source none; no multipart wire) — v0.8-M46 D2', async () => {
      // v0.8-M46 IMPL dry-run branch. Mirrors M38 single-item dry-run
      // (`source: 'none'`, pure-local) extended to N planned_changes,
      // one per file column in argv order. No multipart wire fires.
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          `attachments=${reportPath}`,
          '--set',
          `attachments_2=${report2Path}`,
          '--board',
          '111',
          '--dry-run',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout);
      expect(env.ok).toBe(true);
      const meta = env.meta as EnvelopeShape['meta'] & { dry_run?: boolean };
      expect(meta.dry_run).toBe(true);
      expect(meta.source).toBe('none');
      const envWithPlanned = env as EnvelopeShape & {
        planned_changes?: readonly Record<string, unknown>[];
      };
      expect(envWithPlanned.planned_changes).toEqual([
        {
          operation: 'add_file_to_column',
          item_id: '12345',
          column_id: 'attachments',
          file_path: reportPath,
          filename: 'report.pdf',
          file_size_bytes: 17,
        },
        {
          operation: 'add_file_to_column',
          item_id: '12345',
          column_id: 'attachments_2',
          file_path: report2Path,
          filename: 'report2.pdf',
          file_size_bytes: 19,
        },
      ]);
      // Reserved-literal regression guards on the dry-run path too.
      expect(out.stderr).not.toContain('multi_file_set_unsupported');
      expect(out.stdout).not.toContain('multi_file_set_unsupported');
      expect(out.stderr).not.toContain('m46_preflight_stub');
      expect(out.stdout).not.toContain('m46_preflight_stub');
    });

    it("single-item multi-file pre-check aborts the whole call BEFORE any wire leg when a file path is unreadable (usage_error; no multipart request fires)", async () => {
      // D3 closure — single upfront pre-check pass over ALL file
      // paths BEFORE any wire round-trip. A missing path on leg-2
      // surfaces `usage_error` (`file_not_readable`) whole-call-abort
      // with zero multipart legs fired.
      const multipart = createInlineMultipartFixtureTransport([], {
        assertExhaustive: false,
      });
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set',
          `attachments=${reportPath}`,
          '--set',
          `attachments_2=${join(workdir, 'does-not-exist.pdf')}`,
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: { reason?: string } };
      };
      expect(env.error?.code).toBe('usage_error');
      expect(env.error?.details?.reason).toBe('file_not_readable');
      // Atomicity-before-wire: zero multipart legs fired.
      expect(multipart.requests).toHaveLength(0);
    });

    it('archived file column on item update: throws column_archived (NOT M38 dispatch — Codex round-2 P2-1 pin; pre-check mirrors resolveAndTranslate archived-column guard)', async () => {
      // Pre-IMPL round-1 + IMPL round-1 pre-check fix: passing
      // `--set <archived-file-col>=<path>` reached the M38 dispatch
      // path because the pre-check ran with `includeArchived: true`
      // but didn't check `archived === true`. Round-2 P2-1 fix adds
      // the archived guard inside preCheckM38FileDispatch.
      const archivedFileBoard = {
        ...sampleBoardMetadata,
        columns: [
          {
            id: 'attachments',
            title: 'Attachments',
            type: 'file',
            description: null,
            archived: true,
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
          `attachments=${reportPath}`,
          '--board',
          '111',
          '--dry-run',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [archivedFileBoard] } },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: {
          code: string;
          details?: { column_id?: string; reason?: string };
        };
      };
      expect(env.error?.code).toBe('column_archived');
      expect(env.error?.details?.column_id).toBe('attachments');
      // No M38 reason discriminator — the archived-column rejection
      // is contractually stable across write paths.
      expect(env.error?.details?.reason).toBeUndefined();
    });

    it("D3 invariant: `--set-raw <file-col>=<json>` stays as unsupported_column_type (NO M38 reason discriminator hijack — Codex round-2 P3-2 pin)", async () => {
      // Pre-check inspects only setEntries; `--set-raw` flows
      // through translateRawColumnValue's D3 permanent rejection
      // (`unsupported_column_type` + dual-path hint naming M38
      // friendly + M31 verb-shaped). Pre-IMPL the catch-and-route
      // pattern hijacked `--set-raw` rejection into M38
      // `file_set_on_bulk_unsupported` / `file_set_on_create_unsupported`
      // / internal_error; the round-1 resolution-boundary
      // pre-check fix routes setRaw-only file rejections back
      // through D3 cleanly.
      const out = await drive(
        [
          'item',
          'update',
          '12345',
          '--set-raw',
          'attachments={"url":"https://example.com/x.pdf"}',
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
      );
      // `unsupported_column_type` maps to exit 2 (API error
      // category per cli-design §6.5) — same shape as item set's
      // existing --set-raw files-shaped rejection test.
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: { reason?: string } };
      };
      expect(env.error?.code).toBe('unsupported_column_type');
      // The D3 rejection MUST NOT carry an M38 reason discriminator
      // — the M38 details.reason slots are reserved for the
      // friendly --set path rejections.
      expect(env.error?.details?.reason).toBeUndefined();
    });

    it("mutex priority is resolution-boundary (not translator-order): `--set bad_date=invalid --set attachments=path` surfaces mixed_file_and_value_sets BEFORE the date translator error (Codex round-2 P3-2 pin for the P2-2 invariant)", async () => {
      // Pre-IMPL with the catch-and-route pattern: argv-order
      // translator iterates --set bad_date first, throws
      // usage_error for the invalid date, mutex never fires. The
      // round-1 resolution-boundary pre-check fix runs
      // routeFileColumnDispatch BEFORE translation; mixed
      // mutex fires first.
      const dateBoard = {
        ...sampleBoardMetadata,
        columns: [
          {
            id: 'attachments',
            title: 'Attachments',
            type: 'file',
            description: null,
            archived: null,
            settings_str: '{}',
            width: null,
          },
          {
            id: 'due',
            title: 'Due',
            type: 'date',
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
          'due=not-a-date',
          '--set',
          `attachments=${reportPath}`,
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [dateBoard] } },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: { reason?: string } };
      };
      expect(env.error?.code).toBe('usage_error');
      expect(env.error?.details?.reason).toBe('mixed_file_and_value_sets');
    });
  });
});
