/**
 * Per-account tag-directory lookup helper for the v0.3-M19 `tags`
 * friendly translator. Mirrors the `userByEmail` user-directory
 * pattern in `src/api/resolvers.ts:191–402` (the existing precedent —
 * there is no standalone `user-directory.ts` module; the user-
 * directory cache / lookup / refresh-on-miss machinery lives inside
 * `resolvers.ts`).
 *
 * **Two surfaces.**
 *
 *   - `loadAccountTags({client, env?, noCache?})` — full-directory
 *     reader. Cache-then-live: prefers a fresh on-disk
 *     `account_tags/index.json` cache entry; falls through to a live
 *     `account { tags { id name } }` query on miss / expiry / `noCache`,
 *     and writes the response back to the cache. Also exposes
 *     `complexity: Complexity | null` for the live-fetch leg, mirroring
 *     `BoardMetadataLoadResult` so `monday account tags --verbose` can
 *     report budget like other cache-backed reads.
 *
 *   - `resolveTags({client, input, env?, noCache?})` — name-list →
 *     tag-id resolver. Splits the input on commas, trims, deduplicates,
 *     NFC + case-fold matches against the cache; on any miss, refreshes
 *     the directory once (live `account.tags` re-fetch) and re-checks.
 *     Residual misses surface as `tag_not_found` per cli-design §6.5
 *     with `details.tags: misses[]` in array form (Decision 1, closed
 *     at `4c652d5`). Returns `{ ids, misses, source, cacheAgeSeconds }`
 *     so the caller can populate `meta.source` + `meta.cache_age_seconds`
 *     per cli-design §6.1.
 *
 * **Cache shape.** Per-account scope (`{ kind: 'accountTags' }` cache
 * key, no per-board fan-out — Monday's data model scopes tags to the
 * account, not the workspace). On-disk path
 * `account_tags/index.json`; mode `0600` per the cache layer's existing
 * security contract.
 *
 * **Refresh on miss.** A `--set tags=foo` call against a cache that
 * doesn't list `foo` re-fetches the account directory, upserts, and
 * re-checks before surfacing `tag_not_found`. Mirrors the
 * `userByEmail` cache-then-live-refresh-then-error sequence verbatim.
 */

import { z } from 'zod';
import {
  readEntry,
  resolveCacheRoot,
  writeEntry,
  DEFAULT_CACHE_TTL_SECONDS,
} from './cache.js';
import type { MondayClient } from './client.js';
import { ApiError } from '../utils/errors.js';
import type { Complexity } from '../utils/output/envelope.js';

/**
 * Per-account tag entry. Shape mirrors `UserDirectoryEntry` from
 * `resolvers.ts` (numeric-string id + display name); Monday's
 * `tags` field on the account node returns `{ id, name }` per the
 * GraphQL schema.
 *
 * The `id` field is constrained to a decimal non-negative integer
 * string (NOT just any non-empty string) for the same reason the
 * user directory does it: callers convert it to a JS number for
 * the wire payload (`{ tag_ids: [N1, N2] }`), and a loose
 * `z.string().min(1)` would let `"0x2a"` / `"1e3"` / `"42 "` into
 * the cache where they'd silently corrupt every later
 * `Number(id)` conversion.
 */
export interface AccountTag {
  readonly id: string;
  readonly name: string;
}

const DECIMAL_TAG_ID_PATTERN = /^\d+$/u;

const accountTagSchema = z
  .object({
    id: z.string().regex(DECIMAL_TAG_ID_PATTERN, {
      message: 'tag id must be a decimal non-negative integer string',
    }),
    name: z.string(),
  })
  .strict();

const accountTagsSchema = z.array(accountTagSchema);

export interface ResolveTagsInputs {
  /**
   * The Monday GraphQL client. Required because the cache-then-
   * live sequence falls through to a live account-tag directory
   * reload (via `loadAccountTags`) when the input list contains
   * a name not in the cache, and re-checks the input names
   * against the freshly-loaded set before surfacing
   * `tag_not_found` for any residual misses. Mirrors
   * `UserByEmailInputs.client` in `resolvers.ts:238`.
   */
  readonly client: MondayClient;
  readonly input: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly noCache?: boolean;
}

