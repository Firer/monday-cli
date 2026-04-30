import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_FILE_MODE,
  DEFAULT_CACHE_TTL_SECONDS,
  cacheKeyToRelativePath,
  clearAll,
  clearEntry,
  listEntries,
  readEntry,
  resolveCacheRoot,
  stats,
  writeEntry,
  type CacheEntryInfo,
  type CacheKey,
} from '../../../src/api/cache.js';
import { CacheError } from '../../../src/utils/errors.js';

describe('resolveCacheRoot', () => {
  it('uses XDG_CACHE_HOME when set', () => {
    expect(
      resolveCacheRoot({ env: { XDG_CACHE_HOME: '/xdg' }, home: '/home/nick' }),
    ).toBe('/xdg/monday-cli');
  });

  it('falls back to <home>/.cache when XDG is unset', () => {
    expect(resolveCacheRoot({ env: {}, home: '/home/nick' })).toBe(
      '/home/nick/.cache/monday-cli',
    );
  });

  it('treats empty XDG_CACHE_HOME as unset', () => {
    expect(
      resolveCacheRoot({ env: { XDG_CACHE_HOME: '' }, home: '/home/nick' }),
    ).toBe('/home/nick/.cache/monday-cli');
  });

  it('always returns an absolute path', () => {
    const result = resolveCacheRoot({
      env: { XDG_CACHE_HOME: 'rel/cache' },
      home: '/home/nick',
    });
    // Resolved against cwd; we don't care about the prefix, only that
    // it's absolute (which `resolve()` guarantees).
    expect(result.startsWith('/')).toBe(true);
    expect(result.endsWith('/monday-cli')).toBe(true);
  });
});

describe('cacheKeyToRelativePath', () => {
  it('maps board keys', () => {
    expect(cacheKeyToRelativePath({ kind: 'board', boardId: '12345' })).toBe(
      'boards/12345.json',
    );
  });

  it('maps users key', () => {
    expect(cacheKeyToRelativePath({ kind: 'users' })).toBe('users/index.json');
  });

  it('maps schemaVersion key', () => {
    expect(cacheKeyToRelativePath({ kind: 'schemaVersion' })).toBe(
      'schema/version.json',
    );
  });

  it('rejects unsafe board ids', () => {
    expect(() =>
      cacheKeyToRelativePath({ kind: 'board', boardId: '../etc/passwd' }),
    ).toThrow(CacheError);
    expect(() =>
      cacheKeyToRelativePath({ kind: 'board', boardId: '1/2' }),
    ).toThrow(/invalid board id/u);
  });

  it('rejects the bare-dot path-traversal sentinels', () => {
    // Codex review suggestion: the safe-identifier regex allows `.`
    // and `..` literally because `.` is in the character class.
    // Belt-and-braces reject the sentinels so a future caller
    // can't accidentally cause traversal into the cache parent.
    expect(() =>
      cacheKeyToRelativePath({ kind: 'board', boardId: '.' }),
    ).toThrow(/may not be/u);
    expect(() =>
      cacheKeyToRelativePath({ kind: 'board', boardId: '..' }),
    ).toThrow(/may not be/u);
  });
});

