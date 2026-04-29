import { constants as fsConstants, type Stats } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CacheError } from '../utils/errors.js';

/**
 * Local cache for board metadata, the user directory, and the
 * schema-version pin (`cli-design.md` §8). M3+ reads/writes; M1 ships
 * the primitives so the `cache list/clear/stats` commands can reason
 * over the on-disk state.
 *
 * Invariants:
 *  - Files live under `$XDG_CACHE_HOME/monday-cli/` (or
 *    `~/.cache/monday-cli/` if XDG isn't set), per §8.
 *  - File mode is `0600`. Writes set it explicitly; reads `fstat` and
 *    refuse anything group/world-readable.
 *  - Writes are atomic via `tmp + rename`. A crash mid-write leaves the
 *    previous version in place — never a half-written JSON file.
 *  - Per-profile namespacing is deferred to v0.3+. v0.1 is single-
 *    profile so the layout stays flat.
 *
 * The CLI never writes secrets here; redaction lives elsewhere. The
 * mode rule is belt-and-braces — if a future regression slipped a
 * sensitive field in, the file's still `0600`.
 */

const CACHE_DIR_NAME = 'monday-cli';
const FILE_MODE = 0o600;
const FILE_MODE_MASK = 0o077;
const DEFAULT_TTL_SECONDS = 300;
const CACHE_SCHEMA_VERSION = '1';

export const CACHE_FILE_MODE = FILE_MODE;
export const DEFAULT_CACHE_TTL_SECONDS = DEFAULT_TTL_SECONDS;

export type CacheKey =
  | { readonly kind: 'board'; readonly boardId: string }
  | { readonly kind: 'users' }
  | { readonly kind: 'schemaVersion' };

export interface CacheRootOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

/**
 * Resolves the cache root per `cli-design.md` §8 and the XDG Base
 * Directory spec. Order:
 *  1. `$XDG_CACHE_HOME/monday-cli` when set and non-empty.
 *  2. `<home>/.cache/monday-cli` otherwise.
 *
 * The return is always absolute. We don't create the directory here —
 * `writeEntry` does that lazily so a read-only path (`cache list` on a
 * fresh install) doesn't side-effect.
 */
export const resolveCacheRoot = (options: CacheRootOptions = {}): string => {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const xdg = env.XDG_CACHE_HOME;
  const base =
    xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.cache');
  return resolve(base, CACHE_DIR_NAME);
};

/**
 * Maps a typed cache key to its on-disk relative path. Centralised so
 * every consumer (read/write/clear, plus the M1 commands) agrees on
 * the layout.
 */
export const cacheKeyToRelativePath = (key: CacheKey): string => {
  switch (key.kind) {
    case 'board':
      assertSafeIdentifier(key.boardId, 'board id');
      return join('boards', `${key.boardId}.json`);
    case 'users':
      return join('users', 'index.json');
    case 'schemaVersion':
      return join('schema', 'version.json');
  }
};

const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/u;

const assertSafeIdentifier = (value: string, label: string): void => {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new CacheError(`invalid ${label}: ${JSON.stringify(value)}`, {
      details: { hint: 'cache key segments must match [A-Za-z0-9._-]' },
    });
  }
  // The character class accepts `.` and `..` literally — both are
  // path-traversal sentinels on every common filesystem, and a
  // future caller using `.` / `..` as a cache key would happily
  // resolve to a parent directory. Defence in depth (Codex review
  // suggestion): reject the bare-dots forms even though current
  // M1 callers (board ids via `BoardIdSchema`) can't reach this.
  if (value === '.' || value === '..') {
    throw new CacheError(
      `invalid ${label}: cache key segments may not be "." or "..", got ${JSON.stringify(value)}`,
      { details: { hint: 'use a non-sentinel identifier' } },
    );
  }
};

interface CacheEnvelopeOnDisk<T> {
  /**
   * The schema version of the on-disk envelope. Typed as `string`
   * (not the literal `'1'`) so the runtime guard against forward-
   * incompatible cache files actually narrows. A future bump to `'2'`
   * here means M1's reader treats older files as misses, not crashes.
   */
  readonly schema_version: string;
  readonly created_at: string;
  readonly key: CacheKey;
  readonly data: T;
}

export interface CacheReadResult<T> {
  readonly data: T;
  readonly ageSeconds: number;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface CacheReadOptions {
  /** Override the default 5-minute TTL. */
  readonly ttlSeconds?: number;
  /**
   * Source of "now" for age calculation. Injectable so tests can
   * advance time deterministically without `vi.useFakeTimers()`
   * spreading into other tests.
   */
  readonly now?: () => Date;
}

const wrapFsError = (
  err: unknown,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): CacheError => {
  const cause = err instanceof Error ? err : new Error(String(err));
  return new CacheError(message, { cause, details });
};

const isENOENT = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  return (err as { code?: unknown }).code === 'ENOENT';
};

