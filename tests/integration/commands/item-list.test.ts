/**
 * Integration tests for `monday item list` (M4 §3 reads).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6) + per-verb fixture module (R14). Coverage:
 *   - single-page list, --all walk, NDJSON streaming, stale cursor
 *     mid-walk + initial, --where filter parsing, --columns projection,
 *     --sort, cache-aware board metadata, pagination cap.
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import {
  boardMetadataInteraction,
  item,
  sampleBoardMetadata,
  useItemTestEnv,
} from './_item-fixtures.js';

const { drive } = useItemTestEnv();

describe('monday item list (integration)', () => {
  it('emits the projected list with the §6.3 collection envelope', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--json'],
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
                      items: [item('1'), item('2')],
                    },
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
      data: { id: string }[];
    };
    assertEnvelopeContract(env);
    expect(env.data).toHaveLength(2);
    expect(env.meta.total_returned).toBe(2);
    expect(env.meta.has_more).toBe(false);
    expect(env.meta.next_cursor).toBeNull();
  });

  it('per-page sorts items by ID ascending', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--json'],
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
                      items: [item('30'), item('5'), item('200'), item('99')],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string }[];
    };
    expect(env.data.map((i) => i.id)).toEqual(['5', '30', '99', '200']);
  });

  it('--all walks every page until cursor exhausts', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--all', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  { items_page: { cursor: 'C2', items: [item('1'), item('2')] } },
                ],
              },
            },
          },
          {
            operation_name: 'NextItemsPage',
            response: {
              data: {
                next_items_page: { cursor: null, items: [item('3')] },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string }[];
    };
    expect(env.data.map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(env.meta.next_cursor).toBeNull();
    expect(env.meta.has_more).toBe(false);
  });

  it('default (no --all) exposes next_cursor without walking', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  { items_page: { cursor: 'CURSOR-AHEAD', items: [item('1')] } },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.next_cursor).toBe('CURSOR-AHEAD');
    expect(env.meta.has_more).toBe(true);
  });

  it('streams NDJSON: one item per line, trailer last, no envelope on stdout', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--all', '--output', 'ndjson'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  { items_page: { cursor: 'C2', items: [item('1')] } },
                ],
              },
            },
          },
          {
            operation_name: 'NextItemsPage',
            response: {
              data: {
                next_items_page: { cursor: null, items: [item('2')] },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines).toHaveLength(3); // 2 items + trailer
    const item1 = JSON.parse(lines[0] ?? '') as { id: string; name: string };
    expect(item1.id).toBe('1');
    expect(item1.name).toBeDefined();
    const item2 = JSON.parse(lines[1] ?? '') as { id: string };
    expect(item2.id).toBe('2');
    const trailer = JSON.parse(lines[2] ?? '') as {
      _meta: { next_cursor: string | null; has_more: boolean; total_returned: number };
    };
    expect(trailer._meta.next_cursor).toBeNull();
    expect(trailer._meta.has_more).toBe(false);
    expect(trailer._meta.total_returned).toBe(2);
  });

  it('parses --where through filters.ts and includes query_params in the request', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--where', 'status=Done', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            match_variables: {
              queryParams: {
                rules: [
                  {
                    column_id: 'status_4',
                    operator: 'any_of',
                    compare_value: ['Done'],
                  },
                ],
              },
            },
            response: {
              data: {
                boards: [
                  { items_page: { cursor: null, items: [item('1')] } },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('--where + --filter-json mutually exclusive — usage_error', async () => {
    const out = await drive(
      [
        'item',
        'list',
        '--board',
        '111',
        '--where',
        'status=Done',
        '--filter-json',
        '{"rules":[]}',
        '--json',
      ],
      { interactions: [boardMetadataInteraction] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('cursor_age_seconds is computed from the injected ctx.clock (REGRESSION: Codex M4 §7)', async () => {
    // Verifies the ctx.clock plumbing — the unit suite drives the
    // `> 0` boundary against a mock clock that advances; this
    // integration test confirms the command-level wiring runs
    // through the injected clock at all (cursor_age_seconds is a
    // present, finite, non-negative number on the error envelope).
    const out = await drive(
      ['item', 'list', '--board', '111', '--all', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  { items_page: { cursor: 'C2', items: [item('1')] } },
                ],
              },
            },
          },
          {
            operation_name: 'NextItemsPage',
            response: {
              errors: [
                {
                  message: 'Cursor expired',
                  extensions: { code: 'INVALID_CURSOR_EXCEPTION' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error: {
        code: string;
        details: { cursor_age_seconds: number; items_returned_so_far: number };
      };
    };
    expect(env.error.code).toBe('stale_cursor');
    // Plumbing assertion: the field is present and finite. Frozen
    // clock means the value is 0 — that's correct for a same-tick
    // walk. The unit suite (tests/unit/api/pagination.test.ts) drives
    // the advancing-clock case where the value is positive.
    expect(typeof env.error.details.cursor_age_seconds).toBe('number');
    expect(env.error.details.cursor_age_seconds).toBeGreaterThanOrEqual(0);
    expect(env.error.details.items_returned_so_far).toBe(1);
  });

  it('mid-walk stale_cursor fails fast with details (no silent re-issue)', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--all', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  { items_page: { cursor: 'C2', items: [item('1'), item('2')] } },
                ],
              },
            },
          },
          {
            operation_name: 'NextItemsPage',
            response: {
              errors: [
                {
                  message: 'Cursor expired',
                  extensions: { code: 'INVALID_CURSOR_EXCEPTION' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error: {
        code: string;
        details: {
          items_returned_so_far: number;
          last_item_id: string;
          cursor_age_seconds: number;
        };
      };
    };
    expect(env.error.code).toBe('stale_cursor');
    expect(env.error.details.items_returned_so_far).toBe(2);
    expect(env.error.details.last_item_id).toBe('2');
    // Walker did NOT silently re-issue the initial query — exactly
    // one initial + one next_items_page request.
    expect(out.requests).toBe(3); // metadata + initial + next
  });

  it('rejects non-numeric --board as usage_error', async () => {
    const out = await drive(
      ['item', 'list', '--board', 'abc', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('filter parser refreshes board metadata on cache-miss column lookup (REGRESSION: Codex M4 §1)', async () => {
    // First call: warm the cache with the original metadata (no
    // NewCol).
    await drive(
      ['item', 'list', '--board', '111', '--json'],
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
    // Second call: --where references a NewCol that exists on
    // refreshed metadata but not on the cached view. Without §5.3
    // step 5 / Codex M4 §1, this would surface as column_not_found.
    // With the refresh-once contract, the parser refreshes once,
    // resolves NewCol, and queries items_page with the rule.
    const refreshedMetadata = {
      ...sampleBoardMetadata,
      columns: [
        ...sampleBoardMetadata.columns,
        {
          id: 'newcol_1',
          title: 'NewCol',
          type: 'status',
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
        'list',
        '--board',
        '111',
        '--where',
        'NewCol=Done',
        '--json',
      ],
      {
        interactions: [
          // Refresh-on-not-found fires the BoardMetadata operation
          // again, this time with NewCol in the response.
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedMetadata] } },
          },
          {
            operation_name: 'ItemsPage',
            match_variables: {
              queryParams: {
                rules: [
                  {
                    column_id: 'newcol_1',
                    operator: 'any_of',
                    compare_value: ['Done'],
                  },
                ],
              },
            },
            response: {
              data: { boards: [{ items_page: { cursor: null, items: [item('1')] } }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.warnings?.some((w) => w.code === 'stale_cache_refreshed')).toBe(true);
    expect(env.meta.source).toBe('mixed');
  });

  it('drops per-cell column titles in collection output, consolidates into meta.columns (§6.3 / REGRESSION: Codex M4 §8)', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: { cursor: null, items: [item('1')] },
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
      data: { columns: Record<string, { title?: string; type: string }> }[];
      meta: EnvelopeShape['meta'] & {
        columns?: Record<string, { id: string; type: string; title: string }>;
      };
    };
    // Per-cell title is dropped.
    expect(env.data[0]?.columns.status_4?.title).toBeUndefined();
    // Canonical title lives in meta.columns.
    expect(env.meta.columns?.status_4?.title).toBe('Status');
  });

  it('reports source: mixed when board metadata is cached and items are live (REGRESSION: Codex M4 §2)', async () => {
    // First call: warm the cache by running list once.
    await drive(
      ['item', 'list', '--board', '111', '--json'],
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
    // Second call: cache hit on metadata, live on items. Expect
    // source: 'mixed' with cache_age_seconds set.
    const out = await drive(
      ['item', 'list', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemsPage',
            response: {
              data: { boards: [{ items_page: { cursor: null, items: [item('1')] } }] },
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

  it('--limit caps total items returned mid-page and preserves the cursor', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--all', '--limit', '2', '--json'],
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
                      items: [item('1'), item('2'), item('3')],
                    },
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
      data: { id: string }[];
    };
    expect(env.data).toHaveLength(2);
    expect(env.meta.has_more).toBe(true);
    expect(env.meta.next_cursor).toBe('C2');
  });

  it('--group routes through the boards.groups.items_page query shape', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--group', 'topics', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPageByGroup',
            match_variables: { groupId: 'topics' },
            response: {
              data: {
                boards: [
                  {
                    groups: [
                      { items_page: { cursor: null, items: [item('1')] } },
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
      data: { id: string }[];
    };
    expect(env.data).toHaveLength(1);
  });

  it('resolves `me` in --where against a people column', async () => {
    const peopleMeta = {
      ...sampleBoardMetadata,
      columns: [
        ...sampleBoardMetadata.columns,
        {
          id: 'person',
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
      ['item', 'list', '--board', '111', '--where', 'Owner=me', '--json'],
      {
        interactions: [
          { operation_name: 'BoardMetadata', response: { data: { boards: [peopleMeta] } } },
          {
            operation_name: 'Whoami',
            response: {
              data: {
                me: {
                  id: '777',
                  name: 'Alice',
                  email: 'alice@example.test',
                  account: { id: '99', name: 'Org', slug: 'org' },
                },
              },
            },
          },
          {
            operation_name: 'ItemsPage',
            match_variables: {
              queryParams: {
                rules: [
                  { column_id: 'person', operator: 'any_of', compare_value: ['777'] },
                ],
              },
            },
            response: {
              data: {
                boards: [{ items_page: { cursor: null, items: [item('1')] } }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('--api-version reaches the error envelope on board metadata 401', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'item', 'list', '--board', '111', '--json'],
      {
        interactions: [
          { operation_name: 'BoardMetadata', http_status: 401, response: {} },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
  });
});
