/**
 * Integration tests for `monday item update --where ...` bulk path
 * (M5b atomic multi-column write applied across N matched items).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6) + per-verb fixture module (R14). Coverage:
 *   - confirmation_required gate without `--yes` / `--dry-run`
 *   - `--yes` commit through to per-item live mutations
 *   - `--dry-run` aggregation across N matched items (per-item
 *     `planChanges` results merged, resolver-warning dedupe,
 *     source/cache-age aggregation across metadata + walk + per-item
 *     legs)
 *   - partial-failure error decoration (`applied_count` /
 *     `applied_to` / `failed_at_item` / `matched_count`)
 *   - F4 `validation_failed` → `column_archived` remap on bulk
 *     per-item failures (probe-all, post-stale-cache refresh)
 *
 * Single-item path (atomic multi-`--set`, `--name`, dry-run) lives
 * in `item-update.test.ts`. The split happened at HEAD `2c30c66`'s
 * pre-M7 sweep — the original combined file was 2,609 lines, well
 * past §15's 1,500-line threshold; the per-mode split mirrors R14's
 * per-verb split of the original `item.test.ts` (M5b session 4).
 */
import { mkdtemp, rm, stat as fsStat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_API_URL,
  LEAK_CANARY,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import { createInlineMultipartFixtureTransport } from '../../fixtures/multipart-load.js';
import { resolveCacheRoot, writeEntry } from '../../../src/api/cache.js';
import {
  boardMetadataInteraction,
  sampleBoardMetadata,
  sampleItem,
  useItemTestEnv,
} from './_item-fixtures.js';

const { drive, xdgRoot } = useItemTestEnv();

describe('monday item update (integration, M5b — bulk --where path)', () => {
  // Helper to build matched-item responses.
  const buildItem = (id: string, name = `Item ${id}`): typeof sampleItem => ({
    ...sampleItem,
    id,
    name,
  });

  it('rejects bulk shape without --board as usage_error', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Working',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --filter-json as usage_error before any network call (whole-board safety)', async () => {
    // Codex pass-3 of the cli-design backfill PR: an explicit
    // `--filter-json ''` was treated as "bulk mode" by the
    // dispatch (`filterJson !== undefined`), but `buildQueryParams`
    // short-circuits an empty string into "no filter" and returns
    // `queryParams: undefined` — net effect, the bulk walker would
    // visit every item on the board and the live path would mutate
    // every one. The empty value is rejected at the schema boundary
    // so no network call fires.
    const out = await drive(
      [
        'item',
        'update',
        '--board',
        '111',
        '--filter-json',
        '',
        '--yes',
        '--set',
        'status=Done',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/filter-json/);
  });

  it('rejects whitespace-only --filter-json as usage_error before any network call', async () => {
    // Pass-1 of the fix tightened `.min(1)` to a `trim()` refinement
    // so `--filter-json '   '` doesn't slip past the schema and
    // burn a board-metadata network call before failing at
    // `JSON.parse`. The empty-interactions array forces the test to
    // explode with a transport error if the schema lets the input
    // through.
    const out = await drive(
      [
        'item',
        'update',
        '--board',
        '111',
        '--filter-json',
        '   ',
        '--yes',
        '--set',
        'status=Done',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/filter-json/);
  });

  it('rejects mixing positional <iid> AND --where as usage_error', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--where',
        'status=Backlog',
        '--set',
        'status=Working',
        '--board',
        '111',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects bulk shape without --yes (and without --dry-run) as confirmation_required', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Working',
        '--board',
        '111',
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
                      items: [{ id: '5001' }, { id: '5002' }, { id: '5003' }],
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
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { matched_count?: number; board_id?: string };
      };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.matched_count).toBe(3);
    expect(env.error?.details?.board_id).toBe('111');
  });

  it('--dry-run: emits N planned_changes (one per matched item)', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
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
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5001')] } },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5002')] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        item_id: string;
        diff: Readonly<Record<string, unknown>>;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(2);
    expect(env.planned_changes[0]?.item_id).toBe('5001');
    expect(env.planned_changes[1]?.item_id).toBe('5002');
  });

  it('--yes: applies the mutation to every matched item, returns summary + items', async () => {
    const out = await drive(
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
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: { matched_count: number; applied_count: number; board_id: string };
        items: readonly { id: string }[];
      };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.data.summary).toEqual({
      matched_count: 2,
      applied_count: 2,
      board_id: '111',
    });
    expect(env.data.items.length).toBe(2);
    expect(env.resolved_ids).toEqual({ status: 'status_4' });
  });

  it('--yes: per-item failure surfaces with applied_to + matched_count details', async () => {
    const out = await drive(
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
            http_status: 400,
            response: {
              errors: [
                { message: 'invalid', extensions: { code: 'INVALID_ARGUMENT' } },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          applied_count?: number;
          matched_count?: number;
          failed_at_item?: string;
          applied_to?: readonly string[];
        };
      };
    };
    expect(env.error?.code).toBe('validation_failed');
    expect(env.error?.details?.applied_count).toBe(1);
    expect(env.error?.details?.matched_count).toBe(2);
    expect(env.error?.details?.failed_at_item).toBe('5002');
    expect(env.error?.details?.applied_to).toEqual(['5001']);
  });

  it('empty match set is a clean no-op success envelope (no --yes required)', async () => {
    // Codex pass-1 F1 + pass-2 follow-up: empty match must succeed
    // BEFORE the confirmation gate. Test drops `--yes` so a
    // regression to the pre-fix ordering would surface as
    // confirmation_required instead of success.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=NoSuchStatus',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
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
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { summary: { matched_count: number; applied_count: number } };
    };
    expect(env.data.summary).toEqual({
      matched_count: 0,
      applied_count: 0,
      board_id: '111',
    });
  });

  it('F6 (pass-2): malformed ItemsPage response surfaces typed internal_error', async () => {
    // Pre-fix the bulk page parse was loose: items_page optional +
    // boards nullable allowed `{boards:[{}]}` to coerce to an empty
    // match set silently, hiding schema drift behind a "0 matched,
    // 0 applied" success. Pass-2 tightened the schema; this test
    // pins the failure mode.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Done',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              // boards present but items_page missing — pre-fix this
              // looked like an empty page; post-fix, schema rejects.
              data: { boards: [{}] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { issues?: readonly unknown[] } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.issues).toBeDefined();
  });

  it('live: column_archived in bulk path surfaces with details', async () => {
    // Bulk-path archived branch (mirrors single-path coverage).
    // Use --filter-json so the filter parser doesn't try to
    // resolve `status` (the archived column) — agents who hit an
    // archived target with --filter-json bypass the filter
    // resolver entirely. The per-set-entry loop then trips the
    // archived check.
    const archivedMeta = {
      ...sampleBoardMetadata,
      columns: [
        {
          ...sampleBoardMetadata.columns[0],
          archived: true,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[]}',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [archivedMeta] } },
          },
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
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { column_id?: string; board_id?: string } };
    };
    expect(env.error?.code).toBe('column_archived');
    expect(env.error?.details?.column_id).toBe('status_4');
    expect(env.error?.details?.board_id).toBe('111');
  });

  it('live: cold-cache metadata + live walk + cache-served column resolution → mixed source + non-null cache_age_seconds (Codex M8 finding #3)', async () => {
    // Pre-fix, the bulk envelope reported `cache_age_seconds:
    // meta.cacheAgeSeconds`, which is null when metadata loaded
    // live. On a cold-cache run, the FIRST leg (metadata fetch) is
    // live, but the per-token column resolution then hits the
    // freshly-populated cache → resolution.source === 'cache'. The
    // aggregate `meta.source` correctly promotes to `mixed`, but
    // `cache_age_seconds: null` contradicted the `mixed` value.
    // Post-fix, the bulk path tracks `aggregateCacheAge` across
    // resolution legs (mirroring the single-item path) so the
    // envelope reports a non-null cache age whenever any resolution
    // leg served from cache.
    //
    // No cache pre-warm: BoardMetadata fires live; per-token
    // resolution then hits the populated cache.
    const out = await drive(
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
        '--json',
      ],
      {
        interactions: [
          // BoardMetadata fires live (cold cache).
          boardMetadataInteraction,
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }],
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
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    // meta.source promotes to 'mixed' (column resolution served from
    // the freshly-populated cache).
    expect(env.meta.source).toBe('mixed');
    // Cache age must be non-null to be coherent with `mixed` source.
    // Pre-fix this was null (`meta.cacheAgeSeconds` for a live load).
    expect(env.meta.cache_age_seconds).not.toBeNull();
    expect(typeof env.meta.cache_age_seconds).toBe('number');
  });

  it('live: cached metadata + live walk → source: "mixed" with cache_age_seconds', async () => {
    // Codex pass-2: bulk live envelope must aggregate source per
    // §6.1. Cache-served metadata + live items_page walk + live
    // mutations → meta.source: 'mixed', cache_age_seconds set.
    // Pre-fix the source was inferred from warning presence —
    // a plain cache hit (no warning) surfaced as 'live'.
    //
    // Setup:
    //   1. Warm the cache by running a list call.
    //   2. Run bulk update; metadata serves from cache, items_page
    //      + mutations are live.
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
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
    const out = await drive(
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
        '--json',
      ],
      {
        // No BoardMetadata interaction — cache serves it.
        interactions: [
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }],
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
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.source).toBe('mixed');
    expect(env.meta.cache_age_seconds).not.toBeNull();
  });

  it('--dry-run: cached metadata aggregates source + per-item warnings dedupe', async () => {
    // Bulk dry-run aggregates per-item planChanges results: source
    // (cache + live → mixed), cache_age_seconds (max), and warnings
    // (deduped by code+message+token). Warm the cache first so
    // bulk dry-run starts with `meta.source === 'cache'`.
    await drive(
      ['item', 'list', '--board', '111', '--limit', '1', '--json'],
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
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          // Cache hit on metadata. Bulk walks items_page live, then
          // dry-run reads each item's pre-mutation state.
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
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5001')] } },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5002')] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    // Cache-served metadata + live walk → source: 'mixed'.
    expect(env.meta.source).toBe('mixed');
    expect(env.meta.cache_age_seconds).not.toBeNull();
    expect(env.planned_changes.length).toBe(2);
  });

  it('--dry-run: deduplicates resolver warnings across N matched items', async () => {
    // Per-item resolveColumnWithRefresh emits a fresh
    // column_token_collision warning each time (no caching of the
    // collision detection itself), so an N-item bulk would surface
    // N copies of the same warning. dedupeWarnings consolidates by
    // code+message+token so agents see each unique warning once.
    //
    // Setup: a board where column id 'status_4' collides with
    // column title 'STATUS_4' (case-folded, different column).
    // The token 'status_4' resolves to the id-match column but
    // detectCollision flags the title-match column.
    const collidingMeta = {
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
          id: 'text_other',
          title: 'STATUS_4',
          type: 'text',
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
        'update',
        '--where',
        'status_4=Done',
        '--set',
        'status_4=Done',
        '--board',
        '111',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [collidingMeta] } },
          },
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
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [{ ...sampleItem, id: '5001' }] } },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [{ ...sampleItem, id: '5002' }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    const collisionWarnings = env.warnings.filter(
      (w) => w.code === 'column_token_collision',
    );
    // Without dedupe, we'd see >=3 copies (1 from filter + 2 from
    // per-item set resolution). With dedupe, exactly one.
    expect(collisionWarnings.length).toBe(1);
    expect(env.planned_changes.length).toBe(2);
  });

  it('--dry-run: bulk relative date with MONDAY_TIMEZONE override threads through every per-item plan', async () => {
    // Covers update.ts:1044 — the timezone-set branch in the bulk
    // dryrun's dateResolution context build. Mirrors the
    // single-path equivalent above.
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
    const itemWithDate = (id: string): typeof sampleItem => ({
      ...sampleItem,
      id,
      column_values: [
        {
          id: 'date4',
          type: 'date',
          text: '',
          value: null,
          column: { title: 'Due date' },
        },
      ],
    });
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[]}',
        '--set',
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
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: { cursor: null, items: [{ id: '5001' }] },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [itemWithDate('5001')] } },
          },
        ],
      },
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
        diff: Readonly<Record<string, {
          details?: { resolved_from?: { input: string; timezone: string } };
        }>>;
      }[];
    };
    const cell = env.planned_changes[0]?.diff.date4;
    expect(cell?.details?.resolved_from?.input).toBe('tomorrow');
    expect(cell?.details?.resolved_from?.timezone).toBe('Europe/London');
  });

  it('--dry-run: --name + --set in bulk emits planned_changes with name diff', async () => {
    // Covers the dry-run name-injection branch in the bulk path:
    // each per-item planChanges result includes the synthetic
    // `name` key in the multi-mutation diff.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--name',
        'Renamed in bulk',
        '--set',
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
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5001', 'Original 5001')] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly {
        operation: string;
        diff: Readonly<Record<string, { from: unknown; to: unknown }>>;
      }[];
    };
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('change_multiple_column_values');
    expect(plan?.diff.name).toEqual({
      from: 'Original 5001',
      to: 'Renamed in bulk',
    });
    expect(plan?.diff).toHaveProperty('status_4');
  });

  it('live: --filter-json drives the bulk path (literal Monday query_params)', async () => {
    // --filter-json is the escape hatch for filter shapes the
    // --where DSL doesn't cover. Bulk path accepts either.
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[{"column_id":"status_4","compare_value":[1]}]}',
        '--set',
        'status=Done',
        '--board',
        '111',
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
                      items: [{ id: '5001' }],
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
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { summary: { applied_count: number } };
    };
    expect(env.data.summary.applied_count).toBe(1);
  });

  it('live: --name + --set in bulk fires multi-mutation per matched item', async () => {
    // Covers update.ts bulk live name-injection branch: when
    // --name is set, the synthetic `name` translated value joins
    // the multi-mutation columnValues map. Per-item mutation is
    // change_multiple_column_values.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--name',
        'Renamed in bulk',
        '--set',
        'status=Done',
        '--board',
        '111',
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
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemUpdateMulti',
            response: {
              data: {
                change_multiple_column_values: buildItem(
                  '5001',
                  'Renamed in bulk',
                ),
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: { applied_count: number };
        items: readonly { id: string; name: string }[];
      };
    };
    expect(env.data.summary.applied_count).toBe(1);
    expect(env.data.items[0]?.name).toBe('Renamed in bulk');
  });

  it('--filter-json without --yes surfaces confirmation_required with filter_json in details', async () => {
    // Covers update.ts:1029 — confirmation_required details
    // include `filter_json` only when --filter-json was the
    // bulk shape (the --where branch sets `where_clauses` instead).
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[{"column_id":"status_4","compare_value":[1]}]}',
        '--set',
        'status=Done',
        '--board',
        '111',
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
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          matched_count?: number;
          filter_json?: string;
        };
      };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.matched_count).toBe(2);
    expect(env.error?.details?.filter_json).toBe(
      '{"rules":[{"column_id":"status_4","compare_value":[1]}]}',
    );
  });

  it('live: walks NextItemsPage when items_page returns a cursor', async () => {
    // Covers update.ts:942 idx 0 — the `'next_items_page' in r.data`
    // branch in extractPage. Multi-page walk pulls from
    // ItemsPage (cursor=C2) → NextItemsPage (cursor=null), then
    // mutates each matched item.
    const out = await drive(
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
                      cursor: 'C2',
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'NextItemsPage',
            response: {
              data: {
                next_items_page: {
                  cursor: null,
                  items: [{ id: '5002' }],
                },
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
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { summary: { matched_count: number; applied_count: number } };
    };
    expect(env.data.summary.matched_count).toBe(2);
    expect(env.data.summary.applied_count).toBe(2);
  });

  it('live: --set against unsupported column type (battery) in bulk surfaces typed error', async () => {
    // Covers update.ts bulk path: translateColumnValueAsync throws
    // ApiError(unsupported_column_type) → folded with
    // resolverWarnings and re-thrown. M19 close graduated the full
    // v0.2 tentative row (`tags` / `board_relation` / `dependency`);
    // the v0_2_writer_expansion branch is now dead code. Future-
    // roadmap types like `battery` route through the `future`
    // category with a --set-raw hint.
    const futureMeta = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'bat_42',
          title: 'Progress',
          type: 'battery',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[]}',
        '--set',
        'bat_42=42',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [futureMeta] } },
          },
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: { cursor: null, items: [{ id: '5001' }] },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
  });

  it('live: --name only in bulk + per-item failure → no remap target → folded error with bulk-progress decoration', async () => {
    // Covers update.ts:1228 idx 1 — bulk per-item failure with
    // remapTarget undefined (no --set, only --name → translated[]
    // empty → remapTarget = translated[0] = undefined). The catch
    // skips the remap call and decorates with bulk-progress
    // details directly.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--name',
        'Bulk renamed',
        '--board',
        '111',
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
            operation_name: 'ItemUpdateSimple',
            response: { data: { change_simple_column_value: buildItem('5001', 'Bulk renamed') } },
          },
          {
            operation_name: 'ItemUpdateSimple',
            http_status: 400,
            response: {
              errors: [
                { message: 'invalid', extensions: { code: 'INVALID_ARGUMENT' } },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          applied_count?: number;
          matched_count?: number;
          failed_at_item?: string;
          applied_to?: readonly string[];
          remapped_from?: string;
        };
      };
    };
    // Without a remap target, the error stays as the original
    // validation_failed (no column_archived remap fires).
    expect(env.error?.code).toBe('validation_failed');
    expect(env.error?.details?.remapped_from).toBeUndefined();
    expect(env.error?.details?.applied_count).toBe(1);
    expect(env.error?.details?.applied_to).toEqual(['5001']);
    expect(env.error?.details?.matched_count).toBe(2);
    expect(env.error?.details?.failed_at_item).toBe('5002');
  });

  it('--dry-run: empty match set emits empty planned_changes (no item-state reads)', async () => {
    // Covers update.ts:987 (empty-match dry-run branch). Mirrors
    // the empty-match live no-op test but on the dry-run path.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=NoSuchStatus',
        '--set',
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
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes).toEqual([]);
  });

  it('F3: bulk per-item validation_failed after cache-sourced resolution remaps to column_archived with bulk-progress decoration', async () => {
    // Codex pass-1 F3: bulk per-item failures must run the F4
    // remap. Setup:
    //   1. Seed cache with active column.
    //   2. Bulk update fires; first item mutates OK, second
    //      returns validation_failed.
    //   3. F4 forces metadata refresh; live board reports the
    //      column archived.
    //   4. Error surfaces as column_archived with applied_count /
    //      applied_to / matched_count / failed_at_item details.
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
        {
          ...cachedActive.columns[0],
          archived: true,
        },
      ],
    };
    // Seed cache.
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
              data: { boards: [{ items_page: { cursor: null, items: [] } }] },
            },
          },
        ],
      },
    );
    const out = await drive(
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
        '--json',
      ],
      {
        interactions: [
          // Cache hit — no BoardMetadata fetch.
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
          // First item mutates OK.
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5001') } },
          },
          // Second item: validation_failed.
          {
            operation_name: 'ItemUpdateRich',
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
          // F4 refresh confirms archived.
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedArchived] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          remapped_from?: string;
          applied_count?: number;
          applied_to?: readonly string[];
          matched_count?: number;
          failed_at_item?: string;
        };
      };
    };
    expect(env.error?.code).toBe('column_archived');
    expect(env.error?.details?.remapped_from).toBe('validation_failed');
    expect(env.error?.details?.applied_count).toBe(1);
    expect(env.error?.details?.applied_to).toEqual(['5001']);
    expect(env.error?.details?.matched_count).toBe(2);
    expect(env.error?.details?.failed_at_item).toBe('5002');
  });

  it('F3 (multi-column bulk): later-archived column still remaps via probe-all', async () => {
    // Codex M5b finding #3 — bulk variant. The bulk path used to
    // probe only the first translated column (`translated[0]`).
    // A bulk multi-column update where the first target stays
    // active and a LATER target was archived would surface
    // `validation_failed`; the fix walks every translated column
    // and surfaces `column_archived` with bulk-progress details.
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
    const refreshedSecondArchived = {
      ...cachedActive,
      columns: [
        cachedActive.columns[0],
        { ...cachedActive.columns[1], archived: true },
      ],
    };
    // Seed cache.
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
              data: { boards: [{ items_page: { cursor: null, items: [] } }] },
            },
          },
        ],
      },
    );
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--set',
        'date4=2026-05-15',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          // Multi mutation rejected; F4 forces refresh; refresh shows
          // date4 archived, status_4 still active.
          {
            operation_name: 'ItemUpdateMulti',
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
            response: { data: { boards: [refreshedSecondArchived] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: {
          column_id?: string;
          column_title?: string;
          remapped_from?: string;
        };
      };
    };
    expect(env.error?.code).toBe('column_archived');
    // Pre-fix: helper probes translated[0] (status_4, still active)
    // → no remap → validation_failed surfaces. Fix probes both,
    // surfaces date4 (the actually-archived column).
    expect(env.error?.details?.column_id).toBe('date4');
    expect(env.error?.details?.column_title).toBe('Due date');
    expect(env.error?.details?.remapped_from).toBe('validation_failed');
  });
});

