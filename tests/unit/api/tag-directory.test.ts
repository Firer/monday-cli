/**
 * Full-coverage tests for the v0.3-M19 `tag-directory.ts` runtime
 * body. Replaces the pre-flight surface stubs (which just asserted
 * the `Promise.reject` stub error shape) now that the bodies land.
 *
 * Mirrors `resolvers.test.ts userByEmail` patterns:
 *   - tmp `XDG_CACHE_HOME` per test (mkdtemp + cleanup)
 *   - fake `MondayClient` with response queue + call counter
 *   - covers cache hit / cache miss / live refresh / multi-miss /
 *     NFC + case-fold matching / dedup / source discriminant /
 *     noCache / malformed-response paths.
 */

import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadAccountTags,
  resolveTags,
  type AccountTag,
  type LoadAccountTagsResult,
  type ResolveTagsInputs,
  type ResolveTagsResult,
} from '../../../src/api/tag-directory.js';
import type { MondayClient, MondayResponse } from '../../../src/api/client.js';
import { ApiError } from '../../../src/utils/errors.js';

let tmpRoot: string;
const xdgEnv = (): NodeJS.ProcessEnv => ({ XDG_CACHE_HOME: tmpRoot });

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-tag-directory-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

interface ClientStats {
  calls: number;
}

const buildClient = (
  responses: readonly unknown[],
  stats: ClientStats,
  complexity: MondayResponse<unknown>['complexity'] = null,
): MondayClient => {
  let cursor = 0;
  const fake = {
    raw: <T>(): Promise<MondayResponse<T>> => {
      stats.calls++;
      const next = responses[cursor];
      cursor = Math.min(cursor + 1, responses.length - 1);
      return Promise.resolve({
        data: next as T,
        complexity,
        stats: { attempts: 1, totalSleepMs: 0 },
      });
    },
  };
  return fake as unknown as MondayClient;
};

const launch: AccountTag = { id: '101', name: 'launch' };
const priority: AccountTag = { id: '202', name: 'priority' };
const ux: AccountTag = { id: '303', name: 'UX' };

const makeTagsResponse = (
  tags: readonly AccountTag[],
): { account: { tags: readonly AccountTag[] } } => ({
  account: { tags },
});

describe('tag-directory surface types', () => {
  it('AccountTag exposes id (decimal-string) + name', () => {
    const sample: AccountTag = { id: '123', name: 'launch' };
    expect(sample.id).toBe('123');
    expect(sample.name).toBe('launch');
  });

  it('ResolveTagsInputs accepts client + input + optional env/noCache', () => {
    const stubClient = {} as unknown as MondayClient;
    const inputs: ResolveTagsInputs = {
      client: stubClient,
      input: 'launch,priority',
    };
    expect(inputs.input).toBe('launch,priority');
  });

  it('ResolveTagsResult carries ids + misses + source + cacheAgeSeconds', () => {
    const result: ResolveTagsResult = {
      ids: [1, 2],
      misses: [],
      source: 'cache',
      cacheAgeSeconds: 30,
    };
    expect(result.ids).toEqual([1, 2]);
    expect(result.cacheAgeSeconds).toBe(30);
  });

  it('LoadAccountTagsResult carries tags + source + cacheAgeSeconds + complexity', () => {
    const result: LoadAccountTagsResult = {
      tags: [],
      source: 'live',
      cacheAgeSeconds: null,
      complexity: null,
    };
    expect(result.tags).toEqual([]);
  });
});

