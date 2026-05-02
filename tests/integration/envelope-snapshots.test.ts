/**
 * Envelope-shape snapshot suite (`v0.1-plan.md` §3 M7).
 *
 * One snapshot per shipped command on a representative happy-path
 * fixture. The point is to catch v0.2 changes that drift the
 * `data` / `meta` / `warnings` shape — `assertEnvelopeContract`
 * only pins the §6.1 *meta* skeleton (key presence + types); a
 * snapshot pins the full byte shape, so a renamed key, a dropped
 * field, or a re-ordered `meta.complexity` slot fails loud here.
 *
 * Determinism: `helpers.ts baseOptions` injects `FIXED_CLOCK` +
 * `fixed-req-id` + `cliVersion: '0.0.0-test'`, so `meta.retrieved_at`
 * / `meta.request_id` / `meta.cli_version` are stable across
 * runs. No per-test normalisation is needed.
 *
 * Per-command `data` checks already live in the per-command
 * integration files — those guard *behaviour*. This file guards
 * *contract*. The two layers are deliberately overlapping: a
 * single snapshot pin lets a future renamer get caught even if
 * they update the per-command tests in lockstep with the rename
 * (because they'd have to update this snapshot too, which forces
 * a deliberate choice).
 *
 * Pyramid placement: integration, not E2E — fixture cassettes
 * via `FixtureTransport` exercise the full runner path. The
 * overhead per-command is 5-15ms, so the whole suite finishes
 * well under a second.
 */
import { describe, expect, it } from 'vitest';
import {
  drive,
  parseEnvelope,
  useCachedIntegrationEnv,
} from './helpers.js';
import {
  boardMetadataInteraction,
  sampleBoardMetadata,
  sampleItem,
  useItemTestEnv,
} from './commands/_item-fixtures.js';

// `useItemTestEnv` registers per-test mkdtemp/rm hooks for an
// isolated XDG_CACHE_HOME — every item-* command and the metadata-
// resolving paths (board describe / doctor) need it. Each helper
// instance registers its own beforeEach/afterEach pair, so the
// per-test tmpdir is fresh per file.
const { drive: cachedDrive } = useItemTestEnv();
const { drive: doctorDrive } = useCachedIntegrationEnv('monday-cli-snap-doctor-');
const { drive: describeDrive } = useCachedIntegrationEnv('monday-cli-snap-describe-');
const { drive: cacheDrive, xdgRoot: cacheXdgRoot } = useCachedIntegrationEnv(
  'monday-cli-snap-cache-',
);

/**
 * Replaces non-deterministic absolute paths with stable sentinels
 * before snapshotting. The CLI surfaces three: the project cwd
 * (`config path` reflects `process.cwd()`), the cache root
 * (XDG_CACHE_HOME tmpdir created per-test), and the inline
 * cache-root variant when no XDG override is set. Snapshots that
 * pin literal paths can't run on a different machine — and don't
 * need to. The contract being pinned is the *shape*, not the
 * specific filesystem layout.
 */
const normalisePaths = (value: unknown, xdg?: string): unknown => {
  const cwd = process.cwd();
  let json = JSON.stringify(value);
  if (xdg !== undefined && xdg.length > 0) {
    json = json.split(xdg).join('<tmpdir>');
  }
  json = json.split(cwd).join('<cwd>');
  return JSON.parse(json) as unknown;
};

