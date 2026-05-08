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

  describe('NDJSON streaming (M18)', () => {
    // Mirrors item list's M7 NDJSON streaming integration test
    // (tests/integration/commands/item-list.test.ts:152-193). The
    // shape is the same — both go through `paginate.onItem` and
    // share the lifted `startNdjsonStream` helper (R52). The pin
    // here is that item search's NDJSON branch wires up correctly:
    // line count, trailer presence, no truncation, arrival
    // ordering across pages.

    it('streams NDJSON: one item per line, trailer last, no envelope on stdout', async () => {
      const out = await drive(
        [
          'item',
          'search',
          '--board',
          '111',
          '--where',
          'status=Done',
          '--all',
          '--output',
          'ndjson',
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

    it('streams NDJSON without --all (single page, has_more reflects cursor presence)', async () => {
      // --all off: single-page walk; if Monday returns a non-null
      // cursor the trailer reports has_more=true so an agent
      // resuming with --json + the cursor would pick up where the
      // stream left off. Mirrors item list's single-page semantics.
      const out = await drive(
        [
          'item',
          'search',
          '--board',
          '111',
          '--where',
          'status=Done',
          '--output',
          'ndjson',
        ],
        {
          interactions: [
            boardMetadataInteraction,
            {
              operation_name: 'ItemsByColumnValues',
              response: {
                data: {
                  items_page_by_column_values: {
                    cursor: 'CURSOR-AHEAD',
                    items: [item('1')],
                  },
                },
              },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(0);
      const lines = out.stdout.trim().split('\n');
      expect(lines).toHaveLength(2); // 1 item + trailer
      const trailer = JSON.parse(lines[1] ?? '') as {
        _meta: { next_cursor: string | null; has_more: boolean };
      };
      expect(trailer._meta.next_cursor).toBe('CURSOR-AHEAD');
      expect(trailer._meta.has_more).toBe(true);
    });

    it('NDJSON trailer has only the `_meta` key (no warnings sibling per §6.3)', async () => {
      // Same pin as the lifted `startNdjsonStream` unit test —
      // belt-and-braces at the integration boundary so a future
      // regression that adds `warnings` to the trailer fails here
      // (matching docs/cli-design.md §6.3 line 3000-3003).
      const out = await drive(
        [
          'item',
          'search',
          '--board',
          '111',
          '--where',
          'status=Done',
          '--output',
          'ndjson',
        ],
        {
          interactions: [
            boardMetadataInteraction,
            {
              operation_name: 'ItemsByColumnValues',
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
      const lines = out.stdout.trim().split('\n');
      const trailer = JSON.parse(lines[lines.length - 1] ?? '') as Record<
        string,
        unknown
      >;
      expect(Object.keys(trailer)).toEqual(['_meta']);
    });

    it('does NOT emit an envelope wrapping (no ok/data on stdout)', async () => {
      // NDJSON has no envelope — agents read items directly. A
      // regression that fell back to envelope-wrapping (e.g. by
      // forgetting the `if (format === 'ndjson') return` guard)
      // would emit `{"ok":true,...}` on a single line and break
      // every agent's per-line parser.
      const out = await drive(
        [
          'item',
          'search',
          '--board',
          '111',
          '--where',
          'status=Done',
          '--output',
          'ndjson',
        ],
        {
          interactions: [
            boardMetadataInteraction,
            {
              operation_name: 'ItemsByColumnValues',
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
      expect(out.stdout).not.toMatch(/^\s*\{"ok":/);
      // First non-empty line is a resource (has `id`), not an envelope.
      const firstLine = out.stdout.trim().split('\n')[0] ?? '';
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      expect(parsed).toHaveProperty('id');
      expect(parsed).not.toHaveProperty('ok');
      expect(parsed).not.toHaveProperty('data');
    });
  });
});