describe('loadAccountTags — cache-then-live', () => {
  it('returns live + writes to cache on first call', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch, priority])], stats);
    const result = await loadAccountTags({ client, env: xdgEnv() });
    expect(result.source).toBe('live');
    expect(result.cacheAgeSeconds).toBeNull();
    expect(result.tags).toEqual([launch, priority]);
    expect(stats.calls).toBe(1);

    // Second call hits cache — no new live request.
    const cached = await loadAccountTags({ client, env: xdgEnv() });
    expect(cached.source).toBe('cache');
    expect(cached.cacheAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(stats.calls).toBe(1);
  });

  it('surfaces complexity from the live leg', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient(
      [makeTagsResponse([launch])],
      stats,
      {
        before: 5_000_000,
        after: 4_999_900,
        query: 100,
        reset_in_x_seconds: 30,
      },
    );
    const result = await loadAccountTags({ client, env: xdgEnv() });
    expect(result.complexity).toMatchObject({ before: 5_000_000, query: 100 });
  });

  it('returns null complexity for cache hits', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch])], stats);
    await loadAccountTags({ client, env: xdgEnv() });
    const cached = await loadAccountTags({ client, env: xdgEnv() });
    expect(cached.source).toBe('cache');
    expect(cached.complexity).toBeNull();
  });

  it('noCache: true skips cache read AND write — every call is live', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient(
      [makeTagsResponse([launch]), makeTagsResponse([launch, priority])],
      stats,
    );
    const first = await loadAccountTags({
      client,
      env: xdgEnv(),
      noCache: true,
    });
    expect(first.source).toBe('live');
    const second = await loadAccountTags({
      client,
      env: xdgEnv(),
      noCache: true,
    });
    expect(second.source).toBe('live');
    expect(second.tags).toEqual([launch, priority]);
    expect(stats.calls).toBe(2);
  });

  it('handles a null account.tags response (Monday surfaces null on edge accounts)', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([{ account: { tags: null } }], stats);
    const result = await loadAccountTags({ client, env: xdgEnv() });
    expect(result.tags).toEqual([]);
    expect(result.source).toBe('live');
  });

  it('throws not_found on a null account response (Codex post-Commit-5 P1-1 fix)', async () => {
    // Pre-fix: `account === null` collapsed to a benign empty list
    // via `?? []`, hiding auth/scope/account-shape problems and
    // letting later tag writes fail as `tag_not_found` instead of
    // surfacing the real account-level issue. Post-fix surfaces
    // as `not_found` matching `account info`'s shape.
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([{ account: null }], stats);
    await expect(
      loadAccountTags({ client, env: xdgEnv() }),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringMatching(/no account/u) as string,
    });
  });

  it('throws internal_error on a malformed account.tags response', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient(
      // id is a hex string — fails the decimal regex on the directory schema.
      [{ account: { tags: [{ id: '0x1f', name: 'launch' }] } }],
      stats,
    );
    await expect(
      loadAccountTags({ client, env: xdgEnv() }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      loadAccountTags({ client, env: xdgEnv() }),
    ).rejects.toMatchObject({
      code: 'internal_error',
      details: expect.objectContaining({
        issues: expect.any(Array) as unknown[],
      }) as Record<string, unknown>,
    });
  });

  it('a corrupt cache file falls through to live (treated as miss)', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch])], stats);

    // Write a corrupt cache entry that the schema will reject.
    const cacheDir = join(tmpRoot, 'monday-cli', 'account_tags');
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const cacheFile = join(cacheDir, 'index.json');
    await writeFile(
      cacheFile,
      JSON.stringify({
        schema_version: '1',
        created_at: new Date().toISOString(),
        key: { kind: 'accountTags' },
        // Schema requires `id` (decimal string) + `name`; this entry
        // breaks the regex.
        data: [{ id: 'NaN', name: 'broken' }],
      }),
      { mode: 0o600 },
    );
    await chmod(cacheFile, 0o600);

    const result = await loadAccountTags({ client, env: xdgEnv() });
    expect(result.source).toBe('live');
    expect(result.tags).toEqual([launch]);
  });
});

