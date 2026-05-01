/**
 * Integration tests for `monday item set` (M5b §5.3 single-column write).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6) + per-verb fixture module (R14). Coverage:
 *   - happy path simple/rich mutation selection, --dry-run, archived
 *     column, ambiguous column, unsupported column type, cache-miss
 *     refresh, validation_failed → column_archived remap.
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

describe('monday item set (integration, M5b)', () => {
  // Sample item with status: Backlog → after the set call returns
  // updated state: status: Done. The mutation response is the full
  // item shape (Monday returns the post-mutation item per its
  // `change_*_column_value` schema).
  const updatedItem = {
    ...sampleItem,
    column_values: [
      {
        id: 'status_4',
        type: 'status',
        text: 'Done',
        value: '{"label":"Done","index":1}',
        column: { title: 'Status' },
      },
      sampleItem.column_values[1],
    ],
  };

  it('live: --board explicit + status (rich) mutation succeeds; projected item envelope emitted', async () => {
    const out = await drive(
      ['item', 'set', '12345', 'status=Done', '--board', '111', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemSetRich',
            response: {
              data: { change_column_value: updatedItem },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        id: string;
        columns: Record<string, { type: string; label?: string }>;
      };
    };
    assertEnvelopeContract(env);
    expect(env.data.id).toBe('12345');
    expect(env.data.columns.status_4).toMatchObject({
      type: 'status',
      label: 'Done',
    });
    // Resolution succeeded from a live BoardMetadata fetch — source
    // is 'live' (not 'mixed', since no cache leg was involved).
    expect(env.meta.source).toBe('live');
    // Pass-1 finding F1: the resolved column ID is echoed on the
    // live mutation envelope per cli-design §5.3 step 2 line
    // 709-710 — agents capture stable IDs without re-reading
    // metadata.
    const withResolved = env as EnvelopeShape & {
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(withResolved.resolved_ids).toEqual({ status: 'status_4' });
  });

  it('live: implicit --board lookup surfaces not_found when item is missing', async () => {
    const out = await drive(
      ['item', 'set', '99999', 'status=Done', '--json'],
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
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('live: implicit --board lookup surfaces not_found when item.board is null (no read access)', async () => {
    const out = await drive(
      ['item', 'set', '12345', 'status=Done', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: {
              data: { items: [{ id: '12345', board: null }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('live: implicit --board lookup fires when --board omitted', async () => {
    const out = await drive(
      ['item', 'set', '12345', 'status=Done', '--json'],
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
            operation_name: 'ItemSetRich',
            response: {
              data: { change_column_value: updatedItem },
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

  it('live: text column → change_simple_column_value mutation', async () => {
    const textBoard = {
      ...sampleBoardMetadata,
      columns: [
        ...sampleBoardMetadata.columns,
        {
          id: 'text_1',
          title: 'Notes',
          type: 'text',
          description: null,
          archived: null,
          settings_str: null,
          width: null,
        },
      ],
    };
    const itemWithText = {
      ...sampleItem,
      column_values: [
        ...sampleItem.column_values,
        {
          id: 'text_1',
          type: 'text',
          text: 'updated',
          value: '"updated"',
          column: { title: 'Notes' },
        },
      ],
    };
    const out = await drive(
      ['item', 'set', '12345', 'text_1=updated', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [textBoard] } },
          },
          {
            operation_name: 'ItemSetSimple',
            response: {
              data: { change_simple_column_value: itemWithText },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    // Pass-2 minor: assert resolved_ids on the simple-mutation path
    // too (F1 was originally only pinned via the rich path).
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.resolved_ids).toEqual({ text_1: 'text_1' });
  });

  it('F1: resolved_ids keys by agent-supplied token (id:status_4 input echoes the explicit prefix)', async () => {
    // Pass-2 minor: pin the resolved_ids slot's key/value semantics
    // so a future swap (key by column ID instead of token) fails
    // loudly. Agent input was `id:status_4`; resolved column ID is
    // `status_4`. The slot keys by the verbatim agent token.
    const out = await drive(
      ['item', 'set', '12345', 'id:status_4=Done', '--board', '111', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemSetRich',
            response: { data: { change_column_value: updatedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.resolved_ids).toEqual({ 'id:status_4': 'status_4' });
  });

  it('live: column_not_found surfaces typed error envelope (exit 2)', async () => {
    const out = await drive(
      ['item', 'set', '12345', 'NotAColumn=x', '--board', '111', '--json'],
      {
        interactions: [boardMetadataInteraction],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('column_not_found');
  });

  it('live: ambiguous_column surfaces typed error with details.candidates', async () => {
    const ambiguousBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'col_a',
          title: 'Owner',
          type: 'people',
          description: null,
          archived: null,
          settings_str: null,
          width: null,
        },
        {
          id: 'col_b',
          title: 'Owner',
          type: 'people',
          description: null,
          archived: null,
          settings_str: null,
          width: null,
        },
      ],
    };
    const out = await drive(
      ['item', 'set', '12345', 'Owner=alice@example.com', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [ambiguousBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { candidates?: readonly { id: string }[] };
      };
    };
    expect(env.error?.code).toBe('ambiguous_column');
    expect(env.error?.details?.candidates?.length).toBeGreaterThan(0);
  });

  it('live: column_archived surfaces with details.resolver_warnings preserved across cache refresh', async () => {
    // Pre-archived board (cache seed) → live refresh returns the
    // archived column. The resolver fires `stale_cache_refreshed`
    // which folds into details.resolver_warnings on the
    // column_archived throw.
    const cachedBoard = {
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
      ],
    };
    const refreshedBoard = {
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
          id: 'archived_col',
          title: 'OldStatus',
          type: 'status',
          description: null,
          archived: true,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    // Seed the cache by running an item list first, so the next
    // resolveColumnWithRefresh sees a cache hit + has to refresh on
    // miss.
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [cachedBoard] } },
          },
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  { items_page: { cursor: null, items: [] } },
                ],
              },
            },
          },
        ],
      },
    );
    // Now item set against the archived column — cache hit returns
    // the cachedBoard (no archived_col), refresh fetches refreshedBoard.
    const out = await drive(
      ['item', 'set', '12345', 'OldStatus=x', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { resolver_warnings?: readonly { code: string }[] };
      };
    };
    expect(env.error?.code).toBe('column_archived');
    expect(
      env.error?.details?.resolver_warnings?.some(
        (w) => w.code === 'stale_cache_refreshed',
      ),
    ).toBe(true);
  });

  it('live: unsupported_column_type surfaces with v0.2 deferral details', async () => {
    const formulaBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'formula_1',
          title: 'Computed',
          type: 'formula',
          description: null,
          archived: null,
          settings_str: null,
          width: null,
        },
      ],
    };
    const out = await drive(
      ['item', 'set', '12345', 'formula_1=x', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [formulaBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        message?: string;
        details?: {
          column_id?: string;
          type?: string;
          deferred_to?: string;
          set_raw_example?: string;
          hint?: string;
        };
      };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
    // Path B (M5b cleanup): no --set-raw flag in v0.1; the error
    // advertises the v0.2 writer-expansion milestone instead of
    // a dead `set_raw_example` slot.
    expect(env.error?.details?.deferred_to).toBe('v0.2');
    expect(env.error?.details).not.toHaveProperty('set_raw_example');
    expect(env.error?.message).not.toMatch(/Use --set-raw/);
  });

  it('--dry-run: emits the §6.4 envelope with planned_changes, no mutation fires', async () => {
    const out = await drive(
      [
        'item',
        'set',
        '12345',
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
          // No ItemSetRich / ItemSetSimple — dry-run must NOT fire
          // any mutation.
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        board_id: string;
        item_id: string;
        resolved_ids: Readonly<Record<string, string>>;
        diff: Readonly<Record<string, unknown>>;
      }[];
    };
    assertEnvelopeContract(env);
    expect(env.data).toBeNull();
    expect((env.meta as { dry_run?: boolean }).dry_run).toBe(true);
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('change_column_value');
    expect(plan?.board_id).toBe('111');
    expect(plan?.item_id).toBe('12345');
    expect(plan?.resolved_ids).toEqual({ status: 'status_4' });
    expect(plan?.diff.status_4).toMatchObject({
      from: { label: 'Done', index: 1 },
      to: { label: 'Done' },
    });
    // Cassette must be fully consumed except for the unfired
    // mutation interaction (which we didn't include) — so remaining
    // is 0.
    expect(out.remaining).toBe(0);
  });

  it('rejects non-numeric item ID as usage_error', async () => {
    const out = await drive(
      ['item', 'set', 'not-a-number', 'status=Done', '--board', '111', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects malformed --set expression (no =) as usage_error', async () => {
    const out = await drive(
      ['item', 'set', '12345', 'no-equals-sign', '--board', '111', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('live: people column resolves email via userByEmail and emits projected item', async () => {
    const peopleBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'owner_p',
          title: 'Owner',
          type: 'people',
          description: null,
          archived: null,
          settings_str: null,
          width: null,
        },
      ],
    };
    const itemWithPeople = {
      ...sampleItem,
      column_values: [
        {
          id: 'owner_p',
          type: 'people',
          text: 'Alice',
          value: '{"personsAndTeams":[{"id":555,"kind":"person"}]}',
          column: { title: 'Owner' },
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'set',
        '12345',
        'owner_p=alice@example.com',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [peopleBoard] } },
          },
          {
            operation_name: 'UsersByEmail',
            response: {
              data: {
                users: [
                  { id: '555', name: 'Alice', email: 'alice@example.com' },
                ],
              },
            },
          },
          {
            operation_name: 'ItemSetRich',
            response: { data: { change_column_value: itemWithPeople } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('live: user_not_found surfaces typed error when email is unknown', async () => {
    const peopleBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'owner_p',
          title: 'Owner',
          type: 'people',
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
        'set',
        '12345',
        'owner_p=ghost@example.com',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [peopleBoard] } },
          },
          {
            operation_name: 'UsersByEmail',
            response: { data: { users: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('user_not_found');
  });

  it('--dry-run: relative date with MONDAY_TIMEZONE override surfaces details.resolved_from', async () => {
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
        'set',
        '12345',
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
          from: unknown;
          to: unknown;
          details?: { resolved_from?: { input: string; timezone: string } };
        }>>;
      }[];
    };
    const cell = env.planned_changes[0]?.diff.date4;
    expect(cell?.details?.resolved_from?.input).toBe('tomorrow');
    expect(cell?.details?.resolved_from?.timezone).toBe('Europe/London');
  });

  it('F4: validation_failed after LIVE resolution does NOT remap (only cache-sourced does)', async () => {
    // Pass-1 finding F4 scopes the remap to cache-sourced
    // resolution — a live resolution already saw the live archived
    // flag, so a validation_failed there is genuine. Verify the
    // helper bails out for live-source cases.
    const out = await drive(
      ['item', 'set', '12345', 'status=Done', '--board', '111', '--json'],
      {
        interactions: [
          // Live BoardMetadata — column is active.
          boardMetadataInteraction,
          // Mutation returns validation_failed (e.g. unknown
          // status label, NOT archived). With live-source
          // resolution, the helper must NOT trigger the refresh +
          // remap path.
          {
            operation_name: 'ItemSetRich',
            http_status: 400,
            response: {
              errors: [
                {
                  message: 'unknown status label',
                  extensions: { code: 'INVALID_ARGUMENT' },
                },
              ],
            },
          },
          // No second BoardMetadata call — the remap helper
          // bailed out for live-source. If the helper fired, the
          // cassette would be exhausted and we'd get a different
          // error.
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('validation_failed');
  });

  it('F2: UsageError translator failure preserves resolver_warnings (Codex pass-1)', async () => {
    // Pre-fix, foldResolverWarningsIntoError only caught ApiError;
    // a UsageError translator failure (e.g. dropdown empty input)
    // bypassed and lost the stale_cache_refreshed signal. F2 widens
    // the fold to MondayCliError so every typed translator failure
    // carries the resolver context.
    //
    // Setup: cache → seeded board (no `tags` column). Refresh →
    // board with `tags` (dropdown). User passes empty value → the
    // dropdown translator throws UsageError. The cache refresh
    // collected `stale_cache_refreshed` warning that must land in
    // error.details.resolver_warnings.
    const cachedBoard = {
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
      ],
    };
    const refreshedBoard = {
      ...cachedBoard,
      columns: [
        ...cachedBoard.columns,
        {
          id: 'tags_d',
          title: 'Tags',
          type: 'dropdown',
          description: null,
          archived: null,
          settings_str: null,
          width: null,
        },
      ],
    };
    // Seed the cache.
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [cachedBoard] } },
          },
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
    const out = await drive(
      ['item', 'set', '12345', 'tags_d=', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          resolver_warnings?: readonly { code: string }[];
        };
      };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(
      env.error?.details?.resolver_warnings?.some(
        (w) => w.code === 'stale_cache_refreshed',
      ),
    ).toBe(true);
  });

  it('F3 (pass-2): malformed board.id in lookup response surfaces typed internal_error', async () => {
    // Pass-2 tightening: pre-fix the lookup schema validated
    // board.id as `z.string().min(1)`, so a payload like
    // `{ board: { id: "not-a-board-id" } }` slipped past and hit
    // `BoardIdSchema.parse` in loadBoardMetadata as a raw ZodError.
    // Now the schema brands board.id with BoardIdSchema so the
    // failing field path lands on details.issues at the lookup
    // boundary.
    const out = await drive(
      ['item', 'set', '12345', 'status=Done', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: {
              data: {
                items: [
                  { id: '12345', board: { id: 'not-a-board-id' } },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { issues?: readonly { path: string }[] };
      };
    };
    expect(env.error?.code).toBe('internal_error');
    const issues = env.error?.details?.issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path.includes('board.id'))).toBe(true);
  });

  it('F3: malformed ItemBoardLookup response surfaces typed internal_error (Codex pass-1)', async () => {
    // Pre-fix, client.raw<BoardLookupResponse> was a trusted
    // boundary — a malformed response (e.g. `items` not an array)
    // would surface downstream as a raw ZodError from
    // BoardIdSchema.parse. F3 wraps the parse with unwrapOrThrow.
    const out = await drive(
      ['item', 'set', '12345', 'status=Done', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: { data: { items: 'not-an-array' as unknown } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { issues?: readonly { path: string }[]; item_id?: string };
      };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.issues).toBeDefined();
    expect((env.error?.details?.issues ?? []).length).toBeGreaterThan(0);
    expect(env.error?.details?.item_id).toBe('12345');
  });

  it('F4: validation_failed after cache-sourced resolution remaps to column_archived when refresh confirms (Codex pass-1)', async () => {
    // Pre-fix, a cache-sourced resolution that missed the archived
    // flag would surface validation_failed (Monday's mutation
    // rejection), not column_archived. F4 forces a metadata
    // refresh on validation_failed; if the refresh confirms the
    // column is now archived, the error remaps to column_archived
    // so agents key off the stable code.
    //
    // Setup:
    //   1. Seed cache with active column.
    //   2. item set against that column.
    //   3. Live mutation returns validation_failed (HTTP 400 →
    //      validation_failed per api/errors.ts).
    //   4. Refresh fetches board with the column now archived.
    //   5. Helper remaps to column_archived.
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
              data: {
                boards: [{ items_page: { cursor: null, items: [] } }],
              },
            },
          },
        ],
      },
    );
    const out = await drive(
      ['item', 'set', '12345', 'status=Done', '--board', '111', '--json'],
      {
        interactions: [
          // Cache hit — no BoardMetadata call here. Mutation fires
          // because cache says active.
          {
            operation_name: 'ItemSetRich',
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
          // F4 forces a metadata refresh post-failure; the live
          // board now reports the column archived.
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
        details?: { remapped_from?: string };
      };
    };
    expect(env.error?.code).toBe('column_archived');
    expect(env.error?.details?.remapped_from).toBe('validation_failed');
  });

  it('token never leaks in mutation error envelopes (M5b regression)', async () => {
    const out = await drive(
      ['item', 'set', '12345', 'NotAColumn=x', '--board', '111', '--json'],
      {
        interactions: [boardMetadataInteraction],
      },
    );
    expect(out.exitCode).toBe(2);
    // The redaction-hardening discipline: the literal token must
    // never appear in either stream.
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });

  it('live: cache-sourced resolution surfaces source: "mixed" on the success envelope', async () => {
    // Covers set.ts:446 — when the column resolution serves from
    // cache, the success envelope reports source: 'mixed' (the
    // mutation itself is always live). Mirrors the equivalent
    // item clear / item update tests.
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
      ['item', 'set', '12345', 'status=Done', '--board', '111', '--json'],
      {
        interactions: [
          // Cache hit on metadata.
          {
            operation_name: 'ItemSetRich',
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
    const env = parseEnvelope(out.stdout);
    expect(env.meta.source).toBe('mixed');
    expect(env.meta.cache_age_seconds).not.toBeNull();
  });
});
