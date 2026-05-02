/**
 * Integration tests for `monday item create` (M9 §5.8 single-round-trip
 * + §6.4 item-create shape + classic-only subitem gate).
 *
 * Coverage map (per `v0.2-plan.md` §3 M9 + cli-design §5.8 / §6.4):
 *
 *   - Argv-parser rules: `--name` empty after trim, `--position`
 *     requires `--relative-to`, `--parent` mutex with `--group` /
 *     `--position` / `--board`, multiple `--set` against same token.
 *   - Top-level happy path: default group, multiple `--set`,
 *     `resolved_ids` echo, mutation envelope shape pinned.
 *   - Position path: `before` + `after` (PositionRelative wire-enum
 *     mapping) + `--relative-to` same-board verification.
 *   - Subitem path: parent lookup, hierarchy_type gate (classic vs
 *     multi_level), subitems-board derivation from
 *     `subtasks.settings_str.boardIds[0]`, subitem mutation envelope
 *     with `parent_id`.
 *   - Error paths: parent `not_found`, relative-to `not_found`,
 *     wrong-board `--relative-to`, multi-level rejection,
 *     `validation_failed` from Monday on the create wire.
 *   - Dry-run: top-level `create_item` AND subitem `create_subitem`
 *     planned-change shapes pinned (per Codex round-4 P2 — both
 *     §9 preconditions).
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
  useItemTestEnv,
} from './_item-fixtures.js';

const { drive, xdgRoot } = useItemTestEnv();

// Top-level item the create_item mutation returns. Matches the
// `id`, `name`, `board { id }`, `group { id }` projection the
// CREATE_ITEM_MUTATION selects.
const newItem = {
  id: '99001',
  name: 'Refactor login',
  board: { id: '111' },
  group: { id: 'topics' },
};

// Subitems board metadata — distinct id (`333`), referenced from the
// parent board's subtasks column's settings_str.boardIds[0].
const subitemsBoardMetadata = {
  ...sampleBoardMetadata,
  id: '333',
  name: 'Subitems of Tasks',
  columns: [
    {
      id: 'sub_status_1',
      title: 'Status',
      type: 'status',
      description: null,
      archived: null,
      settings_str: '{}',
      width: null,
    },
  ],
};

// Parent board metadata extended with a `subtasks` column that points
// at the subitems board id `333`.
const parentBoardWithSubtasks = {
  ...sampleBoardMetadata,
  columns: [
    ...sampleBoardMetadata.columns,
    {
      id: 'subtasks_1',
      title: 'Subitems',
      type: 'subtasks',
      description: null,
      archived: null,
      settings_str: '{"boardIds":["333"]}',
      width: null,
    },
  ],
};

const newSubitem = {
  id: '99100',
  name: 'Subtask 1',
  board: { id: '333' },
  group: { id: 'subitems_topic' },
  parent_item: { id: '12345' },
};

// ============================================================
// Argv-parser rules (Unit-style, driven through the runner so the
// real Commander + zod parse path is exercised — same rule as the
// M5b integration tests).
// ============================================================

describe('monday item create — argv parsing', () => {
  it('--name empty after trim → usage_error', async () => {
    const out = await drive(
      ['item', 'create', '--board', '111', '--name', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--position without --relative-to → usage_error', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--position',
        'before',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/--position and --relative-to/u);
  });

  it('--relative-to without --position → usage_error', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--relative-to',
        '99999',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--parent + --group → usage_error (subitems live on the subitems board, not in groups)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Test',
        '--group',
        'topics',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(
      /--parent.*mutually exclusive.*--group/u,
    );
  });

  it('--parent + --position → usage_error (subitem position is parent-scoped)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Test',
        '--position',
        'before',
        '--relative-to',
        '99999',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--parent + --board → usage_error (subitems board is server-derived)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Test',
        '--board',
        '111',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(
      /--parent.*mutually exclusive.*--board/u,
    );
  });

  it('top-level without --board → usage_error', async () => {
    const out = await drive(
      ['item', 'create', '--name', 'Test', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/--board.*required/u);
  });

  it('multiple --set against the same token → usage_error (parse-time)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'status=Done',
        '--set',
        'status=Doing',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(
      /Multiple --set.*column token "status"/u,
    );
  });

  it('--set + --set-raw on same token → usage_error (parse-time)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'status=Done',
        '--set-raw',
        'status={"label":"Done"}',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});

// ============================================================
// Top-level happy paths.
// ============================================================

describe('monday item create — top-level (live)', () => {
  it('happy path: --board + --name + multiple --set → create_item with bundled column_values (variables pinned)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        'status=Done',
        '--set',
        'date4=2026-05-01',
        '--json',
      ],
      {
        interactions: [
          // First --set token resolution loads metadata.
          boardMetadataInteraction,
          {
            operation_name: 'ItemCreateTopLevel',
            // Codex M9 P2 #2: pin the wire variables so a regression
            // that drops columnValues, double-encodes the JSON,
            // mis-bundles long_text, or sends top-level columns to
            // create_subitem fails this test loud. Keys mirror the
            // mutation parameter names; columnValues is the bundled
            // map (status as rich object, date as rich object), and
            // groupId/positionRelativeMethod/relativeTo default to
            // null since the test doesn't pass --group/--position.
            match_variables: {
              boardId: '111',
              itemName: 'Refactor login',
              groupId: null,
              columnValues: {
                status_4: { label: 'Done' },
                date4: { date: '2026-05-01' },
              },
              createLabelsIfMissing: false,
              positionRelativeMethod: null,
              relativeTo: null,
            },
            response: { data: { create_item: newItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string; board_id: string; group_id: string | null };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    assertEnvelopeContract(env);
    expect(env.data).toEqual({
      id: '99001',
      name: 'Refactor login',
      board_id: '111',
      group_id: 'topics',
    });
    // resolved_ids echoes both tokens per cli-design §5.3 step 2.
    expect(env.resolved_ids).toEqual({
      status: 'status_4',
      date4: 'date4',
    });
  });

  it('MONDAY_TIMEZONE env override threads through to date resolution context (live path)', async () => {
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
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'date4=2026-05-01',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [dateBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            response: { data: { create_item: newItem } },
          },
        ],
      },
      // Override the env to set MONDAY_TIMEZONE — picked up by the
      // date-resolution context per cli-design §5.3 step 3 line 765.
      // Branch coverage on the env-passthrough path.
      // XDG_CACHE_HOME must thread through (the per-test isolated
      // cache root) so prior tests' cached metadata doesn't pollute
      // this fixture; using the same value the cachedDrive helper
      // sets when no env override is supplied.
      {
        env: {
          MONDAY_API_TOKEN: 'tok-leakcheck-deadbeef-canary',
          MONDAY_API_URL: 'https://api.monday.com/v2',
          MONDAY_TIMEZONE: 'Europe/London',
          XDG_CACHE_HOME: xdgRoot(),
        },
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('long_text re-wrap pinned: live --set <long_text>=value bundles as {text:value} inside create_item.column_values', async () => {
    // Codex round-2 P2 #2 close-out: dry-run --set-raw didn't pin
    // the friendly long_text wire shape (raw payloads bypass the
    // re-wrap). Live friendly --set on a long_text column MUST
    // wrap as {text: "<value>"} inside create_item.column_values
    // — the same rule change_multiple_column_values requires.
    // Without this fixture pin, a regression that drops the
    // re-wrap (sending `description: "hi"` instead of
    // `description: {text: "hi"}`) would slip through unnoticed.
    const longTextBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'description_1',
          title: 'Description',
          type: 'long_text',
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
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'description_1=hi',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [longTextBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            match_variables: {
              boardId: '111',
              itemName: 'Test',
              columnValues: {
                // The long_text re-wrap rule: bare-string in
                // change_simple_column_value, but {text: <value>}
                // inside the column_values map per cli-design §5.3
                // step 5 + the M9 carve-in. M9 inherits the rule
                // from bundleColumnValues.
                description_1: { text: 'hi' },
              },
            },
            response: { data: { create_item: newItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('--group passes through to create_item.group_id wire variable', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--group',
        'topics',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemCreateTopLevel',
            match_variables: {
              boardId: '111',
              itemName: 'Refactor login',
              groupId: 'topics',
            },
            response: { data: { create_item: newItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('no --set → empty resolved_ids; no metadata fetch', async () => {
    const out = await drive(
      ['item', 'create', '--board', '111', '--name', 'Plain item', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemCreateTopLevel',
            response: { data: { create_item: { ...newItem, name: 'Plain item' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.resolved_ids).toEqual({});
    // No metadata interaction was needed; assert exhaustion to pin
    // the no-extra-roundtrip contract.
    expect(out.remaining).toBe(0);
  });

  it('--position before --relative-to + --group → wire enum maps to before_at; relative-to verified on same board (variables pinned)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--group',
        'topics',
        '--position',
        'before',
        '--relative-to',
        '54321',
        '--json',
      ],
      {
        interactions: [
          // verifyRelativeToOnBoard fires first (top-level path).
          {
            operation_name: 'ItemBoardLookup',
            response: {
              data: { items: [{ id: '54321', board: { id: '111' } }] },
            },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            // Codex M9 P2 #2: pin the PositionRelative enum mapping
            // so a regression that flips before/after or sends the
            // friendly value (`'before'`) to Monday instead of the
            // wire enum (`'before_at'`) fails loud.
            match_variables: {
              boardId: '111',
              itemName: 'Refactor login',
              groupId: 'topics',
              positionRelativeMethod: 'before_at',
              relativeTo: '54321',
              columnValues: null,
            },
            response: { data: { create_item: newItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.ok).toBe(true);
  });

  it('--position after --relative-to → wire enum maps to after_at (variables pinned)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--position',
        'after',
        '--relative-to',
        '54321',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: {
              data: { items: [{ id: '54321', board: { id: '111' } }] },
            },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            match_variables: {
              positionRelativeMethod: 'after_at',
              relativeTo: '54321',
            },
            response: { data: { create_item: newItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('--relative-to on a different board → usage_error with item_board_id + requested_board_id', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--position',
        'before',
        '--relative-to',
        '54321',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: {
              data: { items: [{ id: '54321', board: { id: '999' } }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    const errAny = env.error as Readonly<Record<string, unknown>>;
    const details = errAny.details as Readonly<Record<string, unknown>>;
    expect(details).toMatchObject({
      relative_to_id: '54321',
      item_board_id: '999',
      requested_board_id: '111',
    });
  });

  it('--relative-to references a missing item → not_found', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--position',
        'before',
        '--relative-to',
        '99999',
        '--json',
      ],
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

  it('Monday returns create_item with group null → group_id falls back to null', async () => {
    // Forces executeCreateItem's `?? null` group fallback + the
    // `?? BoardIdSchema.parse(inputs.boardId)` fallback when board
    // is also null (defensive against API drift).
    const out = await drive(
      ['item', 'create', '--board', '111', '--name', 'Test', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemCreateTopLevel',
            response: {
              data: {
                create_item: { ...newItem, board: null, group: null },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { board_id: string; group_id: string | null };
    };
    // Falls back to the requested boardId when Monday returns null
    // board on the create response (rare but defensive).
    expect(env.data.board_id).toBe('111');
    expect(env.data.group_id).toBe(null);
  });

  it('Monday returns null create_item payload → internal_error', async () => {
    const out = await drive(
      ['item', 'create', '--board', '111', '--name', 'Test', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemCreateTopLevel',
            response: { data: { create_item: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('live: --set-raw bundles raw payload into create_item.column_values', async () => {
    const richBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'site_1',
          title: 'Site',
          type: 'link',
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
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set-raw',
        'site_1={"url":"https://example.com","text":"Example"}',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [richBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            response: { data: { create_item: newItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.resolved_ids).toEqual({ site_1: 'site_1' });
  });

  it('live: --set on archived column → column_archived (resolver-time gate)', async () => {
    const archivedBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'status_4',
          title: 'Status',
          type: 'status',
          description: null,
          archived: true,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'status=Done',
        '--json',
      ],
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
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('column_archived');
  });

  it('F4 remap: cache-sourced resolution + Monday validation_failed → remapped to column_archived (Codex M9 P1, real regression pin)', async () => {
    // Codex round-2 P3 close-out: this was previously a weak test
    // that ran live resolution and accepted either error code. The
    // proper regression pin — same shape item-set's F4 test uses —
    // pre-warms the cache with an active column, then the create
    // mutation fails as validation_failed, then the helper forces
    // a refresh that sees the archived flag and remaps.
    //
    // Setup:
    //   1. Seed cache with active column (via a separate read).
    //   2. item create — cache hit on resolution.
    //   3. Live mutation returns validation_failed.
    //   4. Refresh fetches board with column now archived.
    //   5. Helper remaps to column_archived with details.remapped_from.
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
        { ...cachedActive.columns[0]!, archived: true },
      ],
    };
    // Step 1: seed cache via a separate read.
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
    // Step 2-5: item create with cached resolution.
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'status=Done',
        '--json',
      ],
      {
        interactions: [
          // No BoardMetadata call here — cache hit. The create
          // mutation fires immediately based on cached metadata.
          {
            operation_name: 'ItemCreateTopLevel',
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
          // F4 forces a metadata refresh post-failure; live board
          // now reports the column archived.
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedArchived] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { remapped_from?: string } };
    };
    expect(env.error?.code).toBe('column_archived');
    expect(env.error?.details?.remapped_from).toBe('validation_failed');
  });

  it('Monday returns validation_failed (label typo) → bubbles up as validation_failed', async () => {
    // Monday's validation error path on create — we surface it as
    // validation_failed because the value-shape was the issue, not
    // a stale archived column. cli-design §6.5 mapping.
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'status=NotALabel',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemCreateTopLevel',
            response: {
              errors: [
                {
                  message: 'invalid label for status column',
                  extensions: {
                    code: 'INVALID_COLUMN_VALUE',
                    status_code: 400,
                  },
                },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    // Not column_archived — we don't run that remap on creates
    // because the resolver already gated on archived (with
    // includeArchived: true and the explicit throw).
    expect(env.error?.code).not.toBe('column_archived');
  });
});

// ============================================================
// Subitem paths.
// ============================================================

describe('monday item create — subitem (live)', () => {
  it('happy path: --parent --name --set → create_subitem with bundled column_values + parent_id (variables pinned)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask 1',
        '--set',
        'sub_status_1=Working',
        '--json',
      ],
      {
        interactions: [
          // 1) parent lookup → parent's board id + hierarchy_type
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    board: { id: '111', hierarchy_type: null },
                  },
                ],
              },
            },
          },
          // 2) parent's BoardMetadata → derive subitems board id
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [parentBoardWithSubtasks] } },
          },
          // 3) BoardMetadata for subitems board (column resolution)
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [subitemsBoardMetadata] } },
          },
          // 4) the create_subitem mutation
          {
            operation_name: 'ItemCreateSubitem',
            // Codex M9 P2 #2: pin the create_subitem wire variables.
            // Critically, parentItemId must be the parent's id (not
            // the subitems board); columnValues must be the BUNDLED
            // map keyed by the subitems board's column ids (not the
            // parent's). Catches regressions where top-level columns
            // accidentally get sent to create_subitem.
            match_variables: {
              parentItemId: '12345',
              itemName: 'Subtask 1',
              columnValues: {
                sub_status_1: { label: 'Working' },
              },
              createLabelsIfMissing: false,
            },
            response: { data: { create_subitem: newSubitem } },
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
        group_id: string | null;
        parent_id?: string;
      };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.data).toMatchObject({
      id: '99100',
      name: 'Subtask 1',
      board_id: '333',
      parent_id: '12345',
    });
    // resolved_ids reflects the subitems-board column id, not the
    // parent's board.
    expect(env.resolved_ids).toEqual({ sub_status_1: 'sub_status_1' });
  });

  it('happy path: --parent --name (no --set) skips subitems-board metadata fetch', async () => {
    const out = await drive(
      ['item', 'create', '--parent', '12345', '--name', 'Plain subtask', '--json'],
      {
        interactions: [
          // Only parent lookup + the mutation — no metadata fetches.
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
            // No --set / --set-raw → columnValues is null (Monday
            // accepts no-column-values create). Pinning catches a
            // regression that sends an empty {} map instead.
            match_variables: {
              parentItemId: '12345',
              itemName: 'Plain subtask',
              columnValues: null,
            },
            response: {
              data: {
                create_subitem: { ...newSubitem, name: 'Plain subtask' },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.remaining).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.resolved_ids).toEqual({});
  });

  it('multi_level board → usage_error with details.hierarchy_type + deferred_to: v0.3', async () => {
    const out = await drive(
      ['item', 'create', '--parent', '12345', '--name', 'Subtask', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    board: { id: '111', hierarchy_type: 'multi_level' },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    const details = (env.error as Readonly<Record<string, unknown>>)
      .details as Readonly<Record<string, unknown>>;
    expect(details).toMatchObject({
      parent_item_id: '12345',
      hierarchy_type: 'multi_level',
      deferred_to: 'v0.3',
    });
  });

  it('parent not_found → not_found error envelope', async () => {
    const out = await drive(
      ['item', 'create', '--parent', '99999', '--name', 'Subtask', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('live: --parent + --set-raw → resolves on subitems board, fires create_subitem with bundled payload', async () => {
    // Forces both the live --set-raw branch on subitems AND the
    // subitems-board metadata fetch path.
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask 1',
        '--set-raw',
        'sub_status_1={"label":"Working"}',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  { id: '12345', board: { id: '111', hierarchy_type: null } },
                ],
              },
            },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [parentBoardWithSubtasks] } },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [subitemsBoardMetadata] } },
          },
          {
            operation_name: 'ItemCreateSubitem',
            response: { data: { create_subitem: newSubitem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.resolved_ids).toEqual({ sub_status_1: 'sub_status_1' });
  });

  it('parent board subtasks column has null settings_str + --set → usage_error', async () => {
    const subtasksMissingSettings = {
      ...sampleBoardMetadata,
      columns: [
        ...sampleBoardMetadata.columns,
        {
          id: 'subtasks_1',
          title: 'Subitems',
          type: 'subtasks',
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
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask',
        '--set',
        'status=Done',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  { id: '12345', board: { id: '111', hierarchy_type: null } },
                ],
              },
            },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [subtasksMissingSettings] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/subtasks column has no settings/u);
  });

  it('parent board subtasks settings_str has empty boardIds + --set → usage_error', async () => {
    const subtasksEmptyBoardIds = {
      ...sampleBoardMetadata,
      columns: [
        ...sampleBoardMetadata.columns,
        {
          id: 'subtasks_1',
          title: 'Subitems',
          type: 'subtasks',
          description: null,
          archived: null,
          settings_str: '{"boardIds":[]}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask',
        '--set',
        'status=Done',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  { id: '12345', board: { id: '111', hierarchy_type: null } },
                ],
              },
            },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [subtasksEmptyBoardIds] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/no linked.*subitems board/u);
  });

  it('parent board subtasks settings_str is malformed JSON + --set → usage_error', async () => {
    // JSON.parse throws → defensive parse=null → boardIds[0] is undefined → empty error path.
    const subtasksMalformedJson = {
      ...sampleBoardMetadata,
      columns: [
        ...sampleBoardMetadata.columns,
        {
          id: 'subtasks_1',
          title: 'Subitems',
          type: 'subtasks',
          description: null,
          archived: null,
          settings_str: 'not-valid-json',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask',
        '--set',
        'status=Done',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  { id: '12345', board: { id: '111', hierarchy_type: null } },
                ],
              },
            },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [subtasksMalformedJson] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('Monday returns subitem with board null → internal_error (defensive guard)', async () => {
    const out = await drive(
      ['item', 'create', '--parent', '12345', '--name', 'Subtask', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  { id: '12345', board: { id: '111', hierarchy_type: null } },
                ],
              },
            },
          },
          {
            operation_name: 'ItemCreateSubitem',
            response: {
              data: {
                create_subitem: { ...newSubitem, board: null },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.message).toMatch(/no board for the new subitem/u);
  });

  it('Monday returns subitem with group null + parent_item null → group_id null but parent_id always populated from argv', async () => {
    // Forces executeCreateSubitem's `?? null` group fallback.
    // parent_item null on the wire → parent_id falls back to the
    // argv-supplied parent (Codex M9 P2 #3 — the CLI already knows
    // the parent ID and shouldn't drop it from the documented
    // envelope shape).
    const out = await drive(
      ['item', 'create', '--parent', '12345', '--name', 'Subtask', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  { id: '12345', board: { id: '111', hierarchy_type: null } },
                ],
              },
            },
          },
          {
            operation_name: 'ItemCreateSubitem',
            response: {
              data: {
                create_subitem: { ...newSubitem, group: null, parent_item: null },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { group_id: string | null; parent_id?: string };
    };
    expect(env.data.group_id).toBe(null);
    // parent_id always populated from argv even when wire returned null.
    expect(env.data.parent_id).toBe('12345');
  });

  it('Monday returns null create_subitem payload → internal_error', async () => {
    const out = await drive(
      ['item', 'create', '--parent', '12345', '--name', 'Subtask', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  { id: '12345', board: { id: '111', hierarchy_type: null } },
                ],
              },
            },
          },
          {
            operation_name: 'ItemCreateSubitem',
            response: { data: { create_subitem: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.message).toMatch(/no item payload from create_subitem/u);
  });

  it('parent.board === null → not_found (token has no read access)', async () => {
    const out = await drive(
      ['item', 'create', '--parent', '12345', '--name', 'Subtask', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
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
    expect(env.error?.message).toMatch(/no readable board/u);
  });

  it('--relative-to: parent.board === null on the relative-to lookup → not_found', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--position',
        'before',
        '--relative-to',
        '54321',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: {
              data: { items: [{ id: '54321', board: null }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('parent board has no subtasks column + --set → usage_error', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask',
        '--set',
        'status=Done',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [{ id: '12345', board: { id: '111', hierarchy_type: null } }],
              },
            },
          },
          // Parent metadata WITHOUT a subtasks column — the derive
          // helper must surface usage_error.
          boardMetadataInteraction,
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/no subtasks column/u);
  });
});

// ============================================================
// Dry-run paths — both branches pinned (Codex round-4 P2 § precondition).
// ============================================================

describe('monday item create — dry-run', () => {
  it('top-level dry-run: planned_changes[0] carries operation: "create_item" + board_id + name + group_id + diff', async () => {
    const out = await drive(
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
        interactions: [
          // Only metadata fetch; no mutation fires.
          boardMetadataInteraction,
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    expect(env.data).toBe(null);
    expect(env.meta).toMatchObject({ dry_run: true });
    expect(env.planned_changes).toHaveLength(1);
    const plan = env.planned_changes[0];
    expect(plan).toMatchObject({
      operation: 'create_item',
      board_id: '111',
      name: 'Refactor login',
      group_id: 'topics',
      resolved_ids: { status: 'status_4' },
    });
    // diff[<col>].from is always null for create.
    const diff = plan!.diff as Readonly<
      Record<string, { from: unknown; to: unknown }>
    >;
    expect(diff).toHaveProperty('status_4');
    expect(diff.status_4!.from).toBe(null);
    expect(diff.status_4!.to).toEqual({ label: 'Done' });
  });

  it('top-level dry-run: --position carries position slot in planned_changes', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--position',
        'before',
        '--relative-to',
        '54321',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: {
              data: { items: [{ id: '54321', board: { id: '111' } }] },
            },
          },
          // No --set here so no metadata fetch needed.
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    const plan = env.planned_changes[0];
    expect(plan).toMatchObject({
      operation: 'create_item',
      position: { method: 'before', relative_to: '54321' },
    });
  });

  it('subitem dry-run: planned_changes[0] carries operation: "create_subitem" + parent_item_id (board_id omitted)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask 1',
        '--set',
        'sub_status_1=Working',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          // 1) parent lookup
          {
            operation_name: 'ItemParentLookup',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    board: { id: '111', hierarchy_type: null },
                  },
                ],
              },
            },
          },
          // 2) parent's BoardMetadata for subitems board derivation
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [parentBoardWithSubtasks] } },
          },
          // 3) subitems board metadata for column resolution
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [subitemsBoardMetadata] } },
          },
          // No mutation — dry-run.
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    expect(env.data).toBe(null);
    expect(env.meta).toMatchObject({ dry_run: true });
    expect(env.planned_changes).toHaveLength(1);
    const plan = env.planned_changes[0];
    expect(plan).toMatchObject({
      operation: 'create_subitem',
      name: 'Subtask 1',
      parent_item_id: '12345',
      resolved_ids: { sub_status_1: 'sub_status_1' },
    });
    // create_subitem variant: board_id is omitted (cli-design §6.4
    // "Subitem variant" line ~1781-1789).
    expect(plan).not.toHaveProperty('board_id');
    expect(plan).not.toHaveProperty('group_id');
    expect(plan).not.toHaveProperty('position');
  });

  it('subitem dry-run with no --set → planned_changes[0] omits diff entries (just name + parent_item_id)', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Plain subtask',
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
          // No metadata fetches needed for no-set subitem dry-run.
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    expect(env.planned_changes).toHaveLength(1);
    const plan = env.planned_changes[0];
    expect(plan).toMatchObject({
      operation: 'create_subitem',
      parent_item_id: '12345',
      name: 'Plain subtask',
      resolved_ids: {},
      diff: {},
    });
    // source: 'live' — Codex M9 P2 #1: pre-planner network legs
    // (parent lookup is always live for subitem) fold into the
    // envelope source. With no --set, planCreate emits 'none' but
    // the parent-lookup leg already fired, so the merged source is
    // 'live'. Pre-fix this surface lied about a wire leg that
    // already happened.
    expect(env.meta.source).toBe('live');
  });

  it('top-level dry-run: archived column (--set on archived) → column_archived with details.column_id', async () => {
    // Forces planCreate's archived-column branch through the dry-run
    // surface; live exercises the same path via the resolution loop
    // in create.ts (the same column gating fires).
    const archivedBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'status_4',
          title: 'Status',
          type: 'status',
          description: null,
          archived: true,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'status=Done',
        '--dry-run',
        '--json',
      ],
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
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('column_archived');
  });

  it('top-level dry-run: cross-token duplicate-resolved-id → usage_error', async () => {
    // Two distinct tokens (`status` and `id:status_4`) resolve to the
    // same column ID — dry-run engine catches this in pass (b).
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'status=Done',
        '--set',
        'id:status_4=Working',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [boardMetadataInteraction],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/resolve to the same column ID/u);
  });

  it('top-level dry-run: translator failure (date typo) → usage_error', async () => {
    // Forces planCreate's translator catch arm.
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'date4=not-a-date',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [boardMetadataInteraction],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('top-level dry-run: --set-raw on archived column → column_archived', async () => {
    // Forces planCreate's --set-raw archived-column branch (parallel
    // to the --set archived branch covered above).
    const archivedBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'status_4',
          title: 'Status',
          type: 'status',
          description: null,
          archived: true,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set-raw',
        'status={"label":"Done"}',
        '--dry-run',
        '--json',
      ],
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
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('column_archived');
  });

  it('top-level dry-run: --set + --set-raw cross-token duplicate-resolved-id → usage_error', async () => {
    // Forces planCreate's pass (b) cross-token check for --set-raw
    // sharing a resolved column with --set (mixed-form duplicate).
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set',
        'status=Done',
        '--set-raw',
        'id:status_4={"label":"Working"}',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [boardMetadataInteraction],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/resolve to the same column ID/u);
  });

  it('top-level dry-run: --set-raw on read-only-forever column → unsupported_column_type', async () => {
    // Forces planCreate's --set-raw translator catch arm (raw-write
    // rejects read-only-forever types pre-mutation).
    const mirrorBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'mirror_1',
          title: 'Linked',
          type: 'mirror',
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
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set-raw',
        'mirror_1={"foo":"bar"}',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [mirrorBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unsupported_column_type');
  });

  it('top-level dry-run with --set-raw: rich payload bundles into create_item.column_values (long_text not re-wrapped on raw)', async () => {
    const richBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'long_desc',
          title: 'Description',
          type: 'long_text',
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
        'create',
        '--board',
        '111',
        '--name',
        'Test',
        '--set-raw',
        'long_desc={"text":"hi","extra":"agent"}',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [richBoard] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    const plan = env.planned_changes[0];
    expect(plan).toMatchObject({
      operation: 'create_item',
      resolved_ids: { long_desc: 'long_desc' },
    });
    const diff = plan!.diff as Readonly<
      Record<string, { from: unknown; to: unknown }>
    >;
    // Raw payload passes through verbatim — the long_text re-wrap
    // logic inside bundleColumnValues only fires for `payload.format
    // === 'simple'`, which raw never produces.
    expect(diff.long_desc!.to).toEqual({ text: 'hi', extra: 'agent' });
  });

  it('top-level dry-run: relative date emits resolved_from echo on the diff cell', async () => {
    // Pins dry-run.ts:810 — buildCreateDiffCell's resolvedFrom echo
    // path for relative-date inputs. planChanges (item update / set)
    // has the equivalent test; planCreate's sibling slot was
    // unpinned until this test landed. Mirrors item-update.test.ts's
    // "--dry-run: relative date in single-path with MONDAY_TIMEZONE
    // override resolves correctly" pattern.
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        'date4=tomorrow',
        '--dry-run',
        '--json',
      ],
      { interactions: [boardMetadataInteraction] },
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
        diff: Readonly<
          Record<
            string,
            { details?: { resolved_from?: { input: string; timezone: string } } }
          >
        >;
      }[];
    };
    const cell = env.planned_changes[0]?.diff.date4;
    expect(cell?.details?.resolved_from?.input).toBe('tomorrow');
    expect(cell?.details?.resolved_from?.timezone).toBe('Europe/London');
  });

  it('top-level dry-run: people email emits resolved_from echo with token mapping', async () => {
    // Pins dry-run.ts:823-828 — buildCreateDiffCell's
    // peopleResolution echo path. Email→ID resolution fires through
    // userByEmail (mocked here via the UsersByEmail cassette
    // interaction); the planCreate engine projects the
    // PeopleResolution onto the diff cell's
    // details.resolved_from.tokens slot.
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
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        'owner_p=alice@example.com',
        '--dry-run',
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
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        diff: Readonly<
          Record<
            string,
            {
              details?: {
                resolved_from?: {
                  tokens: readonly { input: string; resolved_id: string }[];
                };
              };
            }
          >
        >;
      }[];
    };
    const cell = env.planned_changes[0]?.diff.owner_p;
    expect(cell?.details?.resolved_from?.tokens).toEqual([
      { input: 'alice@example.com', resolved_id: '555' },
    ]);
  });
});