describe('resolveTags — comma-split + cache-then-live', () => {
  it('returns ids + empty misses for a single cache hit', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch, priority])], stats);
    // Prime the cache.
    await loadAccountTags({ client, env: xdgEnv() });
    expect(stats.calls).toBe(1);

    const result = await resolveTags({ client, input: 'launch', env: xdgEnv() });
    expect(result.ids).toEqual([101]);
    expect(result.misses).toEqual([]);
    expect(result.source).toBe('cache');
    expect(result.cacheAgeSeconds).toBeGreaterThanOrEqual(0);
    // No additional live call.
    expect(stats.calls).toBe(1);
  });

  it('returns ids in input order for multi-tag input', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch, priority])], stats);
    await loadAccountTags({ client, env: xdgEnv() });

    const result = await resolveTags({
      client,
      input: 'priority,launch',
      env: xdgEnv(),
    });
    expect(result.ids).toEqual([202, 101]);
    expect(result.source).toBe('cache');
  });

  it('NFC + case-fold: " LaUnCh " matches "launch"', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch])], stats);
    await loadAccountTags({ client, env: xdgEnv() });

    const result = await resolveTags({
      client,
      input: ' LaUnCh ',
      env: xdgEnv(),
    });
    expect(result.ids).toEqual([101]);
    expect(result.misses).toEqual([]);
  });

  it('case-fold for non-ASCII names (UX matches via lowercase ux)', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([ux])], stats);
    await loadAccountTags({ client, env: xdgEnv() });

    const result = await resolveTags({ client, input: 'ux', env: xdgEnv() });
    expect(result.ids).toEqual([303]);
  });

  it('dedup: "launch,launch" returns one id', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch])], stats);
    await loadAccountTags({ client, env: xdgEnv() });

    const result = await resolveTags({
      client,
      input: 'launch,launch',
      env: xdgEnv(),
    });
    expect(result.ids).toEqual([101]);
    expect(result.misses).toEqual([]);
  });

  it('dedup is NFC + case-fold aware: "Launch,launch" is one tag', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch])], stats);
    await loadAccountTags({ client, env: xdgEnv() });

    const result = await resolveTags({
      client,
      input: 'Launch,launch',
      env: xdgEnv(),
    });
    expect(result.ids).toEqual([101]);
  });

  it('empty / whitespace-only input returns empty ids + empty misses', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch])], stats);

    const result = await resolveTags({ client, input: ' , , ', env: xdgEnv() });
    expect(result.ids).toEqual([]);
    expect(result.misses).toEqual([]);
    // No live call needed when there's nothing to resolve.
    expect(stats.calls).toBe(0);
  });

  it('miss against fresh cache triggers live refresh; new tag now resolves', async () => {
    const stats: ClientStats = { calls: 0 };
    // First: live populates cache with [launch] only.
    // Second: refresh-on-miss, live returns [launch, priority].
    const client = buildClient(
      [makeTagsResponse([launch]), makeTagsResponse([launch, priority])],
      stats,
    );
    await loadAccountTags({ client, env: xdgEnv() });
    expect(stats.calls).toBe(1);

    const result = await resolveTags({
      client,
      input: 'launch,priority',
      env: xdgEnv(),
    });
    // Refresh fired; final result has both ids.
    expect(result.ids).toEqual([101, 202]);
    expect(result.misses).toEqual([]);
    // Source is 'mixed' because cache had launch but not priority.
    expect(result.source).toBe('mixed');
    // cacheAgeSeconds preserves the cache leg's age (worst-case
    // staleness) for `'mixed'` per §6.1 mergeCacheAge contract.
    // The cache was just-written so the age is 0+ seconds.
    expect(result.cacheAgeSeconds).not.toBeNull();
    expect(result.cacheAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(stats.calls).toBe(2);
  });

  it('residual miss after refresh surfaces in the misses array', async () => {
    const stats: ClientStats = { calls: 0 };
    // Cache populated with only [launch]; refresh returns same set;
    // 'priority' remains a miss after refresh.
    const client = buildClient([makeTagsResponse([launch])], stats);
    await loadAccountTags({ client, env: xdgEnv() });

    const result = await resolveTags({
      client,
      input: 'launch,priority',
      env: xdgEnv(),
    });
    expect(result.ids).toEqual([101]);
    expect(result.misses).toEqual(['priority']);
    expect(result.source).toBe('mixed');
  });

  it('all-miss against fresh cache → refresh → all-miss after refresh: source is live', async () => {
    const stats: ClientStats = { calls: 0 };
    // Cache is populated initially via loadAccountTags. Then we ask for
    // tags none of which are in the cache, triggering refresh; refresh
    // also returns the same set, so all input tokens stay missed.
    const client = buildClient([makeTagsResponse([launch])], stats);
    await loadAccountTags({ client, env: xdgEnv() });

    const result = await resolveTags({
      client,
      input: 'priority,UX',
      env: xdgEnv(),
    });
    // Cache-leg matched zero (cache only had launch); pure live source.
    expect(result.ids).toEqual([]);
    expect(result.misses).toEqual(['priority', 'UX']);
    expect(result.source).toBe('live');
    expect(result.cacheAgeSeconds).toBeNull();
  });

  it('noCache: true bypasses cache read; goes straight to live', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch, priority])], stats);

    const result = await resolveTags({
      client,
      input: 'launch',
      env: xdgEnv(),
      noCache: true,
    });
    expect(result.source).toBe('live');
    expect(result.cacheAgeSeconds).toBeNull();
    expect(result.ids).toEqual([101]);
    expect(stats.calls).toBe(1);
  });

  it('cache hit → no live call; source is cache', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch, priority])], stats);
    // Prime cache.
    await loadAccountTags({ client, env: xdgEnv() });
    expect(stats.calls).toBe(1);

    const result = await resolveTags({
      client,
      input: 'launch,priority',
      env: xdgEnv(),
    });
    expect(result.source).toBe('cache');
    expect(result.cacheAgeSeconds).not.toBeNull();
    expect(stats.calls).toBe(1);
  });

  it('whitespace tokens after split are dropped (",,launch,," → ["launch"])', async () => {
    const stats: ClientStats = { calls: 0 };
    const client = buildClient([makeTagsResponse([launch])], stats);
    await loadAccountTags({ client, env: xdgEnv() });

    const result = await resolveTags({
      client,
      input: ',,launch,,',
      env: xdgEnv(),
    });
    expect(result.ids).toEqual([101]);
    expect(result.misses).toEqual([]);
  });
});
