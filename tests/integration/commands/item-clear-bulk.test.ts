/**
 * Integration tests for `monday item clear --where ...` bulk path
 * (M12 — same-shape bulk wrapper around M5b's per-item clear).
 *
 * Coverage map:
 *
 *   - Argv parser: positional dispatch (1 vs 2 positionals → bulk vs
 *     single), missing --board for bulk, --where + positional <iid>
 *     mutual-exclusion, empty --filter-json fail-fast.
 *   - confirmation_required gate without --yes / --dry-run.
 *   - --yes commit through to per-item live mutations + envelope
 *     summary (matched_count / applied_count / board_id).
 *   - --dry-run aggregation across N matched items (per-item
 *     planClear results merged into one planned_changes array).
 *   - Empty match set: clean no-op envelope, no confirmation gate.
 *   - Per-item failure decoration (applied_count / applied_to /
 *     failed_at_item / matched_count).
 */
import { describe, expect, it } from 'vitest';
import {
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import {
  boardMetadataInteraction,
  sampleItem,
  useItemTestEnv,
} from './_item-fixtures.js';

const { drive } = useItemTestEnv();

const buildItem = (id: string): typeof sampleItem => ({
  ...sampleItem,
  id,
  name: `Item ${id}`,
});

const clearedItem = (id: string): typeof sampleItem => ({
  ...buildItem(id),
  column_values: [
    {
      id: 'status_4',
      type: 'status',
      text: '',
      value: null,
      column: { title: 'Status' },
    },
    {
      id: 'date4',
      type: 'date',
      text: '2026-05-01',
      value: '{"date":"2026-05-01","time":null}',
      column: { title: 'Due date' },
    },
  ],
});

describe('monday item clear --where (integration, M12 bulk path)', () => {
  it('rejects bulk shape without --board as usage_error', async () => {
    const out = await drive(
      [
        'item',
        'clear',
        'status',
        '--where',
        'status=Backlog',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects single positional <col> with no --where + no --board as usage_error', async () => {
    // The argv `clear status` (one positional, no --where, no --board)
    // is ambiguous between "single-item with implicit board lookup but
    // missing itemId" and "bulk with missing --where". The dispatch
    // surfaces it as the bulk-vs-single-shape error.
    const out = await drive(
      ['item', 'clear', 'status', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run + empty match set → empty planned_changes envelope', async () => {
    const out = await drive(
      [
        'item',
        'clear',
        'status',
        '--board',
        '111',
        '--where',
        'status=Backlog',
        '--dry-run',
        '--json',
      ],
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
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly unknown[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes).toEqual([]);
  });

  it('rejects mixing positional <iid> + <col> AND --where as usage_error', async () => {
    const out = await drive(
      [
        'item',
        'clear',
        '12345',
        'status',
        '--where',
        'status=Backlog',
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

  it('rejects empty --filter-json before any network call', async () => {
    const out = await drive(
      [
        'item',
        'clear',
        'status',
        '--board',
        '111',
        '--filter-json',
        '',
        '--yes',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/filter-json/);
  });

  it('confirmation_required without --yes (and without --dry-run)', async () => {
    const out = await drive(
      [
        'item',
        'clear',
        'status',
        '--board',
        '111',
        '--where',
        'status=Backlog',
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
                      items: [
                        { id: '5001' },
                        { id: '5002' },
                        { id: '5003' },
                      ],
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

  it('empty match set → clean no-op envelope (no --yes required)', async () => {
    const out = await drive(
      [
        'item',
        'clear',
        'status',
        '--board',
        '111',
        '--where',
        'status=Backlog',
        '--json',
      ],
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
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: {
          matched_count: number;
          applied_count: number;
          board_id: string;
        };
        items: readonly unknown[];
      };
    };
    expect(env.data.summary.matched_count).toBe(0);
    expect(env.data.summary.applied_count).toBe(0);
    expect(env.data.summary.board_id).toBe('111');
    expect(env.data.items).toEqual([]);
  });

  it('--dry-run: emits N planned_changes (one per matched item)', async () => {
    const out = await drive(
      [
        'item',
        'clear',
        'status',
        '--board',
        '111',
        '--where',
        'status=Backlog',
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
          // planClear fires per-item — fetches each item's current
          // state for the from-side of the diff.
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
      planned_changes: readonly { operation: string; item_id: string }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(2);
    expect(env.planned_changes[0]?.item_id).toBe('5001');
    expect(env.planned_changes[1]?.item_id).toBe('5002');
  });

  it('--yes: walks all matched items and applies the clear', async () => {
    const out = await drive(
      [
        'item',
        'clear',
        'status',
        '--board',
        '111',
        '--where',
        'status=Backlog',
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
            operation_name: 'ItemClearRich',
            response: {
              data: { change_column_value: clearedItem('5001') },
            },
          },
          {
            operation_name: 'ItemClearRich',
            response: {
              data: { change_column_value: clearedItem('5002') },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: {
          matched_count: number;
          applied_count: number;
          board_id: string;
        };
        items: readonly { id: string }[];
      };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.data.summary.matched_count).toBe(2);
    expect(env.data.summary.applied_count).toBe(2);
    expect(env.data.summary.board_id).toBe('111');
    expect(env.data.items.map((i) => i.id)).toEqual(['5001', '5002']);
    expect(env.resolved_ids).toEqual({ status: 'status_4' });
  });

  it('per-item failure: error envelope decorated with applied_count / applied_to / failed_at_item / matched_count', async () => {
    const out = await drive(
      [
        'item',
        'clear',
        'status',
        '--board',
        '111',
        '--where',
        'status=Backlog',
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
                      items: [
                        { id: '5001' },
                        { id: '5002' },
                        { id: '5003' },
                      ],
                    },
                  },
                ],
              },
            },
          },
          // Item 1 succeeds.
          {
            operation_name: 'ItemClearRich',
            response: {
              data: { change_column_value: clearedItem('5001') },
            },
          },
          // Item 2 fails — Monday returns validation_failed (e.g.
          // permission revoked mid-bulk). The envelope carries
          // applied_count: 1, applied_to: ['5001'], failed_at_item:
          // '5002', matched_count: 3.
          {
            operation_name: 'ItemClearRich',
            http_status: 200,
            response: {
              data: { change_column_value: null },
              errors: [
                {
                  message: 'permission denied',
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
      error?: {
        code: string;
        details?: {
          applied_count?: number;
          applied_to?: readonly string[];
          failed_at_item?: string;
          matched_count?: number;
        };
      };
    };
    expect(env.error?.details?.applied_count).toBe(1);
    expect(env.error?.details?.applied_to).toEqual(['5001']);
    expect(env.error?.details?.failed_at_item).toBe('5002');
    expect(env.error?.details?.matched_count).toBe(3);
  });

  it('multi-page walk: collects items across cursor boundaries', async () => {
    const out = await drive(
      [
        'item',
        'clear',
        'status',
        '--board',
        '111',
        '--where',
        'status=Backlog',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          // Page 1 (cursor non-null → walker fetches page 2).
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: 'page-2-cursor',
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          // Page 2 (cursor null → walker stops).
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
            operation_name: 'ItemClearRich',
            response: {
              data: { change_column_value: clearedItem('5001') },
            },
          },
          {
            operation_name: 'ItemClearRich',
            response: {
              data: { change_column_value: clearedItem('5002') },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: { matched_count: number; applied_count: number };
        items: readonly { id: string }[];
      };
    };
    expect(env.data.summary.matched_count).toBe(2);
    expect(env.data.items.map((i) => i.id)).toEqual(['5001', '5002']);
  });

  it('cache-miss refresh during column resolution emits stale_cache_refreshed warning on bulk dry-run', async () => {
    const cachedNoStatus = {
      id: '111',
      name: 'Tasks',
      description: null,
      state: 'active',
      board_kind: 'public',
      board_folder_id: null,
      workspace_id: '5',
      url: null,
      hierarchy_type: null,
      is_leaf: true,
      updated_at: null,
      groups: [],
      columns: [
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
    const refreshedWithStatus = {
      ...cachedNoStatus,
      columns: [
        ...cachedNoStatus.columns,
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
    // Pre-warm cache.
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [cachedNoStatus] } },
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
        'clear',
        'status',
        '--board',
        '111',
        '--where',
        'status=Backlog',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          // Cache hit returns cachedNoStatus; resolver fires
          // onColumnNotFound for the `status` token in --where.
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedWithStatus] } },
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
            response: { data: { items: [buildItem('5001')] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      warnings?: readonly { code: string }[];
    };
    const warnings = env.warnings ?? [];
    expect(warnings.some((w) => w.code === 'stale_cache_refreshed')).toBe(true);
  });

  it('archived column on bulk path → column_archived (no items_page walk)', async () => {
    const archivedColumn = {
      id: 'status_4',
      title: 'Status',
      type: 'status',
      description: null,
      archived: true,
      settings_str: '{}',
      width: null,
    };
    const archivedMetadata = {
      ...boardMetadataInteraction.response.data.boards[0],
      columns: [
        archivedColumn,
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
    const out = await drive(
      [
        'item',
        'clear',
        'status',
        '--board',
        '111',
        '--where',
        'date4=2026-05-01',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [archivedMetadata] } },
          },
          // Walker finds 1 item — bulk flow proceeds.
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
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string };
    };
    expect(env.error?.code).toBe('column_archived');
  });
});
