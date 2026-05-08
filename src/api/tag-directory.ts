/**
 * Per-account tag-directory lookup helper for the v0.3-M19 `tags`
 * friendly translator. Mirrors the `userByEmail` user-directory
 * pattern in `src/api/resolvers.ts` (the existing precedent — there
 * is no standalone `user-directory.ts` module; the user-directory
 * cache / lookup / refresh-on-miss machinery lives inside
 * `resolvers.ts` lines 192–402).
 *
 * **Pre-flight contract diff (this commit) lands type-level
 * signatures only.** Both exported functions throw at runtime to
 * pin the surface ahead of M19's first feat commit; the bodies
 * land at M19 implementation alongside the `tags` translator,
 * `WRITABLE_COLUMN_TYPES` widening (10 → 13), and the cache.ts
 * `CacheKey` union extension (new `'account-tags'` kind, single-
 * account scope).
 *
 * **Why pre-flight pins the signatures.** v0.3-plan §9 preconditions
 * require the M19 contract diff to land before any feat commit so
 * Codex pre-flight can review the contract surface without behaviour
 * changes. The `tags` translator dispatcher slot consumes this
 * module's `resolveTags` directly; the stub bodies here let
 * `column-values.ts` import the type signatures at M19 implementation
 * without a chicken-and-egg surface order.
 *
 * **Cache shape (deferred — lands at M19 implementation).** Per-
 * account scope (`{ kind: 'account-tags' }` cache key, no per-board
 * fan-out — Monday's data model scopes tags to the account, not the
 * workspace). Refresh on miss: a `--set tags=foo` call against a
 * cache that doesn't list `foo` re-fetches the account directory,
 * upserts, and re-checks before surfacing `tag_not_found`. Mirrors
 * the `userByEmail` cache-then-live-refresh-then-error sequence
 * verbatim.
 */

import type { MondayClient } from './client.js';
import { ApiError } from '../utils/errors.js';

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
 * `Number(id)` conversion. The validating regex
 * (`DECIMAL_USER_ID_PATTERN`, `src/types/ids.ts`) is reused here
 * — same rule, same source of truth, no parallel constant.
 */
export interface AccountTag {
  readonly id: string;
  readonly name: string;
}

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
}

const NOT_IMPLEMENTED_HINT =
  'tag-directory bodies land at M19 implementation alongside the ' +
  '`tags` friendly translator. The pre-flight contract diff pins the ' +
  'public surface only — see docs/v0.3-plan.md §3 M19 + §9 ' +
  'preconditions for the implementation-session sequencing.';

/**
 * Resolves a comma-split tag-name list against the per-account
 * directory. Returns numeric tag IDs for the matched names and
 * carries the misses through so the caller can construct a
 * `tag_not_found` error envelope with `details.tags: misses[]`
 * per cli-design §6.5 (`4c652d5`).
 *
 * **Stub body — implementation lands at M19.**
 */
/* c8 ignore start — stub body rejects on every path; M19
   implementation replaces this with the cache-then-live-refresh
   sequence. The non-async signature with `Promise.reject` matches
   the M19 surface (callers `await` the result) without tripping
   the require-await lint on a body that has no await yet. */
export const resolveTags = (
  _inputs: ResolveTagsInputs,
): Promise<ResolveTagsResult> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'resolveTags is a v0.3-M19 pre-flight stub — the runtime body ' +
        'lands when the friendly tags translator ships at M19 ' +
        'implementation.',
      { details: { hint: NOT_IMPLEMENTED_HINT } },
    ),
  );
/* c8 ignore stop */

/**
 * Loads the full per-account tag directory. Used by `monday account
 * tags` (the read verb that resolves the §6.5 `tag_not_found.details
 * .hint` forward-reference) and by the cache-warm-up path the
 * `tags` translator hits on first use.
 *
 * **Stub body — implementation lands at M19 (or v0.3.x fast-follow
 * for the `monday account tags` consumer; M19 implementation
 * decides).**
 */
/* c8 ignore start — stub body rejects on every path. */
export const loadAccountTags = (
  _inputs: LoadAccountTagsInputs,
): Promise<LoadAccountTagsResult> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'loadAccountTags is a v0.3-M19 pre-flight stub — the runtime ' +
        'body lands when the per-account tag directory ships at M19 ' +
        'implementation.',
      { details: { hint: NOT_IMPLEMENTED_HINT } },
    ),
  );
/* c8 ignore stop */
