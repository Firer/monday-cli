import { describe, expect, it } from 'vitest';
import {
  parseColumnTokenPrefix,
  resolveColumn,
  resolveColumnWithRefresh,
} from '../../../src/api/columns.js';
import type { BoardColumn, BoardMetadata } from '../../../src/api/board-metadata.js';
import { ApiError } from '../../../src/utils/errors.js';
import type { MondayClient, MondayResponse } from '../../../src/api/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

const col = (over: Partial<BoardColumn>): BoardColumn => ({
  id: over.id ?? 'status_4',
  title: over.title ?? 'Status',
  type: over.type ?? 'status',
  description: over.description ?? null,
  archived: over.archived ?? false,
  settings_str: over.settings_str ?? null,
  width: over.width ?? null,
});

const board = (columns: readonly BoardColumn[]): BoardMetadata => ({
  id: '111',
  name: 'B',
  description: null,
  state: 'active',
  board_kind: 'public',
  board_folder_id: null,
  workspace_id: null,
  url: null,
  hierarchy_type: 'top_level',
  is_leaf: true,
  updated_at: null,
  groups: [],
  columns: columns as BoardColumn[],
});

describe('parseColumnTokenPrefix', () => {
  it('strips the id: prefix', () => {
    expect(parseColumnTokenPrefix('id:status_4')).toEqual({
      kind: 'id',
      value: 'status_4',
    });
  });

  it('strips the title: prefix preserving spaces', () => {
    expect(parseColumnTokenPrefix('title:Plan A')).toEqual({
      kind: 'title',
      value: 'Plan A',
    });
  });

  it('returns undefined for tokens without a prefix', () => {
    expect(parseColumnTokenPrefix('Status')).toBeUndefined();
    expect(parseColumnTokenPrefix('status_4')).toBeUndefined();
  });
});

