/**
 * Name-resolution helpers (`v0.1-plan.md` §3 M3, `cli-design.md` §5.7).
 *
 * Two surfaces:
 *
 *   - `findOne(scope, name)` — single-source-of-truth for the
 *     `find` verb. Returns the unique match; raises
 *     `ambiguous_name` with `details.candidates` on a multi-match;
 *     `not_found` on zero. `--first` opts into "lowest ID wins"
 *     (rarely the right call for agents; humans use it). M3 wires
 *     `monday board find`; M4 wires `monday item find`. The matching
 *     logic is intentionally NFC-aware + case-fold to match §5.3's
 *     column rules — agents learning one rule shouldn't have to
 *     learn a different one for names.
 *
 *   - `userByEmail(client, email)` — directory lookup with a
 *     `users(emails: [...])` fallback. M3 doesn't actually call
 *     this from a command (read-only `user list/get/me` operate by
 *     ID or whoami), but the function is needed by M5a's
 *     `--set Owner=alice@example.com` value translator. Lives here
 *     because email→ID resolution is the same lookup users make from
 *     two different feature surfaces. The user-directory cache
 *     (`api/cache.ts users` key) ships alongside.
 *
 * **NFC + case-fold for names.** Same rule as §5.3 step 2: NFC
 * normalise, trim, collapse internal whitespace, case-fold (Unicode-
 * aware, locale-independent). Keeps "Status" / "Status " /
 * "STATUS" / "Café" / "Café" all matching the same target.
 */

import { z } from 'zod';
import { ApiError, UsageError } from '../utils/errors.js';
import {
  readEntry,
  resolveCacheRoot,
  writeEntry,
  DEFAULT_CACHE_TTL_SECONDS,
} from './cache.js';
import type { MondayClient } from './client.js';
import { DECIMAL_USER_ID_PATTERN, type UserId } from '../types/ids.js';

const normalise = (s: string): string =>
  s.normalize('NFC').trim().replace(/\s+/gu, ' ');

const caseFold = (s: string): string => s.toLocaleLowerCase('und');

const normaliseFold = (s: string): string => caseFold(normalise(s));

export interface FindOneCandidate<T> {
  readonly id: string;
  readonly name: string;
  readonly resource: T;
}

export interface FindOneOptions {
  /**
   * On multiple matches, return the candidate with the lexicographically
   * lowest ID (numeric IDs string-compare correctly because both sides
   * are decimal strings of the same length when from the same kind).
   * Default false — multi-match raises `ambiguous_name` with
   * `details.candidates`.
   */
  readonly first?: boolean;
  /**
   * Display name for the resource kind in error messages
   * (`"board"`, `"item"`, …). Default `"resource"`.
   */
  readonly kind?: string;
}

export interface FindOneResult<T> {
  readonly resource: T;
  /**
   * `true` when `--first` selected one of multiple matches.
   * Commands surface this as a `warnings: [{ code: 'first_of_many' }]`
   * entry so the caller knows the resolution was non-unique.
   */
  readonly firstOfMany: boolean;
  /**
   * The full candidate set. Useful for the warning payload and for
   * future debug output; not normally rendered.
   */
  readonly candidates: readonly FindOneCandidate<T>[];
}

/**
 * Picks the single resource whose name matches `query`. Pure
 * function — caller passes in the haystack (e.g. all visible
 * boards) and the projector that extracts `{id, name}` from each.
 *
 * Three matching passes, exactly mirroring §5.3 step 2:
 *   1. NFC-normalised exact name.
 *   2. NFC + case-fold name.
 * Step 1 wins over step 2; multiple matches in either pass raise
 * `ambiguous_name` (unless `--first` is set).
 */
export const findOne = <T>(
  haystack: readonly T[],
  query: string,
  project: (t: T) => { readonly id: string; readonly name: string },
  options: FindOneOptions = {},
): FindOneResult<T> => {
  const kind = options.kind ?? 'resource';
  const target = normalise(query);
  if (target.length === 0) {
    throw new UsageError(`find ${kind}: query must be a non-empty name`);
  }

  const projected: readonly FindOneCandidate<T>[] = haystack.map((t) => {
    const p = project(t);
    return { id: p.id, name: p.name, resource: t };
  });

  const exact = projected.filter((c) => normalise(c.name) === target);
  if (exact.length === 1) {
    const [only] = exact;
    if (only !== undefined) {
      return { resource: only.resource, firstOfMany: false, candidates: exact };
    }
  }
  if (exact.length > 1) {
    return resolveMulti(exact, query, kind, options.first ?? false);
  }

  const folded = caseFold(target);
  const fuzzy = projected.filter((c) => caseFold(normalise(c.name)) === folded);
  if (fuzzy.length === 1) {
    const [only] = fuzzy;
    if (only !== undefined) {
      return { resource: only.resource, firstOfMany: false, candidates: fuzzy };
    }
  }
  if (fuzzy.length > 1) {
    return resolveMulti(fuzzy, query, kind, options.first ?? false);
  }

  throw new ApiError(
    'not_found',
    `No ${kind} matches name ${JSON.stringify(query)}`,
    { details: { query, kind } },
  );
};

