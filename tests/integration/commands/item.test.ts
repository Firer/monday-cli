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

  it('--group narrows the items_page request via groupIds', async () => {
    const out = await drive(
      ['item', 'list', '--board', '111', '--group', 'topics', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            match_variables: { groupIds: ['topics'] },
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
            operation_name: 'ItemFind',
            match_variables: { groupIds: ['topics'] },
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: 'C2',
                      items: [item('1', 'Other')],
                    },
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
