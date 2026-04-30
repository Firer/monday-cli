import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findOne,
  userByEmail,
  userIdFromString,
} from '../../../src/api/resolvers.js';
import type { MondayClient, MondayResponse } from '../../../src/api/client.js';
import { ApiError } from '../../../src/utils/errors.js';

interface NamedThing {
  readonly id: string;
  readonly name: string;
}

const board = (id: string, name: string): NamedThing => ({ id, name });

describe('findOne — exact unique match', () => {
  it('returns the single resource when one matches exactly (NFC-normalised)', () => {
    const haystack: readonly NamedThing[] = [
      board('1', 'Refactor login'),
      board('2', 'Refactor signup'),
    ];
    const result = findOne(haystack, 'Refactor login', (t) => t);
    expect(result.resource.id).toBe('1');
    expect(result.firstOfMany).toBe(false);
  });

  it('NFC-folds composed/decomposed forms before matching', () => {
    const composed = board('1', 'Café roadmap');
    const haystack = [composed];
    const result = findOne(haystack, 'Café roadmap', (t) => t);
    expect(result.resource.id).toBe('1');
  });

  it('case-folds when no NFC-exact match exists', () => {
    const haystack = [board('1', 'Refactor Login')];
    const result = findOne(haystack, 'refactor login', (t) => t);
    expect(result.resource.id).toBe('1');
  });

  it('prefers NFC-exact over case-fold when both exist', () => {
    const haystack = [
      board('5', 'Refactor login'),
      board('1', 'REFACTOR login'),
    ];
    const result = findOne(haystack, 'Refactor login', (t) => t);
    expect(result.resource.id).toBe('5');
  });
});

describe('findOne — case-fold ambiguity', () => {
  it('raises ambiguous_name when multiple case-fold variants exist with no NFC-exact match', () => {
    const haystack = [
      board('1', 'Status'),
      board('2', 'STATUS'),
    ];
    let caught: unknown = undefined;
    try {
      findOne(haystack, 'sTaTuS', (t) => t, { kind: 'board' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'ambiguous_name' });
  });

  it('--first picks the lowest-ID case-fold variant', () => {
    const haystack = [
      board('99', 'Status'),
      board('15', 'STATUS'),
    ];
    const result = findOne(haystack, 'sTaTuS', (t) => t, {
      first: true,
      kind: 'board',
    });
    expect(result.resource.id).toBe('15');
    expect(result.firstOfMany).toBe(true);
  });
});

describe('findOne — multiple matches', () => {
  it('raises ambiguous_name with the candidate list when multi-match', () => {
    const haystack = [
      board('1', 'Refactor login'),
      board('2', 'Refactor login'),
    ];
    let caught: unknown = undefined;
    try {
      findOne(haystack, 'Refactor login', (t) => t, { kind: 'board' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      code: 'ambiguous_name',
      details: {
        query: 'Refactor login',
        kind: 'board',
        candidates: [
          { id: '1', name: 'Refactor login' },
          { id: '2', name: 'Refactor login' },
        ],
      },
    });
  });

  it('--first picks the lowest-ID match deterministically', () => {
    const haystack = [
      board('200', 'Refactor login'),
      board('15', 'Refactor login'),
    ];
    const result = findOne(haystack, 'Refactor login', (t) => t, { first: true });
    expect(result.resource.id).toBe('15');
    expect(result.firstOfMany).toBe(true);
  });

  it('--first uses lexicographic tiebreak when IDs are same length', () => {
    const haystack = [
      board('100', 'X'),
      board('99', 'X'),
    ];
    const result = findOne(haystack, 'X', (t) => t, { first: true });
    // 99 has fewer digits so it wins length-first.
    expect(result.resource.id).toBe('99');
  });
});

describe('findOne — zero matches', () => {
  it('raises not_found with the original query', () => {
    const haystack = [board('1', 'Refactor login')];
    let caught: unknown = undefined;
    try {
      findOne(haystack, 'Refactor signup', (t) => t, { kind: 'board' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      code: 'not_found',
      details: { query: 'Refactor signup', kind: 'board' },
    });
  });

  it('raises usage_error on empty query', () => {
    expect(() => findOne([], '   ', (t: NamedThing) => t)).toThrow(
      expect.objectContaining({ code: 'usage_error' }) as Error,
    );
  });
});

describe('userIdFromString', () => {
  it('returns the branded UserId for a numeric string', () => {
    expect(userIdFromString('42')).toBe('42');
  });

  it('throws internal_error for a non-numeric id', () => {
    expect(() => userIdFromString('abc')).toThrow(
      expect.objectContaining({ code: 'internal_error' }) as Error,
    );
  });
});

let tmpRoot: string;
const xdgEnv = (): NodeJS.ProcessEnv => ({ XDG_CACHE_HOME: tmpRoot });

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-resolvers-'));
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
      return Promise.resolve({
        data: next as T,
        complexity: null,
        stats: { attempts: 1, totalSleepMs: 0 },
      });
    },
  };
  return fake as unknown as MondayClient;
};

