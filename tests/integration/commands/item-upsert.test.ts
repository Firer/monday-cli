/**
 * Integration tests for `monday item upsert` (M12 idempotency-cluster
 * verb — cli-design.md §4.3 line 529 + §5.8 + §6.4 + §6.5;
 * v0.2-plan.md §3 M12).
 *
 * Coverage map:
 *
 *   - Argv parser: --board / --name / --match-by required;
 *     comma-split + dedupe; empty match-by tokens; --set required for
 *     each non-`name` match-by token; --set-raw rejected in
 *     --match-by.
 *   - Lookup branch decisions: 0 matches → create branch; 1 match →
 *     update branch; ≥2 → ambiguous_match with details.candidates.
 *   - Live happy paths: create branch fires create_item with bundled
 *     column_values; update branch fires change_multiple_column_values
 *     with synthetic name; envelope `data.operation` discriminator.
 *   - Dry-run paths: both branches emit operation: "create_item" /
 *     "update_item" via post-processed plannedChange.
 *   - Match-by surface: literal `name` pseudo-token resolves to
 *     `column_id: "name"` filter rule; column tokens resolve via the
 *     same column resolver `--set` uses; multi-token AND-combine.
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import {
  boardMetadataInteraction,
  sampleItem,
  useItemTestEnv,
} from './_item-fixtures.js';

const { drive } = useItemTestEnv();

// Lookup interaction template — agents pass this with a per-test
// `items` array to mock the items_page response.
const lookupInteraction = (
  items: readonly { readonly id: string; readonly name: string }[],
  cursor: string | null = null,
): {
  readonly operation_name: string;
  readonly response: {
    readonly data: {
      readonly boards: readonly {
        readonly items_page: {
          readonly cursor: string | null;
          readonly items: readonly { readonly id: string; readonly name: string }[];
        };
      }[];
    };
  };
} => ({
  operation_name: 'ItemUpsertLookup',
  response: {
    data: { boards: [{ items_page: { cursor, items } }] },
  },
});

const updatedItem = {
  ...sampleItem,
  column_values: [
    {
      id: 'status_4',
      type: 'status',
      text: 'Backlog',
      value: '{"label":"Backlog","index":0}',
      column: { title: 'Status' },
    },
  ],
};

// ============================================================
// Argv parser
// ============================================================

describe('monday item upsert — argv parsing', () => {
  it('rejects missing --match-by', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'X',
        '--set',
        'status=Backlog',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --match-by token between commas', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'X',
        '--match-by',
        'name,,owner',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects duplicate --match-by tokens', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'X',
        '--match-by',
        'name,name',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects --match-by column without matching --set', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'X',
        '--match-by',
        'status',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; message: string };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toContain('--match-by');
    expect(env.error?.message).toContain('--set');
  });

  it('rejects --match-by token paired with --set-raw entry', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'X',
        '--match-by',
        'status',
        '--set-raw',
        'status={"label":"Backlog"}',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; message: string };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toContain('--set-raw');
  });

  it('rejects --name empty after trim', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        '   ',
        '--match-by',
        'name',
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
// Live: create branch (lookup → 0 matches → create_item)
// ============================================================

describe('monday item upsert — create branch (0 matches)', () => {
  it('lookup returns 0 → fires create_item with bundled column_values', async () => {
    const out = await drive(
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
          // Match-by `name` skips column resolution; only the lookup
          // fires before metadata loads (resolver-leg goes through
          // resolveAndTranslate for the --set status=Backlog
          // translation).
          boardMetadataInteraction,
          lookupInteraction([]),
          {
            operation_name: 'ItemUpsertCreate',
            response: {
              data: { create_item: { ...updatedItem, id: '99001', name: 'Refactor login' } },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; operation: string; name: string };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    assertEnvelopeContract(env);
    expect(env.data.id).toBe('99001');
    expect(env.data.operation).toBe('create_item');
    expect(env.data.name).toBe('Refactor login');
    expect(env.resolved_ids).toEqual({ status: 'status_4' });
  });

  it('match-by column token resolves via column resolver', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'status',
        '--set',
        'status=Backlog',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          lookupInteraction([]),
          {
            operation_name: 'ItemUpsertCreate',
            response: {
              data: { create_item: { ...updatedItem, id: '99001', name: 'Refactor login' } },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { operation: string };
    };
    expect(env.data.operation).toBe('create_item');
  });

  it('multi-token --match-by AND-combines (name + column)', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name,status',
        '--set',
        'status=Backlog',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          lookupInteraction([]),
          {
            operation_name: 'ItemUpsertCreate',
            response: {
              data: { create_item: { ...updatedItem, id: '99001', name: 'Refactor login' } },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { operation: string };
    };
    expect(env.data.operation).toBe('create_item');
  });
});

// ============================================================
// Live: update branch (lookup → 1 match → change_multiple_column_values)
// ============================================================

describe('monday item upsert — update branch (1 match)', () => {
  it('lookup returns 1 → fires change_multiple_column_values with synthetic name', async () => {
    const out = await drive(
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
          lookupInteraction([{ id: '12345', name: 'Refactor login' }]),
          {
            operation_name: 'ItemUpsertMulti',
            response: {
              data: {
                change_multiple_column_values: {
                  ...updatedItem,
                  id: '12345',
                  name: 'Refactor login',
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; operation: string; name: string };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    assertEnvelopeContract(env);
    expect(env.data.id).toBe('12345');
    expect(env.data.operation).toBe('update_item');
    expect(env.resolved_ids).toEqual({ status: 'status_4' });
  });

  it('lookup returns 0 with --name only → create_item with null column_values', async () => {
    // Symmetric to the `--name only → update_item` test above but for
    // the create branch. Empty `--set` means resolveAndTranslate
    // returns no translated columns, `bundleColumnValues` skips, and
    // the create call fires with `column_values: null`. Pins the
    // empty-translation path through runCreateBranch (otherwise
    // exercised only via the multi-`--set` tests).
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--json',
      ],
      {
        interactions: [
          // Single metadata leg shared across the lookup + create
          // legs; no column resolution needed (--match-by name is a
          // pseudo-token, no --set columns).
          boardMetadataInteraction,
          lookupInteraction([]),
          {
            operation_name: 'ItemUpsertCreate',
            response: {
              data: {
                create_item: { ...sampleItem, id: '99001', name: 'Refactor login' },
              },
              // The mutation's match_variables would echo
              // `columnValues: null` because there are no --set legs
              // to translate. Cassette transport doesn't pin
              // variables here; the contract is `data.operation:
              // create_item` + the new id.
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; operation: string; name: string };
    };
    expect(env.data.id).toBe('99001');
    expect(env.data.operation).toBe('create_item');
    expect(env.data.name).toBe('Refactor login');
  });

  it('lookup returns 1 with --name only → change_simple_column_value name path', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--json',
      ],
      {
        interactions: [
          // No board metadata fetch — match-by `name` doesn't need
          // resolution and there are no `--set` columns to translate.
          // The CLI still loads metadata once to share across legs;
          // this is the single metadata leg.
          boardMetadataInteraction,
          lookupInteraction([{ id: '12345', name: 'Refactor login' }]),
          {
            operation_name: 'ItemUpsertSimple',
            response: {
              data: {
                change_simple_column_value: {
                  ...sampleItem,
                  id: '12345',
                  name: 'Refactor login',
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { operation: string };
    };
    expect(env.data.operation).toBe('update_item');
  });
});

// ============================================================
// Ambiguous match (lookup → 2+ matches → ambiguous_match)
// ============================================================

describe('monday item upsert — ambiguous_match (2+ matches)', () => {
  it('lookup returns 2 → ambiguous_match with details.candidates', async () => {
    const out = await drive(
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
          lookupInteraction([
            { id: '12345', name: 'Refactor login' },
            { id: '12346', name: 'Refactor login' },
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        message: string;
        details: {
          board_id: string;
          match_by: readonly string[];
          match_values: Readonly<Record<string, string>>;
          matched_count: number;
          candidates: readonly { id: string; name: string }[];
        };
      };
    };
    expect(env.error?.code).toBe('ambiguous_match');
    expect(env.error?.details.board_id).toBe('111');
    expect(env.error?.details.match_by).toEqual(['name']);
    expect(env.error?.details.match_values).toEqual({ name: 'Refactor login' });
    expect(env.error?.details.matched_count).toBe(2);
    expect(env.error?.details.candidates).toEqual([
      { id: '12345', name: 'Refactor login' },
      { id: '12346', name: 'Refactor login' },
    ]);
  });

  it('lookup returns 11 → ambiguous_match with candidates capped at 10', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      id: String(10000 + i),
      name: 'Refactor login',
    }));
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          // Cursor is non-null when limit=11 returns 11 items — there
          // could be more pages; the upsert short-circuits anyway.
          lookupInteraction(eleven, 'next-cursor'),
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details: {
          matched_count: number;
          candidates: readonly { id: string; name: string }[];
        };
      };
    };
    expect(env.error?.code).toBe('ambiguous_match');
    expect(env.error?.details.matched_count).toBe(11);
    expect(env.error?.details.candidates.length).toBe(10);
  });

  it('lookup returns 0 with cursor non-null → internal_error (Codex round-1 F3)', async () => {
    // Empty page with non-null cursor is a Monday API anomaly. Codex
    // round-1 F3 — pre-fix the upsert treated empty-with-cursor as
    // "0 matches → create", which would create a duplicate if Monday
    // were lying about the empty page. Post-fix: refuse to mutate.
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          lookupInteraction([], 'next-cursor'),
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { board_id?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.board_id).toBe('111');
  });

  it('lookup returns 1 with cursor non-null → conservative ambiguous_match', async () => {
    // Edge case: Monday returns a single item but with a non-null
    // cursor (a partial page suggesting more exists). decideBranch
    // treats this conservatively as ambiguous because we can't prove
    // there's only one match.
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          lookupInteraction(
            [{ id: '12345', name: 'Refactor login' }],
            'next-cursor',
          ),
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details: { matched_count: number } };
    };
    expect(env.error?.code).toBe('ambiguous_match');
    expect(env.error?.details.matched_count).toBe(1);
  });
});

// ============================================================
// Dry-run paths
// ============================================================

describe('monday item upsert — dry-run', () => {
  it('--dry-run: 0 matches → planned_change with operation: "create_item"', async () => {
    const out = await drive(
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
          lookupInteraction([]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        board_id: string;
        name: string;
        resolved_ids: Readonly<Record<string, string>>;
        diff: Readonly<Record<string, unknown>>;
        match_by: readonly string[];
        matched_count: number;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('create_item');
    expect(plan?.board_id).toBe('111');
    expect(plan?.name).toBe('Refactor login');
    expect(plan?.match_by).toEqual(['name']);
    expect(plan?.matched_count).toBe(0);
    expect(plan?.resolved_ids).toEqual({ status: 'status_4' });
    expect(plan?.diff).toHaveProperty('status_4');
  });

  it('--dry-run: 1 match → planned_change with operation: "update_item" + item_id', async () => {
    const out = await drive(
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
          lookupInteraction([{ id: '12345', name: 'Refactor login' }]),
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [sampleItem] } },
          },
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
        name: string;
        match_by: readonly string[];
        matched_count: number;
        diff: Readonly<Record<string, unknown>>;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('update_item');
    expect(plan?.item_id).toBe('12345');
    expect(plan?.board_id).toBe('111');
    expect(plan?.name).toBe('Refactor login');
    expect(plan?.match_by).toEqual(['name']);
    expect(plan?.matched_count).toBe(1);
    expect(plan?.diff).toHaveProperty('status_4');
    expect(plan?.diff).toHaveProperty('name');
  });

  it('--dry-run: 2+ matches → ambiguous_match (no mutation, no dry-run engine)', async () => {
    const out = await drive(
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
          lookupInteraction([
            { id: '12345', name: 'Refactor login' },
            { id: '12346', name: 'Refactor login' },
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('ambiguous_match');
  });
});

// ============================================================
// `me` resolution for people columns in match-by (Codex round-1 F1)
// ============================================================

describe('monday item upsert — me-token resolution in --match-by', () => {
  it('--set Owner=me resolves via Whoami; lookup queries with the resolved user id', async () => {
    // Codex round-1 F1 regression pin. Pre-fix the upsert sent the
    // literal string "me" to Monday's items_page filter, missing the
    // match and creating a duplicate. The fix routes match-by column
    // values through `buildQueryParams` (the same shared filter
    // pipeline `item search` and `item update --where` use), which
    // resolves `me` to the current user's ID via the Whoami query.
    const peopleMeta = {
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
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'Owner',
        '--set',
        'Owner=me',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [peopleMeta] } },
          },
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
          // Lookup query — assert the rule's compare_value carries
          // the RESOLVED user id (`'777'`), not the literal `'me'`.
          {
            operation_name: 'ItemUpsertLookup',
            match_variables: {
              boardId: '111',
              limit: 11,
              queryParams: {
                rules: [
                  {
                    column_id: 'person',
                    operator: 'any_of',
                    compare_value: ['777'],
                  },
                ],
              },
            },
            response: {
              data: { boards: [{ items_page: { cursor: null, items: [] } }] },
            },
          },
          // Create branch — Whoami fires AGAIN inside the people
          // translator for `--set Owner=me` because each resolution
          // pass keeps its own resolveMe closure.
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
            operation_name: 'ItemUpsertCreate',
            response: {
              data: {
                create_item: {
                  id: '99001',
                  name: 'Refactor login',
                  state: 'active',
                  url: null,
                  created_at: null,
                  updated_at: null,
                  board: { id: '111' },
                  group: { id: 'topics', title: 'Topics' },
                  parent_item: null,
                  column_values: [
                    {
                      id: 'person',
                      type: 'people',
                      text: 'Alice',
                      value: '{"personsAndTeams":[{"id":777,"kind":"person"}]}',
                      column: { title: 'Owner' },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; operation: string };
    };
    expect(env.data.id).toBe('99001');
    expect(env.data.operation).toBe('create_item');
  });
});

// ============================================================
// validation_failed → column_archived remap (F4 — both branches)
// ============================================================

describe('monday item upsert — F4 column-archived remap', () => {
  // Same shape `item create` / `item update` use: cache-sourced
  // resolution returns active, then Monday's mutation-time
  // validation_failed forces a refresh that reveals the archived
  // flag, then foldAndRemap rewrites validation_failed →
  // column_archived with details.remapped_from. M12 inherits the
  // helper from M9 + M5b unchanged; the test pins the inheritance
  // for both branches.
  const cachedActive = {
    ...sampleItem.column_values[0],
  };
  const activeMetadata = {
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
        archived: false,
        settings_str: '{}',
        width: null,
      },
    ],
  };
  const archivedMetadata = {
    ...activeMetadata,
    columns: [{ ...activeMetadata.columns[0], archived: true }],
  };

  it('create branch: validation_failed → column_archived remap', async () => {
    // Pre-warm cache with active column so the upsert resolution
    // hits cache (not live).
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [activeMetadata] } },
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
          // Cache hit — no metadata fetch on the upsert path itself.
          // Lookup returns 0 → branch to create.
          lookupInteraction([]),
          // Create mutation fails with validation_failed.
          {
            operation_name: 'ItemUpsertCreate',
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
          // foldAndRemap fetches fresh metadata; column now archived.
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [archivedMetadata] } },
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
    // Reference cachedActive so the lint rule doesn't drop it.
    expect(cachedActive).toBeDefined();
  });

  it('update branch: validation_failed → column_archived remap', async () => {
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [activeMetadata] } },
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
          lookupInteraction([{ id: '12345', name: 'Refactor login' }]),
          {
            operation_name: 'ItemUpsertMulti',
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
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [archivedMetadata] } },
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
});

// ============================================================
// Cache-miss refresh during column resolution
// ============================================================

describe('monday item upsert — cache-miss refresh', () => {
  it('match-by column missing in cache → onColumnNotFound refresh fires', async () => {
    // Pre-warm cache with an existing column (status_4 only). The
    // upsert references a brand-new column `external_id` for
    // match-by; the resolver fires onColumnNotFound to refetch
    // metadata, finds the new column, and proceeds.
    const cachedNoExternal = {
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
      ],
    };
    const refreshedWithExternal = {
      ...cachedNoExternal,
      columns: [
        ...cachedNoExternal.columns,
        {
          id: 'external_id',
          title: 'External ID',
          type: 'text',
          description: null,
          archived: null,
          settings_str: null,
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
            response: { data: { boards: [cachedNoExternal] } },
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
        'upsert',
        '--board',
        '111',
        '--name',
        'Test',
        '--match-by',
        'external_id',
        '--set',
        'external_id=ABC-123',
        '--json',
      ],
      {
        interactions: [
          // Cache hit on initial metadata; resolver fires onColumnNotFound.
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedWithExternal] } },
          },
          lookupInteraction([]),
          // Resolution-pass fires another metadata fetch — the cache
          // is now updated, but the upsert's resolveAndTranslate call
          // still re-fetches because each resolution-pass loads
          // metadata afresh.
          {
            operation_name: 'ItemUpsertCreate',
            response: {
              data: {
                create_item: {
                  ...sampleItem,
                  id: '99001',
                  name: 'Test',
                  column_values: [
                    {
                      id: 'external_id',
                      type: 'text',
                      text: 'ABC-123',
                      value: '"ABC-123"',
                      column: { title: 'External ID' },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
      warnings?: readonly { code: string }[];
    };
    expect(env.data.id).toBe('99001');
    // The cache-refresh path emits a stale_cache_refreshed warning.
    const warnings = env.warnings ?? [];
    expect(warnings.some((w) => w.code === 'stale_cache_refreshed')).toBe(true);
  });
});

// ============================================================
// --set-raw passthrough (M8 escape hatch)
// ============================================================

describe('monday item upsert — --set-raw participates in column updates', () => {
  it('create branch live: --set-raw bundles into column_values', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--set-raw',
        'status_4={"label":"Backlog"}',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          lookupInteraction([]),
          {
            operation_name: 'ItemUpsertCreate',
            response: {
              data: {
                create_item: {
                  ...updatedItem,
                  id: '99001',
                  name: 'Refactor login',
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { operation: string };
    };
    expect(env.data.operation).toBe('create_item');
  });

  it('update branch dry-run: --set-raw shows in diff', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--set-raw',
        'status_4={"label":"Backlog"}',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          lookupInteraction([{ id: '12345', name: 'Refactor login' }]),
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        operation: string;
        diff: Readonly<Record<string, unknown>>;
      }[];
    };
    expect(env.planned_changes[0]?.operation).toBe('update_item');
    expect(env.planned_changes[0]?.diff).toHaveProperty('status_4');
  });

  it('create branch dry-run: --set-raw shows in diff', async () => {
    const out = await drive(
      [
        'item',
        'upsert',
        '--board',
        '111',
        '--name',
        'Refactor login',
        '--match-by',
        'name',
        '--set-raw',
        'status_4={"label":"Backlog"}',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          lookupInteraction([]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        operation: string;
        diff: Readonly<Record<string, unknown>>;
      }[];
    };
    expect(env.planned_changes[0]?.operation).toBe('create_item');
    expect(env.planned_changes[0]?.diff).toHaveProperty('status_4');
  });
});

// ============================================================
// Sequential-retry idempotency (re-run yields update branch)
// ============================================================

describe('monday item upsert — sequential-retry idempotency', () => {
  it('first call (0 matches) → create; second call (1 match) → update', async () => {
    // First call.
    const firstOut = await drive(
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
          lookupInteraction([]),
          {
            operation_name: 'ItemUpsertCreate',
            response: {
              data: {
                create_item: { ...updatedItem, id: '99001', name: 'Refactor login' },
              },
            },
          },
        ],
      },
    );
    expect(firstOut.exitCode).toBe(0);
    const firstEnv = parseEnvelope(firstOut.stdout) as EnvelopeShape & {
      data: { operation: string };
    };
    expect(firstEnv.data.operation).toBe('create_item');

    // Second call — same args. Board metadata is now cached from the
    // first call (same XDG_CACHE_HOME tmp root), so the only network
    // legs are the lookup + mutation. Lookup returns the just-created
    // item (id=99001) and the branch flips to update_item.
    const secondOut = await drive(
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
          lookupInteraction([{ id: '99001', name: 'Refactor login' }]),
          {
            operation_name: 'ItemUpsertMulti',
            response: {
              data: {
                change_multiple_column_values: {
                  ...updatedItem,
                  id: '99001',
                  name: 'Refactor login',
                },
              },
            },
          },
        ],
      },
    );
    expect(secondOut.exitCode).toBe(0);
    const secondEnv = parseEnvelope(secondOut.stdout) as EnvelopeShape & {
      data: { operation: string };
    };
    expect(secondEnv.data.operation).toBe('update_item');
  });
});