describe('resolveColumn — implicit token resolution', () => {
  it('matches by exact column ID first (case-sensitive)', () => {
    const meta = board([
      col({ id: 'status_4', title: 'Status' }),
      col({ id: 'status_5', title: 'Status' }),
    ]);
    const m = resolveColumn(meta, 'status_4');
    expect(m.via).toBe('id');
    expect(m.column.id).toBe('status_4');
  });

  it('falls through to title when ID does not match', () => {
    const meta = board([
      col({ id: 'status_4', title: 'Owner' }),
    ]);
    const m = resolveColumn(meta, 'Owner');
    expect(m.via).toBe('title');
    expect(m.column.id).toBe('status_4');
  });

  it('NFC-normalises composed/decomposed forms before comparing titles', () => {
    // U+00E9 ("é" composed) vs U+0065 U+0301 ("e" + combining acute)
    const composed = 'Café';
    const decomposed = 'Café';
    const meta = board([col({ id: 'col_1', title: composed })]);
    expect(resolveColumn(meta, decomposed).column.id).toBe('col_1');
  });

  it('case-folds Unicode-aware as a fallback', () => {
    const meta = board([col({ id: 'col_1', title: 'Status' })]);
    expect(resolveColumn(meta, 'STATUS').via).toBe('case_fold');
    expect(resolveColumn(meta, 'status').via).toBe('case_fold');
  });

  it('treats internal-whitespace-collapsed titles as the same NFC pass', () => {
    const meta = board([col({ id: 'col_1', title: 'Plan   A' })]);
    expect(resolveColumn(meta, 'Plan A').via).toBe('title');
  });

  it('case-sensitive title match wins over case-fold collision', () => {
    // Title-exact pass returns "Status" deterministically when the
    // user typed "Status"; case-fold would have collapsed both.
    const meta = board([
      col({ id: 'col_a', title: 'Status' }),
      col({ id: 'col_b', title: 'STATUS' }),
    ]);
    const m = resolveColumn(meta, 'Status');
    expect(m.via).toBe('title');
    expect(m.column.id).toBe('col_a');
  });

  it('raises ambiguous_column when titles collide on the NFC pass', () => {
    const meta = board([
      col({ id: 'col_a', title: 'Owner' }),
      col({ id: 'col_b', title: 'Owner' }),
    ]);
    expect(() => resolveColumn(meta, 'Owner')).toThrow(
      expect.objectContaining({ code: 'ambiguous_column' }) as Error,
    );
  });

  it('raises ambiguous_column on case-fold collision (none exact)', () => {
    const meta = board([
      col({ id: 'col_a', title: 'Status' }),
      col({ id: 'col_b', title: 'STATUS' }),
    ]);
    expect(() => resolveColumn(meta, 'sTaTuS')).toThrow(
      expect.objectContaining({ code: 'ambiguous_column' }) as Error,
    );
  });

  it('raises column_not_found with the board id and token in details', () => {
    const meta = board([col({ id: 'col_a', title: 'Owner' })]);
    let caught: unknown = undefined;
    try {
      resolveColumn(meta, 'nope');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('column_not_found');
    expect((caught as ApiError).details).toMatchObject({
      token: 'nope',
      board_id: '111',
      include_archived: false,
    });
  });
});

describe('resolveColumn — archived columns are filtered out by default', () => {
  it('returns column_not_found when the matching column is archived', () => {
    const meta = board([
      col({ id: 'status_4', title: 'Status', archived: true }),
    ]);
    expect(() => resolveColumn(meta, 'Status')).toThrow(
      expect.objectContaining({ code: 'column_not_found' }) as Error,
    );
    expect(() => resolveColumn(meta, 'status_4')).toThrow(
      expect.objectContaining({ code: 'column_not_found' }) as Error,
    );
  });

  it('resolves the archived column when includeArchived is true', () => {
    const meta = board([
      col({ id: 'status_4', title: 'Status', archived: true }),
    ]);
    const m = resolveColumn(meta, 'Status', { includeArchived: true });
    expect(m.column.archived).toBe(true);
    expect(m.via).toBe('title');
  });
});

describe('resolveColumn — explicit prefix syntax', () => {
  it('id: prefix returns the matched column with via=prefix_id', () => {
    const meta = board([col({ id: 'status_4', title: 'Status' })]);
    expect(resolveColumn(meta, 'id:status_4')).toMatchObject({
      via: 'prefix_id',
      column: { id: 'status_4' },
    });
  });

  it('id: prefix raises column_not_found when missing', () => {
    const meta = board([col({ id: 'status_4', title: 'Status' })]);
    expect(() => resolveColumn(meta, 'id:nope')).toThrow(
      expect.objectContaining({ code: 'column_not_found' }) as Error,
    );
  });

  it('title: prefix matches on NFC-normalised title', () => {
    const meta = board([col({ id: 'col_1', title: 'Plan A' })]);
    expect(resolveColumn(meta, 'title:Plan A').via).toBe('prefix_title');
  });

  it('title: prefix raises ambiguous_column on title collision', () => {
    const meta = board([
      col({ id: 'col_a', title: 'Owner' }),
      col({ id: 'col_b', title: 'Owner' }),
    ]);
    expect(() => resolveColumn(meta, 'title:Owner')).toThrow(
      expect.objectContaining({ code: 'ambiguous_column' }) as Error,
    );
  });

  it('title: prefix accepts a case-fold fallback when no exact match', () => {
    const meta = board([col({ id: 'col_1', title: 'Status' })]);
    expect(resolveColumn(meta, 'title:status').via).toBe('prefix_title');
  });

  it('title: prefix raises ambiguous_column when the case-fold fallback is itself ambiguous', () => {
    const meta = board([
      col({ id: 'col_a', title: 'Status' }),
      col({ id: 'col_b', title: 'STATUS' }),
    ]);
    expect(() => resolveColumn(meta, 'title:sTaTuS')).toThrow(
      expect.objectContaining({ code: 'ambiguous_column' }) as Error,
    );
  });

  it('title: prefix raises column_not_found when nothing matches at all', () => {
    const meta = board([col({ id: 'col_1', title: 'Status' })]);
    expect(() => resolveColumn(meta, 'title:does-not-exist')).toThrow(
      expect.objectContaining({ code: 'column_not_found' }) as Error,
    );
  });
});

let tmpRoot: string;
const xdgEnv = (): NodeJS.ProcessEnv => ({ XDG_CACHE_HOME: tmpRoot });

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-columns-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const buildClient = (
  responses: readonly unknown[],
  stats: { calls: number },
): MondayClient => {
  let cursor = 0;
  const fake = {
    raw: <T>(): Promise<MondayResponse<T>> => {
      stats.calls++;
      const next = responses[cursor];
      cursor = Math.min(cursor + 1, responses.length - 1);
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve({
        data: next as T,
        complexity: null,
        stats: { attempts: 1, totalSleepMs: 0 },
      });
    },
  };
  return fake as unknown as MondayClient;
};

const sampleBoardPayload = (columns: readonly BoardColumn[]): { boards: unknown[] } => ({
  boards: [
    {
      id: '111',
      name: 'Tasks',
      description: null,
      state: 'active',
      board_kind: 'public',
      board_folder_id: null,
      workspace_id: null,
      url: null,
      hierarchy_type: 'top_level',
      is_leaf: true,
      updated_at: null,
      groups: [],
      columns,
    },
  ],
});

describe('resolveColumn — ID/title collision detection (Codex M3 finding 4)', () => {
  it('flags collisionCandidates when ID matches a column whose token also matches another title', () => {
    // Token "status" matches col_a's id exactly, AND col_b's title
    // (after case-fold). §5.3 step 3: ID match wins, but caller
    // gets a column_token_collision signal.
    const meta = board([
      col({ id: 'status', title: 'Original' }),
      col({ id: 'col_b', title: 'Status' }),
    ]);
    const m = resolveColumn(meta, 'status');
    expect(m.via).toBe('id');
    expect(m.column.id).toBe('status');
    expect(m.collisionCandidates.map((c) => c.id)).toEqual(['col_b']);
  });

  it('emits no collisionCandidates when ID match is unambiguous', () => {
    const meta = board([col({ id: 'status_4', title: 'Status' })]);
    const m = resolveColumn(meta, 'status_4');
    expect(m.collisionCandidates).toEqual([]);
  });
});

describe('resolveColumnWithRefresh — auto-refresh once on column_not_found', () => {
  it('retries the load with refresh:true when the cache misses the column', async () => {
    const stats = { calls: 0 };
    const stale = sampleBoardPayload([col({ id: 'status_4', title: 'Status' })]);
    const fresh = sampleBoardPayload([
      col({ id: 'status_4', title: 'Status' }),
      col({ id: 'priority', title: 'Priority' }),
    ]);
    const client = buildClient([stale, fresh], stats);

    // First seed the cache with the stale payload.
    await resolveColumnWithRefresh({
      client,
      boardId: '111',
      token: 'Status',
      env: xdgEnv(),
    });
    expect(stats.calls).toBe(1); // live fetch — cache miss

    // Now look up "Priority" which only exists in the fresh
    // payload. The first read serves from cache (1 fetch so far),
    // raises column_not_found, and the resolver triggers a refresh.
    const result = await resolveColumnWithRefresh({
      client,
      boardId: '111',
      token: 'Priority',
      env: xdgEnv(),
    });
    expect(stats.calls).toBe(2);
    expect(result.match.column.id).toBe('priority');
  });

  it('does not refresh when the first load was already live', async () => {
    const stats = { calls: 0 };
    const live = sampleBoardPayload([col({ id: 'status_4', title: 'Status' })]);
    const client = buildClient([live], stats);
    await expect(
      resolveColumnWithRefresh({
        client,
        boardId: '111',
        token: 'Priority',
        env: xdgEnv(),
      }),
    ).rejects.toMatchObject({ code: 'column_not_found' });
    // Single live fetch, no second call.
    expect(stats.calls).toBe(1);
  });

  it('does not refresh under --no-cache (live data is already authoritative)', async () => {
    const stats = { calls: 0 };
    const client = buildClient(
      [sampleBoardPayload([col({ id: 'status_4', title: 'Status' })])],
      stats,
    );
    await expect(
      resolveColumnWithRefresh({
        client,
        boardId: '111',
        token: 'Priority',
        env: xdgEnv(),
        noCache: true,
      }),
    ).rejects.toMatchObject({ code: 'column_not_found' });
    expect(stats.calls).toBe(1);
  });

  it('returns source=mixed + stale_cache_refreshed warning after refresh resolves a missing column', async () => {
    const stats = { calls: 0 };
    const stale = sampleBoardPayload([col({ id: 'status_4', title: 'Status' })]);
    const fresh = sampleBoardPayload([
      col({ id: 'status_4', title: 'Status' }),
      col({ id: 'priority', title: 'Priority' }),
    ]);
    const client = buildClient([stale, fresh], stats);
    await resolveColumnWithRefresh({
      client,
      boardId: '111',
      token: 'Status',
      env: xdgEnv(),
    });
    const result = await resolveColumnWithRefresh({
      client,
      boardId: '111',
      token: 'Priority',
      env: xdgEnv(),
    });
    expect(result.source).toBe('mixed');
    expect(result.warnings.map((w) => w.code)).toContain(
      'stale_cache_refreshed',
    );
    // Codex M3 pass-2 §1: the mixed result preserves the *original*
    // cache age — that's the age the misleading payload had at the
    // moment the cache returned it. Null would erase the audit trail.
    expect(result.cacheAgeSeconds).not.toBeNull();
    expect(result.cacheAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('cache-hit path reports source=cache and surfaces collisions', async () => {
    const stats = { calls: 0 };
    const payload = sampleBoardPayload([
      col({ id: 'status', title: 'Header' }),
      col({ id: 'col_b', title: 'Status' }),
    ]);
    const client = buildClient([payload], stats);
    // Seed cache.
    await resolveColumnWithRefresh({
      client,
      boardId: '111',
      token: 'status',
      env: xdgEnv(),
    });
    expect(stats.calls).toBe(1);
    const result = await resolveColumnWithRefresh({
      client,
      boardId: '111',
      token: 'status',
      env: xdgEnv(),
    });
    expect(result.source).toBe('cache');
    expect(result.warnings[0]?.code).toBe('column_token_collision');
  });

  it('does not refresh when the failure is ambiguous_column (refresh would not help)', async () => {
    const stats = { calls: 0 };
    const payload = sampleBoardPayload([
      col({ id: 'col_a', title: 'Owner' }),
      col({ id: 'col_b', title: 'Owner' }),
    ]);
    const client = buildClient([payload], stats);
    // Seed the cache.
    await resolveColumnWithRefresh({
      client,
      boardId: '111',
      token: 'col_a',
      env: xdgEnv(),
    });
    expect(stats.calls).toBe(1);
    // Ambiguous lookup — cache hit is fine, but refresh wouldn't fix
    // it. Verify we don't spend a second network call.
    await expect(
      resolveColumnWithRefresh({
        client,
        boardId: '111',
        token: 'Owner',
        env: xdgEnv(),
      }),
    ).rejects.toMatchObject({ code: 'ambiguous_column' });
    expect(stats.calls).toBe(1);
  });
});
