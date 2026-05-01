/**
 * Integration tests for `monday item update` (M5b atomic multi-column +
 * bulk --where).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6) + per-verb fixture module (R14). Coverage:
 *   - single-item path: multi --set + --name, mutation selection,
 *     --dry-run, validation_failed → column_archived remap.
 *   - bulk --where path: confirmation_required gate, --yes commit,
 *     --dry-run aggregation, partial-failure decoration, source
 *     aggregation across metadata + walk + per-item legs.
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

  it('live: --set against an unsupported column type surfaces with --set-raw hint', async () => {
    // Single-path translation-error branch: column resolves OK, but
    // translateColumnValueAsync throws ApiError(unsupported_column_type)
    // for non-allowlisted types. Covers update.ts:521 idx 0 (the
    // err instanceof MondayCliError check after translation).
    const linkMeta = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'link_42',
          title: 'External link',
          type: 'link',
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
        'link_42=https://example.com',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [linkMeta] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { hint?: string } };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
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
});

describe('monday item update (integration, M5b — bulk --where path)', () => {
  // Helper to build matched-item responses.
  const buildItem = (id: string, name = `Item ${id}`): typeof sampleItem => ({
    ...sampleItem,
    id,
    name,
  });

  it('rejects bulk shape without --board as usage_error', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Working',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --filter-json as usage_error before any network call (whole-board safety)', async () => {
    // Codex pass-3 of the cli-design backfill PR: an explicit
    // `--filter-json ''` was treated as "bulk mode" by the
    // dispatch (`filterJson !== undefined`), but `buildQueryParams`
    // short-circuits an empty string into "no filter" and returns
    // `queryParams: undefined` — net effect, the bulk walker would
    // visit every item on the board and the live path would mutate
    // every one. The empty value is rejected at the schema boundary
    // so no network call fires.
    const out = await drive(
      [
        'item',
        'update',
        '--board',
        '111',
        '--filter-json',
        '',
        '--yes',
        '--set',
        'status=Done',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/filter-json/);
  });

  it('rejects whitespace-only --filter-json as usage_error before any network call', async () => {
    // Pass-1 of the fix tightened `.min(1)` to a `trim()` refinement
    // so `--filter-json '   '` doesn't slip past the schema and
    // burn a board-metadata network call before failing at
    // `JSON.parse`. The empty-interactions array forces the test to
    // explode with a transport error if the schema lets the input
    // through.
    const out = await drive(
      [
        'item',
        'update',
        '--board',
        '111',
        '--filter-json',
        '   ',
        '--yes',
        '--set',
        'status=Done',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/filter-json/);
  });

  it('rejects mixing positional <iid> AND --where as usage_error', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--where',
        'status=Backlog',
        '--set',
        'status=Working',
        '--board',
        '111',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects bulk shape without --yes (and without --dry-run) as confirmation_required', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Working',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }, { id: '5002' }, { id: '5003' }],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { matched_count?: number; board_id?: string };
      };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.matched_count).toBe(3);
    expect(env.error?.details?.board_id).toBe('111');
  });

  it('--dry-run: emits N planned_changes (one per matched item)', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
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
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }, { id: '5002' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5001')] } },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5002')] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        item_id: string;
        diff: Readonly<Record<string, unknown>>;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(2);
    expect(env.planned_changes[0]?.item_id).toBe('5001');
    expect(env.planned_changes[1]?.item_id).toBe('5002');
  });

  it('--yes: applies the mutation to every matched item, returns summary + items', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }, { id: '5002' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5001') } },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5002') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: { matched_count: number; applied_count: number; board_id: string };
        items: readonly { id: string }[];
      };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.data.summary).toEqual({
      matched_count: 2,
      applied_count: 2,
      board_id: '111',
    });
    expect(env.data.items.length).toBe(2);
    expect(env.resolved_ids).toEqual({ status: 'status_4' });
  });

  it('--yes: per-item failure surfaces with applied_to + matched_count details', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }, { id: '5002' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5001') } },
          },
          {
            operation_name: 'ItemUpdateRich',
            http_status: 400,
            response: {
              errors: [
                { message: 'invalid', extensions: { code: 'INVALID_ARGUMENT' } },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          applied_count?: number;
          matched_count?: number;
          failed_at_item?: string;
          applied_to?: readonly string[];
        };
      };
    };
    expect(env.error?.code).toBe('validation_failed');
    expect(env.error?.details?.applied_count).toBe(1);
    expect(env.error?.details?.matched_count).toBe(2);
    expect(env.error?.details?.failed_at_item).toBe('5002');
    expect(env.error?.details?.applied_to).toEqual(['5001']);
  });

  it('empty match set is a clean no-op success envelope (no --yes required)', async () => {
    // Codex pass-1 F1 + pass-2 follow-up: empty match must succeed
    // BEFORE the confirmation gate. Test drops `--yes` so a
    // regression to the pre-fix ordering would surface as
    // confirmation_required instead of success.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=NoSuchStatus',
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
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [{ items_page: { cursor: null, items: [] } }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { summary: { matched_count: number; applied_count: number } };
    };
    expect(env.data.summary).toEqual({
      matched_count: 0,
      applied_count: 0,
      board_id: '111',
    });
  });

  it('F6 (pass-2): malformed ItemsPage response surfaces typed internal_error', async () => {
    // Pre-fix the bulk page parse was loose: items_page optional +
    // boards nullable allowed `{boards:[{}]}` to coerce to an empty
    // match set silently, hiding schema drift behind a "0 matched,
    // 0 applied" success. Pass-2 tightened the schema; this test
    // pins the failure mode.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Done',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              // boards present but items_page missing — pre-fix this
              // looked like an empty page; post-fix, schema rejects.
              data: { boards: [{}] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { issues?: readonly unknown[] } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.issues).toBeDefined();
  });

  it('live: column_archived in bulk path surfaces with details', async () => {
    // Bulk-path archived branch (mirrors single-path coverage).
    // Use --filter-json so the filter parser doesn't try to
    // resolve `status` (the archived column) — agents who hit an
    // archived target with --filter-json bypass the filter
    // resolver entirely. The per-set-entry loop then trips the
    // archived check.
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
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[]}',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [archivedMeta] } },
          },
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }, { id: '5002' }],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { column_id?: string; board_id?: string } };
    };
    expect(env.error?.code).toBe('column_archived');
    expect(env.error?.details?.column_id).toBe('status_4');
    expect(env.error?.details?.board_id).toBe('111');
  });

  it('live: cached metadata + live walk → source: "mixed" with cache_age_seconds', async () => {
    // Codex pass-2: bulk live envelope must aggregate source per
    // §6.1. Cache-served metadata + live items_page walk + live
    // mutations → meta.source: 'mixed', cache_age_seconds set.
    // Pre-fix the source was inferred from warning presence —
    // a plain cache hit (no warning) surfaced as 'live'.
    //
    // Setup:
    //   1. Warm the cache by running a list call.
    //   2. Run bulk update; metadata serves from cache, items_page
    //      + mutations are live.
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
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        // No BoardMetadata interaction — cache serves it.
        interactions: [
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5001') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.source).toBe('mixed');
    expect(env.meta.cache_age_seconds).not.toBeNull();
  });

  it('--dry-run: cached metadata aggregates source + per-item warnings dedupe', async () => {
    // Bulk dry-run aggregates per-item planChanges results: source
    // (cache + live → mixed), cache_age_seconds (max), and warnings
    // (deduped by code+message+token). Warm the cache first so
    // bulk dry-run starts with `meta.source === 'cache'`.
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
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          // Cache hit on metadata. Bulk walks items_page live, then
          // dry-run reads each item's pre-mutation state.
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }, { id: '5002' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5001')] } },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5002')] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    // Cache-served metadata + live walk → source: 'mixed'.
    expect(env.meta.source).toBe('mixed');
    expect(env.meta.cache_age_seconds).not.toBeNull();
    expect(env.planned_changes.length).toBe(2);
  });

  it('--dry-run: deduplicates resolver warnings across N matched items', async () => {
    // Per-item resolveColumnWithRefresh emits a fresh
    // column_token_collision warning each time (no caching of the
    // collision detection itself), so an N-item bulk would surface
    // N copies of the same warning. dedupeWarnings consolidates by
    // code+message+token so agents see each unique warning once.
    //
    // Setup: a board where column id 'status_4' collides with
    // column title 'STATUS_4' (case-folded, different column).
    // The token 'status_4' resolves to the id-match column but
    // detectCollision flags the title-match column.
    const collidingMeta = {
      ...sampleBoardMetadata,
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
          id: 'text_other',
          title: 'STATUS_4',
          type: 'text',
          description: null,
          archived: null,
          settings_str: null,
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status_4=Done',
        '--set',
        'status_4=Done',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [collidingMeta] } },
          },
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }, { id: '5002' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [{ ...sampleItem, id: '5001' }] } },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [{ ...sampleItem, id: '5002' }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    const collisionWarnings = env.warnings.filter(
      (w) => w.code === 'column_token_collision',
    );
    // Without dedupe, we'd see >=3 copies (1 from filter + 2 from
    // per-item set resolution). With dedupe, exactly one.
    expect(collisionWarnings.length).toBe(1);
    expect(env.planned_changes.length).toBe(2);
  });

  it('--dry-run: bulk relative date with MONDAY_TIMEZONE override threads through every per-item plan', async () => {
    // Covers update.ts:1044 — the timezone-set branch in the bulk
    // dryrun's dateResolution context build. Mirrors the
    // single-path equivalent above.
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
    const itemWithDate = (id: string): typeof sampleItem => ({
      ...sampleItem,
      id,
      column_values: [
        {
          id: 'date4',
          type: 'date',
          text: '',
          value: null,
          column: { title: 'Due date' },
        },
      ],
    });
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[]}',
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
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: { cursor: null, items: [{ id: '5001' }] },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [itemWithDate('5001')] } },
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

  it('--dry-run: --name + --set in bulk emits planned_changes with name diff', async () => {
    // Covers the dry-run name-injection branch in the bulk path:
    // each per-item planChanges result includes the synthetic
    // `name` key in the multi-mutation diff.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--name',
        'Renamed in bulk',
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
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5001', 'Original 5001')] } },
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
      from: 'Original 5001',
      to: 'Renamed in bulk',
    });
    expect(plan?.diff).toHaveProperty('status_4');
  });

  it('live: --filter-json drives the bulk path (literal Monday query_params)', async () => {
    // --filter-json is the escape hatch for filter shapes the
    // --where DSL doesn't cover. Bulk path accepts either.
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[{"column_id":"status_4","compare_value":[1]}]}',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5001') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { summary: { applied_count: number } };
    };
    expect(env.data.summary.applied_count).toBe(1);
  });

  it('live: --name + --set in bulk fires multi-mutation per matched item', async () => {
    // Covers update.ts bulk live name-injection branch: when
    // --name is set, the synthetic `name` translated value joins
    // the multi-mutation columnValues map. Per-item mutation is
    // change_multiple_column_values.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--name',
        'Renamed in bulk',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemUpdateMulti',
            response: {
              data: {
                change_multiple_column_values: buildItem(
                  '5001',
                  'Renamed in bulk',
                ),
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: { applied_count: number };
        items: readonly { id: string; name: string }[];
      };
    };
    expect(env.data.summary.applied_count).toBe(1);
    expect(env.data.items[0]?.name).toBe('Renamed in bulk');
  });

  it('--filter-json without --yes surfaces confirmation_required with filter_json in details', async () => {
    // Covers update.ts:1029 — confirmation_required details
    // include `filter_json` only when --filter-json was the
    // bulk shape (the --where branch sets `where_clauses` instead).
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[{"column_id":"status_4","compare_value":[1]}]}',
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
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }, { id: '5002' }],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          matched_count?: number;
          filter_json?: string;
        };
      };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.matched_count).toBe(2);
    expect(env.error?.details?.filter_json).toBe(
      '{"rules":[{"column_id":"status_4","compare_value":[1]}]}',
    );
  });

  it('live: walks NextItemsPage when items_page returns a cursor', async () => {
    // Covers update.ts:942 idx 0 — the `'next_items_page' in r.data`
    // branch in extractPage. Multi-page walk pulls from
    // ItemsPage (cursor=C2) → NextItemsPage (cursor=null), then
    // mutates each matched item.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: 'C2',
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'NextItemsPage',
            response: {
              data: {
                next_items_page: {
                  cursor: null,
                  items: [{ id: '5002' }],
                },
              },
            },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5001') } },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5002') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { summary: { matched_count: number; applied_count: number } };
    };
    expect(env.data.summary.matched_count).toBe(2);
    expect(env.data.summary.applied_count).toBe(2);
  });

  it('live: --set against unsupported column type in bulk surfaces typed error', async () => {
    // Covers update.ts:1177 — bulk path's translateColumnValueAsync
    // throws ApiError(unsupported_column_type) → folded with
    // resolverWarnings and re-thrown.
    const linkMeta = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'link_42',
          title: 'External link',
          type: 'link',
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
        '--filter-json',
        '{"rules":[]}',
        '--set',
        'link_42=https://example.com',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [linkMeta] } },
          },
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: { cursor: null, items: [{ id: '5001' }] },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
  });

  it('live: --name only in bulk + per-item failure → no remap target → folded error with bulk-progress decoration', async () => {
    // Covers update.ts:1228 idx 1 — bulk per-item failure with
    // remapTarget undefined (no --set, only --name → translated[]
    // empty → remapTarget = translated[0] = undefined). The catch
    // skips the remap call and decorates with bulk-progress
    // details directly.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--name',
        'Bulk renamed',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }, { id: '5002' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemUpdateSimple',
            response: { data: { change_simple_column_value: buildItem('5001', 'Bulk renamed') } },
          },
          {
            operation_name: 'ItemUpdateSimple',
            http_status: 400,
            response: {
              errors: [
                { message: 'invalid', extensions: { code: 'INVALID_ARGUMENT' } },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          applied_count?: number;
          matched_count?: number;
          failed_at_item?: string;
          applied_to?: readonly string[];
          remapped_from?: string;
        };
      };
    };
    // Without a remap target, the error stays as the original
    // validation_failed (no column_archived remap fires).
    expect(env.error?.code).toBe('validation_failed');
    expect(env.error?.details?.remapped_from).toBeUndefined();
    expect(env.error?.details?.applied_count).toBe(1);
    expect(env.error?.details?.applied_to).toEqual(['5001']);
    expect(env.error?.details?.matched_count).toBe(2);
    expect(env.error?.details?.failed_at_item).toBe('5002');
  });

  it('--dry-run: empty match set emits empty planned_changes (no item-state reads)', async () => {
    // Covers update.ts:987 (empty-match dry-run branch). Mirrors
    // the empty-match live no-op test but on the dry-run path.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=NoSuchStatus',
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
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [{ items_page: { cursor: null, items: [] } }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes).toEqual([]);
  });

  it('F3: bulk per-item validation_failed after cache-sourced resolution remaps to column_archived with bulk-progress decoration', async () => {
    // Codex pass-1 F3: bulk per-item failures must run the F4
    // remap. Setup:
    //   1. Seed cache with active column.
    //   2. Bulk update fires; first item mutates OK, second
    //      returns validation_failed.
    //   3. F4 forces metadata refresh; live board reports the
    //      column archived.
    //   4. Error surfaces as column_archived with applied_count /
    //      applied_to / matched_count / failed_at_item details.
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
    // Seed cache.
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
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          // Cache hit — no BoardMetadata fetch.
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }, { id: '5002' }],
                    },
                  },
                ],
              },
            },
          },
          // First item mutates OK.
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5001') } },
          },
          // Second item: validation_failed.
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
          // F4 refresh confirms archived.
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedArchived] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          remapped_from?: string;
          applied_count?: number;
          applied_to?: readonly string[];
          matched_count?: number;
          failed_at_item?: string;
        };
      };
    };
    expect(env.error?.code).toBe('column_archived');
    expect(env.error?.details?.remapped_from).toBe('validation_failed');
    expect(env.error?.details?.applied_count).toBe(1);
    expect(env.error?.details?.applied_to).toEqual(['5001']);
    expect(env.error?.details?.matched_count).toBe(2);
    expect(env.error?.details?.failed_at_item).toBe('5002');
  });
});