describe('readEntry / writeEntry round-trip', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'monday-cli-cache-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const key: CacheKey = { kind: 'board', boardId: '7' };

  it('writes mode 0600 and round-trips data', async () => {
    const before = Date.now();
    const result = await writeEntry(root, key, { columns: [{ id: 'a' }] });
    expect(result.path.endsWith('boards/7.json')).toBe(true);

    const fileStat = await stat(result.path);
    expect(fileStat.mode & 0o777).toBe(CACHE_FILE_MODE);

    const read = await readEntry(root, key, (raw) => raw, {
      now: () => new Date(before + 5_000),
    });
    expect(read).not.toBeUndefined();
    expect(read?.data).toEqual({ columns: [{ id: 'a' }] });
    expect(read?.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(read?.sizeBytes).toBe(result.sizeBytes);
  });

  it('returns undefined for a missing file', async () => {
    const result = await readEntry(root, key, (raw) => raw);
    expect(result).toBeUndefined();
  });

  it('returns undefined when entry exceeds TTL', async () => {
    await writeEntry(root, key, { ok: true });
    // Backdate the file's mtime so the age computation crosses TTL.
    const path = join(root, cacheKeyToRelativePath(key));
    const stale = new Date(Date.now() - (DEFAULT_CACHE_TTL_SECONDS + 60) * 1000);
    await utimes(path, stale, stale);
    const result = await readEntry(root, key, (raw) => raw);
    expect(result).toBeUndefined();
  });

  it('returns the entry when age is exactly at the TTL boundary', async () => {
    await writeEntry(root, key, { ok: true });
    const path = join(root, cacheKeyToRelativePath(key));
    const exactlyTtl = new Date(Date.now() - DEFAULT_CACHE_TTL_SECONDS * 1000);
    await utimes(path, exactlyTtl, exactlyTtl);
    const result = await readEntry(root, key, (raw) => raw);
    expect(result).not.toBeUndefined();
  });

  it('honours an explicit ttlSeconds override', async () => {
    const { path } = await writeEntry(root, key, { ok: true });
    // Pin mtime so `now - mtime` is deterministic. Without this the
    // assertion races: on slow CI the fs-recorded mtime can land
    // milliseconds *after* the in-process Date.now() the test reads,
    // making the floor land on 0 and `0 > 0` (the staleness check)
    // return the entry instead of undefined.
    const fixedMtime = new Date('2026-01-01T00:00:00.000Z');
    await utimes(path, fixedMtime, fixedMtime);
    const result = await readEntry(root, key, (raw) => raw, {
      ttlSeconds: 0,
      now: () => new Date(fixedMtime.getTime() + 1_000),
    });
    expect(result).toBeUndefined();
  });

  it('refuses to read a cache file with insecure permissions', async () => {
    const result = await writeEntry(root, key, { ok: true });
    await chmod(result.path, 0o644);
    await expect(readEntry(root, key, (raw) => raw)).rejects.toBeInstanceOf(CacheError);
    await expect(readEntry(root, key, (raw) => raw)).rejects.toThrow(
      /insecure permissions/u,
    );
  });

  it('treats a malformed JSON file as a CacheError', async () => {
    const path = join(root, cacheKeyToRelativePath(key));
    await mkdir(join(root, 'boards'), { recursive: true, mode: 0o700 });
    await writeFile(path, '{not json', { mode: CACHE_FILE_MODE });
    await chmod(path, CACHE_FILE_MODE);
    await expect(readEntry(root, key, (raw) => raw)).rejects.toThrow(
      /malformed cache JSON/u,
    );
  });

  it('treats a different schema_version as a miss (not a crash)', async () => {
    const path = join(root, cacheKeyToRelativePath(key));
    await mkdir(join(root, 'boards'), { recursive: true, mode: 0o700 });
    const future = JSON.stringify({
      schema_version: '2',
      created_at: new Date().toISOString(),
      key,
      data: { ok: true },
    });
    await writeFile(path, future, { mode: CACHE_FILE_MODE });
    await chmod(path, CACHE_FILE_MODE);
    const result = await readEntry(root, key, (raw) => raw);
    expect(result).toBeUndefined();
  });

  it('runs the parse callback so callers can validate the payload shape', async () => {
    await writeEntry(root, key, { value: 42 });
    const parsed = await readEntry(root, key, (raw) => {
      const obj = raw as { value: number };
      return obj.value;
    });
    expect(parsed?.data).toBe(42);
  });

  it('atomically replaces an existing entry', async () => {
    await writeEntry(root, key, { v: 1 });
    await writeEntry(root, key, { v: 2 });
    const read = await readEntry(root, key, (raw) => raw);
    expect(read?.data).toEqual({ v: 2 });
  });

  it('wraps fs failures in CacheError when the write target is invalid', async () => {
    const badRoot = join(root, 'definitely-not-a-dir');
    await writeFile(badRoot, 'a file blocking the dir', { mode: 0o600 });
    await expect(writeEntry(badRoot, key, { v: 1 })).rejects.toBeInstanceOf(
      CacheError,
    );
  });
});