describe('userByEmail — directory cache + live fallback', () => {
  const alice = { id: '1', name: 'Alice', email: 'alice@example.test' };
  const bob = { id: '2', name: 'Bob', email: 'bob@example.test' };

  it('returns from live + writes to cache on first call', async () => {
    const stats = { calls: 0 };
    const client = buildClient([{ users: [alice] }], stats);
    const result = await userByEmail({
      client,
      email: 'alice@example.test',
      env: xdgEnv(),
    });
    expect(result.source).toBe('live');
    expect(result.user.id).toBe('1');
    expect(stats.calls).toBe(1);
  });

  it('serves from cache on the second call', async () => {
    const stats = { calls: 0 };
    const client = buildClient(
      [{ users: [alice] }, { users: [alice] }],
      stats,
    );
    await userByEmail({ client, email: 'alice@example.test', env: xdgEnv() });
    const cached = await userByEmail({
      client,
      email: 'alice@example.test',
      env: xdgEnv(),
    });
    expect(cached.source).toBe('cache');
    expect(stats.calls).toBe(1);
  });

  it('matches case-insensitively (NFC + case-fold)', async () => {
    const stats = { calls: 0 };
    const client = buildClient([{ users: [alice] }], stats);
    const result = await userByEmail({
      client,
      email: 'ALICE@example.test',
      env: xdgEnv(),
    });
    expect(result.user.id).toBe('1');
  });

  it('raises user_not_found when Monday returns no matching user', async () => {
    const stats = { calls: 0 };
    const client = buildClient([{ users: [] }], stats);
    await expect(
      userByEmail({ client, email: 'nobody@example.test', env: xdgEnv() }),
    ).rejects.toMatchObject({
      code: 'user_not_found',
      details: { email: 'nobody@example.test' },
    });
  });

  it('upserts the cache so future lookups for a different email hit the cache', async () => {
    const stats = { calls: 0 };
    const client = buildClient(
      [{ users: [alice] }, { users: [bob] }],
      stats,
    );
    await userByEmail({ client, email: alice.email, env: xdgEnv() });
    await userByEmail({ client, email: bob.email, env: xdgEnv() });
    expect(stats.calls).toBe(2);
    const cachedAgain = await userByEmail({
      client,
      email: alice.email,
      env: xdgEnv(),
    });
    expect(cachedAgain.source).toBe('cache');
    expect(stats.calls).toBe(2);
  });

  it('falls through to live fetch when the cache read raises (corrupt entry)', async () => {
    const stats = { calls: 0 };
    // Pre-fill the cache with a malformed payload so the parser
    // rejects it on read.
    const { writeEntry } = await import('../../../src/api/cache.js');
    const root = `${tmpRoot}/monday-cli`;
    await writeEntry(root, { kind: 'users' }, [{ wrong: 'shape' }]);
    const client = buildClient([{ users: [alice] }], stats);
    const result = await userByEmail({
      client,
      email: alice.email,
      env: xdgEnv(),
    });
    expect(stats.calls).toBe(1);
    expect(result.source).toBe('live');
  });

  it.each([
    ['hex-prefixed', '0x2a'],
    ['scientific notation', '1e3'],
    ['signed', '-1'],
    ['decimal', '1.5'],
    ['leading zeros', '00042'],
    ['empty string', ''],
    ['trailing whitespace', '42 '],
    ['letter-mixed', '42abc'],
  ])(
    'rejects malformed live user IDs (%s: %j) — schema enforces decimal non-negative',
    async (_label, malformedId) => {
      // Codex review pass-2 finding F4: pre-fix, userByEmail's
      // `id: z.string().min(1)` schema let malformed IDs into the
      // directory cache where they'd silently corrupt every later
      // consumer's `Number(id)` conversion. The translator's
      // defence-in-depth helper (parsePeopleInput's
      // DECIMAL_USER_ID_PATTERN check) catches the wire path, but the
      // cache poisoning would still affect any future consumer.
      // Tightened the schema to use the same regex; pin via test
      // that malformed IDs from the live fetch fail to parse.
      const stats = { calls: 0 };
      const client = buildClient(
        [{ users: [{ ...alice, id: malformedId }] }],
        stats,
      );
      // R17 (post-people Codex backlog): the parse boundary now
      // wraps ZodError as ApiError(internal_error) carrying
      // `details.issues`. Pre-R17, a raw ZodError bubbled to the
      // runner's catch-all (which DID map to internal_error but lost
      // the issues array). Assert the typed wrap so an agent
      // debugging a malformed Monday response sees the path that
      // failed.
      let thrown: unknown;
      try {
        await userByEmail({ client, email: alice.email, env: xdgEnv() });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      const apiErr = thrown as ApiError;
      expect(apiErr.code).toBe('internal_error');
      expect(apiErr.message).toMatch(/malformed users response/u);
      const details = apiErr.details as { issues: readonly { path: string }[] };
      expect(details.issues.length).toBeGreaterThan(0);
      // Issue path includes `id` so an agent debugging this can
      // identify the failing field at a glance.
      expect(details.issues.some((i) => i.path.endsWith('id'))).toBe(true);
    },
  );

  it('accepts valid live user IDs (0, 1, 42, MAX_SAFE_INTEGER)', async () => {
    // Pin both sides of the boundary so a future "non-zero only"
    // tightening doesn't silently reject the system-user ID slot.
    for (const id of ['0', '1', '42', String(Number.MAX_SAFE_INTEGER)]) {
      const stats = { calls: 0 };
      const client = buildClient([{ users: [{ ...alice, id }] }], stats);
      const result = await userByEmail({
        client,
        email: alice.email,
        env: xdgEnv(),
        noCache: true,
      });
      expect(result.user.id).toBe(id);
    }
  });

  it('--noCache bypasses both cache layers', async () => {
    const stats = { calls: 0 };
    const client = buildClient(
      [{ users: [alice] }, { users: [alice] }],
      stats,
    );
    await userByEmail({ client, email: alice.email, env: xdgEnv() });
    await userByEmail({
      client,
      email: alice.email,
      env: xdgEnv(),
      noCache: true,
    });
    expect(stats.calls).toBe(2);
  });
});