describe('monday item update bulk — --set-raw (M8)', () => {
  it('bulk --set-raw applies same JsonObject payload to every matched item', async () => {
    // Bulk with --set-raw resolves the column once, translates once,
    // then fires the same SelectedMutation against every matched
    // item (cli-design §10.2 + §9.3 sequential execution).
    const tagsBoard = {
      ...sampleBoardMetadata,
      columns: [
        ...sampleBoardMetadata.columns,
        {
          id: 'tags_1',
          title: 'Tags',
          type: 'tags',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[]}',
        '--set-raw',
        'tags_1={"tag_ids":[1,2]}',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [tagsBoard] } },
          },
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
            // First per-item mutation — pin the wire payload shape.
            match_variables: {
              itemId: '5001',
              boardId: '111',
              columnId: 'tags_1',
              value: { tag_ids: [1, 2] },
            },
            response: { data: { change_column_value: { ...sampleItem, id: '5001' } } },
          },
          {
            operation_name: 'ItemUpdateRich',
            match_variables: {
              itemId: '5002',
              boardId: '111',
              columnId: 'tags_1',
              value: { tag_ids: [1, 2] },
            },
            response: { data: { change_column_value: { ...sampleItem, id: '5002' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: { matched_count: number; applied_count: number };
      };
    };
    expect(env.data.summary.matched_count).toBe(2);
    expect(env.data.summary.applied_count).toBe(2);
  });

  it('bulk --set + --set-raw mixed bundle → change_multiple_column_values per item', async () => {
    const tagsBoard = {
      ...sampleBoardMetadata,
      columns: [
        ...sampleBoardMetadata.columns,
        {
          id: 'tags_1',
          title: 'Tags',
          type: 'tags',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[]}',
        '--set',
        'status=Done',
        '--set-raw',
        'tags_1={"tag_ids":[1]}',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [tagsBoard] } },
          },
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }],
                    },
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemUpdateMulti',
            match_variables: {
              itemId: '5001',
              boardId: '111',
              columnValues: {
                status_4: { label: 'Done' },
                tags_1: { tag_ids: [1] },
              },
            },
            response: {
              data: {
                change_multiple_column_values: { ...sampleItem, id: '5001' },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { summary: { matched_count: number; applied_count: number } };
    };
    expect(env.data.summary.matched_count).toBe(1);
    expect(env.data.summary.applied_count).toBe(1);
  });

  it('bulk --set-raw with malformed JSON fails fast — no GraphQL request fires', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[]}',
        '--set-raw',
        'tags_1={broken',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('bulk --set-raw rejects read-only-forever post-resolution (no per-item call fires)', async () => {
    const mirrorBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'mirror_1',
          title: 'Sprint mirror',
          type: 'mirror',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await drive(
      [
        'item',
        'update',
        '--filter-json',
        '{"rules":[]}',
        '--set-raw',
        'mirror_1={"whatever":1}',
        '--board',
        '111',
        '--yes',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [mirrorBoard] } },
          },
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  { items_page: { cursor: null, items: [{ id: '5001' }] } },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { read_only?: boolean } };
    };
    expect(env.error?.code).toBe('unsupported_column_type');
    expect(env.error?.details?.read_only).toBe(true);
  });
});

