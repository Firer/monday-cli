import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadBoardMetadata,
  refreshBoardMetadata,
  evictBoardMetadata,
  boardMetadataSchema,
  type BoardMetadataLoadResult,
} from '../../../src/api/board-metadata.js';
import { DEFAULT_CACHE_TTL_SECONDS } from '../../../src/api/cache.js';
import { ApiError } from '../../../src/utils/errors.js';
import type { MondayClient, MondayResponse } from '../../../src/api/client.js';

const sampleBoard = {
  id: '111',
  name: 'Tasks',
  description: 'Things to do',
  state: 'active',
  board_kind: 'public',
  board_folder_id: null,
  workspace_id: '5',
  url: 'https://acme.monday.com/boards/111',
  hierarchy_type: 'top_level',
  is_leaf: true,
  updated_at: '2026-04-30T10:00:00Z',
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
  columns: [
    {
      id: 'status_4',
      title: 'Status',
      type: 'status',
      description: null,
      archived: false,
      settings_str: '{"labels":{"0":"Backlog","1":"Done"}}',
      width: null,
    },
  ],
};

interface FakeClientStats {
  calls: number;
}

interface FakeResponse {
  readonly data: unknown;
  readonly complexity?: { used: number; remaining: number; reset_in_seconds: number } | null;
}

const buildFakeClient = (
  responses: readonly unknown[],
  stats: FakeClientStats,
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
      // Loose detection: if the response shape has the explicit
      // `data` + `complexity` slot, use it directly; otherwise treat
      // the value as the data payload (legacy test shape).
      if (
        typeof next === 'object' &&
        next !== null &&
        'data' in next &&
        'complexity' in next
      ) {
        const w = next as FakeResponse;
        return Promise.resolve({
          data: w.data as T,
          complexity: w.complexity ?? null,
          stats: { attempts: 1, totalSleepMs: 0 },
        });
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

let tmpRoot: string;
const xdgEnv = (): NodeJS.ProcessEnv => ({ XDG_CACHE_HOME: tmpRoot });

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-board-meta-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('boardMetadataSchema', () => {
  it('accepts the canonical Monday-shape payload', () => {
    expect(() => boardMetadataSchema.parse(sampleBoard)).not.toThrow();
  });

  it('rejects payloads missing the id field', () => {
    const { id: _id, ...rest } = sampleBoard;
    expect(() => boardMetadataSchema.parse(rest)).toThrow();
  });

  it('rejects unknown column-array entries (strict shape)', () => {
    const broken = {
      ...sampleBoard,
      columns: [
        { ...sampleBoard.columns[0], extra: 'no' },
      ],
    };
    expect(() => boardMetadataSchema.parse(broken)).toThrow();
  });
});

describe('loadBoardMetadata — cache miss + cache hit', () => {
  it('fetches live, writes the cache, and reports source=live', async () => {
    const stats: FakeClientStats = { calls: 0 };
    const client = buildFakeClient([{ boards: [sampleBoard] }], stats);

    const result = await loadBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
    });

    expect(result.source).toBe('live');
    expect(result.cacheAgeSeconds).toBeNull();
    expect(result.metadata.id).toBe('111');
    expect(result.complexity).toBeNull();
    expect(stats.calls).toBe(1);
  });

  it('surfaces complexity from --verbose live responses (Codex M3 finding 3)', async () => {
    const stats: FakeClientStats = { calls: 0 };
    const complexity = { used: 1, remaining: 4_999_999, reset_in_seconds: 30 };
    const client = buildFakeClient(
      [{ data: { boards: [sampleBoard] }, complexity }],
      stats,
    );
    const result = await loadBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
    });
    expect(result.complexity).toEqual(complexity);
  });

  it('cache hits never report complexity (no live request ran)', async () => {
    const stats: FakeClientStats = { calls: 0 };
    const complexity = { used: 1, remaining: 4_999_999, reset_in_seconds: 30 };
    const client = buildFakeClient(
      [{ data: { boards: [sampleBoard] }, complexity }],
      stats,
    );
    await loadBoardMetadata({ client, boardId: '111', env: xdgEnv() });
    const cached = await loadBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
    });
    expect(cached.source).toBe('cache');
    expect(cached.complexity).toBeNull();
  });

  it('serves from cache on the second call (no network)', async () => {
    const stats: FakeClientStats = { calls: 0 };
    const client = buildFakeClient([{ boards: [sampleBoard] }], stats);

    await loadBoardMetadata({ client, boardId: '111', env: xdgEnv() });
    const cached = await loadBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
    });

    expect(stats.calls).toBe(1);
    expect(cached.source).toBe('cache');
    expect(cached.cacheAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('--no-cache bypasses both read and write', async () => {
    const stats: FakeClientStats = { calls: 0 };
    const client = buildFakeClient(
      [{ boards: [sampleBoard] }, { boards: [sampleBoard] }, { boards: [sampleBoard] }],
      stats,
    );

    await loadBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
      noCache: true,
    });
    await loadBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
      noCache: true,
    });
    expect(stats.calls).toBe(2);

    // Confirm there is no cache entry left behind to serve a third
    // (cached) call.
    const third = await loadBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
    });
    expect(third.source).toBe('live');
  });

  it('TTL expiry triggers a refresh', async () => {
    const { utimes } = await import('node:fs/promises');
    const stats: FakeClientStats = { calls: 0 };
    const client = buildFakeClient(
      [{ boards: [sampleBoard] }, { boards: [{ ...sampleBoard, name: 'Tasks v2' }] }],
      stats,
    );

    await loadBoardMetadata({ client, boardId: '111', env: xdgEnv() });
    // Backdate the cache file's mtime past the default 5m TTL so the
    // next read treats it as expired. Mirrors the `cache.test.ts`
    // pattern — driven by real wall-clock semantics rather than a
    // fictional injected clock.
    const cachePath = `${tmpRoot}/monday-cli/boards/111.json`;
    const stale = new Date(Date.now() - (DEFAULT_CACHE_TTL_SECONDS + 60) * 1000);
    await utimes(cachePath, stale, stale);

    const second = await loadBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
    });
    expect(stats.calls).toBe(2);
    expect(second.source).toBe('live');
    expect(second.metadata.name).toBe('Tasks v2');
  });

  it('refresh:true forces a live fetch even when cache is fresh', async () => {
    const stats: FakeClientStats = { calls: 0 };
    const client = buildFakeClient(
      [
        { boards: [sampleBoard] },
        { boards: [{ ...sampleBoard, name: 'Tasks v2' }] },
      ],
      stats,
    );

    await loadBoardMetadata({ client, boardId: '111', env: xdgEnv() });
    const refreshed = await refreshBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
    });
    expect(stats.calls).toBe(2);
    expect(refreshed.source).toBe('live');
    expect(refreshed.metadata.name).toBe('Tasks v2');
  });

  it('surfaces not_found when Monday returns boards: []', async () => {
    const stats: FakeClientStats = { calls: 0 };
    const client = buildFakeClient([{ boards: [] }], stats);
    await expect(
      loadBoardMetadata({ client, boardId: '111', env: xdgEnv() }),
    ).rejects.toMatchObject({
      code: 'not_found',
      details: { board_id: '111' },
    });
  });

  it('rejects non-numeric board ids at the parse boundary', async () => {
    const stats: FakeClientStats = { calls: 0 };
    const client = buildFakeClient([{ boards: [sampleBoard] }], stats);
    await expect(
      loadBoardMetadata({ client, boardId: 'abc', env: xdgEnv() }),
    ).rejects.toThrow();
  });
});

