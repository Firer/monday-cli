/**
 * Integration tests for `monday item *` (M4 §3 reads).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6). Coverage:
 *   - item get — happy path + not_found + envelope contract.
 *   - item list — single page, --all walk, NDJSON streaming, stale
 *     cursor mid-walk + initial.
 *   - item find — exact match, ambiguous_name + --first warning.
 *   - item search — items_page_by_column_values + --where parsed
 *     into query_params.
 *   - item subitems — children listing.
 *   - --api-version reaches error envelope on a per-noun basis.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cassette } from '../../fixtures/load.js';
import {
  assertEnvelopeContract,
  drive as driveBase,
  parseEnvelope,
  FIXTURE_API_URL,
  LEAK_CANARY,
  type DriveResult,
  type EnvelopeShape,
} from '../helpers.js';
import type { RunOptions } from '../../../src/cli/run.js';

// item list / search exercise the cache-aware loadBoardMetadata —
// each test wants an isolated XDG_CACHE_HOME so cache writes don't
// bleed across tests.
let xdgRoot: string;

beforeEach(async () => {
  xdgRoot = await mkdtemp(join(tmpdir(), 'monday-cli-item-int-'));
});

afterEach(async () => {
  await rm(xdgRoot, { recursive: true, force: true });
});

const drive = async (
  argv: readonly string[],
  cassette: Cassette,
  overrides: Partial<RunOptions> = {},
): Promise<DriveResult> => {
  const env = {
    MONDAY_API_TOKEN: LEAK_CANARY,
    MONDAY_API_URL: FIXTURE_API_URL,
    XDG_CACHE_HOME: xdgRoot,
  };
  return driveBase(argv, cassette, { env, ...overrides });
};

const sampleColumnValues = [
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
    text: '2026-05-01',
    value: '{"date":"2026-05-01","time":null}',
    column: { title: 'Due date' },
  },
];

const sampleItem = {
  id: '12345',
  name: 'Refactor login',
  state: 'active',
  url: 'https://example.monday.com/items/12345',
  created_at: '2026-04-29T10:00:00Z',
  updated_at: '2026-04-29T11:00:00Z',
  board: { id: '111' },
  group: { id: 'topics', title: 'Topics' },
  parent_item: null,
  column_values: sampleColumnValues,
};

describe('monday item get (integration)', () => {
  it('emits the projected single-resource envelope', async () => {
    const out = await drive(
      ['item', 'get', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemGet',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        id: string;
        name: string;
        board_id: string;
        columns: Record<string, { type: string; label?: string; date?: string }>;
      };
    };
    assertEnvelopeContract(env);
    expect(env.meta.source).toBe('live');
    expect(env.data.id).toBe('12345');
    expect(env.data.board_id).toBe('111');
    expect(env.data.columns.status_4).toMatchObject({
      type: 'status',
      label: 'Done',
    });
    expect(env.data.columns.date4).toMatchObject({
      type: 'date',
      date: '2026-05-01',
    });
  });

  it('surfaces not_found when Monday returns no item', async () => {
    const out = await drive(
      ['item', 'get', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemGet',
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('--api-version reaches the error envelope on HTTP 401', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'item', 'get', '12345', '--json'],
      {
        interactions: [
          { operation_name: 'ItemGet', http_status: 401, response: {} },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
  });

  it('rejects non-numeric item IDs as usage_error', async () => {
    const out = await drive(
      ['item', 'get', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--api-version reaches the usage_error envelope on parseArgv failure (REGRESSION: Codex M4 pass-2 §3)', async () => {
    // Pass-2 §3: pre-`resolveClient` errors (parseArgv throwing on
    // a bad positional) previously fell back to the SDK pin. The
    // preAction hook in program.ts now commits the resolved
    // `--api-version` before any subcommand action runs.
    const out = await drive(
      ['--api-version', '2026-04', 'item', 'get', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.meta.api_version).toBe('2026-04');
  });
});

const sampleBoardMetadata = {
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
      id: 'status_4',
      title: 'Status',
      type: 'status',
      description: null,
      archived: null,
      settings_str: '{}',
      width: null,
    },
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

const boardMetadataInteraction = {
  operation_name: 'BoardMetadata',
  response: { data: { boards: [sampleBoardMetadata] } },
};

const item = (id: string, name = `Item ${id}`): typeof sampleItem => ({
  ...sampleItem,
  id,
  name,
  // Item.board.id must match the board the test is querying so the
  // projector emits the right board_id.
  board: { id: '111' },
});

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

describe('monday item find (integration)', () => {
  it('returns the unique match', async () => {
    const out = await drive(
      ['item', 'find', 'Refactor login', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [item('1', 'Refactor login'), item('2', 'Other')],
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
      data: { id: string; name: string };
    };
    expect(env.data.id).toBe('1');
    expect(env.data.name).toBe('Refactor login');
  });

  it('raises ambiguous_name on multi-match without --first', async () => {
    const out = await drive(
      ['item', 'find', 'Refactor', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [item('1', 'Refactor'), item('2', 'Refactor')],
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
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('ambiguous_name');
  });

  it('surfaces first_of_many warning under --first', async () => {
    const out = await drive(
      ['item', 'find', 'Refactor', '--board', '111', '--first', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [item('5', 'Refactor'), item('1', 'Refactor')],
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
      data: { id: string };
    };
    expect(env.data.id).toBe('1'); // lowest ID wins
    expect(env.warnings?.[0]?.code).toBe('first_of_many');
  });

  it('not_found when the board has no matching item', async () => {
    const out = await drive(
      ['item', 'find', 'No such', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [{ items_page: { cursor: null, items: [item('1', 'Other')] } }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('emits pagination_cap_reached warning when find scan was capped before resolving uniqueness (REGRESSION: Codex M4 §6)', async () => {
    // Resolved match exists on page 1 but the cap is small enough
    // that there are still more pages — uniqueness can't be
    // verified.
    const out = await drive(
      [
        'item',
        'find',
        'Refactor',
        '--board',
        '111',
        '--limit-pages',
        '1',
        '--page-size',
        '2',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: 'C2',
                      items: [
                        item('1', 'Refactor'),
                        item('2', 'Other'),
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
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
      warnings: { code: string }[];
    };
    expect(env.data.id).toBe('1');
    expect(env.warnings.some((w) => w.code === 'pagination_cap_reached')).toBe(true);
  });

  it('walks multiple pages until the match is found, with --group narrowing', async () => {
    const out = await drive(
      [
        'item',
        'find',
        'Refactor login',
        '--board',
        '111',
        '--group',
        'topics',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemFindByGroup',
            match_variables: { groupId: 'topics' },
            response: {
              data: {
                boards: [
                  {
                    groups: [
                      {
                        items_page: {
                          cursor: 'C2',
                          items: [item('1', 'Other')],
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemFindNext',
            response: {
              data: {
                next_items_page: {
                  cursor: null,
                  items: [item('2', 'Refactor login')],
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string };
    };
    expect(env.data.id).toBe('2');
  });
});

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

describe('monday item subitems (integration)', () => {
  it('lists direct subitems sorted by ID asc', async () => {
    const out = await drive(
      ['item', 'subitems', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemSubitems',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    subitems: [item('30'), item('5'), item('99')],
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
    expect(env.data.map((i) => i.id)).toEqual(['5', '30', '99']);
    expect(env.meta.has_more).toBe(false);
    expect(env.meta.next_cursor).toBeNull();
  });

  it('returns empty array when item has no subitems', async () => {
    const out = await drive(
      ['item', 'subitems', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemSubitems',
            response: { data: { items: [{ id: '12345', subitems: [] }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: unknown[];
    };
    expect(env.data).toEqual([]);
  });

  it('handles null subitems (Monday returns null instead of [])', async () => {
    const out = await drive(
      ['item', 'subitems', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemSubitems',
            response: { data: { items: [{ id: '12345', subitems: null }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: unknown[];
    };
    expect(env.data).toEqual([]);
  });

  it('surfaces not_found when the parent item is missing', async () => {
    const out = await drive(
      ['item', 'subitems', '99999', '--json'],
      {
        interactions: [
          { operation_name: 'ItemSubitems', response: { data: { items: [] } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });
});

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

  it('live: unsupported_column_type surfaces with --set-raw hint', async () => {
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
        details?: { set_raw_example?: string };
      };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
    expect(env.error?.details?.set_raw_example).toMatch(/--set-raw/);
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
          XDG_CACHE_HOME: xdgRoot,
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
});