export interface ResolveTagsResult {
  readonly ids: readonly number[];
  readonly misses: readonly string[];
  readonly source: 'cache' | 'live' | 'mixed';
  /**
   * Age of the cache entry the resolver read from when `source` is
   * `'cache'` (full cache hit, no live refresh) or `'mixed'` (cache
   * had some matches, live refresh covered the rest — the cache
   * leg's age is preserved as the worst-case staleness the agent
   * observed). `null` for `'live'` (no cache leg fired — empty
   * cache or `noCache: true`). Surfaced into `meta.cache_age_seconds`
   * via the translator-source aggregation pathway, matching the
   * broader §6.1 mixed-source/cache-age contract.
   */
  readonly cacheAgeSeconds: number | null;
}

export interface LoadAccountTagsInputs {
  /**
   * The Monday GraphQL client. Required because `loadAccountTags`
   * may bypass the cache (e.g. `monday account tags --refresh` if
   * that flag ships at M19 implementation) and always hits the live
   * directory on a cache miss. Mirrors `UserByEmailInputs.client`.
   */
  readonly client: MondayClient;
  readonly env?: NodeJS.ProcessEnv;
  readonly noCache?: boolean;
}

export interface LoadAccountTagsResult {
  readonly tags: readonly AccountTag[];
  readonly source: 'cache' | 'live';
  readonly cacheAgeSeconds: number | null;
  /**
   * `meta.complexity` payload from the live request when one ran;
   * `null` for cache hits and for non-`--verbose` live calls (Monday
   * doesn't include `complexity` unless the operation selects it).
   * Surfacing this here is what lets cache-backed commands report
   * accurate complexity in `--verbose` mode (mirrors
   * `BoardMetadataLoadResult.complexity` from `board-metadata.ts`).
   */
  readonly complexity: Complexity | null;
}

const ACCOUNT_TAGS_QUERY = `
  query AccountTags {
    account {
      tags {
        id
        name
      }
    }
  }
`;

interface AccountTagsResponse {
  readonly account:
    | {
        readonly tags: readonly { readonly id: string; readonly name: string }[] | null;
      }
    | null;
}

const readDirectoryCache = async (
  env: NodeJS.ProcessEnv,
): Promise<
  | { readonly entries: readonly AccountTag[]; readonly ageSeconds: number }
  | undefined
> => {
  const root = resolveCacheRoot({ env });
  try {
    const hit = await readEntry<readonly AccountTag[]>(
      root,
      { kind: 'accountTags' },
      (raw) => accountTagsSchema.parse(raw),
      { ttlSeconds: DEFAULT_CACHE_TTL_SECONDS },
    );
    if (hit === undefined) return undefined;
    return { entries: hit.data, ageSeconds: hit.ageSeconds };
  } catch {
    // A corrupt or unreadable cache file is non-fatal — the caller
    // will fall through to a live fetch. Same shape `userByEmail`
    // uses (`resolvers.ts:264–266`).
    return undefined;
  }
};

const writeDirectoryCache = async (
  env: NodeJS.ProcessEnv,
  entries: readonly AccountTag[],
): Promise<void> => {
  const root = resolveCacheRoot({ env });
  try {
    await writeEntry(root, { kind: 'accountTags' }, entries);
  } catch {
    // Best-effort — cache write failures don't block the lookup
    // (mirrors `userByEmail`'s `writeDirectoryCache` policy).
  }
};

/**
 * Loads the full per-account tag directory. Used by `monday account
 * tags` (the read verb that resolves the §6.5 `tag_not_found.details
 * .hint` forward-reference) and by `resolveTags`'s refresh-on-miss
 * path. Cache-then-live: prefers a fresh on-disk entry; falls
 * through to a live `account.tags` query on miss / expiry /
 * `noCache`. Cache writes are best-effort (disk full / permission
 * flips don't block the lookup).
 */