describe('envelope snapshot — config', () => {
  it('config show', async () => {
    const out = await drive(['config', 'show', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('config path', async () => {
    const out = await drive(['config', 'path', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(0);
    // `data.cwd` and `data.searched[].path` reflect the cwd at run
    // time. Snapshot the rest by collapsing the cwd to a sentinel.
    expect(normalisePaths(parseEnvelope(out.stdout))).toMatchSnapshot();
  });
});

describe('envelope snapshot — schema', () => {
  it('schema --json full registry envelope shape', async () => {
    // Snapshot the meta + the *count* of commands rather than the
    // entire commands map (~10KB of JSON Schema per command). The
    // snapshot's job is to pin the envelope contract; the per-command
    // schemas are pinned by `tests/e2e/schema.test.ts` (ajv compile).
    const out = await drive(['schema', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as {
      ok: boolean;
      data: { schema_version: string; commands: Record<string, unknown> };
      meta: Readonly<Record<string, unknown>>;
    };
    const { commands, ...dataRest } = env.data;
    const trimmed = {
      ok: env.ok,
      data: { ...dataRest, command_count: Object.keys(commands).length },
      meta: env.meta,
    };
    expect(trimmed).toMatchSnapshot();
  });

  it('schema config.show — single-command narrowing', async () => {
    const out = await drive(['schema', 'config.show', '--json'], {
      interactions: [],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — account', () => {
  it('account whoami', async () => {
    const out = await drive(['account', 'whoami', '--json'], {
      interactions: [
        {
          operation_name: 'Whoami',
          response: {
            data: {
              me: {
                id: '1',
                name: 'Alice',
                email: 'alice@example.test',
                account: { id: '99', name: 'Org', slug: 'org' },
              },
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('account info', async () => {
    const out = await drive(['account', 'info', '--json'], {
      interactions: [
        {
          operation_name: 'AccountInfo',
          response: {
            data: {
              account: {
                id: '99',
                name: 'Org',
                slug: 'org',
                country_code: 'GB',
                first_day_of_the_week: 'monday',
                active_members_count: 7,
                logo: null,
                plan: { version: 1, tier: 'pro', max_users: 100, period: 'annual' },
              },
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('account version', async () => {
    const out = await drive(['account', 'version', '--json'], {
      interactions: [
        {
          operation_name: 'Versions',
          response: {
            data: {
              versions: [
                { display_name: '2026-01', kind: 'current', value: '2026-01' },
                { display_name: '2025-10', kind: 'maintenance', value: '2025-10' },
              ],
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('account complexity', async () => {
    const out = await drive(['account', 'complexity', '--json'], {
      interactions: [
        {
          operation_name: 'ComplexityProbe',
          response: {
            data: {
              complexity: {
                before: 5_000_000,
                after: 4_999_999,
                query: 1,
                reset_in_x_seconds: 30,
              },
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — workspace', () => {
  const sampleWorkspace = {
    id: '5',
    name: 'Engineering',
    description: 'Platform team',
    kind: 'open',
    state: 'active',
    is_default_workspace: false,
    created_at: '2026-04-01T00:00:00Z',
  };

  it('workspace list', async () => {
    const out = await drive(['workspace', 'list', '--json'], {
      interactions: [
        {
          operation_name: 'WorkspaceList',
          response: { data: { workspaces: [sampleWorkspace] } },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('workspace get', async () => {
    const out = await drive(['workspace', 'get', '5', '--json'], {
      interactions: [
        {
          operation_name: 'WorkspaceGet',
          response: {
            data: {
              workspaces: [
                {
                  ...sampleWorkspace,
                  settings: { icon: { color: '#0000FF', image: null } },
                },
              ],
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('workspace folders', async () => {
    const out = await drive(['workspace', 'folders', '5', '--json'], {
      interactions: [
        {
          operation_name: 'WorkspaceFolders',
          response: {
            data: {
              folders: [
                {
                  id: '101',
                  name: 'Roadmap',
                  color: 'aquamarine',
                  created_at: '2026-04-01T00:00:00Z',
                  owner_id: '1',
                  parent: null,
                  children: [{ id: '500', name: 'Q2 plan' }],
                },
              ],
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — board', () => {
  const sampleBoard = {
    id: '111',
    name: 'Tasks',
    description: null,
    state: 'active',
    board_kind: 'public',
    board_folder_id: null,
    workspace_id: '5',
    url: 'https://x.monday.com/boards/111',
    items_count: 7,
    updated_at: '2026-04-30T10:00:00Z',
  };

  it('board list', async () => {
    const out = await drive(['board', 'list', '--json'], {
      interactions: [
        {
          operation_name: 'BoardList',
          response: { data: { boards: [sampleBoard] } },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board get', async () => {
    const out = await drive(['board', 'get', '111', '--json'], {
      interactions: [
        {
          operation_name: 'BoardGet',
          match_variables: { ids: ['111'] },
          response: {
            data: { boards: [{ ...sampleBoard, permissions: 'collaborators' }] },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board find', async () => {
    const out = await drive(['board', 'find', 'Tasks', '--json'], {
      interactions: [
        {
          operation_name: 'BoardFind',
          match_variables: { page: 1 },
          response: {
            data: {
              boards: [
                {
                  id: '111',
                  name: 'Tasks',
                  description: null,
                  state: 'active',
                  board_kind: 'public',
                  workspace_id: '5',
                  url: null,
                },
              ],
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board describe', async () => {
    const out = await describeDrive(['board', 'describe', '111', '--json'], {
      interactions: [boardMetadataInteraction],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board columns', async () => {
    const out = await describeDrive(['board', 'columns', '111', '--json'], {
      interactions: [boardMetadataInteraction],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board groups', async () => {
    const out = await describeDrive(['board', 'groups', '111', '--json'], {
      interactions: [
        {
          operation_name: 'BoardMetadata',
          response: {
            data: {
              boards: [
                {
                  ...sampleBoardMetadata,
                  groups: [
                    {
                      id: 'topics',
                      title: 'Topics',
                      color: 'red',
                      position: '1.000',
                      archived: false,
                      deleted: false,
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board subscribers', async () => {
    const out = await drive(['board', 'subscribers', '111', '--json'], {
      interactions: [
        {
          operation_name: 'BoardSubscribers',
          response: {
            data: {
              boards: [
                {
                  id: '111',
                  subscribers: [
                    {
                      id: '1',
                      name: 'Alice',
                      email: 'alice@example.test',
                      is_guest: false,
                      enabled: true,
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board doctor (healthy)', async () => {
    const out = await doctorDrive(['board', 'doctor', '111', '--json'], {
      interactions: [
        {
          operation_name: 'BoardMetadata',
          response: {
            data: {
              boards: [
                {
                  ...sampleBoardMetadata,
                  // Ensure exactly one writable column (status) so
                  // the diagnostic count is 0.
                  columns: [sampleBoardMetadata.columns[0]],
                },
              ],
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — user', () => {
  const sampleUser = {
    id: '1',
    name: 'Alice',
    email: 'alice@example.test',
    enabled: true,
    is_guest: false,
    is_admin: false,
    is_view_only: false,
    is_pending: false,
    is_verified: true,
    title: null,
    time_zone_identifier: 'Europe/London',
    join_date: '2026-01-01',
    last_activity: '2026-04-30T09:00:00Z',
  };

  it('user list', async () => {
    const out = await drive(['user', 'list', '--json'], {
      interactions: [
        {
          operation_name: 'UserList',
          response: { data: { users: [sampleUser] } },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('user get', async () => {
    const out = await drive(['user', 'get', '1', '--json'], {
      interactions: [
        {
          operation_name: 'UserGet',
          response: {
            data: {
              users: [
                { ...sampleUser, url: 'https://x.monday.com/u/1', country_code: 'GB' },
              ],
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('user me', async () => {
    const out = await drive(['user', 'me', '--json'], {
      interactions: [
        {
          operation_name: 'Whoami',
          response: {
            data: {
              me: {
                id: '1',
                name: 'Alice',
                email: 'alice@example.test',
                account: { id: '99', name: 'Org', slug: 'org' },
              },
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — update', () => {
  const sampleUpdate = {
    id: '77',
    body: '<p>Looks good</p>',
    text_body: 'Looks good',
    creator_id: '1',
    creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
    created_at: '2026-04-30T09:00:00Z',
    updated_at: '2026-04-30T09:01:00Z',
    edited_at: '2026-04-30T09:01:00Z',
    replies: [],
  };

  it('update list', async () => {
    const out = await drive(['update', 'list', '5001', '--json'], {
      interactions: [
        {
          operation_name: 'UpdateList',
          response: {
            data: { items: [{ id: '5001', updates: [sampleUpdate] }] },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('update get', async () => {
    const out = await drive(['update', 'get', '77', '--json'], {
      interactions: [
        {
          operation_name: 'UpdateGet',
          response: {
            data: { updates: [{ ...sampleUpdate, item_id: '5001' }] },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('update create', async () => {
    const out = await drive(
      ['update', 'create', '12345', '--body', 'Done — moved to QA.', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateCreate',
            response: {
              data: {
                create_update: {
                  id: '88',
                  body: '<p>Done — moved to QA.</p>',
                  text_body: 'Done — moved to QA.',
                  creator_id: '1',
                  creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
                  item_id: '12345',
                  created_at: '2026-04-30T11:00:00Z',
                  updated_at: '2026-04-30T11:00:00Z',
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — item reads', () => {
  it('item list', async () => {
    const out = await cachedDrive(
      ['item', 'list', '--board', '111', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  { items_page: { cursor: null, items: [sampleItem] } },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item get', async () => {
    const out = await cachedDrive(['item', 'get', '12345', '--json'], {
      interactions: [
        {
          operation_name: 'ItemGet',
          response: { data: { items: [sampleItem] } },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item find', async () => {
    const out = await cachedDrive(
      ['item', 'find', 'Refactor login', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [
                  {
                    items_page: { cursor: null, items: [sampleItem] },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item search', async () => {
    const out = await cachedDrive(
      ['item', 'search', '--board', '111', '--where', 'status=Done', '--json'],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsByColumnValues',
            response: {
              data: {
                items_page_by_column_values: {
                  cursor: null,
                  items: [sampleItem],
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item subitems', async () => {
    const out = await cachedDrive(['item', 'subitems', '12345', '--json'], {
      interactions: [
        {
          operation_name: 'ItemSubitems',
          response: {
            data: {
              items: [
                { id: '12345', subitems: [{ ...sampleItem, id: '99' }] },
              ],
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — item mutations', () => {
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

  it('item set (single, rich)', async () => {
    const out = await cachedDrive(
      ['item', 'set', '12345', 'status=Done', '--board', '111', '--json'],
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
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item set --dry-run (planned_changes envelope)', async () => {
    const out = await cachedDrive(
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
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item set link (M8 firm row — pipe form)', async () => {
    const linkBoard = {
      ...sampleBoardMetadata,
      columns: [
        ...sampleBoardMetadata.columns,
        {
          id: 'site_1',
          title: 'Site',
          type: 'link',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const updatedLinkItem = {
      ...sampleItem,
      column_values: [
        {
          id: 'site_1',
          type: 'link',
          text: 'Example',
          value: '{"url":"https://example.com","text":"Example"}',
          column: { title: 'Site' },
        },
      ],
    };
    const out = await cachedDrive(
      [
        'item',
        'set',
        '12345',
        'site_1=https://example.com|Example',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [linkBoard] } },
          },
          {
            operation_name: 'ItemSetRich',
            response: { data: { change_column_value: updatedLinkItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item set --set-raw (M8 escape hatch — single column)', async () => {
    const updatedRawItem = {
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
    const out = await cachedDrive(
      [
        'item',
        'set',
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
            operation_name: 'ItemSetRich',
            response: { data: { change_column_value: updatedRawItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item clear (single, rich)', async () => {
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
    const out = await cachedDrive(
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
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item update (single, multi --set)', async () => {
    const updatedMultiItem = {
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
          id: 'date4',
          type: 'date',
          text: '2026-05-15',
          value: '{"date":"2026-05-15","time":null}',
          column: { title: 'Due date' },
        },
      ],
    };
    const out = await cachedDrive(
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
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item create (top-level, single --set)', async () => {
    const newItem = {
      id: '99001',
      name: 'Refactor login',
      board: { id: '111' },
      group: { id: 'topics' },
    };
    const out = await cachedDrive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        'status=Done',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemCreateTopLevel',
            response: { data: { create_item: newItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item create --dry-run (top-level planned_changes envelope)', async () => {
    const out = await cachedDrive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--group',
        'topics',
        '--set',
        'status=Done',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [boardMetadataInteraction],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item create subitem (--parent, no --set)', async () => {
    const newSubitem = {
      id: '99100',
      name: 'Subtask 1',
      board: { id: '333' },
      group: { id: 'subitems_topic' },
      parent_item: { id: '12345' },
    };
    const out = await cachedDrive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask 1',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    board: { id: '111', hierarchy_type: 'classic' },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemCreateSubitem',
            response: { data: { create_subitem: newSubitem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item create subitem --dry-run (subitem planned_changes envelope — no board_id)', async () => {
    const out = await cachedDrive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask 1',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    board: { id: '111', hierarchy_type: 'classic' },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item archive (live, --yes)', async () => {
    const archivedItem = { ...sampleItem, state: 'archived' };
    const out = await cachedDrive(
      ['item', 'archive', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchive',
            response: { data: { archive_item: archivedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item archive --dry-run (planned_changes envelope with item snapshot)', async () => {
    const out = await cachedDrive(
      ['item', 'archive', '12345', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchiveRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item delete (live, --yes)', async () => {
    const deletedItem = { ...sampleItem, state: 'deleted' };
    const out = await cachedDrive(
      ['item', 'delete', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDelete',
            response: { data: { delete_item: deletedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item delete --dry-run (planned_changes envelope with item snapshot)', async () => {
    const out = await cachedDrive(
      ['item', 'delete', '12345', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDeleteRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item duplicate (live, two-leg lookup + mutation, with duplicated_from_id)', async () => {
    // Pins the M10 Session B mutation envelope shape — `data` carries
    // the projected new item plus the `duplicated_from_id` lineage
    // echo (cli-design §6.4 line 1827-1831 precedent: per-verb
    // extensions to `data`, mirroring upsert's `created` flag).
    const duplicatedItem = {
      ...sampleItem,
      id: '67890',
      name: 'Refactor login (copy)',
    };
    const out = await cachedDrive(
      ['item', 'duplicate', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: {
              data: { items: [{ id: '12345', board: { id: '111' } }] },
            },
          },
          {
            operation_name: 'ItemDuplicate',
            response: { data: { duplicate_item: duplicatedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item duplicate --with-updates --dry-run (planned_changes envelope with with_updates echo)', async () => {
    // Pins the dry-run envelope shape — diverges from archive +
    // delete only in the additional `with_updates` slot inside
    // planned_changes[0]. `meta.source: "live"` because the source-
    // item read fired (single-leg dry-run; the live path is the
    // two-leg one).
    const out = await cachedDrive(
      ['item', 'duplicate', '12345', '--with-updates', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDuplicateRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item move --to-group (same-board live)', async () => {
    // Pins the M11 same-board mutation envelope — `data` is the §6.2
    // single-resource projection of the moved item with the new
    // `group_id`. `meta.source: "live"` (single-leg, no metadata
    // load).
    const movedItem = {
      ...sampleItem,
      group: { id: 'new_group', title: 'New group' },
    };
    const out = await cachedDrive(
      ['item', 'move', '12345', '--to-group', 'new_group', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemMoveToGroup',
            response: { data: { move_item_to_group: movedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item move --to-group --dry-run (same-board planned_changes envelope)', async () => {
    // Pins the M11 same-board dry-run shape — `operation:
    // "move_item_to_group"`, `to_group_id`, `item: <projected>`.
    // No mutation fires; single-leg ItemMoveRead supplies the
    // snapshot.
    const out = await cachedDrive(
      ['item', 'move', '12345', '--to-group', 'new_group', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item move --to-board (cross-board live with --columns-mapping)', async () => {
    // Pins the M11 cross-board mutation envelope — four-leg flow
    // (source-item read + source + target metadata + the mutation).
    // `data` carries the projected item on the target board.
    // `meta.source` may be `mixed` (the metadata loads can hit cache
    // depending on test ordering); the snapshot pins the byte shape
    // either way.
    const targetBoardMetadata = {
      ...sampleBoardMetadata,
      id: '222',
      name: 'Tasks (target)',
      columns: [
        {
          id: 'status_42',
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
    const movedItem = { ...sampleItem, board: { id: '222' } };
    const out = await cachedDrive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'topics',
        '--to-board',
        '222',
        '--columns-mapping',
        '{"status_4": "status_42"}',
        '--no-cache',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
          {
            ...boardMetadataInteraction,
            match_variables: { ids: ['111'] },
          },
          {
            operation_name: 'BoardMetadata',
            match_variables: { ids: ['222'] },
            response: { data: { boards: [targetBoardMetadata] } },
          },
          {
            operation_name: 'ItemMoveToBoard',
            response: { data: { move_item_to_board: movedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item move --to-board --dry-run (cross-board planned_changes with column_mappings echo)', async () => {
    // Pins the M11 cross-board dry-run shape — `column_mappings:
    // [{source, target}]` enumerates every mapped column (verbatim
    // matches surface explicitly) so agents reading the preview see
    // the exact wire shape Monday will receive.
    const targetBoardMetadata = {
      ...sampleBoardMetadata,
      id: '222',
      name: 'Tasks (target)',
      columns: [
        {
          id: 'status_42',
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
    const out = await cachedDrive(
      [
        'item',
        'move',
        '12345',
        '--to-group',
        'topics',
        '--to-board',
        '222',
        '--columns-mapping',
        '{"status_4": "status_42"}',
        '--dry-run',
        '--no-cache',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemMoveRead',
            response: { data: { items: [sampleItem] } },
          },
          {
            ...boardMetadataInteraction,
            match_variables: { ids: ['111'] },
          },
          {
            operation_name: 'BoardMetadata',
            match_variables: { ids: ['222'] },
            response: { data: { boards: [targetBoardMetadata] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item upsert (create branch live — 0 matches → create_item)', async () => {
    // Pins the M12 mutation envelope for the create branch — `data`
    // carries the projected new item plus `data.operation:
    // "create_item"` per cli-design §6.4. `meta.source: "mixed"`
    // (cache-served metadata + live lookup + live mutation).
    const newItem = {
      ...sampleItem,
      id: '99001',
      name: 'Refactor login',
    };
    const out = await cachedDrive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--set',
        'status=Backlog',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpsertLookup',
            response: {
              data: {
                boards: [{ items_page: { cursor: null, items: [] } }],
              },
            },
          },
          {
            operation_name: 'ItemUpsertCreate',
            response: { data: { create_item: newItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item upsert (update branch live — 1 match → update_item)', async () => {
    // Pins the M12 update branch — `data.operation: "update_item"`,
    // same projected-item shape as `item update` plus the operation
    // discriminator. Synthetic `name` key bundled into
    // change_multiple_column_values per §5.3 step 5.
    const matchedItem = { ...sampleItem };
    const out = await cachedDrive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--set',
        'status=Backlog',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpsertLookup',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '12345', name: 'Refactor login' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemUpsertMulti',
            response: {
              data: { change_multiple_column_values: matchedItem },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item upsert --dry-run (create branch — operation: "create_item")', async () => {
    // Pins the M12 dry-run shape for the create branch — verb-level
    // `operation` in planned_changes plus the M12-specific
    // `match_by` / `matched_count` echoes. `meta.source: "mixed"`
    // (cache-served metadata + live lookup; planCreate's resolution
    // legs hit cache).
    const out = await cachedDrive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--set',
        'status=Backlog',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpsertLookup',
            response: {
              data: { boards: [{ items_page: { cursor: null, items: [] } }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item upsert --dry-run (update branch — operation: "update_item")', async () => {
    // Pins the M12 dry-run shape for the update branch — verb-level
    // operation rewrite (the underlying planChanges produces the
    // wire-name `change_multiple_column_values`; M12 surfaces it as
    // `update_item` for envelope consistency with the live shape).
    const out = await cachedDrive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--set',
        'status=Backlog',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpsertLookup',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '12345', name: 'Refactor login' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item upsert ambiguous_match error envelope (M12 §6.5)', async () => {
    // Pins the M12 error envelope — `error.code: "ambiguous_match"`
    // plus the §6.5 details schema (`board_id`, `match_by`,
    // `match_values`, `matched_count`, `candidates`). No mutation
    // fires; the envelope is the recovery contract.
    const out = await cachedDrive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--set',
        'status=Backlog',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemUpsertLookup',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [
                        { id: '12345', name: 'Refactor login' },
                        { id: '12346', name: 'Refactor login' },
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
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });
});

describe('envelope snapshot — raw', () => {
  it('raw inline query', async () => {
    const out = await drive(['raw', '{ me { id name email } }', '--json'], {
      interactions: [
        {
          response: {
            data: {
              me: { id: '7', name: 'Alice', email: 'alice@example.test' },
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — cache', () => {
  it('cache list (empty cache)', async () => {
    const out = await cacheDrive(['cache', 'list', '--json'], {
      interactions: [],
    });
    expect(out.exitCode).toBe(0);
    expect(
      normalisePaths(parseEnvelope(out.stdout), cacheXdgRoot()),
    ).toMatchSnapshot();
  });

  it('cache stats (empty cache)', async () => {
    const out = await cacheDrive(['cache', 'stats', '--json'], {
      interactions: [],
    });
    expect(out.exitCode).toBe(0);
    expect(
      normalisePaths(parseEnvelope(out.stdout), cacheXdgRoot()),
    ).toMatchSnapshot();
  });

  it('cache clear (empty cache)', async () => {
    const out = await cacheDrive(['cache', 'clear', '--json'], {
      interactions: [],
    });
    expect(out.exitCode).toBe(0);
    expect(
      normalisePaths(parseEnvelope(out.stdout), cacheXdgRoot()),
    ).toMatchSnapshot();
  });
});

describe('envelope snapshot — error envelope', () => {
  // One representative error path so the §6.1 error-envelope shape is
  // pinned alongside the success shape. Other error codes are pinned
  // by the per-command tests (every code has at least one).
  it('not_found on board get', async () => {
    const out = await drive(['board', 'get', '999', '--json'], {
      interactions: [
        { operation_name: 'BoardGet', response: { data: { boards: [] } } },
      ],
    });
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('config_error when MONDAY_API_TOKEN is missing', async () => {
    const out = await drive(['account', 'whoami', '--json'], {
      interactions: [],
    }, { env: {} });
    expect(out.exitCode).toBe(3);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });
});