// ============================================================
// M25 — `--continue-on-error` partial-success bulk path
// (cli-design §6.4 "Bulk per-item partial-success" sub-section).
// ============================================================

describe('monday item update bulk — --continue-on-error (M25 partial-success)', () => {
  const buildItem = (id: string, name = `Item ${id}`): typeof sampleItem => ({
    ...sampleItem,
    id,
    name,
  });

  it('rejects --continue-on-error on the single-item shape at argv-parse time (no network call fires)', async () => {
    // The flag is meaningful only on bulk shapes — a single-item
    // failure IS the whole-call failure. validateInputShape rejects
    // before any network call.
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--continue-on-error',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/single-item/i);
  });

  // v0.4-M30 pre-flight combination-rule rejections — both fire from
  // validateInputShape before any network call. The routing branch in
  // `partial-success-bulk.ts` IS in production code at pre-flight
  // (`concurrency > 1` routes to `dispatchParallel`; `concurrency
  // undefined / === 1` routes to `dispatchSequential`), but the
  // `dispatchParallel` runtime body is a c8-ignored stub that throws
  // `internal_error` with `details.deferred_to: "v0.4-M30 IMPL"`.
  // No integration test exercises `concurrency > 1` at pre-flight
  // because the rejection paths below stop the call before reaching
  // dispatch. Coverage of the parallel route's runtime behaviour is
  // M30 IMPL's scope.

  it('rejects --concurrency on the single-item shape at validateInputShape (before any network call) (M30)', async () => {
    // `--concurrency` is only meaningful on the bulk partial-success
    // path. validateInputShape rejects before any network call,
    // mirroring the --continue-on-error single-item rejection above.
    const out = await drive(
      [
        'item',
        'update',
        '12345',
        '--set',
        'status=Done',
        '--concurrency',
        '4',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/concurrency.*single-item/i);
  });

  it('rejects --concurrency without --continue-on-error on the bulk shape at validateInputShape (before any network call) (M30)', async () => {
    // v0.4-plan §8 D2 closure: --concurrency requires
    // --continue-on-error. Fail-fast bulk parallel dispatch is
    // explicitly deferred (no defined "abort N in-flight" semantic).
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--concurrency',
        '4',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/concurrency.*continue-on-error/i);
  });

  it('rejects --concurrency 0 at parse-boundary (M30 range floor)', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--continue-on-error',
        '--concurrency',
        '0',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects --concurrency 33 at parse-boundary (M30 range ceiling)', async () => {
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--continue-on-error',
        '--concurrency',
        '33',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('without --yes (and without --dry-run) surfaces confirmation_required regardless of --continue-on-error (gate orthogonality)', async () => {
    // Confirmation gate is orthogonal to --continue-on-error; both
    // must be acknowledged for the live partial-success path to
    // fire. cli-design §6.4 confirmation-gate paragraph.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
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
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('confirmation_required');
  });

  it('empty match emits the v0.1 fail-fast empty-match envelope shape (NOT partial-success) — cli-design §6.4 empty-match paragraph', async () => {
    // Codex round-2 P2-1: the partial-success envelope shape only
    // materialises when at least one per-item dispatch fires. An
    // empty match emits the v0.1 envelope (items: [] + no
    // failed_count / results / operation), regardless of
    // --continue-on-error.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=NoSuchStatus',
        '--set',
        'status=Done',
        '--board',
        '111',
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
                boards: [{ items_page: { cursor: null, items: [] } }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: { matched_count: number; applied_count: number; board_id: string };
        items?: readonly unknown[];
        operation?: unknown;
        results?: readonly unknown[];
      };
    };
    expect(env.data.summary).toEqual({
      matched_count: 0,
      applied_count: 0,
      board_id: '111',
    });
    expect(env.data.items).toEqual([]);
    // Partial-success-specific fields stay absent on the empty-match shape.
    expect(env.data.operation).toBeUndefined();
    expect(env.data.results).toBeUndefined();
  });

  it('--dry-run + --continue-on-error emits the v0.1 dry-run shape unchanged (N-element planned_changes[], no partial-success envelope) — cli-design §6.4 dry-run paragraph', async () => {
    // Dry-run can't preview per-item failures because no dispatch
    // fires — the partial-success envelope only materialises on
    // live dispatch. cli-design §6.4 dry-run paragraph.
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Backlog',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--continue-on-error',
        '--dry-run',
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
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5001')] } },
          },
          {
            operation_name: 'ItemDryRunRead',
            response: { data: { items: [buildItem('5002')] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly { item_id: string }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(2);
    expect(env.planned_changes[0]?.item_id).toBe('5001');
    expect(env.planned_changes[1]?.item_id).toBe('5002');
  });

  it('all-success: N items succeed → ok: true + summary.failed_count: 0 + per-record item populated', async () => {
    const out = await drive(
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
                      items: [{ id: '5001' }, { id: '5002' }, { id: '5003' }],
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
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5003') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        summary: {
          matched_count: number;
          applied_count: number;
          failed_count: number;
          board_id: string;
        };
        results: readonly {
          item_id: string;
          ok: boolean;
          item?: { id: string };
          error?: { code: string };
        }[];
      };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.ok).toBe(true);
    expect(env.data.operation).toBe('item_update');
    expect(env.data.summary).toEqual({
      matched_count: 3,
      applied_count: 3,
      failed_count: 0,
      board_id: '111',
    });
    expect(env.data.results).toHaveLength(3);
    for (const record of env.data.results) {
      expect(record.ok).toBe(true);
      expect(record.item?.id).toBe(record.item_id);
      expect(record.error).toBeUndefined();
    }
    // resolved_ids slot inherited from v0.1 bulk envelope.
    expect(env.resolved_ids).toEqual({ status: 'status_4' });
  });

  it('all-failed: N items reject → top-level ok: true (universal partial-success) + summary.applied_count: 0 + per-record error populated', async () => {
    const out = await drive(
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
            http_status: 400,
            response: {
              errors: [
                { message: 'invalid', extensions: { code: 'INVALID_ARGUMENT' } },
              ],
            },
          },
          {
            operation_name: 'ItemUpdateRich',
            http_status: 400,
            response: {
              errors: [
                { message: 'invalid', extensions: { code: 'INVALID_ARGUMENT' } },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0); // universal partial-success: still ok: true
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        summary: {
          matched_count: number;
          applied_count: number;
          failed_count: number;
        };
        results: readonly {
          item_id: string;
          ok: boolean;
          error?: { code: string };
        }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.operation).toBe('item_update');
    expect(env.data.summary.matched_count).toBe(2);
    expect(env.data.summary.applied_count).toBe(0);
    expect(env.data.summary.failed_count).toBe(2);
    expect(env.data.results).toHaveLength(2);
    for (const record of env.data.results) {
      expect(record.ok).toBe(false);
      expect(record.error?.code).toBe('validation_failed');
    }
  });

  it('mixed success/failure: per-record outcomes preserved in input order', async () => {
    const out = await drive(
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
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5001') } },
          },
          {
            operation_name: 'ItemUpdateRich',
            http_status: 400,
            response: {
              errors: [
                { message: 'invalid', extensions: { code: 'INVALID_ARGUMENT' } },
              ],
            },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5003') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        summary: {
          matched_count: number;
          applied_count: number;
          failed_count: number;
        };
        results: readonly {
          item_id: string;
          ok: boolean;
          item?: { id: string };
          error?: { code: string };
        }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.operation).toBe('item_update');
    expect(env.data.summary).toMatchObject({
      matched_count: 3,
      applied_count: 2,
      failed_count: 1,
    });
    expect(env.data.results[0]).toMatchObject({
      item_id: '5001',
      ok: true,
    });
    expect(env.data.results[0]?.item?.id).toBe('5001');
    expect(env.data.results[1]).toMatchObject({
      item_id: '5002',
      ok: false,
    });
    expect(env.data.results[1]?.error?.code).toBe('validation_failed');
    expect(env.data.results[1]?.item).toBeUndefined();
    expect(env.data.results[2]).toMatchObject({
      item_id: '5003',
      ok: true,
    });
  });

  it('stale-cache archived column: per-item validation_failed remaps to column_archived (Codex pre-flight round-1 P1-1)', async () => {
    // Codex pre-flight round-1 P1-1 contract MUST: per-item
    // failures inherit the SAME foldAndRemap remap the v0.1 fail-
    // fast path applies. A cache-sourced validation_failed +
    // BoardMetadata-refresh-confirms-archived → per-record
    // error.code is column_archived, not validation_failed
    // (cli-design §6.5 stable-code rule applies uniformly).
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
      columns: [{ ...cachedActive.columns[0], archived: true }],
    };
    // Seed cache.
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
              data: { boards: [{ items_page: { cursor: null, items: [] } }] },
            },
          },
        ],
      },
    );
    const out = await drive(
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
          // Cache hit on metadata — no BoardMetadata fetch.
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
          // First item: validation_failed (will remap per-item).
          {
            operation_name: 'ItemUpdateRich',
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
          // foldAndRemap probe: refresh confirms archived.
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedArchived] } },
          },
          // Second item: also validation_failed → also remaps.
          {
            operation_name: 'ItemUpdateRich',
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
          // Second item's foldAndRemap probe.
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [refreshedArchived] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        summary: { failed_count: number };
        results: readonly {
          item_id: string;
          ok: boolean;
          error?: { code: string; message: string };
        }[];
      };
    };
    expect(env.data.summary.failed_count).toBe(2);
    for (const record of env.data.results) {
      expect(record.ok).toBe(false);
      // The remap is the load-bearing assertion — without P1-1's
      // foldAndRemap context-threading, per-record codes would
      // surface as validation_failed for archived-column root
      // causes, breaking cli-design §6.5's stable-code rule.
      expect(record.error?.code).toBe('column_archived');
    }
  });

  it('internal_error from a per-item wire call re-throws as whole-call (top-level ok: false), preserving M14 round-2 F1 escape hatch', async () => {
    // M14 round-2 F1 / round-3 F1 precedent — dispatchSequential
    // re-throws internal_error so schema-drift in the response
    // surfaces as whole-call rather than per-record. The M25
    // wrapper inherits this behaviour by NOT wrapping the
    // dispatchSequential re-throw.
    const out = await drive(
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
          // First item: malformed response (missing root key) —
          // assertResponseFieldPresent throws internal_error.
          {
            operation_name: 'ItemUpdateRich',
            response: { data: {} },
          },
        ],
      },
    );
    // Whole-call abort — top-level ok: false (exit 2 — API
    // error envelope), NOT a partial-success envelope with the
    // schema-drift hidden inside data.results[].
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('resolver warnings on the bulk envelope are preserved across the partial-success path (collected from filter + resolution legs)', async () => {
    // Resolver warnings (column_token_collision /
    // stale_cache_refreshed) collected from the filter +
    // resolution legs surface on the partial-success envelope's
    // top-level warnings slot, mirroring the v0.1 fail-fast bulk
    // success envelope. Setup: collide title-keyed token so
    // detectCollision emits warnings during resolution.
    const collidingMeta = {
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
          id: 'text_other',
          title: 'STATUS_4',
          type: 'text',
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
        'update',
        '--filter-json',
        '{"rules":[]}',
        '--set',
        'status_4=Done',
        '--board',
        '111',
        '--yes',
        '--continue-on-error',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'BoardMetadata',
            response: { data: { boards: [collidingMeta] } },
          },
          {
            operation_name: 'ItemsPage',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [{ id: '5001' }],
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
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    const collisionWarnings = env.warnings.filter(
      (w) => w.code === 'column_token_collision',
    );
    expect(collisionWarnings.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// M30 — `--concurrency <N>` parallel dispatch on the partial-success
// bulk path (cli-design §6.4 "Bulk per-item partial-success —
// Parallel dispatch"). These tests drive the runtime body of
// `src/api/parallel-dispatch.ts:dispatchParallel` via the cassette
// transport; the per-target dispatch closure in
// `src/api/partial-success-bulk.ts` is shared verbatim with the
// sequential route so the envelope shape is byte-equivalent to M25.
// ──────────────────────────────────────────────────────────────────

describe('monday item update bulk — --concurrency (M30 parallel dispatch)', () => {
  // Per-verb fixture helper — same shape as the M5b / M25 describe
  // blocks above. Kept local to avoid coupling the M30 block to the
  // M5b helper through a closure surface.
  const buildItem = (id: string, name = `Item ${id}`): typeof sampleItem => ({
    ...sampleItem,
    id,
    name,
  });

  it('--concurrency 2: 4 items all succeed → byte-equivalent envelope shape to sequential M25 path', async () => {
    const out = await drive(
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
        '--concurrency',
        '2',
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
                        { id: '5004' },
                      ],
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
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5003') } },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5004') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        summary: {
          matched_count: number;
          applied_count: number;
          failed_count: number;
          board_id: string;
        };
        results: readonly { item_id: string; ok: boolean }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.operation).toBe('item_update');
    expect(env.data.summary).toEqual({
      matched_count: 4,
      applied_count: 4,
      failed_count: 0,
      board_id: '111',
    });
    expect(env.data.results).toHaveLength(4);
    // Input-order preservation by index: results[i].item_id ===
    // matchedItemIds[i] regardless of completion order.
    expect(env.data.results.map((r) => r.item_id)).toEqual([
      '5001',
      '5002',
      '5003',
      '5004',
    ]);
    for (const r of env.data.results) {
      expect(r.ok).toBe(true);
    }
  });

  it('--concurrency 4 with delay on target[0]: input-order preserved despite late completion (R-NEW-28 axis 5)', async () => {
    // Cassette interactions consume in ARRIVAL order at the
    // transport. With N=4 workers spinning up simultaneously the
    // first 4 dispatches arrive in worker pickup order (synchronous
    // up to the first await inside client.raw), so interactions
    // 2..5 below match targets 5001..5004 respectively. The
    // delay_ms on the FIRST interaction (5001) means that target's
    // wire response is the LAST to land; the result array's
    // ordering by input index (not completion order) is the
    // load-bearing invariant under test.
    const out = await drive(
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
        '--concurrency',
        '4',
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
                        { id: '5004' },
                      ],
                    },
                  },
                ],
              },
            },
          },
          {
            // target 5001 — slowest; completes LAST chronologically.
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5001') } },
            delay_ms: 60,
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5002') } },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5003') } },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5004') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        results: readonly { item_id: string; ok: boolean; item?: { id: string } }[];
      };
    };
    expect(env.data.results.map((r) => r.item_id)).toEqual([
      '5001',
      '5002',
      '5003',
      '5004',
    ]);
    expect(env.data.results[0]?.item?.id).toBe('5001');
  });

  it('--concurrency 2 mixed outcomes: per-record success/failure both land in data.results[] (R-NEW-28 axis 1)', async () => {
    const out = await drive(
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
        '--concurrency',
        '2',
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
                        { id: '5004' },
                      ],
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
            http_status: 400,
            response: {
              errors: [
                { message: 'invalid', extensions: { code: 'INVALID_ARGUMENT' } },
              ],
            },
          },
          {
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('5003') } },
          },
          {
            operation_name: 'ItemUpdateRich',
            http_status: 400,
            response: {
              errors: [
                { message: 'invalid', extensions: { code: 'INVALID_ARGUMENT' } },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0); // universal partial-success: ok: true
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: {
          matched_count: number;
          applied_count: number;
          failed_count: number;
        };
        results: readonly {
          item_id: string;
          ok: boolean;
          error?: { code: string };
        }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.summary).toMatchObject({
      matched_count: 4,
      applied_count: 2,
      failed_count: 2,
    });
    expect(env.data.results.map((r) => r.item_id)).toEqual([
      '5001',
      '5002',
      '5003',
      '5004',
    ]);
    expect(env.data.results[0]?.ok).toBe(true);
    expect(env.data.results[1]?.ok).toBe(false);
    expect(env.data.results[1]?.error?.code).toBe('validation_failed');
    expect(env.data.results[2]?.ok).toBe(true);
    expect(env.data.results[3]?.ok).toBe(false);
    expect(env.data.results[3]?.error?.code).toBe('validation_failed');
  });

  it('--concurrency 2 internal_error re-throws whole-call (top-level ok: false; no partial data.results[]) (R-NEW-28 axis 2)', async () => {
    // Schema-drift in Monday's response: the `change_column_value`
    // root key is `null`, which `assertResponseFieldPresent` rejects
    // as `internal_error`. The partial-success wrapper re-throws
    // internal_error whole-call rather than papering over it as a
    // per-record slot (M14 round-2 F1 precedent) — agents need the
    // malformed-response signal directly.
    const out = await drive(
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
        '--concurrency',
        '2',
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
            // Response missing root key (`change_column_value: null`)
            // → assertResponseFieldPresent throws internal_error.
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: null } },
          },
        ],
        // The pool may bail without consuming all interactions if a
        // worker throws internal_error before the others get to
        // dispatch their second targets — assertion is the envelope
        // shape, not cassette consumption.
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('internal_error');
  });

  it('--concurrency 1 explicit: byte-equivalent envelope to M25 sequential default (D3 closure)', async () => {
    // `--concurrency 1` routes through dispatchSequential (the
    // routing branch in partial-success-bulk.ts sends both
    // `undefined` and `1` to the sequential helper). The envelope
    // shape MUST be identical to the M25 baseline above (the
    // `all-success` test in the M25 describe block) — agents who
    // explicitly pin N=1 should see the same byte shape as omitting
    // the flag.
    const out = await drive(
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
        '--concurrency',
        '1',
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
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        summary: { matched_count: number; applied_count: number; failed_count: number; board_id: string };
        results: readonly { item_id: string; ok: boolean }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.operation).toBe('item_update');
    expect(env.data.summary).toEqual({
      matched_count: 2,
      applied_count: 2,
      failed_count: 0,
      board_id: '111',
    });
    expect(env.data.results.map((r) => r.item_id)).toEqual(['5001', '5002']);
  });

  it('--concurrency 4 with empty match: emits v0.1 fail-fast empty-match envelope regardless of --concurrency (cli-design §6.4)', async () => {
    // Empty-match branch fires BEFORE the dispatch helpers are
    // invoked — neither dispatchSequential nor dispatchParallel
    // sees the targets list at all. Asserts that --concurrency is
    // orthogonal to the empty-match shape (cli-design §6.4 empty-
    // match paragraph).
    const out = await drive(
      [
        'item',
        'update',
        '--where',
        'status=Nonexistent',
        '--set',
        'status=Done',
        '--board',
        '111',
        '--yes',
        '--continue-on-error',
        '--concurrency',
        '4',
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
                    items_page: { cursor: null, items: [] },
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
      data: {
        summary: { matched_count: number; applied_count: number };
        items: readonly unknown[];
        operation?: string;
        results?: readonly unknown[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.summary.matched_count).toBe(0);
    expect(env.data.items).toEqual([]);
    // Partial-success-specific fields stay absent — empty match
    // emits the v0.1 envelope shape, NOT the partial-success shape
    // (no `operation`, no `results`).
    expect(env.data.operation).toBeUndefined();
    expect(env.data.results).toBeUndefined();
  });

  it('--concurrency 8 smoke variant: 8 items succeed via 8-worker pool (M30 IMPL exit-criterion N=8 dispatch variant)', async () => {
    // Smoke variant beyond N=2/4: verify the pool's bound + result
    // assembly hold at the wider concurrency. Codex round-3 P3-2
    // flagged the missing N=8/16/32 matrix coverage; this test
    // closes the N=8 slot. N=16 and N=32 are covered by extension
    // through the same pool body — the dispatchParallel runtime
    // doesn't branch on the concurrency value.
    const ids = Array.from({ length: 8 }, (_, i) =>
      String(6001 + i),
    );
    const out = await drive(
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
        '--concurrency',
        '8',
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
                      items: ids.map((id) => ({ id })),
                    },
                  },
                ],
              },
            },
          },
          ...ids.map((id) => ({
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem(id) } },
          })),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        operation: string;
        summary: { matched_count: number; applied_count: number; failed_count: number; board_id: string };
        results: readonly { item_id: string; ok: boolean; item?: { id: string } }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.operation).toBe('item_update');
    expect(env.data.summary).toEqual({
      matched_count: 8,
      applied_count: 8,
      failed_count: 0,
      board_id: '111',
    });
    expect(env.data.results).toHaveLength(8);
    expect(env.data.results.map((r) => r.item_id)).toEqual(ids);
    for (const record of env.data.results) {
      expect(record.ok).toBe(true);
      expect(record.item?.id).toBe(record.item_id);
    }
  });

  it('--concurrency 2 concurrency_exceeded retry: transient per-target CONCURRENCY_LIMIT_EXCEEDED retries via the existing retry layer (cli-design §6.4 D5 closure)', async () => {
    // D5 closure pins "no M30-specific retry logic; inherits
    // src/api/retry.ts". A per-target dispatch returning
    // CONCURRENCY_LIMIT_EXCEEDED is retryable + the retry layer
    // applies exponential backoff; on success at attempt 2 the
    // record lands as ok: true in data.results[]. Asserts the
    // shape doesn't degrade because of the in-flight retry —
    // M30's pool layer does NOT double-retry.
    const out = await drive(
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
        '--concurrency',
        '2',
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
                      items: [{ id: '7001' }, { id: '7002' }],
                    },
                  },
                ],
              },
            },
          },
          {
            // Worker 1 picks 7001 first — transient
            // concurrency_exceeded on attempt 1; the retry layer
            // sleeps + re-fires.
            operation_name: 'ItemUpdateRich',
            http_status: 429,
            response: {
              errors: [
                {
                  message: 'concurrency limit exceeded',
                  extensions: { code: 'CONCURRENCY_LIMIT_EXCEEDED' },
                },
              ],
            },
          },
          {
            // Worker 2 picks 7002 — succeeds first attempt.
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('7002') } },
          },
          {
            // Worker 1's retry of 7001 → success.
            operation_name: 'ItemUpdateRich',
            response: { data: { change_column_value: buildItem('7001') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        summary: { matched_count: number; applied_count: number; failed_count: number };
        results: readonly { item_id: string; ok: boolean }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.summary).toMatchObject({
      matched_count: 2,
      applied_count: 2,
      failed_count: 0,
    });
    expect(env.data.results.map((r) => r.item_id)).toEqual(['7001', '7002']);
  });

  it('--concurrency 4 SIGINT mid-dispatch: signal abort surfaces exit 130 without a partial envelope (R-NEW-28 axis 6 end-to-end)', async () => {
    // Drives the SIGINT path end-to-end through the runner. The
    // runner combines `options.signal` with its internal abort via
    // `AbortSignal.any` (`src/cli/run.ts:151`); aborting with the
    // `{kind:'sigint'}` sentinel triggers exit 130 with no envelope
    // on stderr (`src/cli/run.ts:174,183`). Cassette delay_ms holds
    // the dispatches open long enough for the abort timer to fire
    // mid-flight; the pool's worker-loop signal check + the
    // MondayClient.signal threading abort the in-flight wire calls.
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort({ kind: 'sigint' });
    }, 15);
    const out = await drive(
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
        '--concurrency',
        '4',
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
                        { id: '8001' },
                        { id: '8002' },
                        { id: '8003' },
                        { id: '8004' },
                      ],
                    },
                  },
                ],
              },
            },
          },
          // All four dispatches hold for 200ms — well past the 15ms
          // abort timer — so the workers are mid-flight when SIGINT
          // fires. Their MondayClient.signal threading aborts the
          // wire calls; the worker-loop signal check stops the pool
          // from scheduling new ones (none beyond N=4 to schedule
          // anyway). The runner returns exit 130 without a partial
          // envelope. `repeat: 4` keeps the cassette flexible since
          // worker arrival order is deterministic but completion
          // status under abort is timing-dependent.
          {
            operation_name: 'ItemUpdateRich',
            delay_ms: 200,
            response: { data: { change_column_value: buildItem('8001') } },
            repeat: 4,
          },
        ],
      },
      { signal: controller.signal },
    );
    expect(out.exitCode).toBe(130);
    // SIGINT contract: no envelope on either stream — the
    // runner's 130 short-circuit happens before envelope
    // assembly (`src/cli/run.ts:174,183`). Asserting BOTH
    // streams stay empty catches a regression where a success
    // envelope writes to stdout BEFORE the abort path takes
    // over + then exit 130 returns — the exit code alone
    // wouldn't distinguish that case.
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe('');
  });

  describe('v0.7-M42 bulk file `--set` carve-out fold (D5 closure from v0.6-M38) — IMPL', () => {
    // Board metadata fixture pinning a file-typed `attachments`
    // column alongside the standard `status_1` filter column. The
    // file dispatch's pre-check resolves `attachments` to type
    // `file` and returns `kind: 'file_bulk'`; the action body
    // branches into `runItemUpdateBulkFileDispatch`.
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
          id: 'status_1',
          title: 'Status',
          type: 'status',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };

    // Standard `add_file_to_column` success response template.
    // Per-test specs override only the slots the assertion inspects
    // (id / name). The shape mirrors M31's asset projection.
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
      workdir = await mkdtemp(join(tmpdir(), 'monday-cli-item-update-m42-'));
      reportPath = join(workdir, 'report.pdf');
      await writeFile(reportPath, 'PDF-bytes-fixture', 'utf8');
    });
    afterEach(async () => {
      await rm(workdir, { recursive: true, force: true });
    });

    const fileBoardMetadata = {
      operation_name: 'BoardMetadata',
      response: { data: { boards: [fileBoard] } },
    };
    const itemsPageWithTwo = {
      operation_name: 'ItemsPage',
      response: {
        data: {
          boards: [
            {
              items_page: {
                cursor: null,
                items: [{ id: '12345' }, { id: '23456' }],
              },
            },
          ],
        },
      },
    };

    it('live --yes fail-fast bulk file dispatch: fans `add_file_to_column` across matched items, emits BulkFileSetData envelope with per-item asset slots', async () => {
      // The IMPL replacement of the v0.7-M42 pre-flight stub. The
      // shipped contract surface (argv parse, pre-check returning
      // `kind: 'file_bulk'`, items_page walk, confirmation gate)
      // runs upstream; the helper now runs the local file pre-check
      // once + dispatches `executeFileColumnSet` per matched item
      // + emits the partial-success-bulk envelope shape with
      // `operation: 'item_update_bulk_file_set'`. Fail-fast bulk
      // (no `--continue-on-error`) succeeds end-to-end → every
      // result row carries `ok: true` + the asset projection.
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            match_filename: 'report.pdf',
            response: { data: { add_file_to_column: buildAsset('asset-1') } },
          },
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
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath}`,
          '--yes',
          '--json',
        ],
        { interactions: [fileBoardMetadata, itemsPageWithTwo] },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: {
          operation: string;
          summary: {
            matched_count: number;
            applied_count: number;
            failed_count: number;
            board_id: string;
            column_id: string;
            filename: string;
            file_size_bytes: number;
          };
          results: readonly {
            item_id: string;
            ok: boolean;
            asset?: { id: string; name: string };
          }[];
        };
      };
      expect(env.ok).toBe(true);
      expect(env.data.operation).toBe('item_update_bulk_file_set');
      expect(env.data.summary).toEqual({
        matched_count: 2,
        applied_count: 2,
        failed_count: 0,
        board_id: '111',
        column_id: 'attachments',
        filename: 'report.pdf',
        file_size_bytes: 17,
      });
      expect(env.data.results).toHaveLength(2);
      expect(env.data.results[0]).toMatchObject({
        item_id: '12345',
        ok: true,
        asset: { id: 'asset-1', name: 'report.pdf' },
      });
      expect(env.data.results[1]).toMatchObject({
        item_id: '23456',
        ok: true,
        asset: { id: 'asset-2', name: 'report.pdf' },
      });
      // One multipart wire call per matched item (no `--concurrency`
      // on fail-fast bulk; M30 D2 closure pins `--concurrency requires
      // --continue-on-error`).
      expect(multipart.requests).toHaveLength(2);
    });

    it('dry-run bulk file dispatch: emits per-item planned_changes (one `add_file_to_column` per matched item), no multipart wire round-trips', async () => {
      // Dry-run branch — pre-check still fires (local file read +
      // size measurement) so the envelope's planned_changes carry
      // real filename + file_size_bytes; no multipart wire calls
      // fire. Unlike M38 single-item dry-run which pins
      // `meta.source: 'none'` (pure-local), bulk dry-run carries
      // the upstream legs' aggregated source (metadata + items_page
      // walk) — reaching this branch already paid for wire legs.
      const multipart = createInlineMultipartFixtureTransport([], {
        assertExhaustive: false,
      });
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath}`,
          '--dry-run',
          '--json',
        ],
        { interactions: [fileBoardMetadata, itemsPageWithTwo] },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        planned_changes?: readonly Record<string, unknown>[];
      };
      expect(env.ok).toBe(true);
      const meta = env.meta as EnvelopeShape['meta'] & { dry_run?: boolean };
      expect(meta.dry_run).toBe(true);
      // Source aggregates 3 wire legs: live metadata fetch +
      // cache-served M38 pre-check (resolveColumnWithRefresh hits
      // the just-written cache) + synthetic live items_page walk.
      // `mergeSource(live + cache + live) === 'mixed'` per
      // cli-design §6.1. Codex IMPL R1 P2-1 fix — pre-fix dropped
      // the M38 pre-check leg and emitted 'live' instead.
      expect(meta.source).toBe('mixed');
      expect(env.planned_changes).toEqual([
        {
          operation: 'add_file_to_column',
          item_id: '12345',
          column_id: 'attachments',
          file_path: reportPath,
          filename: 'report.pdf',
          file_size_bytes: 17,
        },
        {
          operation: 'add_file_to_column',
          item_id: '23456',
          column_id: 'attachments',
          file_path: reportPath,
          filename: 'report.pdf',
          file_size_bytes: 17,
        },
      ]);
      expect(multipart.requests).toHaveLength(0);
    });

    it("single upfront pre-check failure aborts whole-call with usage_error.details.reason: 'file_not_readable' BEFORE any multipart wire call (D3 atomicity discipline)", async () => {
      // D3 closure: the local file pre-check fires ONCE upfront
      // (one path × N items), and a failed pre-check aborts the
      // whole call regardless of `--continue-on-error`. The
      // multipart transport's `assertExhaustive` is on with an
      // empty cassette — any wire call would fail loudly. The
      // test passing means zero multipart traffic.
      const multipart = createInlineMultipartFixtureTransport([], {
        assertExhaustive: true,
      });
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${join(workdir, 'does-not-exist.pdf')}`,
          '--yes',
          '--continue-on-error',
          '--json',
        ],
        { interactions: [fileBoardMetadata, itemsPageWithTwo] },
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

    it("single upfront pre-check failure with empty file aborts whole-call with usage_error.details.reason: 'file_empty' (also fires on the --dry-run path — pre-check is path-uniform)", async () => {
      // Pre-check fires on dry-run too (the planned_changes need
      // a real filename + file_size_bytes to be meaningful).
      // A zero-byte fixture surfaces `file_empty` before either
      // the dry-run planned_changes emit or the live multipart
      // dispatch.
      const emptyPath = join(workdir, 'empty.pdf');
      await writeFile(emptyPath, '', 'utf8');
      const multipart = createInlineMultipartFixtureTransport([], {
        assertExhaustive: true,
      });
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${emptyPath}`,
          '--dry-run',
          '--json',
        ],
        { interactions: [fileBoardMetadata, itemsPageWithTwo] },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: { reason?: string } };
      };
      expect(env.error?.code).toBe('usage_error');
      expect(env.error?.details?.reason).toBe('file_empty');
      expect(multipart.requests).toHaveLength(0);
    });

    it('fail-fast: first per-item failure aborts whole-call with `applied_to: []` decoration (no items succeeded yet)', async () => {
      // Mirrors the v0.1 fail-fast JSON-bulk pattern at the action
      // body's main loop — the error class carries
      // `details.applied_count` / `applied_to` / `failed_at_item`
      // / `matched_count` so an agent reading the failure envelope
      // sees how many items applied before the failure.
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
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath}`,
          '--yes',
          '--json',
        ],
        { interactions: [fileBoardMetadata, itemsPageWithTwo] },
        { multipartTransport: multipart },
      );
      // `file_too_large` (rewrap of FILE_SIZE_LIMIT_EXCEEDED) is a
      // usage_error → exit 1.
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: {
          code: string;
          details?: {
            reason?: string;
            applied_count?: number;
            applied_to?: readonly string[];
            failed_at_item?: string;
            matched_count?: number;
          };
        };
      };
      expect(env.error?.code).toBe('usage_error');
      expect(env.error?.details?.reason).toBe('file_too_large');
      expect(env.error?.details?.applied_count).toBe(0);
      expect(env.error?.details?.applied_to).toEqual([]);
      expect(env.error?.details?.failed_at_item).toBe('12345');
      expect(env.error?.details?.matched_count).toBe(2);
      // One multipart wire call fired (the failing one); the
      // second item never dispatched (fail-fast).
      expect(multipart.requests).toHaveLength(1);
    });

    it('fail-fast: second per-item failure aborts whole-call with `applied_to: [<first-id>]` decoration', async () => {
      // First item succeeds → `applied_to` echoes its ID; second
      // item fails → whole-call abort with the decoration. Third
      // item would never dispatch (none in this 2-item set).
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            response: { data: { add_file_to_column: buildAsset('asset-1') } },
          },
          {
            operation_name: 'AddFileToColumn',
            response: {
              errors: [{ message: 'Item not found' }],
              http_status: 404,
            },
          },
        ],
        { assertExhaustive: false },
      );
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath}`,
          '--yes',
          '--json',
        ],
        { interactions: [fileBoardMetadata, itemsPageWithTwo] },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: {
          code: string;
          details?: {
            applied_count?: number;
            applied_to?: readonly string[];
            failed_at_item?: string;
            matched_count?: number;
          };
        };
      };
      expect(env.error?.details?.applied_count).toBe(1);
      expect(env.error?.details?.applied_to).toEqual(['12345']);
      expect(env.error?.details?.failed_at_item).toBe('23456');
      expect(env.error?.details?.matched_count).toBe(2);
      // Two multipart wire calls fired (the success + the failure).
      expect(multipart.requests).toHaveLength(2);
    });

    it('--continue-on-error: per-item failures land in `data.results[i].error`, successes in `data.results[i].asset`; envelope is ok: true with mixed records', async () => {
      // Partial-success path. The shared `dispatchSequential`
      // captures per-target failures into per-record slots rather
      // than aborting the loop; the universal partial-success
      // rule (cli-design §6.4) keeps the top-level envelope
      // `ok: true` regardless of how many items failed.
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            response: { data: { add_file_to_column: buildAsset('asset-1') } },
          },
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
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath}`,
          '--yes',
          '--continue-on-error',
          '--json',
        ],
        { interactions: [fileBoardMetadata, itemsPageWithTwo] },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: {
          operation: string;
          summary: {
            matched_count: number;
            applied_count: number;
            failed_count: number;
          };
          results: readonly {
            item_id: string;
            ok: boolean;
            asset?: { id: string };
            error?: { code: string; message: string };
          }[];
        };
      };
      expect(env.ok).toBe(true);
      expect(env.data.operation).toBe('item_update_bulk_file_set');
      expect(env.data.summary).toMatchObject({
        matched_count: 2,
        applied_count: 1,
        failed_count: 1,
      });
      expect(env.data.results).toHaveLength(2);
      expect(env.data.results[0]).toMatchObject({
        item_id: '12345',
        ok: true,
        asset: { id: 'asset-1' },
      });
      expect(env.data.results[0]?.error).toBeUndefined();
      expect(env.data.results[1]).toMatchObject({
        item_id: '23456',
        ok: false,
        error: { code: 'usage_error' },
      });
      expect(env.data.results[1]?.asset).toBeUndefined();
      expect(multipart.requests).toHaveLength(2);
    });

    it('--continue-on-error --concurrency 4: routes through dispatchParallel; all 4 items dispatched concurrently', async () => {
      // v0.4-M30 D2 closure: `--concurrency > 1` routes through
      // `dispatchParallel` (bounded async-pool). 4 items × N=4
      // means every worker is busy for the whole run — the
      // captured request count == matched count regardless of
      // completion order.
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            response: { data: { add_file_to_column: buildAsset('asset-1') } },
            repeat: 4,
          },
        ],
        { assertExhaustive: false },
      );
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath}`,
          '--yes',
          '--continue-on-error',
          '--concurrency',
          '4',
          '--json',
        ],
        {
          interactions: [
            fileBoardMetadata,
            {
              operation_name: 'ItemsPage',
              response: {
                data: {
                  boards: [
                    {
                      items_page: {
                        cursor: null,
                        items: [
                          { id: '7001' },
                          { id: '7002' },
                          { id: '7003' },
                          { id: '7004' },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: {
          summary: {
            matched_count: number;
            applied_count: number;
            failed_count: number;
          };
          results: readonly { item_id: string; ok: boolean }[];
        };
      };
      expect(env.data.summary).toMatchObject({
        matched_count: 4,
        applied_count: 4,
        failed_count: 0,
      });
      // Result rows preserve input order regardless of worker
      // completion order (axis 5 of the R-NEW-28 6-axis equivalence
      // — both dispatchers populate `results[i]` by input index).
      expect(env.data.results.map((r) => r.item_id)).toEqual([
        '7001',
        '7002',
        '7003',
        '7004',
      ]);
      expect(multipart.requests).toHaveLength(4);
    });

    it("D3 invariant: bulk `--set-raw <file-col>=<json>` stays as unsupported_column_type (NOT hijacked into file_set_on_bulk_unsupported — Codex round-2 P3-2 pin)", async () => {
      // Pre-check inspects setEntries only; --set-raw rejection
      // flows through resolveAndTranslate → translateRawColumnValue
      // → D3 permanent rejection (M42 IMPL does not surface this
      // path — the file-bulk dispatch helper never runs).
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set-raw',
          'attachments={"url":"https://example.com/x.pdf"}',
          '--yes',
          '--json',
        ],
        {
          interactions: [
            fileBoardMetadata,
            // items_page is reached because pre-check has no
            // setEntries to scan, then resolveAndTranslate runs
            // and translateRawColumnValue rejects.
            {
              operation_name: 'ItemsPage',
              response: {
                data: {
                  boards: [
                    {
                      items_page: {
                        cursor: null,
                        items: [{ id: '12345' }],
                      },
                    },
                  ],
                },
              },
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

    it('cache-preseeded metadata: emits source: "mixed" reflecting cache metadata + live walk + live multipart dispatch (Codex IMPL R1 P2-1 — SourceAggregator folds metaSource + m38.source + walk leg)', async () => {
      // Codex IMPL R1 P2-1 fix: bulk file dispatch helper now folds
      // the metadata + M38 pre-check + items_page walk + multipart
      // dispatch source legs through SourceAggregator. With cache-
      // preseeded metadata, the aggregate is `cache` + `cache`
      // (pre-check hits the just-read cache) + `live` (walk) +
      // `live` (dispatch) → `mixed`. Pre-fix the helper derived
      // source from `metaSource` alone and emitted `'mixed'` only
      // because `metaSource === 'cache'` short-circuits to
      // `'mixed'` — but that misses the case where metaSource is
      // 'live' yet m38.source is 'cache' (also `mixed` post-fix).
      const cacheRoot = resolveCacheRoot({
        env: { XDG_CACHE_HOME: xdgRoot() },
      });
      // writeEntry wraps `data` in the on-disk envelope
      // ({schema_version, created_at, key, data}); pass the raw
      // BoardMetadata shape so readEntry's parseCacheEntry hit.
      await writeEntry(cacheRoot, { kind: 'board', boardId: '111' }, fileBoard);
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            match_filename: 'report.pdf',
            response: { data: { add_file_to_column: buildAsset('asset-1') } },
            repeat: 2,
          },
        ],
        { assertExhaustive: false },
      );
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath}`,
          '--yes',
          '--json',
        ],
        {
          // No BoardMetadata interaction — pre-seeded cache hits.
          interactions: [itemsPageWithTwo],
        },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { summary: { applied_count: number } };
      };
      expect(env.ok).toBe(true);
      // Cache-served metadata + cache-served pre-check + live walk +
      // live dispatch → `mixed`.
      expect(env.meta.source).toBe('mixed');
      expect(env.data.summary.applied_count).toBe(2);
      expect(multipart.requests).toHaveLength(2);
      // P2-2 corollary: cache invalidates after happy path even though
      // it was pre-seeded. The cache file should be removed.
      const cachePath = join(cacheRoot, 'boards', '111.json');
      await expect(fsStat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('fail-fast partial success then failure: invalidates board cache before re-throwing (Codex IMPL R1 P2-2 — wire state mutated before the abort, cache must follow)', async () => {
      // Codex IMPL R1 P2-2 fix: when the fail-fast loop applies any
      // items successfully before a per-item failure aborts the
      // call, the board cache must invalidate before the throw —
      // otherwise a follow-up read serves stale metadata that
      // doesn't reflect the asset count change. Pre-fix the
      // invalidate fired only when EVERY item applied; the
      // partial-success-then-fail path skipped it entirely.
      const cacheRoot = resolveCacheRoot({
        env: { XDG_CACHE_HOME: xdgRoot() },
      });
      // writeEntry wraps `data` in the on-disk envelope
      // ({schema_version, created_at, key, data}); pass the raw
      // BoardMetadata shape so readEntry's parseCacheEntry hit.
      await writeEntry(cacheRoot, { kind: 'board', boardId: '111' }, fileBoard);
      const cachePath = join(cacheRoot, 'boards', '111.json');
      await expect(fsStat(cachePath)).resolves.toBeDefined();
      const multipart = createInlineMultipartFixtureTransport(
        [
          // First item succeeds — asset attached wire-side.
          {
            operation_name: 'AddFileToColumn',
            response: { data: { add_file_to_column: buildAsset('asset-1') } },
          },
          // Second item fails — fail-fast aborts the loop.
          {
            operation_name: 'AddFileToColumn',
            response: {
              errors: [{ message: 'Item not found' }],
              http_status: 404,
            },
          },
        ],
        { assertExhaustive: false },
      );
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath}`,
          '--yes',
          '--json',
        ],
        { interactions: [itemsPageWithTwo] },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: {
          code: string;
          details?: { applied_count?: number; applied_to?: readonly string[] };
        };
      };
      // Decoration confirms one item applied before the abort.
      expect(env.error?.details?.applied_count).toBe(1);
      expect(env.error?.details?.applied_to).toEqual(['12345']);
      // Cache invalidated despite the throw — agent's next read
      // doesn't serve a count that lies about the asset state.
      await expect(fsStat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('--continue-on-error: per-item `validation_failed` against an archived file column remaps to `column_archived` via foldAndRemap (Codex IMPL R1 P1-1 — stable-code rule applies uniformly across single + JSON-bulk + file-bulk fail-fast + partial-success)', async () => {
      // Codex IMPL R1 P1-1 fix: per-item failures now apply
      // `foldAndRemap` BEFORE landing in `data.results[i].error`
      // so a stale-cache `validation_failed` (column archived
      // server-side, still active in the local cache) remaps to
      // the stable `column_archived` code. Mirrors
      // `runPartialSuccessBulkUpdate`'s perTargetDispatch
      // (`src/api/partial-success-bulk.ts`) and the v0.1 fail-fast
      // JSON-bulk pattern; cli-design §6.5 stable-code rule is
      // now applied uniformly across single + JSON-bulk + file-
      // bulk paths.
      //
      // Cassette flow:
      //   1. Pre-seed cache with file column ACTIVE.
      //   2. Bulk dispatch — pre-check resolves from cache (active).
      //   3. Multipart wire returns `validation_failed`-mapped
      //      INVALID_ARGUMENT for the single matched item.
      //   4. foldAndRemap fires `refreshBoardMetadata`; cassette
      //      returns the same board with the file column ARCHIVED.
      //   5. Per-record `error.code` remaps to `column_archived`.
      const cacheRoot = resolveCacheRoot({
        env: { XDG_CACHE_HOME: xdgRoot() },
      });
      // writeEntry wraps `data` in the on-disk envelope
      // ({schema_version, created_at, key, data}); pass the raw
      // BoardMetadata shape so readEntry's parseCacheEntry hit.
      await writeEntry(cacheRoot, { kind: 'board', boardId: '111' }, fileBoard);
      const archivedFileBoard = {
        ...fileBoard,
        columns: [
          { ...fileBoard.columns[0], archived: true },
          fileBoard.columns[1],
        ],
      };
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
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
        ],
        { assertExhaustive: false },
      );
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath}`,
          '--yes',
          '--continue-on-error',
          '--json',
        ],
        {
          interactions: [
            // Cache-hit on first call. Then foldAndRemap refreshes
            // metadata once for the remap probe.
            {
              operation_name: 'ItemsPage',
              response: {
                data: {
                  boards: [
                    {
                      items_page: {
                        cursor: null,
                        items: [{ id: '12345' }],
                      },
                    },
                  ],
                },
              },
            },
            {
              operation_name: 'BoardMetadata',
              response: { data: { boards: [archivedFileBoard] } },
            },
          ],
        },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: {
          summary: { applied_count: number; failed_count: number };
          results: readonly {
            item_id: string;
            ok: boolean;
            error?: { code: string };
          }[];
        };
      };
      expect(env.ok).toBe(true);
      expect(env.data.summary.applied_count).toBe(0);
      expect(env.data.summary.failed_count).toBe(1);
      // P1-1 fix lands the remap — without it, error.code would be
      // `validation_failed` and agents keying off the stable
      // `column_archived` code (cli-design §6.5) would see
      // inconsistent outcomes across the bulk fail modes.
      expect(env.data.results[0]?.error?.code).toBe('column_archived');
    });

    it("'file_set_on_bulk_unsupported' literal stays RESERVED across the codebase: bulk file --set no longer surfaces it (carve-out folded at v0.7-M42); the literal MUST NOT reappear from this dispatch path", async () => {
      // Regression guard for the v0.6-M38 D5 literal. The IMPL
      // dispatches the file-bulk path through the multipart fan-out;
      // any failure now surfaces `file_too_large` / `not_found` /
      // partial-success records — never the historical
      // `file_set_on_bulk_unsupported` discriminator. Tests this
      // by exercising the live happy path + confirming the
      // discriminator literal is absent from both streams.
      const multipart = createInlineMultipartFixtureTransport(
        [
          {
            operation_name: 'AddFileToColumn',
            response: { data: { add_file_to_column: buildAsset('asset-1') } },
            repeat: 2,
          },
        ],
        { assertExhaustive: false },
      );
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath}`,
          '--yes',
          '--json',
        ],
        { interactions: [fileBoardMetadata, itemsPageWithTwo] },
        { multipartTransport: multipart },
      );
      expect(out.exitCode).toBe(0);
      expect(out.stdout).not.toContain('file_set_on_bulk_unsupported');
      expect(out.stderr).not.toContain('file_set_on_bulk_unsupported');
      expect(out.stdout).not.toContain('m42_preflight_stub');
      expect(out.stderr).not.toContain('m42_preflight_stub');
    });
  });

  describe('v0.8-M46 bulk multi-file `--set` carve-out fold (D2 closure from v0.6-M38) — pre-flight stub', () => {
    // v0.8-M46 pre-flight contract diff. argv + pre-check + items_page
    // walk + confirmation gate + routing ship as live contract; the
    // per-item multi-leg fan-out body is the c8-ignored stub throwing
    // `'m46_preflight_stub'`. IMPL lifts the stub in a separate
    // session. Mirrors v0.7-M42 pre-flight test shape verbatim.
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
        {
          id: 'status_1',
          title: 'Status',
          type: 'status',
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
      workdirM46 = await mkdtemp(join(tmpdir(), 'monday-cli-item-update-m46-'));
      reportPath1 = join(workdirM46, 'report-1.pdf');
      reportPath2 = join(workdirM46, 'report-2.pdf');
      await writeFile(reportPath1, 'PDF-bytes-fixture-1', 'utf8');
      await writeFile(reportPath2, 'PDF-bytes-fixture-2', 'utf8');
    });
    afterEach(async () => {
      await rm(workdirM46, { recursive: true, force: true });
    });

    const fileBoardMetadataMulti = {
      operation_name: 'BoardMetadata',
      response: { data: { boards: [fileBoardMultiCols] } },
    };
    const itemsPageWithTwo = {
      operation_name: 'ItemsPage',
      response: {
        data: {
          boards: [
            {
              items_page: {
                cursor: null,
                items: [{ id: '12345' }, { id: '23456' }],
              },
            },
          ],
        },
      },
    };

    it("routes 2+ file --set entries on item_update_bulk to the v0.8-M46 stub (surfaces 'm46_preflight_stub' until IMPL; was 'multi_file_set_unsupported' rejection at v0.6-M38 / v0.7)", async () => {
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath1}`,
          '--set',
          `attachments_2=${reportPath2}`,
          '--yes',
          '--json',
        ],
        { interactions: [fileBoardMetadataMulti, itemsPageWithTwo] },
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: {
          code: string;
          details?: {
            reason?: string;
            call_shape?: string;
            file_count?: number;
            matched_count?: number;
          };
        };
      };
      expect(env.error?.code).toBe('internal_error');
      expect(env.error?.details?.reason).toBe('m46_preflight_stub');
      expect(env.error?.details?.call_shape).toBe('item_update_bulk');
      expect(env.error?.details?.file_count).toBe(2);
      expect(env.error?.details?.matched_count).toBe(2);
      // Regression-guard: the v0.6-M38 reserved literal stays absent
      // from runtime output post-fold.
      expect(out.stderr).not.toContain('multi_file_set_unsupported');
      expect(out.stdout).not.toContain('multi_file_set_unsupported');
    });

    it("v0.8-M46 Codex R1 P3-2 fix: 'multi_file_set_unsupported' literal stays absent on the DRY-RUN bulk multi-file routing path", async () => {
      // Dry-run reaches the same stub (the c8-ignored body throws
      // unconditionally regardless of `inputs.isDryRun`); the live-
      // path regression-guard above asserts literal absence on live,
      // this one asserts the same on dry-run.
      const out = await drive(
        [
          'item',
          'update',
          '--board',
          '111',
          '--where',
          'status_1=Backlog',
          '--set',
          `attachments=${reportPath1}`,
          '--set',
          `attachments_2=${reportPath2}`,
          '--dry-run',
          '--json',
        ],
        { interactions: [fileBoardMetadataMulti, itemsPageWithTwo] },
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: {
          code: string;
          details?: { reason?: string; is_dry_run?: boolean };
        };
      };
      expect(env.error?.details?.reason).toBe('m46_preflight_stub');
      expect(env.error?.details?.is_dry_run).toBe(true);
      expect(out.stderr).not.toContain('multi_file_set_unsupported');
      expect(out.stdout).not.toContain('multi_file_set_unsupported');
    });
  });
});