export const loadAccountTags = async (
  inputs: LoadAccountTagsInputs,
): Promise<LoadAccountTagsResult> => {
  /* c8 ignore next — defensive fallback; tests always pass `env`. */
  const env = inputs.env ?? process.env;
  const noCache = inputs.noCache ?? false;

  if (!noCache) {
    const cached = await readDirectoryCache(env);
    if (cached !== undefined) {
      return {
        tags: cached.entries,
        source: 'cache',
        cacheAgeSeconds: cached.ageSeconds,
        complexity: null,
      };
    }
  }

  const response = await inputs.client.raw<AccountTagsResponse>(
    ACCOUNT_TAGS_QUERY,
    undefined,
    { operationName: 'AccountTags' },
  );
  const tagsRaw = response.data.account?.tags ?? [];
  // Parse-then-wrap (R17 / `validation.md` "Never bubble raw ZodError
  // out of a parse boundary"). Malformed Monday responses surface as
  // typed `internal_error` with `details.issues` rather than a bare
  // ZodError that the runner's catch-all maps to `internal_error` but
  // loses the failing field path.
  const parsed = accountTagsSchema.safeParse(tagsRaw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }));
    throw new ApiError(
      'internal_error',
      `Monday returned a malformed account.tags response — the directory ` +
        `schema rejected the payload at ${issues.length.toString()} ` +
        `issue${issues.length === 1 ? '' : 's'}.`,
      {
        cause: parsed.error,
        details: {
          issues,
          hint:
            "this is a data-integrity error in Monday's response (or an " +
            "accountTagsSchema drift); verify the response shape and " +
            "update accountTagsSchema if Monday's contract has changed.",
        },
      },
    );
  }
  const fresh = parsed.data;
  if (!noCache) {
    await writeDirectoryCache(env, fresh);
  }
  return {
    tags: fresh,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

/**
 * NFC + case-fold + whitespace-collapse normalisation for tag-name
 * matching. Same rule as `cli-design.md` §5.3 step 2's column-token
 * normalisation — agents learning one rule shouldn't have to learn a
 * different one for tags vs columns vs status labels. A stray
 * trailing space or a `Café` vs `Café` (NFD) variant resolves to the
 * same tag.
 */
const normaliseFold = (s: string): string =>
  s.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');

interface MatchResult {
  readonly ids: readonly number[];
  readonly misses: readonly string[];
}

const matchTags = (
  entries: readonly AccountTag[],
  inputs: readonly string[],
): MatchResult => {
  // Build a lookup table once per match pass. Multiple input tokens
  // matching the same tag entry resolve to the same id (deduplication
  // happens upstream in `resolveTags`).
  const byNormalised = new Map<string, AccountTag>();
  for (const entry of entries) {
    byNormalised.set(normaliseFold(entry.name), entry);
  }
  const ids: number[] = [];
  const misses: string[] = [];
  for (const input of inputs) {
    const hit = byNormalised.get(normaliseFold(input));
    if (hit === undefined) {
      misses.push(input);
      continue;
    }
    // Decimal regex on the schema gates the `Number()` conversion;
    // safe-integer guard mirrors the people translator's defensive
    // shape (`people.ts:300`).
    const parsed = Number(hit.id);
    /* c8 ignore next 7 — the schema's regex (`/^\d+$/u`) gates entries
       at parse boundary; combined with Number.isSafeInteger this branch
       only fires if Monday surfaces a >2^53 tag id, which exceeds the
       documented cap. Defensive guard for noUncheckedIndexedAccess +
       future-proofing. */
    if (!Number.isSafeInteger(parsed)) {
      throw new ApiError(
        'internal_error',
        `Monday returned a tag id "${hit.id}" that exceeds the JavaScript ` +
          `safe-integer range (2^53 - 1). Number(id) would lose precision, ` +
          `corrupting the wire payload.`,
        {
          details: {
            tag_name: hit.name,
            tag_id: hit.id,
            hint:
              'this is a data-integrity error in the account-tag ' +
              'directory; report it at the monday-cli issues tracker.',
          },
        },
      );
    }
    ids.push(parsed);
  }
  return { ids, misses };
};

const dedupePreserveOrder = (tokens: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const key = normaliseFold(token);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
};

/**
 * Resolves a comma-split tag-name list against the per-account
 * directory. Returns numeric tag IDs for the matched names and
 * carries the misses through so the caller can construct a
 * `tag_not_found` error envelope with `details.tags: misses[]` per
 * cli-design §6.5 (`4c652d5`).
 *
 * **Three-step lookup** mirroring `userByEmail`:
 *
 *   1. Read the on-disk cache (skipped on `noCache`). Match input
 *      tokens against cached entries with NFC + case-fold +
 *      whitespace-collapse.
 *   2. If any input token misses against the cached set, refresh
 *      the directory once via a live `account.tags` query (also
 *      skipped on `noCache` — the live leg always runs but the
 *      result isn't cached).
 *   3. Match input tokens against the freshly-loaded set. Any
 *      residual miss is surfaced as `tag_not_found` (caller's
 *      responsibility — this function returns the misses array
 *      and the caller decides whether to throw).
 *
 * **Empty input handled by the caller** — this function does not
 * reject an empty input list; `column-values.ts`'s `tags` translator
 * is the boundary that surfaces `usage_error` for `--set tags=""`
 * (mirroring the dropdown / people empty-input contract).
 */
export const resolveTags = async (
  inputs: ResolveTagsInputs,
): Promise<ResolveTagsResult> => {
  /* c8 ignore next — defensive fallback; tests always pass `env`. */
  const env = inputs.env ?? process.env;
  const noCache = inputs.noCache ?? false;
  const tokens = inputs.input
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const dedup = dedupePreserveOrder(tokens);

  // Empty after split+trim+filter+dedup: caller boundary handles. The
  // resolver returns an empty result so the translator can decide
  // (the friendly translator throws usage_error before reaching this
  // function, but this contract stays defensive).
  if (dedup.length === 0) {
    return { ids: [], misses: [], source: 'cache', cacheAgeSeconds: null };
  }

  let cacheHitAge: number | null = null;
  let cacheMatched: MatchResult | undefined;
  if (!noCache) {
    const cached = await readDirectoryCache(env);
    if (cached !== undefined) {
      cacheHitAge = cached.ageSeconds;
      cacheMatched = matchTags(cached.entries, dedup);
      if (cacheMatched.misses.length === 0) {
        return {
          ids: cacheMatched.ids,
          misses: [],
          source: 'cache',
          cacheAgeSeconds: cached.ageSeconds,
        };
      }
    }
  }

  // Refresh-on-miss: bypass cache and hit live directly, then upsert
  // the fresh entries into the cache. Same shape as `userByEmail`'s
  // `users(emails:)` fallback — the cache may be stale (Monday's UI
  // created a new tag between cache write and this call), so going
  // through `loadAccountTags` would just re-read the same stale
  // cache. The `noCache: true` override forces the live leg.
  const live = await loadAccountTags({
    client: inputs.client,
    env,
    noCache: true,
  });
  // Upsert the freshly-loaded directory into the cache so the next
  // call benefits from the refresh (skipped on `noCache: true` —
  // the agent explicitly disabled cache writes).
  if (!noCache) {
    await writeDirectoryCache(env, live.tags);
  }
  const liveMatched = matchTags(live.tags, dedup);
  // Determine source discriminant. If the cache leg matched some but
  // not all, the result mixes cache + live (we re-matched the entire
  // input against live, so technically the final ids come from live —
  // but we still touched cache, so `mixed` is the honest signal).
  // If the cache leg matched nothing OR was skipped, this is a pure
  // `live` resolution.
  const source: ResolveTagsResult['source'] =
    cacheMatched !== undefined && cacheMatched.ids.length > 0 ? 'mixed' : 'live';
  return {
    ids: liveMatched.ids,
    misses: liveMatched.misses,
    source,
    // For `'mixed'`, surface the cache leg's age as the worst-case
    // staleness the agent observed — matches the broader §6.1
    // mixed-source/cache-age contract (`mergeCacheAge` keeps the
    // oldest age across legs that hit cache). For `'live'` (no
    // cache leg fired), null.
    cacheAgeSeconds: source === 'mixed' ? cacheHitAge : null,
  };
};