describe('evictBoardMetadata', () => {
  it('removes the on-disk entry so the next load re-fetches', async () => {
    const stats: FakeClientStats = { calls: 0 };
    const client = buildFakeClient(
      [{ boards: [sampleBoard] }, { boards: [sampleBoard] }],
      stats,
    );

    await loadBoardMetadata({ client, boardId: '111', env: xdgEnv() });
    await evictBoardMetadata('111', xdgEnv());
    const after: BoardMetadataLoadResult = await loadBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
    });
    expect(stats.calls).toBe(2);
    expect(after.source).toBe('live');
  });
});

describe('loadBoardMetadata — error handling', () => {
  it('falls through to live fetch when the cache read raises', async () => {
    // Pre-fill the cache with a malformed payload so the parser
    // rejects it on read; loadBoardMetadata should swallow the
    // error and re-fetch live.
    const { writeEntry } = await import('../../../src/api/cache.js');
    const root = `${tmpRoot}/monday-cli`;
    await writeEntry(root, { kind: 'board', boardId: '111' }, { wrong: 'shape' });

    const stats: FakeClientStats = { calls: 0 };
    const client = buildFakeClient([{ boards: [sampleBoard] }], stats);
    const result = await loadBoardMetadata({
      client,
      boardId: '111',
      env: xdgEnv(),
    });
    expect(stats.calls).toBe(1);
    expect(result.source).toBe('live');
  });

  it('propagates ApiErrors from the live fetch', async () => {
    const err = new ApiError('rate_limited', 'slow down');
    const stats: FakeClientStats = { calls: 0 };
    const client = buildFakeClient([err], stats);
    await expect(
      loadBoardMetadata({ client, boardId: '111', env: xdgEnv() }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
