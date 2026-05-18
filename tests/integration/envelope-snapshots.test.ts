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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, chmod, writeFile } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import {
  createInlineMultipartFixtureTransport,
} from '../fixtures/multipart-load.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { run } from '../../src/cli/run.js';
import {
  baseOptions,
  drive,
  FIXTURE_API_URL,
  LEAK_CANARY,
  parseEnvelope,
  parseNdjsonStream,
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

  // M14 workspace lifecycle (5 verbs).
  // ─────────────────────────────────────────────────────────────────

  const m14Workspace = {
    ...sampleWorkspace,
    id: '12345',
    name: 'Marketing',
    description: 'EU campaigns',
    kind: 'open',
    is_default_workspace: false,
    created_at: '2026-05-07T11:00:00Z',
    settings: { icon: { color: '#0000FF', image: null } },
  };

  it('workspace create (M14)', async () => {
    const out = await drive(
      ['workspace', 'create', '--name', 'Marketing', '--description', 'EU campaigns', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceCreate',
            response: { data: { create_workspace: m14Workspace } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('workspace update (M14)', async () => {
    const renamedWorkspace = { ...m14Workspace, name: 'Marketing — EU' };
    const out = await drive(
      ['workspace', 'update', '12345', '--name', 'Marketing — EU', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceUpdate',
            response: { data: { update_workspace: renamedWorkspace } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('workspace delete (M14)', async () => {
    const out = await drive(
      ['workspace', 'delete', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceDelete',
            response: { data: { delete_workspace: m14Workspace } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('workspace add-users (M14 — partial-success envelope)', async () => {
    // All-numeric input fans out one WorkspaceAddUsers call per
    // user — the partial-success envelope's `data.results` carries
    // per-user outcomes. Mixed numeric+email is exercised in the
    // dedicated integration tests; the snapshot here pins the
    // simplest happy-path shape.
    const out = await drive(
      ['workspace', 'add-users', '12345', '--users', '7,8', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceAddUsers',
            response: {
              data: {
                add_users_to_workspace: [
                  { id: '7', name: 'Alice', email: 'alice@example.test' },
                ],
              },
            },
          },
          {
            operation_name: 'WorkspaceAddUsers',
            response: {
              data: {
                add_users_to_workspace: [
                  { id: '8', name: 'Bob', email: 'bob@example.test' },
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

  it('workspace remove-users (M14 — partial-success envelope)', async () => {
    const out = await drive(
      ['workspace', 'remove-users', '12345', '--users', '7', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceRemoveUsers',
            response: {
              data: {
                delete_users_from_workspace: [
                  { id: '7', name: 'Alice', email: 'alice@example.test' },
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

  // M15 board lifecycle (6 verbs).
  // ─────────────────────────────────────────────────────────────────

  const m15Board = {
    id: '12345',
    name: 'Engineering',
    description: 'Eng team',
    state: 'active',
    board_kind: 'public',
    board_folder_id: null,
    workspace_id: '5',
    url: 'https://x.monday.com/boards/12345',
    items_count: 0,
    updated_at: '2026-05-07T11:00:00Z',
    permissions: 'everyone',
  };

  it('board create (M15)', async () => {
    const out = await drive(
      ['board', 'create', '--name', 'Engineering', '--workspace', '5', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardCreate',
            response: { data: { create_board: m15Board } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board update (M15)', async () => {
    // Per-attribute fan-out: BoardUpdate → BoardUpdateFinalRead.
    // Force-live final read because Monday's per-attribute mutation
    // returns only the changed slice.
    const renamedBoard = { ...m15Board, name: 'Engineering — EU' };
    const out = await drive(
      ['board', 'update', '12345', '--name', 'Engineering — EU', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardUpdate',
            response: { data: { update_board: 'Engineering — EU' } },
          },
          {
            operation_name: 'BoardUpdateFinalRead',
            response: { data: { boards: [renamedBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board archive (M15)', async () => {
    const out = await drive(
      ['board', 'archive', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardArchive',
            response: { data: { archive_board: { ...m15Board, state: 'archived' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board delete (M15)', async () => {
    const out = await drive(
      ['board', 'delete', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDelete',
            response: { data: { delete_board: { ...m15Board, state: 'deleted' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board duplicate (M15 — wrapped envelope with is_async)', async () => {
    // M15 introduced the wrapped envelope: data: { board, is_async }
    // because Monday's BoardDuplication carries an is_async slot the
    // projection schema doesn't model.
    const duplicatedBoard = { ...m15Board, id: '99999', name: 'Engineering (dup)' };
    const out = await drive(
      ['board', 'duplicate', '12345', '--name', 'Engineering (dup)', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardDuplicate',
            response: {
              data: {
                duplicate_board: {
                  board: duplicatedBoard,
                  is_async: false,
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

  it('board add-users (M15 — partial-success envelope)', async () => {
    const out = await drive(
      ['board', 'add-users', '12345', '--users', '7', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardAddUsers',
            response: {
              data: {
                add_users_to_board: [
                  { id: '7', name: 'Alice', email: 'alice@example.test' },
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

  // M16 board column lifecycle (3 verbs).
  // ─────────────────────────────────────────────────────────────────

  const m16Column = {
    id: 'priority_42',
    title: 'Priority',
    type: 'status',
    description: null,
    archived: false,
    settings_str: '{}',
    width: null,
  };

  it('board column-create (M16)', async () => {
    const out = await drive(
      ['board', 'column-create', '12345', '--type', 'status', '--title', 'Priority', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnCreate',
            response: { data: { create_column: m16Column } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board column-update (M16)', async () => {
    // Live path: ColumnChangeTitle fires directly for --title (no
    // preflight — only --dry-run preflights via loadBoardMetadata).
    // ColumnChangeMetadata fires for --description; this snapshot
    // pins the simplest --title-only case so only one fan-out leg
    // fires.
    const renamedColumn = { ...m16Column, title: 'Severity' };
    const out = await drive(
      ['board', 'column-update', '12345', 'priority_42', '--title', 'Severity', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnChangeTitle',
            response: { data: { change_column_title: renamedColumn } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board column-delete (M16)', async () => {
    const out = await drive(
      ['board', 'column-delete', '12345', 'priority_42', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ColumnDelete',
            response: { data: { delete_column: m16Column } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  // M17 board group lifecycle (5 verbs).
  // ─────────────────────────────────────────────────────────────────

  const m17Group = {
    id: 'topics',
    title: 'Topics',
    color: '#9D99B9',
    archived: false,
    deleted: false,
    position: '1',
  };

  it('board group-create (M17)', async () => {
    const out = await drive(
      ['board', 'group-create', '12345', '--name', 'Topics', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupCreate',
            response: { data: { create_group: m17Group } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board group-update (M17)', async () => {
    // Live path: GroupUpdate fires directly (no preflight — only
    // --dry-run preflights via loadBoardMetadata). update_group
    // returns the full Group projection post-mutation (no force-
    // live final read leg, distinguishing group-update from
    // board-update).
    const renamedGroup = { ...m17Group, title: 'In progress' };
    const out = await drive(
      ['board', 'group-update', '12345', 'topics', '--name', 'In progress', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupUpdate',
            response: { data: { update_group: renamedGroup } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board group-archive (M17 — destructive single-target)', async () => {
    const archivedGroup = { ...m17Group, archived: true };
    const out = await drive(
      ['board', 'group-archive', '12345', 'topics', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupArchive',
            response: { data: { archive_group: archivedGroup } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board group-duplicate (M17)', async () => {
    const duplicatedGroup = { ...m17Group, id: 'topics_dup', title: 'Topics (dup)' };
    const out = await drive(
      ['board', 'group-duplicate', '12345', 'topics', '--name', 'Topics (dup)', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupDuplicate',
            response: { data: { duplicate_group: duplicatedGroup } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board group-delete (M17 — destructive single-target)', async () => {
    const deletedGroup = { ...m17Group, deleted: true };
    const out = await drive(
      ['board', 'group-delete', '12345', 'topics', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'GroupDelete',
            response: { data: { delete_group: deletedGroup } },
          },
        ],
      },
    );
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

  // M13 update mutation surface (8 verbs).
  // ─────────────────────────────────────────────────────────────────

  it('update reply (M13)', async () => {
    const out = await drive(
      ['update', 'reply', '77', '--body', 'Acknowledged.', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateReply',
            response: {
              data: {
                create_update: {
                  id: '88',
                  body: '<p>Acknowledged.</p>',
                  text_body: 'Acknowledged.',
                  creator_id: '1',
                  creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
                  item_id: '12345',
                  created_at: '2026-04-30T11:30:00Z',
                  updated_at: '2026-04-30T11:30:00Z',
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

  // Monday's edit/delete/like/unlike/pin/unpin mutations all
  // return the full Update projection (id + body + text_body +
  // creator + item_id + timestamps) — the M13 mutation envelopes
  // share the shape pinned by `updateProjectionSchema`.
  const m13MutationUpdate = {
    id: '77',
    body: '<p>Looks good</p>',
    text_body: 'Looks good',
    creator_id: '1',
    creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
    item_id: '12345',
    created_at: '2026-04-30T09:00:00Z',
    updated_at: '2026-04-30T09:01:00Z',
  };

  it('update edit (M13)', async () => {
    const out = await drive(
      ['update', 'edit', '77', '--body', 'Edited body', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateEdit',
            response: {
              data: {
                edit_update: {
                  ...m13MutationUpdate,
                  body: '<p>Edited body</p>',
                  text_body: 'Edited body',
                  updated_at: '2026-04-30T11:45:00Z',
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

  it('update delete (M13)', async () => {
    const out = await drive(
      ['update', 'delete', '77', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateDelete',
            response: { data: { delete_update: m13MutationUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('update like (M13)', async () => {
    const out = await drive(
      ['update', 'like', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateLike',
            response: { data: { like_update: m13MutationUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('update unlike (M13)', async () => {
    const out = await drive(
      ['update', 'unlike', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateUnlike',
            response: { data: { unlike_update: m13MutationUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('update pin (M13)', async () => {
    const out = await drive(
      ['update', 'pin', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdatePin',
            response: { data: { pin_to_top: m13MutationUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('update unpin (M13)', async () => {
    const out = await drive(
      ['update', 'unpin', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateUnpin',
            response: { data: { unpin_from_top: m13MutationUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('update clear-all (M13 — partial-success envelope)', async () => {
    // M13's first partial-success consumer. data.results carries
    // per-update outcomes; envelope is ok: true even if every per-
    // update delete fails, because dispatch ran.
    const out = await drive(
      ['update', 'clear-all', '5001', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateClearAllRead',
            response: {
              data: {
                items: [{ id: '5001', updates: [{ id: '101' }, { id: '102' }] }],
              },
            },
          },
          {
            operation_name: 'UpdateClearAllDelete',
            response: { data: { delete_update: { id: '101' } } },
          },
          {
            operation_name: 'UpdateClearAllDelete',
            response: { data: { delete_update: { id: '102' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  // update list per-board (M13 routing variant) and --with-replies
  // are existing-command shape pins per Codex M18 pre-flight
  // open question — both are required envelope snapshots since
  // M13 changed the default-replies behaviour (the v0.2 breaking
  // change) and added the per-board variant.

  it('update list --board (M13 per-board variant)', async () => {
    const out = await drive(
      ['update', 'list', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateListByBoard',
            response: {
              data: { boards: [{ id: '111', updates: [sampleUpdate] }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('update list --with-replies (M13 opt-in nested shape)', async () => {
    const updateWithReplies = {
      ...sampleUpdate,
      replies: [
        { id: '88', body: '<p>reply</p>', text_body: 'reply', creator_id: '2', created_at: '2026-04-30T09:30:00Z' },
      ],
    };
    const out = await drive(
      ['update', 'list', '5001', '--with-replies', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            response: {
              data: { items: [{ id: '5001', updates: [updateWithReplies] }] },
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

  describe('v0.6-M38 file-column friendly --set <file-col>=<path>', () => {
    const fileBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'attachments',
          title: 'Attachments',
          type: 'file',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const sampleFileAsset = {
      id: '555000111',
      name: 'report.pdf',
      url: 'https://files.monday.com/x/report.pdf',
      public_url: 'https://share.monday.com/x',
      file_extension: 'pdf',
      file_size: 17,
      created_at: '2026-06-01T10:30:00Z',
      uploaded_by: { id: '1', name: 'Alice' },
      original_geometry: null,
      url_thumbnail: null,
    };
    let m38Workdir: string;
    let m38ReportPath: string;
    beforeEach(async () => {
      m38Workdir = await mkdtemp(pathJoin(osTmpdir(), 'monday-cli-m38-snap-'));
      m38ReportPath = pathJoin(m38Workdir, 'report.pdf');
      await writeFile(m38ReportPath, 'PDF-bytes-fixture', 'utf8');
    });
    afterEach(async () => {
      await rm(m38Workdir, { recursive: true, force: true });
    });

    it('item set <file-col>=<path> (M38 live dispatch — M31-shaped envelope)', async () => {
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            match_filename: 'report.pdf',
            response: { data: { add_file_to_column: sampleFileAsset } },
          },
        ],
        { assertExhaustive: false },
      );
      const out = await cachedDrive(
        [
          'item',
          'set',
          '12345',
          `attachments=${m38ReportPath}`,
          '--board',
          '111',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(0);
      // The live dispatch envelope is workdir-stable — filename
      // is basename-derived (`report.pdf`); file_size_bytes is
      // the deterministic 17-byte fixture; asset.* echoes the
      // cassette's `sampleFileAsset`. No sentinel substitution
      // needed.
      expect(parseEnvelope(out.stdout)).toMatchSnapshot();
    });

    it('item set <file-col>=<path> --dry-run (M38 D4 planned_changes envelope)', async () => {
      const out = await cachedDrive(
        [
          'item',
          'set',
          '12345',
          `attachments=${m38ReportPath}`,
          '--board',
          '111',
          '--dry-run',
          '--json',
        ],
        {
          interactions: [
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [fileBoard] } },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(0);
      // file_path is the agent-supplied absolute path (workdir-
      // dependent); replace with a sentinel before snapshotting so
      // the snapshot stays workdir-stable.
      const env = parseEnvelope(out.stdout) as ReturnType<
        typeof parseEnvelope
      > & {
        planned_changes?: readonly Record<string, unknown>[];
      };
      if (env.planned_changes !== undefined) {
        env.planned_changes = env.planned_changes.map((pc) => ({
          ...pc,
          file_path: '<workdir>/report.pdf',
        }));
      }
      expect(env).toMatchSnapshot();
    });
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

  it('item clear --where (bulk live with --yes — same envelope shape as item update --where)', async () => {
    // Pins the M12 bulk-clear envelope. `data.summary` carries
    // matched_count / applied_count / board_id; `data.items` is the
    // per-item projected list. `resolved_ids` echoes the agent
    // token → resolved column ID map.
    const cleared = (id: string): typeof sampleItem => ({
      ...sampleItem,
      id,
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
    });
    const out = await cachedDrive(
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
            response: { data: { change_column_value: cleared('5001') } },
          },
          {
            operation_name: 'ItemClearRich',
            response: { data: { change_column_value: cleared('5002') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item clear --where confirmation_required envelope (without --yes / --dry-run)', async () => {
    // Pins the §6.5 confirmation_required envelope shape for bulk
    // clear — same details schema as bulk update (matched_count,
    // where_clauses, board_id). Agents read this envelope to know
    // how many items they're about to mutate before re-running with
    // --yes.
    const out = await cachedDrive(
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
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
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

// =============================================================
// v0.3 — M19–M28 envelope-shape additions (M28 release prep).
//
// Dev namespace envelope shapes (M26a/b) + cross-board search
// (M23) are NOT snapshotted here — their fixture infrastructure
// (per-profile config.toml seeding for dev verbs; per-board
// metadata cassettes for cross-board fan-out) lives in the
// dedicated per-command suites at `tests/integration/commands/
// dev.test.ts` + `m23-cross-board.test.ts` where the envelope-
// shape contract is already pinned by per-test assertions. The
// snapshot suite below targets the v0.3 surfaces whose
// envelopes diverge structurally from v0.1/v0.2: tag reads,
// time-track documentation-only placeholders, the OAuth
// placeholder guard, the diagnostics cluster, board favorites,
// per-item history events, the partial-success bulk envelope,
// and the outbound writes (webhook + notification).
// =============================================================

const { drive: tagsDrive } = useCachedIntegrationEnv(
  'monday-cli-snap-tags-',
);

describe('envelope snapshot — account tags (M19)', () => {
  // Closes the §6.5 `tag_not_found.details.hint` forward reference
  // by surfacing the discovery surface that the friendly tags
  // translator depends on.
  it('account tags (live, populated)', async () => {
    const out = await tagsDrive(['account', 'tags', '--json'], {
      interactions: [
        {
          operation_name: 'AccountTags',
          response: {
            data: {
              account: {
                tags: [
                  { id: '101', name: 'launch' },
                  { id: '202', name: 'priority' },
                ],
              },
            },
          },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('account tags (empty directory)', async () => {
    const out = await tagsDrive(['account', 'tags', '--json'], {
      interactions: [
        {
          operation_name: 'AccountTags',
          response: { data: { account: { tags: [] } } },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — item time-track (M20, documentation-only)', () => {
  // The two verbs are registered for forward-compatibility (agent
  // scripts targeting `monday item time-track start/stop` are
  // stable across the eventual Monday API support). Today they
  // reject every invocation with `usage_error` carrying the
  // empirical-probe context as the hint. The snapshot pins the
  // documentation-only envelope shape so agents see a stable
  // failure surface until the swap.
  it('item time-track start — usage_error (Monday API does not support time-tracking writes)', async () => {
    const out = await drive(
      ['item', 'time-track', 'start', '12345', '--board', '111', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('item time-track stop — usage_error (Monday API does not support time-tracking writes)', async () => {
    const out = await drive(
      ['item', 'time-track', 'stop', '12345', '--board', '111', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });
});

describe('envelope snapshot — auth login placeholder guard (M21 + M28)', () => {
  // M28 pre-flight added a top-of-action guard that throws
  // `usage_error.details.reason: oauth_unregistered` BEFORE any
  // listener bind or wire call when the shipped OAuth credentials
  // are still the `<UNREGISTERED_PENDING_OAUTH_APP>` placeholder
  // AND `__test_oauth_helper` is unset. Test seam is intentionally
  // omitted here so the production-mode guard branch fires.
  it('auth login (placeholder-guard surface)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'monday-cli-snap-auth-'));
    try {
      const { options, captured } = baseOptions({
        argv: [
          'node',
          'monday',
          'auth',
          'login',
          '--profile',
          'work',
          '--json',
        ],
        env: {
          MONDAY_API_URL: FIXTURE_API_URL,
          HOME: home,
          // Intentionally NO __test_oauth_helper — drives the
          // production-mode guard, the v0.3.0 deferral surface.
        },
      });
      const fetchStub = vi.fn();
      vi.stubGlobal('fetch', fetchStub);
      try {
        const result = await run(options);
        expect(result.exitCode).toBe(1);
        expect(parseEnvelope(captured.stderr())).toMatchSnapshot();
        expect(fetchStub).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('envelope snapshot — monday status (M22 --no-probe)', () => {
  // --no-probe suppresses DNS/TCP/TLS/auth so the network probes
  // surface as `skipped:no_probe_flag` and the local probes
  // (cache_writability / redaction_self_test / env_var_pickup)
  // exercise their `ok` arm. Tests against a real tmp HOME so
  // cache_writability lands against a mode-0700 ~/.monday-cli.
  it('monday status --no-probe (overall: ok)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'monday-cli-snap-status-'));
    try {
      const cacheDir = join(home, '.monday-cli');
      await mkdir(cacheDir, { mode: 0o700 });
      await chmod(cacheDir, 0o700);
      const { options, captured } = baseOptions({
        argv: ['node', 'monday', 'status', '--no-probe', '--json'],
        env: {
          MONDAY_API_TOKEN: LEAK_CANARY,
          MONDAY_API_URL: FIXTURE_API_URL,
          HOME: home,
        },
      });
      const result = await run(options);
      expect(result.exitCode).toBe(0);
      // Each probe carries a wall-clock `elapsed_ms` slot — varies
      // per run, so we replace with a stable sentinel before
      // snapshotting (the shape pins the *presence* of the slot, not
      // the literal value). tmpdir paths also collapse to <tmpdir>
      // so the snapshot is portable across machines.
      const raw = JSON.parse(captured.stdout()) as { data: { probes: Record<string, { elapsed_ms?: number }> } };
      for (const probe of Object.values(raw.data.probes)) {
        if (typeof probe.elapsed_ms === 'number') {
          probe.elapsed_ms = 0;
        }
      }
      expect(normalisePaths(raw, home)).toMatchSnapshot();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('envelope snapshot — monday usage (M22)', () => {
  // Per cli-design §11.5.3: `platform_api.daily_limit { base, total }`
  // + `platform_api.daily_analytics.by_day` summed for today's UTC
  // YYYY-MM-DD key. usage_remaining_today clamps at zero when usage
  // exceeds total.
  it('monday usage (live, within budget)', async () => {
    const out = await drive(['usage', '--json'], {
      interactions: [
        {
          operation_name: 'MondayUsage',
          response: {
            data: {
              platform_api: {
                daily_limit: { base: 100, total: 200 },
                daily_analytics: {
                  by_day: [
                    { day: '2026-04-30', usage: 42 },
                  ],
                  last_updated: '2026-04-30T09:55:00Z',
                },
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

describe('envelope snapshot — board favorites (M23)', () => {
  // Two-stage filter+hydrate against `Query.favorites`
  // (polymorphic — Board | Folder | Dashboard | Workspace). The
  // verb filters Stage-1 to Board-typed entries + hydrates via
  // `boards(ids:)` for the row shape. Sort order follows Monday's
  // UI sidebar (Float `position`).
  it('board favorites (empty — Stage 1 short-circuits)', async () => {
    const out = await drive(['board', 'favorites', '--json'], {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: { data: { favorites: [] } },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('board favorites (happy two-stage: Stage 1 filter → Stage 2 hydrate)', async () => {
    const out = await drive(['board', 'favorites', '--json'], {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: {
            data: {
              favorites: [
                { id: 'h1', object: { id: '100', type: 'Board' }, position: 1 },
                { id: 'h2', object: { id: '200', type: 'Folder' }, position: 2 },
                { id: 'h3', object: { id: '300', type: 'Board' }, position: 3 },
              ],
            },
          },
        },
        {
          operation_name: 'BoardFavoritesStage2',
          response: {
            data: {
              boards: [
                {
                  id: '100',
                  name: 'Tasks',
                  state: 'active',
                  workspace_id: '5',
                  url: 'https://example.monday.com/boards/100',
                },
                {
                  id: '300',
                  name: 'Roadmap',
                  state: 'active',
                  workspace_id: '5',
                  url: 'https://example.monday.com/boards/300',
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

describe('envelope snapshot — item history (M24)', () => {
  // Two-source chronological merge: `boards.activity_logs` +
  // `items.updates`. Events sort by `created_at` ascending; ties
  // break by lexicographic `id`. Variant taxonomy:
  // `update_column_value` (item-scoped activity log),
  // `update_posted` / `update_replied` (synthesized from
  // `items.updates`). Board-scoped activity-log entries filtered
  // out by `entity = 'pulse'`.
  it('item history (happy — mixed activity + update events)', async () => {
    const out = await drive(
      ['item', 'history', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: {
              data: { items: [{ id: '12345', board: { id: '111' } }] },
            },
          },
          {
            operation_name: 'ItemHistoryActivityLogs',
            response: {
              data: {
                boards: [
                  {
                    id: '111',
                    activity_logs: [
                      {
                        id: 'al-1',
                        event: 'update_column_value',
                        entity: 'pulse',
                        user_id: '7',
                        created_at: '2026-04-29T11:00:00Z',
                        data: JSON.stringify({
                          column_id: 'status',
                          column_type: 'status',
                          value: JSON.stringify({ label: 'Done', index: 1 }),
                          previous_value: JSON.stringify({
                            label: 'Working on it',
                            index: 0,
                          }),
                          textual_value: 'Done',
                          pulse_id: '12345',
                          pulse_name: 'Refactor login',
                        }),
                      },
                    ],
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemHistoryUpdates',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    updates: [
                      {
                        id: 'u-1',
                        body: '<p>Shipped in PR #1234</p>',
                        text_body: 'Shipped in PR #1234',
                        created_at: '2026-04-29T12:00:00Z',
                        edited_at: '2026-04-29T12:00:00Z',
                        creator_id: '7',
                        replies: [],
                      },
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
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('item history — usage_error on invalid --since', async () => {
    const out = await drive(
      ['item', 'history', '12345', '--since', 'not-a-date', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });
});

describe('envelope snapshot — item update --continue-on-error (M25 partial-success bulk)', () => {
  // cli-design §6.4 "Bulk per-item partial-success" — top-level
  // ok: true whenever dispatch ran; per-item outcomes in
  // data.results; data.summary.failed_count joins matched_count
  // + applied_count (matched_count === applied_count +
  // failed_count). resolved_ids echo unchanged.
  it('item update --where --continue-on-error (all-success branch)', async () => {
    const buildItem = (id: string): typeof sampleItem => ({
      ...sampleItem,
      id,
      name: `Item ${id}`,
    });
    const out = await cachedDrive(
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
        '--continue-on-error',
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
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — webhook (M27)', () => {
  // M27 wraps `webhooks(board_id:)` + `create_webhook` +
  // `delete_webhook`. Webhooks are live-only (outside cli-design
  // §8 cache scope); the `webhook create` envelope echoes the
  // wire `Webhook` projection; `webhook delete --dry-run` is
  // strictly argv-derived (no pre-mutation read).
  it('webhook list (happy — two entries)', async () => {
    const out = await drive(
      ['webhook', 'list', '12345678', '--json'],
      {
        interactions: [
          {
            operation_name: 'Webhooks',
            response: {
              data: {
                webhooks: [
                  {
                    id: '88001',
                    board_id: '12345678',
                    event: 'create_item',
                    config: null,
                  },
                  {
                    id: '88002',
                    board_id: '12345678',
                    event: 'change_status_column_value',
                    config: '{"columnId":"status"}',
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

  it('webhook create (live mutation envelope)', async () => {
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'create_item',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'CreateWebhook',
            response: {
              data: {
                create_webhook: {
                  id: '88001',
                  board_id: '12345678',
                  event: 'create_item',
                  config: null,
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

  it('webhook create --dry-run (strictly argv-derived planned envelope)', async () => {
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'create_item',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('webhook delete (confirmation_required without --yes / --dry-run)', async () => {
    const out = await drive(
      ['webhook', 'delete', '88001', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });
});

describe('envelope snapshot — notification (M27)', () => {
  // `--target-type item|board` argv collapses to wire
  // `NotificationTargetType.Project` at the fetcher boundary; the
  // CLI-declared kind is echoed in the envelope but NOT verified
  // against the underlying record (Monday only validates target
  // visibility as a `Project`). `--dry-run` is strictly argv-
  // derived.
  it('notification send (live, --target-type item)', async () => {
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '7',
        '--target',
        '12345',
        '--target-type',
        'item',
        '--text',
        'Heads up on this one',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'CreateNotification',
            response: {
              data: {
                create_notification: {
                  id: 'n-1',
                  text: 'Heads up on this one',
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

  it('notification send --dry-run (strictly argv-derived planned envelope)', async () => {
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '7',
        '--target',
        '12345',
        '--target-type',
        'item',
        '--text',
        'Heads up on this one',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — item watch (M29)', () => {
  // M29 ships the first long-poll streaming verb: an NDJSON stream
  // of one event record per emitted activity-log row, terminated by
  // a `{"_meta": {...}}` trailer carrying the seven M29 slots flat
  // (events_emitted / polls_made / failed_polls / last_seen_event_id
  // / circuit_broken_at / exit_reason / watch_duration_seconds /
  // warnings / source). Snapshot pins the per-event projection shape
  // + the trailer key set; `watch_duration_seconds` is wall-clock-
  // dependent so we collapse it to a sentinel before snapshot.
  const ITEM_ID = '12345';
  const BOARD_ID = '67890';

  const validItemBoardLookup = {
    operation_name: 'ItemBoardLookup',
    response: { data: { items: [{ id: ITEM_ID, board: { id: BOARD_ID } }] } },
  } as const;

  const pollResponse = (
    rows: readonly { readonly id: string; readonly created_at: string }[],
  ) => ({
    operation_name: 'ItemWatchPoll',
    response: {
      data: {
        boards: [
          {
            id: BOARD_ID,
            activity_logs: rows.map((r) => ({
              id: r.id,
              event: 'update_column_value',
              entity: 'pulse',
              user_id: '99',
              created_at: r.created_at,
              data: JSON.stringify({
                column_id: 'status',
                column_type: 'status',
                value: JSON.stringify({ label: 'Done', index: 1 }),
                previous_value: JSON.stringify({
                  label: 'In progress',
                  index: 0,
                }),
                textual_value: 'Done',
                pulse_id: ITEM_ID,
                pulse_name: 'Refactor login',
              }),
            })),
          },
        ],
      },
    },
  });

  // NDJSON stream parser: returns the per-event records + trailer.
  // `watch_duration_seconds` is wall-clock-dependent — normalise to
  // a sentinel so the snapshot stays deterministic across runs.
  const parseStreamSnapshot = (stdout: string): unknown => {
    const { records, trailer } = parseNdjsonStream(stdout, {
      normaliseTrailerField: (key, value) =>
        key === 'watch_duration_seconds' && typeof value === 'number'
          ? '<watch_duration_seconds:number>'
          : value,
    });
    return { events: records, trailer };
  };

  it('item watch --once (single-event backlog → one event record + trailer)', async () => {
    const out = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      {
        interactions: [
          validItemBoardLookup,
          pollResponse([{ id: '1001', created_at: '2026-05-13T10:00:00Z' }]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe('');
    expect(parseStreamSnapshot(out.stdout)).toMatchSnapshot();
  });

  it('item watch --once (empty backlog → trailer only, no event records)', async () => {
    const out = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      {
        interactions: [validItemBoardLookup, pollResponse([])],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseStreamSnapshot(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — doc list (M32)', () => {
  // M32 ships `doc list` as the first wrapped-paginated-record
  // envelope on a read surface (`emitSuccess(kind: 'single')` carrying
  // `{documents, page, limit, returned_count, has_more}` — see
  // R-NEW-74 watch-item). Snapshot pins both the empty + populated
  // shapes; the empty shape is structurally distinct from a flat
  // list because the wrapper slots (`page`/`limit`/`returned_count`/
  // `has_more`) still surface.
  const wireDoc = (
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    id: '88001',
    object_id: '99001',
    name: 'Sprint planning notes',
    doc_kind: 'public',
    url: 'https://example.monday.com/docs/88001',
    relative_url: '/docs/88001',
    workspace_id: '12345',
    workspace: { id: '12345', name: 'Engineering' },
    doc_folder_id: null,
    created_at: '2026-05-01T12:00:00Z',
    created_by: { id: '7', name: 'Nick Webster' },
    updated_at: '2026-05-13T14:00:00Z',
    settings: { theme: 'default' },
    ...overrides,
  });

  it('doc list (empty account — wrapped record with documents: [])', async () => {
    const out = await drive(['doc', 'list', '--json'], {
      interactions: [
        {
          operation_name: 'ListDocs',
          response: { data: { docs: [] } },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc list (populated — two docs, live source, has_more heuristic)', async () => {
    const out = await drive(['doc', 'list', '--json'], {
      interactions: [
        {
          operation_name: 'ListDocs',
          response: {
            data: {
              docs: [
                wireDoc(),
                wireDoc({ id: '88002', name: 'Retro notes', doc_kind: 'private' }),
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

describe('envelope snapshot — doc get (M32)', () => {
  // M32 `doc get <did>` direct-unwraps `data: <Document with
  // blocks>` (in contrast to `doc list`'s wrapped record). Two
  // snapshot variants: the happy with `blocks: [...]` hydration, and
  // the D8 `not_found` envelope when `docs: []` (Monday returns
  // empty when the doc doesn't exist OR is inaccessible to the
  // caller's token — single error code per D8 closure).
  const wireBlock = (
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    id: 'block-a',
    type: 'text',
    content: { ops: [{ insert: 'hello world' }] },
    position: 1,
    parent_block_id: null,
    doc_id: '88001',
    created_at: '2026-05-01T12:00:00Z',
    created_by: { id: '7', name: 'Nick Webster' },
    updated_at: '2026-05-01T12:00:00Z',
    ...overrides,
  });

  const wireDoc = (
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    id: '88001',
    object_id: '99001',
    name: 'Sprint planning notes',
    doc_kind: 'public',
    url: 'https://example.monday.com/docs/88001',
    relative_url: '/docs/88001',
    workspace_id: '12345',
    workspace: { id: '12345', name: 'Engineering' },
    doc_folder_id: null,
    created_at: '2026-05-01T12:00:00Z',
    created_by: { id: '7', name: 'Nick Webster' },
    updated_at: '2026-05-13T14:00:00Z',
    settings: { theme: 'default' },
    blocks: [wireBlock(), wireBlock({ id: 'block-b', position: 2 })],
    ...overrides,
  });

  it('doc get (happy with blocks hydrated — direct-unwrap envelope)', async () => {
    const out = await drive(['doc', 'get', '88001', '--json'], {
      interactions: [
        {
          operation_name: 'GetDoc',
          response: { data: { docs: [wireDoc()] } },
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc get not_found envelope (docs: [] — D8 closure)', async () => {
    const out = await drive(['doc', 'get', '99999', '--json'], {
      interactions: [
        {
          operation_name: 'GetDoc',
          response: { data: { docs: [] } },
        },
      ],
    });
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });
});

describe('envelope snapshot — completion (M33)', () => {
  // M33 ships `monday completion <bash|zsh|fish>` as the first
  // raw-bytes-carve-out verb (cli-design §3.1 #2). Default mode
  // emits the install-time script on stdout WITHOUT the §6 envelope
  // wrap (so `monday completion bash >> ~/.bashrc` works as a
  // sourceable file). The `--json` / `--output json` /
  // `MONDAY_OUTPUT=json` paths opt INTO the envelope with
  // `data: { shell, script }` + `meta.source: "none"` (CLI-internal
  // verb — no Monday wire call, no cache).
  //
  // Snapshot pins the §6 envelope shape for all three shell
  // targets; `data.script` is collapsed to a sentinel because
  // per-shell template bytes are pinned by the dedicated
  // `tests/integration/commands/completion.test.ts` (registry-
  // sync invariant + per-target sanity asserts), and the script
  // body grows every time the command registry changes — pinning
  // length here would churn this snapshot on every verb addition.
  // The script is asserted non-empty as a separate per-shell
  // expectation below.
  const normaliseCompletion = (
    raw: string,
  ): Readonly<Record<string, unknown>> => {
    const env = JSON.parse(raw) as {
      ok: boolean;
      data: { shell: string; script: string };
      meta: Record<string, unknown>;
      warnings: readonly unknown[];
    };
    expect(env.data.script.length).toBeGreaterThan(0);
    return {
      ok: env.ok,
      data: {
        shell: env.data.shell,
        script: '<script:non-empty>',
      },
      meta: env.meta,
      warnings: env.warnings,
    };
  };

  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    it(`completion ${shell} --json (§6 envelope wraps the script)`, async () => {
      const out = await drive(['completion', shell, '--json'], {
        interactions: [],
      });
      expect(out.exitCode).toBe(0);
      expect(normaliseCompletion(out.stdout)).toMatchSnapshot();
    });
  }

  it('completion --table (usage_error — only --json + raw-bytes default supported)', async () => {
    const out = await drive(['completion', 'bash', '--table'], {
      interactions: [],
    });
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('completion <invalid-shell> (usage_error from parseArgv boundary)', async () => {
    const out = await drive(['completion', 'powershell', '--json'], {
      interactions: [],
    });
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });
});

describe('envelope snapshot — team (v0.5-M34)', () => {
  // M34 wraps `Query.teams` (list + get), `create_team`,
  // `delete_team`, `add_users_to_team`, `remove_users_from_team`.
  // Teams are live-only (outside cli-design §8 cache scope); the
  // membership verbs project Monday's `ChangeTeamMembershipsResult`
  // (failed_users + successful_users) into the universal §6.1
  // partial-success envelope (`data.results: [{user_id, ok, ...}]`).
  const wireUser = (id: string) => ({
    id,
    name: `User ${id}`,
    email: `user${id}@example.test`,
  });

  it('team-list (happy — two teams)', async () => {
    const out = await drive(
      ['user', 'team-list', '--json'],
      {
        interactions: [
          {
            operation_name: 'ListTeams',
            response: {
              data: {
                teams: [
                  {
                    id: '11001',
                    name: 'Backend Engineering',
                    picture_url: null,
                    is_guest: false,
                    users: [wireUser('67890')],
                    owners: [wireUser('999')],
                  },
                  {
                    id: '11002',
                    name: 'Sales',
                    picture_url: null,
                    is_guest: true,
                    users: [],
                    owners: [wireUser('888')],
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

  it('team-list (empty account)', async () => {
    const out = await drive(
      ['user', 'team-list', '--json'],
      {
        interactions: [
          {
            operation_name: 'ListTeams',
            response: { data: { teams: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('team-get (happy)', async () => {
    const out = await drive(
      ['user', 'team-get', '11001', '--json'],
      {
        interactions: [
          {
            operation_name: 'GetTeam',
            response: {
              data: {
                teams: [
                  {
                    id: '11001',
                    name: 'Backend Engineering',
                    picture_url: null,
                    is_guest: false,
                    users: [wireUser('67890'), wireUser('67891')],
                    owners: [wireUser('999')],
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

  it('team-get (not_found — D8 collapse of doesn\'t-exist + inaccessible)', async () => {
    const out = await drive(
      ['user', 'team-get', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'GetTeam',
            response: { data: { teams: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('team-create (live mutation envelope)', async () => {
    const out = await drive(
      ['user', 'team-create', '--name', 'Backend Eng', '--json'],
      {
        interactions: [
          {
            operation_name: 'CreateTeam',
            response: {
              data: {
                create_team: {
                  id: '11005',
                  name: 'Backend Eng',
                  picture_url: null,
                  is_guest: false,
                  users: [],
                  owners: [wireUser('999')],
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

  it('team-create --dry-run (argv-derived planned envelope with all optional fields)', async () => {
    const out = await drive(
      [
        'user',
        'team-create',
        '--name',
        'Vendors',
        '--users',
        '67890,67891',
        '--guest-team',
        '--allow-empty',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('team-delete (confirmation_required without --yes / --dry-run)', async () => {
    const out = await drive(
      ['user', 'team-delete', '11001', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('team-delete --dry-run (argv-derived minimal planned envelope)', async () => {
    const out = await drive(
      ['user', 'team-delete', '11001', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('team-delete --yes (live mutation envelope echoes deleted Team)', async () => {
    const out = await drive(
      ['user', 'team-delete', '11001', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'DeleteTeam',
            response: {
              data: {
                delete_team: {
                  id: '11001',
                  name: 'Doomed Team',
                  picture_url: null,
                  is_guest: false,
                  users: [wireUser('67890')],
                  owners: [wireUser('999')],
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

  it('team-add-members (partial-success envelope with input-order preserved)', async () => {
    const out = await drive(
      [
        'user',
        'team-add-members',
        '11001',
        '--users',
        '67890,67891,67892',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'AddUsersToTeam',
            response: {
              data: {
                add_users_to_team: {
                  failed_users: [wireUser('67891')],
                  successful_users: [wireUser('67890'), wireUser('67892')],
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

  it('team-add-members --dry-run (argv-derived planned envelope)', async () => {
    const out = await drive(
      [
        'user',
        'team-add-members',
        '11001',
        '--users',
        '67890,67891',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('team-remove-members (partial-success envelope with input-order preserved)', async () => {
    const out = await drive(
      ['user', 'team-remove-members', '11001', '--users', '67890,67891', '--json'],
      {
        interactions: [
          {
            operation_name: 'RemoveUsersFromTeam',
            response: {
              data: {
                remove_users_from_team: {
                  failed_users: [wireUser('67890')],
                  successful_users: [wireUser('67891')],
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

describe('envelope snapshot — doc CRUD (v0.5-M35)', () => {
  // M35 wraps `create_doc` (2 CLI verbs per D7 — workspace vs board
  // placement), `update_doc_name`, `delete_doc`, `duplicate_doc`.
  // Doc mutations are live-only (outside cli-design §8 cache scope);
  // 3 of 4 wire mutations return Monday's opaque `JSON` scalar +
  // project to the flat `{doc_id, success: true}` envelope per D9
  // (rename / delete echo input id; duplicate carries the NEW id).
  const wireDoc = (
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    id: '88010',
    object_id: '99010',
    name: 'Q4 launch plan',
    doc_kind: 'public',
    url: 'https://example.monday.com/docs/88010',
    relative_url: '/docs/88010',
    workspace_id: '5555',
    workspace: { id: '5555', name: 'Engineering' },
    doc_folder_id: null,
    created_at: '2026-05-15T12:00:00Z',
    created_by: { id: '7', name: 'Nick Webster' },
    updated_at: '2026-05-15T12:00:00Z',
    settings: null,
    ...overrides,
  });

  it('doc create-in-workspace (live mutation envelope — Document with blocks omitted)', async () => {
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        'Q4 launch plan',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'CreateDocInWorkspace',
            response: { data: { create_doc: wireDoc() } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc create-in-workspace --dry-run (argv-derived planned with all optional fields)', async () => {
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        'Confidential plan',
        '--folder',
        '12345',
        '--kind',
        'private',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc create-on-column (live mutation envelope)', async () => {
    const out = await drive(
      [
        'doc',
        'create-on-column',
        '--item',
        '12345',
        '--column',
        'doc_column_1',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'CreateDocOnColumn',
            response: { data: { create_doc: wireDoc({ id: '88020' }) } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc create-on-column --dry-run (argv-derived minimal planned envelope)', async () => {
    const out = await drive(
      [
        'doc',
        'create-on-column',
        '--item',
        '12345',
        '--column',
        'doc_column_1',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc rename (live opaque-JSON projection echoes input doc_id)', async () => {
    const out = await drive(
      ['doc', 'rename', '88010', '--name', 'Revised plan', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateDocName',
            response: { data: { update_doc_name: {} } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc rename --dry-run (argv-derived planned envelope)', async () => {
    const out = await drive(
      [
        'doc',
        'rename',
        '88010',
        '--name',
        'Revised plan',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc delete (confirmation_required without --yes / --dry-run)', async () => {
    const out = await drive(
      ['doc', 'delete', '88010', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('doc delete --dry-run (argv-derived minimal planned envelope)', async () => {
    const out = await drive(
      ['doc', 'delete', '88010', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc delete --yes (live opaque-JSON projection echoes input doc_id)', async () => {
    const out = await drive(
      ['doc', 'delete', '88010', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'DeleteDoc',
            response: { data: { delete_doc: { success: true } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc duplicate (live opaque-JSON projection carries NEW doc_id)', async () => {
    const out = await drive(
      ['doc', 'duplicate', '88010', '--json'],
      {
        interactions: [
          {
            operation_name: 'DuplicateDoc',
            response: { data: { duplicate_doc: { id: '88099' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc duplicate --with-updates --dry-run (argv-derived planned with duplicate_type)', async () => {
    const out = await drive(
      [
        'doc',
        'duplicate',
        '88010',
        '--with-updates',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});

describe('envelope snapshot — per-block CRUD (v0.5-M36) + doc-content import (v0.5-M37)', () => {
  // M36 wraps `create_doc_block` + `update_doc_block` +
  // `delete_doc_block`. M37 wraps `import_doc_from_html` +
  // `add_content_to_doc_from_markdown`. Snapshots cover the
  // parse-boundary usage_error rejections + destructive-gate
  // confirmation_required + dry-run envelopes; live-mutation
  // envelopes are pinned in the per-verb integration test files
  // (doc-block-create / update / delete + doc-import-html /
  // append-markdown) where cassettes thread the wire response shape.
  //
  // Pre-Codex-IMPL-round-5: M37 cases lived inside the M36 describe
  // block (vestige of the M37 pre-flight commit that added them
  // mid-block). The describe-title widening here keeps the M37
  // snapshot keys readable (they prepend the describe title) without
  // moving the snapshot bodies — see Codex IMPL round-5 P3-1.

  it('doc block-create rejects unknown --type at parse boundary (D10)', async () => {
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'not-a-block-type',
        '--content',
        '{}',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('doc block-create rejects malformed --content JSON at parse boundary', async () => {
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'normal_text',
        '--content',
        '{not valid json',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('doc block-create dry-run envelope (planned_changes shape)', async () => {
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'normal_text',
        '--content',
        '{"alignment":"left","content":"Hello"}',
        '--after',
        'blk_anchor',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc block-update dry-run envelope (planned_changes shape)', async () => {
    const out = await drive(
      [
        'doc',
        'block-update',
        'blk_abc123',
        '--content',
        '{"alignment":"center","content":"Hi"}',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc block-delete (confirmation_required without --yes / --dry-run)', async () => {
    const out = await drive(
      ['doc', 'block-delete', 'blk_abc123', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('doc block-delete dry-run envelope (planned_changes shape)', async () => {
    const out = await drive(
      ['doc', 'block-delete', 'blk_abc123', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  // ---------------------------------------------------------------
  // v0.5-M37 doc-content import (`import-html` + `append-markdown`)
  // — parse-boundary rejections + dry-run success envelopes (runtime
  // body landed at M37 IMPL; per-verb integration tests with wire
  // fixture cassettes live in `tests/integration/commands/doc-
  // import-html.test.ts` + `doc-append-markdown.test.ts`). No
  // `confirmation_required` snapshot — both verbs are content-creation
  // (0 destructive verbs at M37).
  // ---------------------------------------------------------------

  it('doc import-html rejects mutual exclusion of --html / --html-string', async () => {
    const out = await drive(
      [
        'doc',
        'import-html',
        '--workspace',
        '5555',
        '--html',
        './plan.html',
        '--html-string',
        '<h1>x</h1>',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('doc import-html rejects neither --html nor --html-string (mutex)', async () => {
    const out = await drive(
      ['doc', 'import-html', '--workspace', '5555', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('doc import-html rejects unknown --kind at parse boundary', async () => {
    const out = await drive(
      [
        'doc',
        'import-html',
        '--workspace',
        '5555',
        '--html-string',
        '<h1>x</h1>',
        '--kind',
        'not-a-kind',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('doc import-html rejects oversized --html-string at parse boundary (D13)', async () => {
    // 256_001 bytes — one byte over MAX_DOC_IMPORT_PAYLOAD_BYTES.
    // Surfaces as `usage_error.details.issues[{path: 'htmlString',
    // message: '...exceeds the 256000-byte wire-side limit...'}]`
    // from `parseArgv`'s zod-issues envelope (D13 closure prose
    // ratified at Codex pre-flight round 1 P2-1 — the prose claim
    // is the actual `details.issues[]` envelope shape, NOT a
    // top-level `details.reason: 'payload_too_large'` slot).
    const oversized = 'x'.repeat(256_001);
    const out = await drive(
      [
        'doc',
        'import-html',
        '--workspace',
        '5555',
        '--html-string',
        oversized,
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    // Trim the issue message to a sentinel before snapshotting so
    // the 256_001-byte literal doesn't bloat the snapshot file; the
    // shape (path/message envelope) is what we pin.
    const env = parseEnvelope(out.stderr);
    if (
      !env.ok
      && typeof env.error?.details === 'object'
      && env.error.details !== null
      && Array.isArray((env.error.details as Record<string, unknown>).issues)
    ) {
      const issues = (env.error.details as { issues: { message?: unknown }[] }).issues;
      for (const issue of issues) {
        if (typeof issue.message === 'string') {
          issue.message = '<oversized-string-rejection-message>';
        }
      }
    }
    expect(env).toMatchSnapshot();
  });

  it('doc import-html dry-run envelope (planned_changes shape)', async () => {
    const out = await drive(
      [
        'doc',
        'import-html',
        '--workspace',
        '5555',
        '--html-string',
        '<h1>Plan</h1>',
        '--folder',
        '12345',
        '--kind',
        'private',
        '--title',
        'Q4 plan',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    // M37 IMPL: dry-run path emits a `success: true` envelope with
    // `planned_changes: [{operation: 'import_doc_from_html', ...}]`
    // + `meta.dry_run: true` + `meta.source: 'none'`. The HTML payload
    // itself is omitted from the envelope; only the `html_source`
    // descriptor (`'(inline)'` for `--html-string`; `'(stdin)'` for
    // `--html -`; the literal path for `--html <file>`) lands so
    // agents see WHAT would be sent without the bytes.
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });

  it('doc append-markdown rejects mutual exclusion of --markdown / --markdown-string', async () => {
    const out = await drive(
      [
        'doc',
        'append-markdown',
        '88010',
        '--markdown',
        './notes.md',
        '--markdown-string',
        '# x',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('doc append-markdown rejects neither --markdown nor --markdown-string (mutex)', async () => {
    const out = await drive(
      ['doc', 'append-markdown', '88010', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('doc append-markdown rejects non-numeric <doc-id> via DocId brand', async () => {
    const out = await drive(
      [
        'doc',
        'append-markdown',
        'not-numeric',
        '--markdown-string',
        '# x',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr)).toMatchSnapshot();
  });

  it('doc append-markdown rejects oversized --markdown-string at parse boundary (D13)', async () => {
    // Parallel-sibling snapshot to the `import-html` oversized test
    // above — added at the post-M37-pre-flight refactor-audit per
    // R-v0.5-NEW-9 (round-N parallel-fetcher fix-up test parity
    // discipline) 2nd supporting instance. Round-1 M37 fix-up added
    // the oversized snapshot for `import-html` only; this mirror
    // pin closes the parity gap so a future refactor that drops
    // either size-guard `.refine()` regresses ONE consumer
    // visibly + makes the gap-class drift catchable by gates rather
    // than the next audit pass.
    const oversized = 'x'.repeat(256_001);
    const out = await drive(
      [
        'doc',
        'append-markdown',
        '88010',
        '--markdown-string',
        oversized,
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    // Same sentinel-trim as the `import-html` mirror — the 256_001-
    // byte literal would bloat the snapshot; the shape (path /
    // message envelope) is what we pin.
    const env = parseEnvelope(out.stderr);
    if (
      !env.ok
      && typeof env.error?.details === 'object'
      && env.error.details !== null
      && Array.isArray((env.error.details as Record<string, unknown>).issues)
    ) {
      const issues = (env.error.details as { issues: { message?: unknown }[] }).issues;
      for (const issue of issues) {
        if (typeof issue.message === 'string') {
          issue.message = '<oversized-string-rejection-message>';
        }
      }
    }
    expect(env).toMatchSnapshot();
  });

  it('doc append-markdown dry-run envelope (planned_changes shape)', async () => {
    const out = await drive(
      [
        'doc',
        'append-markdown',
        '88010',
        '--markdown-string',
        '# Heading\n\nBody',
        '--after',
        'blk_anchor',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    // M37 IMPL: dry-run path emits a `success: true` envelope with
    // `planned_changes: [{operation: 'add_content_to_doc_from_markdown',
    // doc_id, after_block_id?, markdown_source}]` + `meta.dry_run:
    // true` + `meta.source: 'none'`. The markdown payload itself is
    // omitted; only the `markdown_source` descriptor lands.
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout)).toMatchSnapshot();
  });
});