const ensureSecureDir = async (path: string): Promise<void> => {
  // mkdir respects umask, so the explicit `mode` is advisory on some
  // platforms. Re-apply via chmod so a tightened-after-creation
  // directory doesn't betray cache contents to another user.
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  } catch (err) {
    throw wrapFsError(err, `cannot prepare cache directory ${path}`, {
      path,
    });
  }
};

/**
 * Reads and parses a cache entry. Returns `undefined` on cache miss
 * (file not present or expired). Throws `CacheError` on any other
 * failure (permission too loose, malformed JSON, decode mismatch).
 */
export const readEntry = async <T>(
  root: string,
  key: CacheKey,
  parse: (raw: unknown) => T,
  options: CacheReadOptions = {},
): Promise<CacheReadResult<T> | undefined> => {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const now = (options.now ?? (() => new Date()))();
  const relativePath = cacheKeyToRelativePath(key);
  const fullPath = join(root, relativePath);

  let handle;
  try {
    handle = await open(fullPath, fsConstants.O_RDONLY);
  } catch (err) {
    if (isENOENT(err)) {
      return undefined;
    }
    throw wrapFsError(err, `cannot read cache entry ${relativePath}`, {
      path: fullPath,
    });
  }

  try {
    const stats = await handle.stat();
    if ((stats.mode & FILE_MODE_MASK) !== 0) {
      throw new CacheError(
        `refusing to read cache entry with insecure permissions ${formatMode(stats.mode)}`,
        {
          details: {
            path: fullPath,
            mode: formatMode(stats.mode),
            hint: 'expected mode 0600 — delete and re-fetch',
          },
        },
      );
    }
    const ageSeconds = Math.max(
      0,
      Math.floor((now.getTime() - stats.mtimeMs) / 1000),
    );
    if (ageSeconds > ttlSeconds) {
      return undefined;
    }
    const raw = await handle.readFile('utf8');
    let envelope: CacheEnvelopeOnDisk<unknown>;
    try {
      envelope = JSON.parse(raw) as CacheEnvelopeOnDisk<unknown>;
    } catch (err) {
      throw wrapFsError(err, `malformed cache JSON at ${relativePath}`, {
        path: fullPath,
      });
    }
    if (envelope.schema_version !== CACHE_SCHEMA_VERSION) {
      // Treat a different cache schema as a miss — stale on-disk state
      // shouldn't break a fresh CLI version.
      return undefined;
    }
    const parsed = parse(envelope.data);
    return {
      data: parsed,
      ageSeconds,
      path: fullPath,
      sizeBytes: stats.size,
    };
  } finally {
    await handle.close();
  }
};

/**
 * Writes a cache entry atomically. Sequence:
 *  1. Ensure the parent directory exists with mode `0700`.
 *  2. Write to a tmp sibling with mode `0600`.
 *  3. `rename` over the final path. Atomic on the same filesystem.
 *
 * On any failure the tmp file is best-effort cleaned up so a half-
 * written `.tmp` doesn't accumulate on the next call.
 */