describe('listEntries', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'monday-cli-cache-list-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns [] when the root does not exist', async () => {
    const result = await listEntries(join(root, 'never-created'));
    expect(result).toEqual([]);
  });

  it('returns [] when the root is empty', async () => {
    const result = await listEntries(root);
    expect(result).toEqual([]);
  });

  it('classifies known kinds and returns sorted entries', async () => {
    await writeEntry(root, { kind: 'board', boardId: '1' }, {});
    await writeEntry(root, { kind: 'board', boardId: '22' }, {});
    await writeEntry(root, { kind: 'users' }, {});
    await writeEntry(root, { kind: 'schemaVersion' }, {});

    // An unknown layout under the cache root — must surface as 'other'.
    const otherDir = join(root, 'misc');
    await mkdir(otherDir, { recursive: true, mode: 0o700 });
    await writeFile(join(otherDir, 'rogue.json'), '{}', { mode: 0o600 });

    const found = await listEntries(root);
    expect(found.map((e) => e.relativePath)).toEqual([
      'boards/1.json',
      'boards/22.json',
      'misc/rogue.json',
      'schema/version.json',
      'users/index.json',
    ]);
    const byKind = found.reduce<Record<string, CacheEntryInfo>>((acc, e) => {
      acc[e.relativePath] = e;
      return acc;
    }, {});
    expect(byKind['boards/1.json']?.kind).toBe('boards');
    expect(byKind['boards/1.json']?.id).toBe('1');
    expect(byKind['users/index.json']?.kind).toBe('users');
    expect(byKind['users/index.json']?.id).toBeUndefined();
    expect(byKind['schema/version.json']?.kind).toBe('schema');
    expect(byKind['misc/rogue.json']?.kind).toBe('other');
  });

  it('skips non-json files', async () => {
    await writeEntry(root, { kind: 'board', boardId: '1' }, {});
    await writeFile(join(root, 'boards', 'README.txt'), 'ignore me', {
      mode: 0o600,
    });
    const found = await listEntries(root);
    expect(found.map((e) => e.relativePath)).toEqual(['boards/1.json']);
  });

  it('uses the injected clock for ageSeconds', async () => {
    const { path } = await writeEntry(root, { kind: 'users' }, {});
    // Pin mtime: the floor((future - mtime) / 1000) calculation flakes
    // on CI when fs mtime trails Date.now() by a few ms (race between
    // writeFile completion and the Date.now() the test captures).
    // Setting mtime explicitly removes that source of jitter.
    const fixedMtime = new Date('2026-01-01T00:00:00.000Z');
    await utimes(path, fixedMtime, fixedMtime);
    const future = new Date(fixedMtime.getTime() + 60_000);
    const found = await listEntries(root, { now: () => future });
    expect(found[0]?.ageSeconds).toBe(60);
  });

  it('wraps readdir EACCES failures into CacheError', async () => {
    const sealed = join(root, 'sealed-readdir');
    await mkdir(sealed, { recursive: true, mode: 0o700 });
    await writeEntry(sealed, { kind: 'board', boardId: '1' }, {});
    const boardsDir = join(sealed, 'boards');
    // 0o000 denies read permission so readdir fails with EACCES.
    await chmod(boardsDir, 0o000);
    try {
      await expect(listEntries(sealed)).rejects.toBeInstanceOf(CacheError);
    } finally {
      await chmod(boardsDir, 0o700);
    }
  });

  it('wraps non-ENOENT root stat failures into CacheError', async () => {
    const sealed = join(root, 'sealed-stat-root');
    await mkdir(sealed, { recursive: true, mode: 0o700 });
    const inside = join(sealed, 'inside');
    await mkdir(inside, { recursive: true, mode: 0o700 });
    // Drop search permission on the parent so stat() of `inside`
    // fails with EACCES rather than ENOENT.
    await chmod(sealed, 0o000);
    try {
      await expect(listEntries(inside)).rejects.toBeInstanceOf(CacheError);
    } finally {
      await chmod(sealed, 0o700);
    }
  });
});

