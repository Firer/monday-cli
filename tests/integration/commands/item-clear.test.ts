/**
 * Integration tests for `monday item clear` (M5b dedicated clear verb).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6) + per-verb fixture module (R14). Coverage:
 *   - per-type clear payload (simple "" / rich {}), --dry-run,
 *     archived column, item-on-wrong-board, cache-miss refresh.
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
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

const { drive } = useItemTestEnv();

describe('monday item clear (integration, M5b)', () => {
  // Sample item post-clear: the cleared cell echoes the empty wire
  // shape Monday returns after `change_*_column_value` resets the
  // value (text: "", value: null for status — Monday's actual
  // post-clear shape varies by type but the projector handles both).
  const clearedItem = {
    ...sampleItem,
    column_values: [
      {
        id: 'status_4',
        type: 'status',
        text: '',
        value: null,
        column: { title: 'Status' },
      },
      sampleItem.column_values[1],
    ],
  };

  it('live: rich type (status) → change_column_value with empty {} payload', async () => {
    const out = await drive(
      ['item', 'clear', '12345', 'status', '--board', '111', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemClearRich',
            response: { data: { change_column_value: clearedItem } },
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
    // resolved_ids echoes the agent token → resolved column ID per
    // cli-design §5.3 step 2.
    expect(env.resolved_ids).toEqual({ status: 'status_4' });
  });

  it('live: simple type (text) → change_simple_column_value with "" payload', async () => {
    const textBoard = {
      ...sampleBoardMetadata,
      columns: [
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
    const itemWithClearedText = {
      ...sampleItem,
      column_values: [
        {
          id: 'text_1',
          type: 'text',
          text: '',
          value: null,
          column: { title: 'Notes' },
        },
      ],
    };
    const out = await drive(
      ['item', 'clear', '12345', 'text_1', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [textBoard] } },
          },
          {
            operation_name: 'ItemClearSimple',
            response: { data: { change_simple_column_value: itemWithClearedText } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.resolved_ids).toEqual({ text_1: 'text_1' });
  });

  it('live: implicit --board lookup fires when --board omitted', async () => {
    const out = await drive(
      ['item', 'clear', '12345', 'status', '--json'],
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
            operation_name: 'ItemClearRich',
            response: { data: { change_column_value: clearedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('live: implicit --board lookup surfaces not_found when item is missing', async () => {
    const out = await drive(
      ['item', 'clear', '99999', 'status', '--json'],
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

  it('live: column_not_found surfaces typed error envelope', async () => {
    const out = await drive(
      ['item', 'clear', '12345', 'NotAColumn', '--board', '111', '--json'],
      {
        interactions: [boardMetadataInteraction],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('column_not_found');
  });

  it('live: column_archived surfaces with details preserved', async () => {
    const archivedBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'old_status',
          title: 'OldStatus',
          type: 'status',
          description: null,
          archived: true,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      ['item', 'clear', '12345', 'old_status', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [archivedBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { column_id?: string } };
    };
    expect(env.error?.code).toBe('column_archived');
    expect(env.error?.details?.column_id).toBe('old_status');
  });

  it('live: unsupported_column_type — read-only-forever (formula) surfaces with read_only: true', async () => {
    // Codex M5b cleanup re-review #2: cli-design line 897 originally
    // said `item clear` non-allowlisted types surfaced
    // `unsupported_column_type` "with a `--set-raw` hint" — that
    // hint was the exact dead v0.1 suggestion Path B was meant to
    // remove. The new policy mirrors `item set`: read-only-forever
    // types get `read_only: true`, v0.2-roadmap types get
    // `deferred_to: "v0.2"`. No --set-raw hint anywhere in v0.1.
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
      ['item', 'clear', '12345', 'formula_1', '--board', '111', '--json'],
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
          deferred_to?: string;
          read_only?: boolean;
          set_raw_example?: string;
        };
      };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
    expect(env.error?.details?.read_only).toBe(true);
    // Negative pins: read-only-forever types must not advertise a
    // future write path or a v0.1 --set-raw flag.
    expect(env.error?.details).not.toHaveProperty('deferred_to');
    expect(env.error?.details).not.toHaveProperty('set_raw_example');
    expect(env.error?.message).not.toMatch(/--set-raw/);
  });

  it('live: unsupported_column_type — v0.2 writer-expansion (link) surfaces with deferred_to: v0.2', async () => {
    // Companion test: v0.2-roadmap types carry `deferred_to: "v0.2"`,
    // mirroring `item set`. Pinned at the integration layer so a
    // regression in either branch fails an end-to-end test.
    const linkBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'link_1',
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
      ['item', 'clear', '12345', 'link_1', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [linkBoard] } },
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
          read_only?: boolean;
          set_raw_example?: string;
        };
      };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
    expect(env.error?.details?.deferred_to).toBe('v0.2');
    expect(env.error?.details).not.toHaveProperty('read_only');
    expect(env.error?.details).not.toHaveProperty('set_raw_example');
  });

  it('--dry-run: archived column surfaces column_archived before item-state read fires', async () => {
    // Covers dry-run.ts:525 (planClear archived branch). All-or-
    // nothing semantics: the archived check fires BEFORE fetchItem,
    // so no ItemDryRunRead interaction is needed.
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
      ['item', 'clear', '12345', 'status', '--board', '111', '--dry-run', '--json'],
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

  it('--dry-run: item-on-wrong-board surfaces usage_error with both board IDs', async () => {
    // Covers dry-run.ts:557 (planClear wrong-board branch). The
    // item read returns a different board ID than the resolver
    // resolved the column on — usage_error with item_board_id
    // and requested_board_id so agents can self-correct.
    const out = await drive(
      ['item', 'clear', '12345', 'status', '--board', '111', '--dry-run', '--json'],
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
                    board: { id: '999' },
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
          item_board_id?: string;
          requested_board_id?: string;
        };
      };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.details?.item_board_id).toBe('999');
    expect(env.error?.details?.requested_board_id).toBe('111');
  });

  it('--dry-run: emits §6.4 envelope with empty rich payload as the to side', async () => {
    const itemWithStatus = {
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
      ['item', 'clear', '12345', 'status', '--board', '111', '--dry-run', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [itemWithStatus] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        resolved_ids: Readonly<Record<string, string>>;
        diff: Readonly<Record<string, { from: unknown; to: unknown }>>;
      }[];
    };
    expect(env.data).toBeNull();
    expect((env.meta as { dry_run?: boolean }).dry_run).toBe(true);
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('change_column_value');
    expect(plan?.resolved_ids).toEqual({ status: 'status_4' });
    // The clear diff: from = current value, to = {} (empty rich
    // payload). cli-design §6.4 requires the wire shape on `to`.
    expect(plan?.diff.status_4?.from).toEqual({ label: 'Done', index: 1 });
    expect(plan?.diff.status_4?.to).toEqual({});
  });

  it('--dry-run: simple type renders to: "" on the diff', async () => {
    const textBoard = {
      ...sampleBoardMetadata,
      columns: [
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
        {
          id: 'text_1',
          type: 'text',
          text: 'something',
          value: '"something"',
          column: { title: 'Notes' },
        },
      ],
    };
    const out = await drive(
      ['item', 'clear', '12345', 'text_1', '--board', '111', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [textBoard] } },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [itemWithText] } },
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
    expect(plan?.diff.text_1?.from).toBe('something');
    expect(plan?.diff.text_1?.to).toBe('');
  });

  it('rejects non-numeric item ID as usage_error', async () => {
    const out = await drive(
      ['item', 'clear', 'not-a-number', 'status', '--board', '111', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('token never leaks in mutation error envelopes (M5b regression)', async () => {
    const out = await drive(
      ['item', 'clear', '12345', 'NotAColumn', '--board', '111', '--json'],
      {
        interactions: [boardMetadataInteraction],
      },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });

  it('live: implicit --board lookup surfaces not_found when item.board is null', async () => {
    // Mirrors item set / item update implicit-lookup tests. Covers
    // clear.ts:187 — `first.board === null` branch.
    const out = await drive(
      ['item', 'clear', '12345', 'status', '--json'],
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

  it('live: cache-sourced resolution surfaces source: "mixed" on the success envelope', async () => {
    // Covers clear.ts:332 — when the column resolution serves from
    // cache, the success envelope reports source: 'mixed' (the
    // mutation itself is always live). Warm the cache first.
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
      ['item', 'clear', '12345', 'status', '--board', '111', '--json'],
      {
        interactions: [
          // Cache hit on metadata.
          {
            operation_name: 'ItemClearRich',
            response: {
              data: {
                change_column_value: {
                  ...sampleItem,
                  column_values: [
                    {
                      id: 'status_4',
                      type: 'status',
                      text: '',
                      value: null,
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
