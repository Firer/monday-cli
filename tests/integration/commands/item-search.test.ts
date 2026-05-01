/**
 * Integration tests for `monday item search` (M4 §3 reads).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6) + per-verb fixture module (R14). Coverage:
 *   - items_page_by_column_values + --where parsed into query_params,
 *     cross-clause column resolution, cache-aware metadata.
 */
import { describe, expect, it } from 'vitest';
import {
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

describe('monday item search (integration)', () => {
  it('runs items_page_by_column_values with merged column queries', async () => {
    const out = await drive(
      [
        'item',
        'search',
        '--board',
        '111',
        '--where',
        'status=Done',
        '--where',
        'status=Backlog',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsByColumnValues',
            match_variables: {
              columns: [
                { column_id: 'status_4', column_values: ['Done', 'Backlog'] },
              ],
            },
            response: {
              data: {
                items_page_by_column_values: {
                  cursor: null,
                  items: [item('1'), item('2')],
                },
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
  });

  it('refreshes board metadata on cache-miss column lookup (REGRESSION: Codex M4 §1)', async () => {
    // Warm the cache with metadata that lacks NewCol.
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
      ['item', 'search', '--board', '111', '--where', 'NewCol=Done', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedMetadata] } },
          },
          {
            operation_name: 'ItemsByColumnValues',
            match_variables: {
              columns: [
                { column_id: 'newcol_1', column_values: ['Done'] },
              ],
            },
            response: {
              data: {
                items_page_by_column_values: {
                  cursor: null,
                  items: [item('1')],
                },
              },
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

  it('rejects non-equality operators with usage_error', async () => {
    const out = await drive(
      [
        'item',
        'search',
        '--board',
        '111',
        '--where',
        'status~=Done',
        '--json',
      ],
      { interactions: [boardMetadataInteraction] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('resolves `me` against a people column via whoami', async () => {
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
      ['item', 'search', '--board', '111', '--where', 'Owner=me', '--json'],
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
            operation_name: 'ItemsByColumnValues',
            match_variables: {
              columns: [{ column_id: 'person', column_values: ['777'] }],
            },
            response: {
              data: {
                items_page_by_column_values: {
                  cursor: null,
                  items: [item('1')],
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('resolves case-insensitive `me` (`ME`) against a people column', async () => {
    // Codex review pass-2 finding: pass 1 fixed me-casing parity in
    // filters.ts (item list --where) but missed item search's
    // separate clause-resolution path. Pin via integration that
    // `--where Owner=ME` round-trips through the Whoami query and
    // sends the resolved ID, not the literal `ME`, to Monday.
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
      ['item', 'search', '--board', '111', '--where', 'Owner=ME', '--json'],
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
            operation_name: 'ItemsByColumnValues',
            match_variables: {
              columns: [{ column_id: 'person', column_values: ['777'] }],
            },
            response: {
              data: {
                items_page_by_column_values: {
                  cursor: null,
                  items: [item('1')],
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('--all walks via next_items_page', async () => {
    const out = await drive(
      [
        'item',
        'search',
        '--board',
        '111',
        '--where',
        'status=Done',
        '--all',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsByColumnValues',
            response: {
              data: {
                items_page_by_column_values: {
                  cursor: 'C2',
                  items: [item('1')],
                },
              },
            },
          },
          {
            operation_name: 'ItemsByColumnValuesNext',
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
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string }[];
    };
    expect(env.data).toHaveLength(2);
  });
});