const resolveMulti = <T>(
  matches: readonly FindOneCandidate<T>[],
  query: string,
  kind: string,
  first: boolean,
): FindOneResult<T> => {
  if (first) {
    // Lowest ID wins — string-compares fine for same-kind numeric
    // IDs because both sides are decimal strings of equal length.
    // Fall back to localeCompare on length-mismatched IDs so we
    // pick a deterministic winner even when the assumption breaks.
    const sorted = [...matches].sort((a, b) =>
      a.id.length === b.id.length
        ? a.id.localeCompare(b.id)
        : a.id.length - b.id.length,
    );
    const [winner] = sorted;
    /* c8 ignore next 8 — defensive: caller passes non-empty `matches`,
       so `sorted[0]` is always defined. Guard exists for
       `noUncheckedIndexedAccess` narrowing. */
    if (winner === undefined) {
      throw new ApiError(
        'not_found',
        `No ${kind} matches name ${JSON.stringify(query)}`,
        { details: { query, kind } },
      );
    }
    return {
      resource: winner.resource,
      firstOfMany: true,
      candidates: matches,
    };
  }
  throw new ApiError(
    'ambiguous_name',
    `Name ${JSON.stringify(query)} matches ${String(matches.length)} ${kind}s; ` +
      `pass --first to pick the lowest-ID match or call \`${kind} get <id>\`.`,
    {
      details: {
        query,
        kind,
        candidates: matches.map((c) => ({ id: c.id, name: c.name })),
      },
    },
  );
};

// ---------------------------------------------------------------------
// userByEmail — directory cache + users(emails:) fallback
// ---------------------------------------------------------------------

/**
 * User-directory entry shape. The `id` field is constrained to a
 * decimal non-negative integer string (`0`, `42`, `1234567`) — not
 * just any non-empty string — because callers (M5a's people
 * translator, future commands) eventually convert it to a JS number
 * for wire payloads. Loose `z.string().min(1)` would let `"0x2a"` /
 * `"1e3"` / `"42 "` into the directory cache where they'd silently
 * corrupt every later consumer's `Number(id)` conversion.
 *
 * The validating regex (`DECIMAL_USER_ID_PATTERN`, `src/types/
 * ids.ts`) is also imported by `api/people.ts`'s `idStringToNumber`
 * for a defence-in-depth check at the translator boundary — same
 * rule, two layers (R16 consolidated the two prior verbatim copies
 * onto a single source of truth).
 */
const userDirectoryEntrySchema = z
  .object({
    id: z.string().regex(DECIMAL_USER_ID_PATTERN, {
      message: 'user id must be a decimal non-negative integer string',
    }),
    name: z.string(),
    email: z.string(),
  })
  .strict();

const userDirectorySchema = z.array(userDirectoryEntrySchema);

export type UserDirectoryEntry = z.infer<typeof userDirectoryEntrySchema>;

const USERS_BY_EMAIL_QUERY = `
  query UsersByEmail($emails: [String!]) {
    users(emails: $emails, limit: 100) {
      id
      name
      email
    }
  }
`;

interface UsersResponse {
  readonly users: readonly { readonly id: string; readonly name: string; readonly email: string }[] | null;
}

export interface UserByEmailInputs {
  readonly client: MondayClient;
  readonly email: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly noCache?: boolean;
}

export interface UserByEmailResult {
  readonly user: UserDirectoryEntry;
  readonly source: 'cache' | 'live';
  readonly cacheAgeSeconds: number | null;
}

const readDirectoryCache = async (
  env: NodeJS.ProcessEnv,
): Promise<{ readonly entries: readonly UserDirectoryEntry[]; readonly ageSeconds: number } | undefined> => {
  const root = resolveCacheRoot({ env });
  try {
    const hit = await readEntry<readonly UserDirectoryEntry[]>(
      root,
      { kind: 'users' },
      (raw) => userDirectorySchema.parse(raw),
      { ttlSeconds: DEFAULT_CACHE_TTL_SECONDS },
    );
    if (hit === undefined) return undefined;
    return { entries: hit.data, ageSeconds: hit.ageSeconds };
  } catch {
    return undefined;
  }
};