describe('clearEntry / clearAll', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'monday-cli-cache-clear-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('clearEntry removes a single file and reports bytes freed', async () => {
    const { sizeBytes } = await writeEntry(root, { kind: 'board', boardId: '1' }, { v: 1 });
    const result = await clearEntry(root, { kind: 'board', boardId: '1' });
    expect(result.removed).toBe(1);
    expect(result.bytesFreed).toBe(sizeBytes);
    await expect(stat(join(root, 'boards/1.json'))).rejects.toThrow();
  });

  it('clearEntry on a missing file reports zero', async () => {
    const result = await clearEntry(root, { kind: 'board', boardId: '999' });
    expect(result).toEqual({ removed: 0, bytesFreed: 0 });
  });

  it('clearAll on an empty cache reports zero', async () => {
    const result = await clearAll(root);
    expect(result).toEqual({ removed: 0, bytesFreed: 0 });
  });

  it('clearAll removes every entry and the root directory', async () => {
    await writeEntry(root, { kind: 'board', boardId: '1' }, {});
    await writeEntry(root, { kind: 'users' }, {});
    const result = await clearAll(root);
    expect(result.removed).toBe(2);
    expect(result.bytesFreed).toBeGreaterThan(0);
    await expect(stat(root)).rejects.toThrow();
  });

  it('clearAll on a never-created root is a no-op', async () => {
    const result = await clearAll(join(root, 'never-existed'));
    expect(result).toEqual({ removed: 0, bytesFreed: 0 });
  });

  it('clearEntry surfaces non-ENOENT stat failures as CacheError', async () => {
    const sealed = join(root, 'sealed');
    await mkdir(sealed, { recursive: true, mode: 0o700 });
    await writeEntry(sealed, { kind: 'board', boardId: '1' }, {});
    // Drop search permission on the parent so stat() fails with EACCES.
    await chmod(sealed, 0o000);
    try {
      await expect(
        clearEntry(sealed, { kind: 'board', boardId: '1' }),
      ).rejects.toBeInstanceOf(CacheError);
    } finally {
      await chmod(sealed, 0o700);
    }
  });

  it('clearEntry surfaces unlink failures as CacheError', async () => {
    const sealed = join(root, 'sealed-unlink');
    await mkdir(sealed, { recursive: true, mode: 0o700 });
    const { path } = await writeEntry(sealed, { kind: 'board', boardId: '2' }, {});
    // Lock the parent dir so unlink() fails (the file itself is mode 0600
    // and stat() works because we statted before the chmod ran).
    await chmod(join(sealed, 'boards'), 0o500);
    try {
      // stat() succeeds on a 0o500 dir (we have read+exec); unlink fails.
      await expect(
        clearEntry(sealed, { kind: 'board', boardId: '2' }),
      ).rejects.toBeInstanceOf(CacheError);
      // Still there.
      await expect(stat(path)).resolves.toBeDefined();
    } finally {
      await chmod(join(sealed, 'boards'), 0o700);
    }
  });

  it('clearAll surfaces rm failures as CacheError', async () => {
    const sealed = join(root, 'sealed-rm');
    await mkdir(sealed, { recursive: true, mode: 0o700 });
    await writeEntry(sealed, { kind: 'users' }, { v: 1 });
    // Make the cache root read-only so the recursive rm of its
    // contents fails. listEntries succeeded earlier (because we have
    // read+exec) — the failure happens inside the actual rm().
    await chmod(sealed, 0o500);
    try {
      await expect(clearAll(sealed)).rejects.toBeInstanceOf(CacheError);
    } finally {
      await chmod(sealed, 0o700);
    }
  });
});

describe('stats', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'monday-cli-cache-stats-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports an empty cache with exists:true when only the root is present', async () => {
    await mkdir(root, { recursive: true });
    const result = await stats(root);
    expect(result.exists).toBe(true);
    expect(result.entries).toBe(0);
    expect(result.bytes).toBe(0);
    expect(result.oldestAgeSeconds).toBeNull();
    expect(result.newestAgeSeconds).toBeNull();
  });

  it('reports exists:false when the root has never existed', async () => {
    const result = await stats(join(root, 'never-existed'));
    expect(result.exists).toBe(false);
    expect(result.entries).toBe(0);
  });

  it('aggregates totals and ages across entries', async () => {
    const e1 = await writeEntry(root, { kind: 'board', boardId: '1' }, { v: 1 });
    const e2 = await writeEntry(root, { kind: 'users' }, { v: 2 });
    // Pin both files' mtime so the age arithmetic is deterministic;
    // see the listEntries injected-clock test for why this matters on
    // CI runners with fs mtime / Date.now() drift.
    const fixedMtime = new Date('2026-01-01T00:00:00.000Z');
    await utimes(e1.path, fixedMtime, fixedMtime);
    await utimes(e2.path, fixedMtime, fixedMtime);
    const result = await stats(root, {
      now: () => new Date(fixedMtime.getTime() + 30_000),
    });
    expect(result.entries).toBe(2);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.oldestAgeSeconds).toBe(30);
    expect(result.newestAgeSeconds).toBe(30);
  });

});
