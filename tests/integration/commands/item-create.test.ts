/**
 * Integration tests for `monday item create` (M9 §5.8
 * JSON-only-path single-round-trip + v0.7-M43 file `--set`
 * two-leg carve-out fold + §6.4 item-create shape + v0.9-M50
 * unified subitem dispatch — both classic and multi-level boards,
 * no `hierarchy_type`-keyed rejection).
 *
 * Coverage map (per `v0.2-plan.md` §3 M9 + v0.7-plan §3 M43 +
 * cli-design §5.8 / §6.4):
 *
 *   - Argv-parser rules: `--name` empty after trim, `--position`
 *     requires `--relative-to`, `--parent` mutex with `--group` /
 *     `--position` / `--board`, multiple `--set` against same token.
 *   - Top-level happy path: default group, multiple `--set`,
 *     `resolved_ids` echo, mutation envelope shape pinned
 *     (JSON-only path — single `create_item` round-trip with
 *     bundled `column_values`).
 *   - Position path: `before` + `after` (PositionRelative wire-enum
 *     mapping) + `--relative-to` same-board verification.
 *   - Subitem path: parent lookup, unified dispatch across classic +
 *     multi-level boards (no `hierarchy_type` rejection — v0.9-M50),
 *     target-board derivation from `subtasks.settings_str.boardIds[0]`
 *     (classic sub_items_board or multi-level host board), subitem
 *     mutation envelope with `parent_id`.
 *   - Error paths: parent `not_found`, relative-to `not_found`,
 *     wrong-board `--relative-to`,
 *     `validation_failed` from Monday on the create wire.
 *   - Dry-run: top-level `create_item` AND subitem `create_subitem`
 *     planned-change shapes pinned (per Codex round-4 P2 — both
 *     §9 preconditions).
 *   - v0.7-M43 file `--set` carve-out fold (v0.6-M38 → v0.7-M43 D6
 *     fold): file `--set` on item create routes through the
 *     `runItemCreateFileDispatch` two-leg helper. IMPL coverage
 *     spans the live happy path (leg-1 `create_item` then leg-2
 *     `add_file_to_column` succeed; envelope is the canonical
 *     `ItemCreateOutput` with `resolved_ids` echo for both tokens
 *     + the file token), the D6 mixed-set asymmetry (non-file
 *     `--set` values bundle into leg-1's `column_values` atomically;
 *     file entry routes to leg-2), the subitem path (`create_subitem`
 *     + `add_file_to_column`), the D2 dry-run envelope (two
 *     `planned_changes` entries — `create_item` then
 *     `add_file_to_column`), the D1 orphan-warn envelope on leg-2
 *     failure (`internal_error` carrying `details.created_item_id`
 *     + `details.cause` + `details.hint`), the no-orphan leg-1
 *     failure path, the upfront `precheckLocalFile` abort, and
 *     regression-guards for both the v0.7-M43 transient stub literal
 *     (`'m43_preflight_stub'`) and the v0.6-M38 reserved literal
 *     (`'file_set_on_create_unsupported'`). The D3 `--set-raw
 *     <file-col>=<json>` rejection stays at `translateRawColumnValue`
 *     (separate enforcement layer).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createInlineMultipartFixtureTransport } from '../../fixtures/multipart-load.js';

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

// Multi-level board (v0.9-M50). The host board's `subtasks` column
// self-references the board itself (`boardIds: ["111"]` === the parent
// board id), so subitem column resolution targets board 111 — NOT a
// separate sub_items_board (the classic model). The host board carries
// both the self-referencing `subtasks` column AND a status column the
// `--set` token resolves against.
const parentBoardMultiLevel = {
  ...sampleBoardMetadata,
  id: '111',
  name: 'Multi-level host board',
  columns: [
    {
      id: 'ml_status',
      title: 'Status',
      type: 'status',
      description: null,
      archived: null,
      settings_str: '{}',
      width: null,
    },
    {
      id: 'subtasks_self',
      title: 'Subitems',
      type: 'subtasks',
      description: null,
      archived: null,
      settings_str: '{"boardIds":["111"]}',
      width: null,
    },
  ],
};

// Subitem nested on a multi-level host board — board is 111 (the host),
// not a separate sub_items_board.
const newSubitemMultiLevel = {
  id: '99200',
  name: 'Nested subtask',
  board: { id: '111' },
  group: { id: 'topics' },
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

  it('multi_level board → create_subitem succeeds (v0.9-M50 unified dispatch; closes M28). Nesting was verified depth-3+ at API 2026-01 (the CLI pin); the prior multi_level → usage_error gate asserted a now-false data-model claim and is DELETED. No --set → no metadata leg; the subitem lands on the host board (111), not a separate sub_items_board.', async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Nested subtask',
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
                    board: { id: '111', hierarchy_type: 'multi_level' },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemCreateSubitem',
            // No --set → columnValues null (same shape as the classic
            // plain-subtask path above). Multi-level subitems live on
            // the parent's host board (111).
            match_variables: {
              parentItemId: '12345',
              itemName: 'Nested subtask',
              columnValues: null,
            },
            response: {
              data: {
                create_subitem: {
                  id: '99200',
                  name: 'Nested subtask',
                  board: { id: '111' },
                  group: { id: 'subitems_topic' },
                  parent_item: { id: '12345' },
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.remaining).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        id: string;
        name: string;
        board_id?: string;
        parent_id?: string;
      };
    };
    expect(env.data).toMatchObject({
      id: '99200',
      name: 'Nested subtask',
      board_id: '111',
      parent_id: '12345',
    });
  });

  it("v0.9-M50 regression guard: the deleted multi_level rejection's literals stay GONE — no `deferred_to`, no false 'sub_items_board carries no subtasks column' claim, no 'M28 Decision 11 closure' tag in any emitted envelope. A half-applied revert that re-introduced the `hierarchy_type === 'multi_level'` throw would fail here (exit 1 + the literals on stderr).", async () => {
    // The deleted gate (create.ts, pre-M50) asserted a now-FALSE fact
    // ("Monday's sub_items_board carries no subtasks column at API
    // 2026-01, so depth-2 subitems have no data-model home") and
    // carried `details.deferred_to: 'v0.9'` while shipping AT v0.9 —
    // the R-NEW-82 "wait for the version you're already running"
    // anti-pattern. This guard pins both literals absent on the exact
    // surface that used to emit them (the multi-level create path).
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Nested subtask',
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
                    board: { id: '111', hierarchy_type: 'multi_level' },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemCreateSubitem',
            response: {
              data: {
                create_subitem: {
                  id: '99200',
                  name: 'Nested subtask',
                  board: { id: '111' },
                  group: { id: 'subitems_topic' },
                  parent_item: { id: '12345' },
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    for (const literal of [
      'deferred_to',
      'sub_items_board carries no subtasks',
      'multi-level subitem creation is deferred',
      'M28 Decision 11 closure',
    ]) {
      expect(out.stdout, `${literal}: stdout`).not.toContain(literal);
      expect(out.stderr, `${literal}: stderr`).not.toContain(literal);
    }
  });

  it('live: --parent + --set-raw on a multi_level board → resolves against the self-referenced host board (subtasks.settings_str.boardIds[0] === parent board 111), fires create_subitem with bundled column_values (v0.9-M50 — pins the host-board self-reference dispatch, not just classic sub_items_board)', async () => {
    // The host board's `subtasks` column self-references board 111
    // (boardIds: ["111"]), so column resolution targets the host board
    // itself — distinct from the classic model where it points at a
    // separate sub_items_board. The self-reference means a SINGLE
    // `BoardMetadata` round-trip: leg-1 derives the target via the
    // subtasks column AND warms board 111's metadata cache, so the
    // column-resolution leg reads board 111 from cache (no second wire
    // call). Classic boards fetch two distinct boards (parent +
    // sub_items_board) and so issue two `BoardMetadata` calls.
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Nested subtask',
        '--set-raw',
        'ml_status={"label":"Working"}',
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
                    board: { id: '111', hierarchy_type: 'multi_level' },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [parentBoardMultiLevel] } },
          },
          {
            operation_name: 'ItemCreateSubitem',
            // The bundled column_values must reach create_subitem keyed
            // by the host board's column id (ml_status), and parentItemId
            // must be the parent (12345), not the host board.
            match_variables: {
              parentItemId: '12345',
              itemName: 'Nested subtask',
              columnValues: {
                ml_status: { label: 'Working' },
              },
              createLabelsIfMissing: false,
            },
            response: { data: { create_subitem: newSubitemMultiLevel } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.remaining).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; board_id?: string; parent_id?: string };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.data).toMatchObject({
      id: '99200',
      board_id: '111',
      parent_id: '12345',
    });
    expect(env.resolved_ids).toEqual({ ml_status: 'ml_status' });
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

describe('monday item create — v0.7-M43 file-column carve-out fold (v0.6-M38 → v0.7-M43 D6 fold) — IMPL', () => {
  // Board metadata fixture pinning a file-typed `attachments` column
  // alongside a status column (`status_4` lets the D6 mixed-set
  // asymmetry test bundle a non-file `--set status=Done` into leg-1's
  // column_values atomically).
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
      {
        id: 'status_4',
        title: 'Status',
        type: 'status',
        description: null,
        archived: null,
        settings_str:
          '{"labels":{"0":"Backlog","1":"In Progress","2":"Done"}}',
        width: null,
      },
    ],
  };

  // Parent board fixture for the subitem path. The `subtasks` column's
  // settings_str.boardIds[0] points at subitemsFileBoard (id `333`),
  // which carries the file column the subitem create attaches to.
  const subitemsFileBoard = {
    ...sampleBoardMetadata,
    id: '333',
    name: 'Subitems of Tasks',
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
  const parentBoardWithSubitemsFile = {
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

  // Standard `add_file_to_column` success-response template. Mirrors
  // M31's asset projection (10-field Asset surface; per-test specs
  // override only the slots the assertion inspects).
  const buildAsset = (id: string): Record<string, unknown> => ({
    id,
    name: 'report.pdf',
    url: `https://files.monday.com/x/${id}.pdf`,
    public_url: `https://share.monday.com/${id}`,
    file_extension: 'pdf',
    file_size: 17,
    created_at: '2026-06-01T10:30:00Z',
    uploaded_by: { id: '1', name: 'Alice' },
    original_geometry: null,
    url_thumbnail: null,
  });

  let workdir: string;
  let reportPath: string;
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'monday-cli-item-create-m43-'));
    reportPath = join(workdir, 'report.pdf');
    await writeFile(reportPath, 'PDF-bytes-fixture', 'utf8');
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('v0.8-M47 stdin create-time live: two-leg `create_item` then stdin → `add_file_to_column`; --filename threads to the wire', async () => {
    const multipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'piped.pdf',
          response: { data: { add_file_to_column: buildAsset('asset-stdin') } },
        },
      ],
      { assertExhaustive: false },
    );
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'From a pipe',
        '--set',
        'attachments=-',
        '--filename',
        'piped.pdf',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            // Only `--set` was the file entry (routed to leg-2), so
            // leg-1 ships `columnValues: null`.
            match_variables: {
              boardId: '111',
              itemName: 'From a pipe',
              columnValues: null,
            },
            response: { data: { create_item: newItem } },
          },
        ],
      },
      {
        multipartTransport: multipart,
        stdin: Readable.from([Buffer.from('PIPED-create-bytes')]),
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).not.toContain('m47_preflight_stub');
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string; board_id: string };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    assertEnvelopeContract(env);
    // Envelope stays the canonical ItemCreateOutput on `data` (leg-1's
    // projection) — byte-equivalent to the path-sourced create.
    expect(env.data).toEqual({
      id: '99001',
      name: 'Refactor login',
      board_id: '111',
      group_id: 'topics',
    });
    expect(env.resolved_ids).toEqual({ attachments: 'attachments' });
    // Leg-2 fired once against leg-1's new item ID, carrying the
    // buffered stdin bytes under the `--filename` Asset.name.
    expect(multipart.requests).toHaveLength(1);
    const req = multipart.requests[0]!;
    expect(req.operationName).toBe('AddFileToColumn');
    expect(req.filename).toBe('piped.pdf');
    expect(Buffer.from(req.fileBytes).toString('utf8')).toBe(
      'PIPED-create-bytes',
    );
    expect(req.fileType).toBe('application/pdf');
  });

  it('v0.8-M47 stdin create-time dry-run: two planned_changes entries (create_item + add_file_to_column); entry-2 carries file_path "-" with no item_id / no file_size_bytes; no wire fires', async () => {
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: false,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'From a pipe',
        '--set',
        'attachments=-',
        '--filename',
        'piped.pdf',
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
      {
        multipartTransport: multipart,
        stdin: Readable.from([Buffer.from('SHOULD-NOT-BE-READ')]),
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.ok).toBe(true);
    const meta = env.meta as EnvelopeShape['meta'] & { dry_run?: boolean };
    expect(meta.dry_run).toBe(true);
    const envWithPlanned = env as EnvelopeShape & {
      planned_changes?: readonly Record<string, unknown>[];
    };
    const changes = envWithPlanned.planned_changes ?? [];
    const fileChange = changes.find(
      (c) => c.operation === 'add_file_to_column',
    );
    expect(fileChange).toMatchObject({
      operation: 'add_file_to_column',
      column_id: 'attachments',
      file_path: '-',
      filename: 'piped.pdf',
    });
    // Entry-2 omits item_id (the item doesn't exist at dry-run time)
    // and file_size_bytes (a stream can't be fs.stat'd; D4).
    expect(fileChange).not.toHaveProperty('item_id');
    expect(fileChange).not.toHaveProperty('file_size_bytes');
    expect(multipart.requests).toHaveLength(0);
  });

  it('v0.8-M47 stdin create-time live: empty stdin rejects usage_error (stdin_file_empty) BEFORE leg-1 — no item is created (no orphan)', async () => {
    // The stdin read fires before leg-1, so an empty pipe rejects
    // without ever calling `create_item` — no orphan item, no wire
    // round-trip beyond the column-resolution metadata fetch.
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: false,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'From a pipe',
        '--set',
        'attachments=-',
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
      {
        multipartTransport: multipart,
        stdin: Readable.from([]),
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.details).toMatchObject({ reason: 'stdin_file_empty' });
    // Neither leg-1 (create_item) nor leg-2 (add_file_to_column) fired.
    expect(multipart.requests).toHaveLength(0);
  });

  it('live: two-leg dispatch fires `create_item` then `add_file_to_column` and emits the canonical ItemCreateOutput envelope (v0.6-M38 → v0.7-M43 D6 fold)', async () => {
    // Happy path: leg-1 creates the item (no bundled column_values
    // since the only `--set` is the file entry); leg-2 attaches the
    // file. Asserts the success envelope is byte-equivalent to the
    // JSON-only create path on `data` (the file's asset is attached
    // wire-side but intentionally NOT surfaced on `data` per the
    // output-shapes.md envelope contract for the M43 path).
    const multipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report.pdf',
          response: { data: { add_file_to_column: buildAsset('asset-1') } },
        },
      ],
      { assertExhaustive: false },
    );
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            // Leg-1 ships with `column_values: null` because the only
            // `--set` was the file entry (routed to leg-2). The
            // null-vs-empty-map distinction is wire-meaningful per
            // §5.8 — Monday accepts `null` distinctly from `{}`.
            match_variables: {
              boardId: '111',
              itemName: 'Refactor login',
              groupId: null,
              columnValues: null,
              createLabelsIfMissing: false,
              positionRelativeMethod: null,
              relativeTo: null,
            },
            response: { data: { create_item: newItem } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        id: string;
        name: string;
        board_id: string;
        group_id: string | null;
      };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    assertEnvelopeContract(env);
    expect(env.data).toEqual({
      id: '99001',
      name: 'Refactor login',
      board_id: '111',
      group_id: 'topics',
    });
    // resolved_ids echoes the file token's resolved column ID.
    expect(env.resolved_ids).toEqual({ attachments: 'attachments' });
    // Leg-2 fired once against leg-1's freshly-created item ID.
    expect(multipart.requests).toHaveLength(1);
    const req = multipart.requests[0]!;
    expect(req.operationName).toBe('AddFileToColumn');
    expect(req.filename).toBe('report.pdf');
    // Source: every wire leg fires live (metadata fetch + M38 pre-
    // check's resolveColumnWithRefresh + leg-1 mutation + leg-2
    // multipart). When only the file `--set` is present, no second
    // column-resolution leg fires (no resolveAndTranslate cache-hit
    // to mix in), so the aggregate stays `'live'`. Mirrors the M38
    // single-item file dispatch envelope's `source: 'live'`.
    expect(env.meta.source).toBe('live');
  });

  it('live: D6 mixed-set asymmetry — non-file `--set` values bundle into leg-1 `column_values` atomically; file entry routes to leg-2 (SUPPRESSED mixed-rule on item_create)', async () => {
    // The D6 SUPPRESSION at routeFileColumnDispatch on
    // 'item_create' callShape lets a non-file `--set status=Done`
    // through alongside the file `--set attachments=...`. The action
    // body partitions: leg-1 bundles status into column_values atomically
    // (Monday's `create_item` accepts column_values), leg-2 attaches
    // the file. Both succeed → success envelope echoes both tokens
    // in resolved_ids.
    const multipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report.pdf',
          response: { data: { add_file_to_column: buildAsset('asset-2') } },
        },
      ],
      { assertExhaustive: false },
    );
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
        `attachments=${reportPath}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            // Leg-1's column_values carries ONLY the non-file entry
            // (status_4). The file `--set` is partitioned out and
            // dispatched separately as leg-2 — a regression that
            // routed the file into column_values would fail this
            // match_variables pin.
            match_variables: {
              boardId: '111',
              itemName: 'Refactor login',
              groupId: null,
              columnValues: { status_4: { label: 'Done' } },
              createLabelsIfMissing: false,
              positionRelativeMethod: null,
              relativeTo: null,
            },
            response: { data: { create_item: newItem } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      resolved_ids?: Readonly<Record<string, string>>;
    };
    // Both tokens echo in resolved_ids — the file token from M38
    // pre-check, the status token from resolveAndTranslate.
    expect(env.resolved_ids).toEqual({
      attachments: 'attachments',
      status: 'status_4',
    });
    // Both legs fired exactly once.
    expect(multipart.requests).toHaveLength(1);
  });

  it('live: subitem path dispatches `create_subitem` then `add_file_to_column` and emits the subitem envelope with `parent_id`', async () => {
    // Subitem variant: parent lookup + parent-board metadata (for
    // subtasks column derivation) + subitems-board metadata pre-check
    // + create_subitem + add_file_to_column. Asserts the subitem
    // success envelope carries `parent_id`.
    const multipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report.pdf',
          response: { data: { add_file_to_column: buildAsset('sub-1') } },
        },
      ],
      { assertExhaustive: false },
    );
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask 1',
        '--set',
        `attachments=${reportPath}`,
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
                    board: {
                      id: '111',
                      hierarchy_type: null,
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [parentBoardWithSubitemsFile] } },
          },
          // Subitems board metadata — M38 pre-check resolves
          // `attachments` against board 333 (subitems board).
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [subitemsFileBoard] } },
          },
          {
            operation_name: 'ItemCreateSubitem',
            match_variables: {
              parentItemId: '12345',
              itemName: 'Subtask 1',
              columnValues: null,
              createLabelsIfMissing: false,
            },
            response: { data: { create_subitem: newSubitem } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        id: string;
        name: string;
        board_id: string;
        parent_id: string;
      };
    };
    expect(env.data.id).toBe('99100');
    expect(env.data.parent_id).toBe('12345');
    expect(env.data.board_id).toBe('333');
    expect(multipart.requests).toHaveLength(1);
  });

  it('dry-run: emits D2 two-`planned_changes` envelope — `create_item` then `add_file_to_column` — without burning the multipart wire', async () => {
    // D2 closure: dry-run runs planCreate (non-file resolution +
    // diff cells) then appends the file entry. No multipart wire
    // round-trip fires; the multipart transport's `assertExhaustive`
    // is on with an empty cassette so any wire call would fail
    // loudly.
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
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
        `attachments=${reportPath}`,
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
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes?: readonly Record<string, unknown>[];
    };
    expect(env.ok).toBe(true);
    const meta = env.meta as EnvelopeShape['meta'] & { dry_run?: boolean };
    expect(meta.dry_run).toBe(true);
    // Two entries: leg-1 create_item shape (with bundled non-file
    // column_values + diff cell for status_4) THEN leg-2
    // add_file_to_column shape (no item_id since the item doesn't
    // exist yet at dry-run time).
    expect(env.planned_changes).toHaveLength(2);
    const [entry1, entry2] = env.planned_changes!;
    expect(entry1).toMatchObject({
      operation: 'create_item',
      board_id: '111',
      name: 'Refactor login',
    });
    expect(entry2).toEqual({
      operation: 'add_file_to_column',
      column_id: 'attachments',
      file_path: reportPath,
      filename: 'report.pdf',
      file_size_bytes: 17,
    });
    expect(multipart.requests).toHaveLength(0);
  });

  it('dry-run with a non-file `--set-raw`: leg-1 plan bundles the raw column_values (rawEntries non-empty branch)', async () => {
    // Exercises the `rawEntries.length !== 0` arm of leg-1's planCreate
    // call in the single-file create dispatch dry-run (the `--set`-only
    // dry-run above hits the empty arm). `--set-raw status_4=<json>`
    // bundles into leg-1's planned column_values alongside the single
    // file planned_change. No multipart wire fires.
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set-raw',
        'status_4={"label":"Done"}',
        '--set',
        `attachments=${reportPath}`,
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
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes?: readonly Record<string, unknown>[];
    };
    expect(env.ok).toBe(true);
    // 1 create_item (with the raw status bundled) + 1 add_file_to_column.
    expect(env.planned_changes).toHaveLength(2);
    expect(env.planned_changes![0]).toMatchObject({ operation: 'create_item' });
    expect(env.planned_changes![1]).toMatchObject({
      operation: 'add_file_to_column',
      column_id: 'attachments',
    });
    expect(multipart.requests).toHaveLength(0);
  });

  it('dry-run subitem: emits two planned_changes — `create_subitem` then `add_file_to_column` — and subitem entry1 omits `board_id` (server-side derivation)', async () => {
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask 1',
        '--set',
        `attachments=${reportPath}`,
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
                    board: {
                      id: '111',
                      hierarchy_type: null,
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [parentBoardWithSubitemsFile] } },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [subitemsFileBoard] } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes?: readonly Record<string, unknown>[];
    };
    expect(env.planned_changes).toHaveLength(2);
    const [entry1, entry2] = env.planned_changes!;
    expect(entry1).toMatchObject({
      operation: 'create_subitem',
      parent_item_id: '12345',
      name: 'Subtask 1',
    });
    // Subitem entry-1 must NOT carry `board_id` — the target board
    // (classic sub_items_board or multi-level host board) is derived
    // server-side; surfacing the agent's --board would falsely imply
    // ownership of that board (per output-shapes §6.4 subitem dry-run
    // shape).
    expect(entry1).not.toHaveProperty('board_id');
    expect(entry2).toMatchObject({
      operation: 'add_file_to_column',
      column_id: 'attachments',
    });
    expect(multipart.requests).toHaveLength(0);
  });

  it('orphan-warn (D1): leg-2 failure surfaces `internal_error` with `details.{reason, created_item_id, column_id, cause, hint}` — the leg-1 item persists', async () => {
    // The defining M43 envelope shape. Leg-1 succeeds (item 99001
    // created) → leg-2 fails with `file_too_large` → the helper
    // catches MondayCliError, applies foldAndRemap, then wraps as
    // ApiError('internal_error', ...) carrying the D1 orphan-warn
    // decoration with `created_item_id` echoing the orphan. The
    // remapped leg-2 error embeds as `details.cause` JSON projection
    // so agents can branch on the underlying failure.
    const multipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          response: {
            errors: [
              {
                message: 'File size limit exceeded',
                extensions: { code: 'FILE_SIZE_LIMIT_EXCEEDED' },
              },
            ],
          },
        },
      ],
      { assertExhaustive: false },
    );
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            response: { data: { create_item: newItem } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    // `internal_error` is the M43 outer-envelope code per D1 closure
    // — exit 2 (API error category).
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          reason?: string;
          created_item_id?: string;
          column_id?: string;
          cause?: { code?: string; message?: string };
          hint?: string;
        };
      };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.reason).toBe(
      'create_then_file_upload_partial_failure',
    );
    expect(env.error?.details?.created_item_id).toBe('99001');
    expect(env.error?.details?.column_id).toBe('attachments');
    // Cause projection carries the remapped leg-2 error's code +
    // its nested details. M31's `FILE_SIZE_LIMIT_EXCEEDED` rewrap
    // surfaces as `code: 'usage_error'` (file-size cap is on the
    // call-shape boundary) with `details.reason: 'file_too_large'`
    // (the §6.5 stable-discriminator). The orphan-warn envelope
    // echoes both — `cause.code` for the outer typed code and
    // `cause.details.reason` for the M31 discriminator agents key
    // off.
    expect(env.error?.details?.cause?.code).toBe('usage_error');
    const causeDetails = (env.error?.details?.cause as {
      details?: { reason?: string };
    }).details;
    expect(causeDetails?.reason).toBe('file_too_large');
    expect(typeof env.error?.details?.cause?.message).toBe('string');
    // Hint mentions both recovery paths (retry leg-2 + rollback)
    // and echoes the orphan's ID so agents can copy-paste.
    expect(env.error?.details?.hint).toContain('99001');
    expect(env.error?.details?.hint).toMatch(/monday item set/);
    expect(env.error?.details?.hint).toMatch(/monday item delete/);
    // Leg-2 fired exactly once (the failing call).
    expect(multipart.requests).toHaveLength(1);
  });

  it('mixed-set translation reject: resolveAndTranslate failure aborts before leg-1 fires (status=NoSuchLabel → usage_error from the friendly translator)', async () => {
    // The helper's `resolveAndTranslate` catch arm fires when the
    // non-file `--set` translator rejects (e.g., unknown status
    // label). The catch arm calls `mergeResolverWarningsIntoError`
    // (no-op on empty pre-check warnings) and re-throws — leg-1
    // never fires. Without this test the catch arm's
    // `err instanceof MondayCliError` true-arm + the
    // `mergeResolverWarningsIntoError` call are uncovered.
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        'status=NoSuchLabel',
        '--set',
        `attachments=${reportPath}`,
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
    // Translation rejections route through `translateColumnValueAsync`
    // which surfaces typed errors mapping to exit 1 (`usage_error`)
    // or exit 2 (`unsupported_column_type` / `validation_failed`)
    // depending on the rejection kind. The key invariant for the
    // catch arm coverage is that the error reached the runner from
    // resolveAndTranslate (not from a successful create) — both
    // the `created_item_id` absence + zero multipart wire calls
    // pin that.
    expect([1, 2]).toContain(out.exitCode);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          reason?: string;
          created_item_id?: string;
        };
      };
    };
    expect(env.error?.details?.created_item_id).toBeUndefined();
    expect(env.error?.details?.reason).not.toBe(
      'create_then_file_upload_partial_failure',
    );
    // Codex IMPL R1 P3-1 + R2 P3-1 (W9): the reserved-literal
    // regression-guard must fire on every failure path — the
    // resolveAndTranslate catch arm is its own emit surface (not
    // exercised by the dedicated four-surface regression-guard
    // test). Assert literal absence for BOTH reserved literals
    // (v0.7-M43 transient + v0.6-M38 historical) inline so a
    // regression here is caught regardless of how the broader
    // regression-guard test evolves.
    expect(out.stdout).not.toContain('m43_preflight_stub');
    expect(out.stderr).not.toContain('m43_preflight_stub');
    expect(out.stdout).not.toContain('file_set_on_create_unsupported');
    expect(out.stderr).not.toContain('file_set_on_create_unsupported');
    expect(multipart.requests).toHaveLength(0);
  });

  it('leg-1 mixed-set failure: F4 remap path fires with `translated.map(t => t.columnId)` populated from the non-file `--set` entries (cache-served resolution + Monday validation_failed → column_archived remap)', async () => {
    // Mixed-set with leg-1 failure exercises the F4 remap path's
    // `columnIds: translated.map((t) => t.columnId)` argument with a
    // non-empty array — the M43 helper's leg-1 catch arm mirrors the
    // JSON path's F4 remap at create.ts:1082-1106. Seeding the cache
    // with the column ACTIVE then refreshing to ARCHIVED triggers
    // foldAndRemap's remap path (Codex M9 P1 regression pin shape).
    const cachedActive = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'attachments',
          title: 'Attachments',
          type: 'file',
          description: null,
          archived: false,
          settings_str: '{}',
          width: null,
        },
        {
          id: 'status_4',
          title: 'Status',
          type: 'status',
          description: null,
          archived: false,
          settings_str:
            '{"labels":{"0":"Backlog","1":"In Progress","2":"Done"}}',
          width: null,
        },
      ],
    };
    const refreshedArchived = {
      ...cachedActive,
      columns: [
        cachedActive.columns[0]!,
        { ...cachedActive.columns[1]!, archived: true },
      ],
    };
    // Step 1: seed cache with active status_4 via a separate read.
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
    // Step 2: item create — cache hit on resolution + leg-1 fails →
    // foldAndRemap fetches refreshed BoardMetadata → sees archived →
    // remaps to column_archived.
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
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
        `attachments=${reportPath}`,
        '--json',
      ],
      {
        interactions: [
          // Leg-1 returns validation_failed — the M38 pre-check + the
          // helper's resolveAndTranslate both hit cache (no
          // BoardMetadata interaction here).
          {
            operation_name: 'ItemCreateTopLevel',
            response: {
              errors: [
                {
                  message: 'Invalid value for column status',
                  extensions: { code: 'InvalidColumnValueException' },
                },
              ],
            },
          },
          // foldAndRemap refreshes BoardMetadata → sees status_4
          // archived → remaps.
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedArchived] } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          reason?: string;
          created_item_id?: string;
          remapped_from?: string;
        };
      };
    };
    // The leg-1 F4 remap path surfaces `column_archived` (cli-design
    // §6.5 stable-code rule). NO orphan envelope because no item was
    // created.
    expect(env.error?.code).toBe('column_archived');
    expect(env.error?.details?.created_item_id).toBeUndefined();
    expect(env.error?.details?.reason).not.toBe(
      'create_then_file_upload_partial_failure',
    );
    // Leg-2 never fired.
    expect(multipart.requests).toHaveLength(0);
  });

  it('leg-1 failure: validation_failed from `create_item` aborts before leg-2 — NO orphan envelope (no item to clean up)', async () => {
    // Leg-1 failure means no item was created → no orphan handle,
    // no `created_item_id` slot. The error surfaces with the raw
    // remap from foldAndRemap (column_archived if the cache lied
    // about an archived column; validation_failed otherwise). The
    // multipart transport's `assertExhaustive` is on with an empty
    // cassette — leg-2 must NOT fire.
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            response: {
              errors: [
                {
                  message: 'Item name must not be blank',
                  extensions: { code: 'InvalidArgumentException' },
                },
              ],
            },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          reason?: string;
          created_item_id?: string;
        };
      };
    };
    // Outer code is NOT `internal_error` with the orphan-warn
    // discriminator — leg-1 failure routes through the standard
    // F4 remap, surfacing the underlying API error code. The key
    // invariant: NO `created_item_id` (no orphan exists).
    expect(env.error?.details?.reason).not.toBe(
      'create_then_file_upload_partial_failure',
    );
    expect(env.error?.details?.created_item_id).toBeUndefined();
    // Leg-2 never fired (the cassette assertion would fire if it had).
    expect(multipart.requests).toHaveLength(0);
  });

  it('atomicity-before-wire: ENOENT path aborts with `usage_error.details.reason: file_not_readable` BEFORE leg-1 fires (cli-design §5.8 pre-check discipline)', async () => {
    // Upfront precheckLocalFile fires BEFORE either wire leg. A
    // missing file surfaces `usage_error` with `file_not_readable`
    // → exit 1; neither create_item nor add_file_to_column fires
    // (both cassettes are exhaustive-empty).
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${join(workdir, 'does-not-exist.pdf')}`,
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
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { reason?: string } };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.details?.reason).toBe('file_not_readable');
    expect(multipart.requests).toHaveLength(0);
  });

  it("D3 invariant: item create `--set-raw <file-col>=<json>` stays as unsupported_column_type (NOT hijacked into file_set_on_create_unsupported — Codex round-2 P3-2 pin)", async () => {
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'New item',
        '--set-raw',
        'attachments={"url":"https://example.com/x.pdf"}',
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
    // `unsupported_column_type` maps to exit 2 (API error
    // category per cli-design §6.5).
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { reason?: string } };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
    expect(env.error?.details?.reason).toBeUndefined();
  });

  it("'m43_preflight_stub' literal stays RESERVED: M43 IMPL no longer surfaces it (was the pre-flight stub's transient discriminator); the literal MUST NOT reappear from any of the M43 surfaces (success + dry-run + orphan-warn + leg-1 failure)", async () => {
    // Regression-guard mirroring v0.7-M42's `'m42_preflight_stub'`
    // post-IMPL regression-guard pattern. The IMPL replacement of
    // the v0.7-M43 pre-flight stub leaves the literal RESERVED — a
    // future re-introduction of `details.reason: 'm43_preflight_stub'`
    // (programmer regression, half-applied revert) would fail this
    // test. Per Codex IMPL R1 P3-1 (W9): drives each M43 surface
    // separately rather than asserting absence on one path alone,
    // because the literal could land in any catch arm or emit
    // surface independently — the test description claimed broader
    // coverage than the original single-path assertion delivered.
    const assertLiteralAbsent = (
      label: string,
      out: { stdout: string; stderr: string },
    ): void => {
      expect(out.stdout, `${label}: stdout`).not.toContain(
        'm43_preflight_stub',
      );
      expect(out.stderr, `${label}: stderr`).not.toContain(
        'm43_preflight_stub',
      );
      // R-v0.7-NEW-4 regression-guard: the v0.6-M38 reserved
      // literal also stays absent from every runtime envelope.
      expect(out.stdout, `${label}: stdout (v0.6 literal)`).not.toContain(
        'file_set_on_create_unsupported',
      );
      expect(out.stderr, `${label}: stderr (v0.6 literal)`).not.toContain(
        'file_set_on_create_unsupported',
      );
    };

    // Surface 1 — live two-leg success envelope.
    const successMultipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          response: { data: { add_file_to_column: buildAsset('a-1') } },
        },
      ],
      { assertExhaustive: false },
    );
    const successOut = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            response: { data: { create_item: newItem } },
          },
        ],
      },
      { multipartTransport: successMultipart },
    );
    expect(successOut.exitCode).toBe(0);
    assertLiteralAbsent('live success', successOut);

    // Surface 2 — dry-run two-`planned_changes` envelope.
    const dryRunMultipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const dryRunOut = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath}`,
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
      { multipartTransport: dryRunMultipart },
    );
    expect(dryRunOut.exitCode).toBe(0);
    assertLiteralAbsent('dry-run', dryRunOut);

    // Surface 3 — orphan-warn envelope on leg-2 failure.
    const orphanMultipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          response: {
            errors: [
              {
                message: 'File size limit exceeded',
                extensions: { code: 'FILE_SIZE_LIMIT_EXCEEDED' },
              },
            ],
          },
        },
      ],
      { assertExhaustive: false },
    );
    const orphanOut = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            response: { data: { create_item: newItem } },
          },
        ],
      },
      { multipartTransport: orphanMultipart },
    );
    expect(orphanOut.exitCode).toBe(2);
    assertLiteralAbsent('orphan-warn', orphanOut);

    // Surface 4 — leg-1 failure envelope (no orphan).
    const leg1FailMultipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const leg1FailOut = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoard] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            response: {
              errors: [
                {
                  message: 'Item name must not be blank',
                  extensions: { code: 'InvalidArgumentException' },
                },
              ],
            },
          },
        ],
      },
      { multipartTransport: leg1FailMultipart },
    );
    expect(leg1FailOut.exitCode).toBe(2);
    assertLiteralAbsent('leg-1 failure', leg1FailOut);
  });
});

describe('monday item create — v0.8-M46 multi-file `--set` carve-out fold (D2 closure from v0.6-M38)', () => {
  // v0.8-M46 IMPL. argv + pre-check + create-mode resolution +
  // routing surface ships as live contract; the two-leg-group
  // multi-file dispatch body (`runItemCreateFileMultiDispatch`):
  // precheckLocalFile × N + leg-1 create_item (bundling non-file
  // column_values) + legs 2..N+1 sequential add_file_to_column,
  // emitting `operation: 'item_create_with_files'`. The
  // `'m46_preflight_stub'` + `'multi_file_set_unsupported'`
  // discriminator literals stay RESERVED post-IMPL (regression-
  // guarded below).
  const buildMultiAsset = (id: string, name: string): Record<string, unknown> => ({
    id,
    name,
    url: `https://files.monday.com/x/${id}`,
    public_url: `https://share.monday.com/${id}`,
    file_extension: 'pdf',
    file_size: 19,
    created_at: '2026-06-01T10:30:00Z',
    uploaded_by: { id: '1', name: 'Alice' },
    original_geometry: null,
    url_thumbnail: null,
  });
  const fileBoardMultiCols = {
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
      {
        id: 'attachments_2',
        title: 'Attachments 2',
        type: 'file',
        description: null,
        archived: null,
        settings_str: '{}',
        width: null,
      },
    ],
  };

  let workdirM46: string;
  let reportPath1: string;
  let reportPath2: string;
  beforeEach(async () => {
    workdirM46 = await mkdtemp(join(tmpdir(), 'monday-cli-item-create-m46-'));
    reportPath1 = join(workdirM46, 'report-1.pdf');
    reportPath2 = join(workdirM46, 'report-2.pdf');
    await writeFile(reportPath1, 'PDF-bytes-fixture-1', 'utf8');
    await writeFile(reportPath2, 'PDF-bytes-fixture-2', 'utf8');
  });
  afterEach(async () => {
    await rm(workdirM46, { recursive: true, force: true });
  });

  it("live create-time multi-file: leg-1 create_item then N sequential add_file_to_column legs + emits 'item_create_with_files' (inlined item shape, NOT scalar item_id)", async () => {
    // v0.8-M46 IMPL two-leg-group. Leg-1 creates the item (column_values
    // null since both `--set` are file entries → routed to file legs);
    // legs 2..N+1 attach the files sequentially per D1. The envelope
    // inlines leg-1's full ItemCreateOutput under `item` (NOT a scalar
    // item_id — the Codex R2 P2-1 regression-guard contract).
    const multipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report-1.pdf',
          response: { data: { add_file_to_column: buildMultiAsset('a1', 'report-1.pdf') } },
        },
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report-2.pdf',
          response: { data: { add_file_to_column: buildMultiAsset('a2', 'report-2.pdf') } },
        },
      ],
      { assertExhaustive: true },
    );
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${reportPath2}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoardMultiCols] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            match_variables: {
              boardId: '111',
              itemName: 'Refactor login',
              columnValues: null,
            },
            response: { data: { create_item: newItem } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        item: { id: string; name: string; board_id: string; group_id: string | null };
        assets: { column_id: string; filename: string; asset: { id: string } }[];
        applied_file_columns: string[];
      };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    assertEnvelopeContract(env);
    expect(env.data.operation).toBe('item_create_with_files');
    // Inlined ItemCreateOutput shape, NOT a scalar item_id.
    expect(env.data.item).toEqual({
      id: '99001',
      name: 'Refactor login',
      board_id: '111',
      group_id: 'topics',
    });
    expect(env.data.applied_file_columns).toEqual([
      'attachments',
      'attachments_2',
    ]);
    expect(env.data.assets).toHaveLength(2);
    expect(env.data.assets[0]).toMatchObject({
      column_id: 'attachments',
      filename: 'report-1.pdf',
      asset: { id: 'a1' },
    });
    expect(env.data.assets[1]).toMatchObject({
      column_id: 'attachments_2',
      filename: 'report-2.pdf',
      asset: { id: 'a2' },
    });
    expect(env.resolved_ids).toMatchObject({
      attachments: 'attachments',
      attachments_2: 'attachments_2',
    });
    // Two file legs fired in dispatch order against the created item.
    expect(multipart.requests).toHaveLength(2);
    expect(multipart.requests[0]?.filename).toBe('report-1.pdf');
    expect(multipart.requests[1]?.filename).toBe('report-2.pdf');
    multipart.assertConsumed();
    expect(out.stderr).not.toContain('m46_preflight_stub');
    expect(out.stdout).not.toContain('m46_preflight_stub');
    expect(out.stderr).not.toContain('multi_file_set_unsupported');
    expect(out.stdout).not.toContain('multi_file_set_unsupported');
  });

  it('dry-run create-time multi-file: emits N+1 planned_changes (1 create_item + N add_file_to_column without item_id), no wire legs', async () => {
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${reportPath2}`,
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoardMultiCols] } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes?: readonly Record<string, unknown>[];
    };
    expect(env.ok).toBe(true);
    const meta = env.meta as EnvelopeShape['meta'] & { dry_run?: boolean };
    expect(meta.dry_run).toBe(true);
    // 1 create_item + 2 add_file_to_column = 3 planned_changes.
    expect(env.planned_changes).toHaveLength(3);
    expect(env.planned_changes![0]).toMatchObject({
      operation: 'create_item',
      board_id: '111',
      name: 'Refactor login',
    });
    expect(env.planned_changes![1]).toEqual({
      operation: 'add_file_to_column',
      column_id: 'attachments',
      file_path: reportPath1,
      filename: 'report-1.pdf',
      file_size_bytes: 19,
    });
    expect(env.planned_changes![2]).toEqual({
      operation: 'add_file_to_column',
      column_id: 'attachments_2',
      file_path: reportPath2,
      filename: 'report-2.pdf',
      file_size_bytes: 19,
    });
    expect(multipart.requests).toHaveLength(0);
    expect(out.stdout).not.toContain('m46_preflight_stub');
    expect(out.stderr).not.toContain('m46_preflight_stub');
  });

  it("create-time multi-file partial failure: orphan-warn 'create_then_file_upload_partial_failure' with created_item_id + applied_file_columns (length 0..N-1) after a file leg fails", async () => {
    // Leg-1 creates the item; leg-2 (attachments) lands; leg-3
    // (attachments_2) fails. The orphan-warn envelope extends M43's
    // discriminator with the always-present applied_file_columns slot
    // (length k>0 here — one file column landed before the failure).
    const multipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report-1.pdf',
          response: { data: { add_file_to_column: buildMultiAsset('a1', 'report-1.pdf') } },
        },
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report-2.pdf',
          response: { errors: [{ message: 'Internal server error' }] },
          http_status: 500,
        },
      ],
      { assertExhaustive: false },
    );
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${reportPath2}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoardMultiCols] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            response: { data: { create_item: newItem } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          reason?: string;
          created_item_id?: string;
          applied_file_columns?: string[];
          failed_file_column?: string;
          column_id?: string;
          cause?: { code?: string };
        };
      };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.reason).toBe(
      'create_then_file_upload_partial_failure',
    );
    expect(env.error?.details?.created_item_id).toBe('99001');
    // One file column landed before the failure.
    expect(env.error?.details?.applied_file_columns).toEqual(['attachments']);
    expect(env.error?.details?.failed_file_column).toBe('attachments_2');
    expect(env.error?.details?.column_id).toBe('attachments_2');
    expect(env.error?.details?.cause?.code).toBeDefined();
    expect(out.stderr).not.toContain('m46_preflight_stub');
  });

  it('create-time multi-file partial failure with length-0 applied_file_columns when the FIRST file leg fails (no file columns landed; item still orphaned)', async () => {
    // Leg-1 creates the item; the FIRST file leg fails immediately —
    // applied_file_columns is length 0 (mirrors M43's single-file
    // leg-2-fails-immediately case extended to the multi-file surface).
    const multipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report-1.pdf',
          response: { errors: [{ message: 'Internal server error' }] },
          http_status: 500,
        },
      ],
      { assertExhaustive: false },
    );
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${reportPath2}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoardMultiCols] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            response: { data: { create_item: newItem } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        details?: {
          reason?: string;
          created_item_id?: string;
          applied_file_columns?: string[];
          failed_file_column?: string;
        };
      };
    };
    expect(env.error?.details?.reason).toBe(
      'create_then_file_upload_partial_failure',
    );
    expect(env.error?.details?.created_item_id).toBe('99001');
    expect(env.error?.details?.applied_file_columns).toEqual([]);
    expect(env.error?.details?.failed_file_column).toBe('attachments');
    // Only one file leg fired — the loop stopped at the first failure.
    expect(multipart.requests).toHaveLength(1);
  });

  it('create-time multi-file pre-check aborts the whole call BEFORE leg-1 create when a file path is unreadable (usage_error; no create_item wire leg)', async () => {
    // D3 — N upfront pre-checks BEFORE either wire leg. A missing path
    // aborts the whole call with `usage_error`; the BoardMetadata fetch
    // (for the M38 pre-check's column resolution) fires, but no
    // ItemCreateTopLevel leg + no multipart leg.
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: false,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${join(workdirM46, 'missing.pdf')}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoardMultiCols] } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { reason?: string } };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.details?.reason).toBe('file_not_readable');
    expect(multipart.requests).toHaveLength(0);
  });

  // Board fixture for the mixed case below: two file columns PLUS a
  // status column, so leg-1's `create_item` bundles the non-file
  // `--set status_4=Done` into `column_values` while the two file
  // columns route to legs 2..N+1.
  const fileBoardMultiColsPlusStatus = {
    ...sampleBoardMetadata,
    columns: [
      ...fileBoardMultiCols.columns,
      {
        id: 'status_4',
        title: 'Status',
        type: 'status',
        description: null,
        archived: null,
        settings_str:
          '{"labels":{"0":"Backlog","1":"In Progress","2":"Done"}}',
        width: null,
      },
    ],
  };

  it('live create-time multi-file mixed with a non-file `--set`: leg-1 bundles the non-file column_values, legs 2..N+1 attach the files', async () => {
    // Exercises the `translated.length !== 0` arm of leg-1's
    // column_values bundling (the file-only happy path above hits the
    // `=== 0 → null` arm) — a non-file `--set status_4=Done` rides
    // into leg-1's `column_values` atomically while the two file
    // columns fan out across legs 2..N+1 (D6 mixed-rule asymmetry on
    // `'item_create'`).
    const multipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report-1.pdf',
          response: { data: { add_file_to_column: buildMultiAsset('a1', 'report-1.pdf') } },
        },
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report-2.pdf',
          response: { data: { add_file_to_column: buildMultiAsset('a2', 'report-2.pdf') } },
        },
      ],
      { assertExhaustive: true },
    );
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        'status_4=Done',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${reportPath2}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoardMultiColsPlusStatus] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            // Non-file `status_4=Done` bundles into leg-1's column_values
            // (non-null this time — distinct from the file-only path).
            match_variables: { boardId: '111', itemName: 'Refactor login' },
            response: { data: { create_item: newItem } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { operation: string; applied_file_columns: string[] };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.data.operation).toBe('item_create_with_files');
    expect(env.data.applied_file_columns).toEqual([
      'attachments',
      'attachments_2',
    ]);
    // resolved_ids carries the non-file token alongside the file tokens.
    expect(env.resolved_ids).toMatchObject({
      status_4: 'status_4',
      attachments: 'attachments',
      attachments_2: 'attachments_2',
    });
    expect(multipart.requests).toHaveLength(2);
    multipart.assertConsumed();
  });

  it('live create-time multi-file: leg-1 `create_item` failure folds + remaps before any file leg fires (no orphan)', async () => {
    // Leg-1 fails — no item is created, so there is no orphan handle;
    // the failure folds resolver warnings + remaps via foldAndRemap
    // (mirrors M43 single-file leg-1 failure). Exercises the
    // `err instanceof MondayCliError` leg-1-catch arm + the
    // `resolutionResult.source ?? 'live'` fallback (file-only `--set`
    // leaves the JSON resolution source unset). No multipart leg fires.
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${reportPath2}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoardMultiCols] } },
          },
          {
            operation_name: 'ItemCreateTopLevel',
            response: {
              errors: [
                {
                  message: 'invalid create payload',
                  extensions: { code: 'INVALID_COLUMN_VALUE', status_code: 400 },
                },
              ],
            },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { reason?: string } };
    };
    // Leg-1 failure surfaces a mapped error, NOT the orphan-warn
    // partial-failure reason (no item was created to orphan).
    expect(env.error?.code).not.toBe('column_archived');
    expect(env.error?.details?.reason).not.toBe(
      'create_then_file_upload_partial_failure',
    );
    // No item created → no file legs dispatched.
    expect(multipart.requests).toHaveLength(0);
  });

  // Subitems board (id `333`) carrying TWO file columns + a parent
  // board whose subtasks column points at it — the subitem variant of
  // the multi-file create path.
  const subitemsBoardMultiFile = {
    ...sampleBoardMetadata,
    id: '333',
    name: 'Subitems of Tasks',
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
      {
        id: 'attachments_2',
        title: 'Attachments 2',
        type: 'file',
        description: null,
        archived: null,
        settings_str: '{}',
        width: null,
      },
    ],
  };
  const parentBoardForMultiFileSubitem = {
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

  it('live create-time multi-file subitem: leg-1 `create_subitem` then N sequential file legs against the new subitem', async () => {
    // Exercises the `createMode.kind === 'subitem'` arm of leg-1 in
    // the multi-file dispatch helper (the top-level happy path hits the
    // item arm). Parent lookup → parent metadata → subitems-board
    // metadata pre-check → create_subitem → 2 file legs.
    const multipart = createInlineMultipartFixtureTransport(
      [
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report-1.pdf',
          response: { data: { add_file_to_column: buildMultiAsset('s1', 'report-1.pdf') } },
        },
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'report-2.pdf',
          response: { data: { add_file_to_column: buildMultiAsset('s2', 'report-2.pdf') } },
        },
      ],
      { assertExhaustive: true },
    );
    const out = await drive(
      [
        'item',
        'create',
        '--parent',
        '12345',
        '--name',
        'Subtask 1',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${reportPath2}`,
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
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [parentBoardForMultiFileSubitem] } },
          },
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [subitemsBoardMultiFile] } },
          },
          {
            operation_name: 'ItemCreateSubitem',
            match_variables: { parentItemId: '12345', itemName: 'Subtask 1' },
            response: { data: { create_subitem: newSubitem } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        item: { id: string; parent_id?: string; board_id: string };
        applied_file_columns: string[];
      };
    };
    expect(env.data.operation).toBe('item_create_with_files');
    expect(env.data.item.parent_id).toBe('12345');
    expect(env.data.item.board_id).toBe('333');
    expect(env.data.applied_file_columns).toEqual([
      'attachments',
      'attachments_2',
    ]);
    expect(multipart.requests).toHaveLength(2);
    multipart.assertConsumed();
  });

  it('dry-run create-time multi-file with a non-file `--set-raw`: leg-1 plan bundles the raw column_values (rawEntries non-empty branch)', async () => {
    // Exercises the `rawEntries.length !== 0` arm of leg-1's planCreate
    // call in the dry-run branch (the file-only dry-run above hits the
    // empty arm). A `--set-raw status_4=<json>` bundles into leg-1's
    // planned column_values alongside the two file planned_changes.
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set-raw',
        'status_4={"label":"Done"}',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${reportPath2}`,
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoardMultiColsPlusStatus] } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes?: readonly Record<string, unknown>[];
    };
    expect(env.ok).toBe(true);
    // 1 create_item (with the raw status bundled) + 2 add_file_to_column.
    expect(env.planned_changes).toHaveLength(3);
    expect(env.planned_changes![0]).toMatchObject({ operation: 'create_item' });
    expect(multipart.requests).toHaveLength(0);
  });

  it('dry-run create-time multi-file: a malformed `--set-raw` JSON is rejected before any wire leg', async () => {
    // `--set-raw` JSON is parsed eagerly in the action body (before the
    // multi-file dispatch helper runs), so malformed JSON aborts the
    // whole call up front — regression guard that the multi-file route
    // doesn't bypass that early `--set-raw` validation. No wire leg.
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set-raw',
        'status_4=not-json',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${reportPath2}`,
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoardMultiColsPlusStatus] } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).not.toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBeDefined();
    expect(multipart.requests).toHaveLength(0);
  });

  it('live create-time multi-file: a malformed `--set-raw` JSON is rejected before any wire leg', async () => {
    // Same early `--set-raw` validation on the live route — malformed
    // JSON aborts the whole call before leg-1 create / any multipart
    // leg fires (regression guard, mirrors the dry-run case above).
    const multipart = createInlineMultipartFixtureTransport([], {
      assertExhaustive: true,
    });
    const out = await drive(
      [
        'item',
        'create',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--set-raw',
        'status_4=not-json',
        '--set',
        `attachments=${reportPath1}`,
        '--set',
        `attachments_2=${reportPath2}`,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [fileBoardMultiColsPlusStatus] } },
          },
        ],
      },
      { multipartTransport: multipart },
    );
    expect(out.exitCode).not.toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBeDefined();
    expect(multipart.requests).toHaveLength(0);
  });
});