const writeDirectoryCache = async (
  env: NodeJS.ProcessEnv,
  entries: readonly UserDirectoryEntry[],
): Promise<void> => {
  const root = resolveCacheRoot({ env });
  try {
    await writeEntry(root, { kind: 'users' }, entries);
  } catch {
    // Best-effort — cache write failures don't block the lookup.
  }
};

const upsertCache = async (
  env: NodeJS.ProcessEnv,
  fresh: readonly UserDirectoryEntry[],
): Promise<void> => {
  const existing = await readDirectoryCache(env);
  const byId = new Map<string, UserDirectoryEntry>();
  for (const entry of existing?.entries ?? []) {
    byId.set(entry.id, entry);
  }
  for (const entry of fresh) {
    byId.set(entry.id, entry);
  }
  await writeDirectoryCache(env, [...byId.values()]);
};

const matchInCache = (
  entries: readonly UserDirectoryEntry[],
  email: string,
): UserDirectoryEntry | undefined => {
  const target = normaliseFold(email);
  return entries.find((e) => normaliseFold(e.email) === target);
};

/**
 * Looks up a user by email. Prefers the local user-directory cache;
 * on miss, calls `users(emails: [...])` and folds the result back
 * into the cache. Unknown email → `user_not_found` with the
 * unmatched email in `details`.
 *
 * Email matching is NFC + case-fold so `Alice@Example.COM` and
 * `alice@example.com` resolve identically.
 */
export const userByEmail = async (
  inputs: UserByEmailInputs,
): Promise<UserByEmailResult> => {
  /* c8 ignore next — defensive fallback; tests always pass `env`. */
  const env = inputs.env ?? process.env;
  const noCache = inputs.noCache ?? false;

  if (!noCache) {
    const cached = await readDirectoryCache(env);
    if (cached !== undefined) {
      const hit = matchInCache(cached.entries, inputs.email);
      if (hit !== undefined) {
        return { user: hit, source: 'cache', cacheAgeSeconds: cached.ageSeconds };
      }
    }
  }

  const response = await inputs.client.raw<UsersResponse>(
    USERS_BY_EMAIL_QUERY,
    { emails: [inputs.email] },
    { operationName: 'UsersByEmail' },
  );
  const users = response.data.users ?? [];
  // R17: parse-then-wrap. Per `validation.md`'s "Never bubble raw
  // ZodError out of a parse boundary" rule, malformed Monday
  // responses (e.g. a future tenant where `id` is a hex string)
  // surface as a typed `internal_error` carrying `details.issues`
  // rather than a bare ZodError. Pre-R17, the raw ZodError reached
  // the runner's catch-all which DID map to `internal_error` (the
  // right semantic code) but lost the issues array — agents
  // debugging a malformed Monday response saw only the bare
  // message. The newly-tightened `id` regex (R-people pass-2 F4)
  // makes this surface more reachable: every malformed ID from
  // Monday now hits this boundary instead of silently caching.
  const parsed = userDirectorySchema.safeParse(users);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }));
    throw new ApiError(
      'internal_error',
      `Monday returned a malformed users response for email ` +
        `${JSON.stringify(inputs.email)} — the directory schema rejected ` +
        `the payload at ${issues.length} ` +
        `issue${issues.length === 1 ? '' : 's'}.`,
      {
        cause: parsed.error,
        details: {
          email: inputs.email,
          issues,
          hint:
            'this is a data-integrity error in Monday\'s response (or a ' +
            'directory-schema drift); verify the response shape and update ' +
            'userDirectoryEntrySchema if Monday\'s contract has changed.',
        },
      },
    );
  }
  const fresh = parsed.data;
  if (!noCache && fresh.length > 0) {
    await upsertCache(env, fresh);
  }

  const match = matchInCache(fresh, inputs.email);
  if (match !== undefined) {
    return { user: match, source: 'live', cacheAgeSeconds: null };
  }
  throw new ApiError(
    'user_not_found',
    `No Monday user matches email ${JSON.stringify(inputs.email)}`,
    { details: { email: inputs.email } },
  );
};

/**
 * Cast a `string` to a `UserId`. Used by callers that hold a
 * directory-projected ID and need the branded form for downstream
 * APIs. Validates via the same regex as the schema brand.
 */
export const userIdFromString = (id: string): UserId => {
  if (!/^\d+$/u.test(id)) {
    throw new ApiError(
      'internal_error',
      `Monday returned a non-numeric user id: ${JSON.stringify(id)}`,
    );
  }
  return id as UserId;
};