export const writeEntry = async (
  root: string,
  key: CacheKey,
  data: unknown,
): Promise<{ readonly path: string; readonly sizeBytes: number }> => {
  const relativePath = cacheKeyToRelativePath(key);
  const fullPath = join(root, relativePath);
  const dir = dirname(fullPath);

  await ensureSecureDir(root);
  await ensureSecureDir(dir);

  const envelope: CacheEnvelopeOnDisk<unknown> = {
    schema_version: CACHE_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    key,
    data,
  };
  const payload = JSON.stringify(envelope);
  const tmpPath = `${fullPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, payload, { mode: FILE_MODE });
    // Some platforms ignore the `mode` on `writeFile` (umask). Re-
    // chmod explicitly so we never leave the file group/world
    // readable.
    await chmod(tmpPath, FILE_MODE);
    await rename(tmpPath, fullPath);
    return { path: fullPath, sizeBytes: Buffer.byteLength(payload, 'utf8') };
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw wrapFsError(err, `cannot write cache entry ${relativePath}`, {
      path: fullPath,
    });
  }
};

export interface CacheEntryInfo {
  readonly path: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly ageSeconds: number;
  /**
   * Best-effort kind classification. `boards`/`users`/`schema` reflect
   * the layout in §8; an entry that doesn't match any known prefix is
   * surfaced as `other` rather than dropped — agents see exactly what
   * `cache clear` would remove.
   */
  readonly kind: 'boards' | 'users' | 'schema' | 'other';
  readonly id: string | undefined;
}

const classifyEntry = (
  relativePath: string,
): { kind: CacheEntryInfo['kind']; id: string | undefined } => {
  const segments = relativePath.split(sep);
  const [first] = segments;
  if (first === 'boards' && segments.length === 2) {
    const [, file] = segments;
    if (file !== undefined) {
      const id = file.replace(/\.json$/u, '');
      return { kind: 'boards', id };
    }
  }
  if (first === 'users') {
    return { kind: 'users', id: undefined };
  }
  if (first === 'schema') {
    return { kind: 'schema', id: undefined };
  }
  return { kind: 'other', id: undefined };
};

interface ListOptions {
  readonly now?: () => Date;
}

/**
 * Walks the cache root and reports every JSON entry. Returns an empty
 * array (not an error) when the root doesn't exist — `cache list` on
 * a fresh install is a normal state, not a failure.
 */
export const listEntries = async (
  root: string,
  options: ListOptions = {},
): Promise<readonly CacheEntryInfo[]> => {
  const now = (options.now ?? (() => new Date()))();
  let exists = true;
  try {
    await stat(root);
  } catch (err) {
    if (isENOENT(err)) {
      exists = false;
    } else {
      throw wrapFsError(err, `cannot stat cache root ${root}`, { path: root });
    }
  }
  if (!exists) {
    return [];
  }
  const found: CacheEntryInfo[] = [];
  await walk(root, root, found, now);
  // Stable order: sorted by relative path. Spec says agents key off
  // shape; deterministic output is friendlier than insertion order.
  return [...found].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
};

const walk = async (
  root: string,
  current: string,
  out: CacheEntryInfo[],
  now: Date,
): Promise<void> => {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (err) {
    throw wrapFsError(err, `cannot read cache directory ${current}`, {
      path: current,
    });
  }
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out, now);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      // Skip non-file dirents (sockets/symlinks) and non-cache files
      // (a stray README.txt under boards/, etc.). Either case is an
      // un-cataloged on-disk artefact, not something `cache list`
      // should fabricate an entry for.
      continue;
    }
    let stats: Stats;
    try {
      stats = await stat(full);
    } catch (err) {
      throw wrapFsError(err, `cannot stat cache file ${full}`, { path: full });
    }
    const relativePath = relative(root, full);
    const { kind, id } = classifyEntry(relativePath);
    const ageSeconds = Math.max(
      0,
      Math.floor((now.getTime() - stats.mtimeMs) / 1000),
    );
    out.push({
      path: full,
      relativePath,
      sizeBytes: stats.size,
      modifiedAt: new Date(stats.mtimeMs).toISOString(),
      ageSeconds,
      kind,
      id,
    });
  }
};

export interface ClearResult {
  readonly removed: number;
  readonly bytesFreed: number;
}

/**
 * Removes a single entry. Missing → no-op; reports zero removals so
 * `cache clear --board <bid>` against an unknown board doesn't fail.
 */
export const clearEntry = async (
  root: string,
  key: CacheKey,
): Promise<ClearResult> => {
  const fullPath = join(root, cacheKeyToRelativePath(key));
  let stats: Stats;
  try {
    stats = await stat(fullPath);
  } catch (err) {
    if (isENOENT(err)) {
      return { removed: 0, bytesFreed: 0 };
    }
    throw wrapFsError(err, `cannot stat cache entry ${fullPath}`, {
      path: fullPath,
    });
  }
  try {
    await unlink(fullPath);
  } catch (err) {
    throw wrapFsError(err, `cannot remove cache entry ${fullPath}`, {
      path: fullPath,
    });
  }
  return { removed: 1, bytesFreed: stats.size };
};

/**
 * Removes the entire cache root. Used by `monday cache clear` (no
 * flag) and tests. Counts removed JSON files for reporting; the
 * directory tree itself goes too so a follow-up `cache list` reports
 * an empty cache, not phantom directories.
 */
export const clearAll = async (root: string): Promise<ClearResult> => {
  const entries = await listEntries(root);
  if (entries.length === 0) {
    // Nothing to remove; only delete the dir tree if it exists so the
    // `cache list` output stays empty afterwards.
    await rm(root, { recursive: true, force: true });
    return { removed: 0, bytesFreed: 0 };
  }
  const bytesFreed = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  try {
    await rm(root, { recursive: true, force: true });
  } catch (err) {
    throw wrapFsError(err, `cannot clear cache root ${root}`, { path: root });
  }
  return { removed: entries.length, bytesFreed };
};

export interface CacheStats {
  readonly root: string;
  readonly exists: boolean;
  readonly entries: number;
  readonly bytes: number;
  readonly oldestAgeSeconds: number | null;
  readonly newestAgeSeconds: number | null;
}

export const stats = async (
  root: string,
  options: ListOptions = {},
): Promise<CacheStats> => {
  const entries = await listEntries(root, options);
  if (entries.length === 0) {
    // listEntries already threw on EACCES / etc.; reaching here means
    // the root was either missing or present-and-empty. A quick stat
    // distinguishes — any failure (race with `rm`, etc.) is treated
    // as "doesn't exist" rather than re-wrapping into a CacheError.
    const exists = await stat(root).then(
      () => true,
      () => false,
    );
    return {
      root,
      exists,
      entries: 0,
      bytes: 0,
      oldestAgeSeconds: null,
      newestAgeSeconds: null,
    };
  }
  const ages = entries.map((e) => e.ageSeconds);
  return {
    root,
    exists: true,
    entries: entries.length,
    bytes: entries.reduce((sum, e) => sum + e.sizeBytes, 0),
    oldestAgeSeconds: Math.max(...ages),
    newestAgeSeconds: Math.min(...ages),
  };
};

const formatMode = (mode: number): string =>
  `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
