/**
 * Board metadata loader (`v0.1-plan.md` §3 M3, `cli-design.md` §8).
 *
 * Single source of truth for "what columns / groups / kind does this
 * board have?" — the shape every M3+ command that resolves a column
 * token, prints `board describe`, or maps a `--where` clause needs.
 * The data is cached on disk via `api/cache.ts` (5-minute default TTL,
 * `--no-cache` bypasses) and the cache miss path issues a single
 * GraphQL call against the raw `client.raw<T>` escape hatch — the
 * SDK's typed `boards` query doesn't expose `hierarchy_type` /
 * `is_leaf`, both of which the design's "describe" output requires
 * (`cli-design.md` §2.8).
 *
 * The cache layer holds Monday-shape JSON; this module is the *only*
 * place that reshapes Monday's response into the projected
 * `BoardMetadata` form. Keeping the shape stable here means a future
 * SDK bump that adds optional fields doesn't ripple into 14 commands —
 * `boardMetadataSchema.parse` is the parse boundary, and the cache
 * envelope's `schema_version` (cache.ts) gates older payloads.
 *
 * **Auto-refresh-on-failure semantics.** Two cache-miss-style paths:
 *
 *   1. Cache absent / expired → fetch live, write cache, return.
 *   2. Cache present but caller's lookup against it failed (e.g.
 *      column token didn't match anything) → refresh once, return
 *      the new metadata. Callers (`columns.ts`) decide whether the
 *      second lookup succeeded; this module just promises that
 *      `loadBoardMetadata({ refresh: true })` bypasses the cache.
 *
 * `--no-cache` is a stronger signal — it skips the on-disk read
 * entirely *and* skips the post-fetch write. Useful for `monday board
 * describe --no-cache <bid>` when the agent suspects on-disk drift.
 */

import { z } from 'zod';
import {
  clearEntry,
  readEntry,
  resolveCacheRoot,
  writeEntry,
  DEFAULT_CACHE_TTL_SECONDS,
  type CacheReadResult,
} from './cache.js';
import type { MondayClient } from './client.js';
import { BoardIdSchema, type BoardId } from '../types/ids.js';
import { ApiError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import type { Complexity } from '../utils/output/envelope.js';

const BOARD_METADATA_QUERY = `
  query BoardMetadata($ids: [ID!]!) {
    boards(ids: $ids) {
      id
      name
      description
      state
      board_kind
      board_folder_id
      workspace_id
      url
      hierarchy_type
      is_leaf
      updated_at
      groups {
        id
        title
        color
        position
        archived
        deleted
      }
      columns {
        id
        title
        type
        description
        archived
        settings_str
        width
      }
    }
  }
`;

const groupSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    color: z.string().nullable(),
    position: z.string().nullable(),
    archived: z.boolean().nullable(),
    deleted: z.boolean().nullable(),
  })
  .strict();

const columnSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    type: z.string().min(1),
    description: z.string().nullable(),
    archived: z.boolean().nullable(),
    settings_str: z.string().nullable(),
    width: z.number().nullable(),
  })
  .strict();

export const boardMetadataSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    state: z.string().nullable(),
    board_kind: z.string().nullable(),
    board_folder_id: z.string().nullable(),
    workspace_id: z.string().nullable(),
    url: z.string().nullable(),
    hierarchy_type: z.string().nullable(),
    is_leaf: z.boolean().nullable(),
    updated_at: z.string().nullable(),
    groups: z.array(groupSchema),
    columns: z.array(columnSchema),
  })
  .strict();

export type BoardMetadata = z.infer<typeof boardMetadataSchema>;
export type BoardColumn = z.infer<typeof columnSchema>;
export type BoardGroup = z.infer<typeof groupSchema>;

interface BoardMetadataQueryResult {
  readonly boards: readonly unknown[] | null;
}

const responseSchema = z.looseObject({
  boards: z.array(z.unknown()).nullable(),
});

export interface LoadBoardMetadataInputs {
  readonly client: MondayClient;
  readonly boardId: BoardId | string;
  /** Source for the cache root — defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * `--no-cache`: skip the on-disk read + write entirely. Live fetch
   * always happens; the result is returned unchanged. Defaults to
   * false.
   */
  readonly noCache?: boolean;
  /**
   * Force a live fetch even when the cache holds a fresh entry; the
   * fresh response is written back to cache. `columns.ts` uses this
   * to retry once on `column_not_found` before surfacing the error.
   */
  readonly refresh?: boolean;
  /**
   * Override TTL in seconds. Defaults to the cache module's 5-minute
   * baseline. Passed through to `readEntry` only.
   */
  readonly ttlSeconds?: number;
  /**
   * Now provider, threaded through to the cache module so age
   * calculations are deterministic in tests.
   */
  readonly now?: () => Date;
}

/**
 * Result of a `loadBoardMetadata` call. `source` agrees with the
 * envelope's `meta.source` rule: `cache` for a hit, `live` for a
 * fetch (whether the cache was bypassed, expired, or refreshed).
 *
 * `cacheAgeSeconds` is the on-disk age of the served payload when
 * source is `cache` — used by command actions to populate
 * `meta.cache_age_seconds`. `null` for live fetches.
 */
export interface BoardMetadataLoadResult {
  readonly metadata: BoardMetadata;
  readonly source: 'live' | 'cache';
  readonly cacheAgeSeconds: number | null;
  /**
   * `meta.complexity` payload from the live request when one ran;
   * `null` for cache hits and for non-`--verbose` live calls (Monday
   * doesn't include `complexity` unless the operation selects it).
   * Surfacing this here is what lets cache-backed commands report
   * accurate complexity in `--verbose` mode (Codex M3 pass-1 §3 —
   * the original projection threw the value away).
   */
  readonly complexity: Complexity | null;
}

const projectBoard = (raw: unknown, boardId: string): BoardMetadata =>
  // R18 parse-boundary wrap. Live-fetch projection: a malformed
  // Monday response (schema drift, future field rename) surfaces as
  // `internal_error` with `details.issues` rather than a bare
  // ZodError that the runner's catch-all maps to `internal_error`
  // but loses the failing field path. Per validation.md "Never
  // bubble raw ZodError out of a parse boundary".
  unwrapOrThrow(boardMetadataSchema.safeParse(raw), {
    context: `Monday returned a malformed board metadata response for id ${boardId}`,
    details: { board_id: boardId },
    hint:
      'this is a data-integrity error in Monday\'s response (or a ' +
      'boardMetadataSchema drift); verify the response shape and ' +
      'update the schema if Monday\'s contract has changed.',
  });

// Cache-read parse callback. ZodError here is intentionally
// swallowed by the surrounding `loadBoardMetadata` try/catch (cache-
// miss path) — a corrupt cache file is treated as a miss and a live
// fetch follows. Wrapping with unwrapOrThrow would be a change in
// behaviour. Kept as a thin parse so corrupt-cache → cache-miss
// stays the established contract.
const parseCacheEntry = (raw: unknown): BoardMetadata =>
  boardMetadataSchema.parse(raw);

interface LiveFetchResult {
  readonly metadata: BoardMetadata;
  readonly complexity: Complexity | null;
}

const fetchLive = async (
  client: MondayClient,
  boardId: string,
): Promise<LiveFetchResult> => {
  const response = await client.raw<BoardMetadataQueryResult>(
    BOARD_METADATA_QUERY,
    { ids: [boardId] },
    { operationName: 'BoardMetadata' },
  );
  // Pre-validate the loose response shape so a missing `boards` key
  // surfaces a clear error rather than tripping the projection
  // parser on an undefined entry. R18 parse-boundary wrap: malformed
  // top-level shape (e.g. response without a `boards` key, or
  // `boards` not an array) surfaces with `details.issues` rather
  // than a bare ZodError.
  const validated = unwrapOrThrow(responseSchema.safeParse(response.data), {
    context: `Monday returned a malformed BoardMetadata response for id ${boardId}`,
    details: { board_id: boardId },
    hint:
      'this is a data-integrity error in Monday\'s response (or a ' +
      'BoardMetadata response-shape drift); verify the response and ' +
      'update responseSchema if Monday\'s contract has changed.',
  });
  const first = validated.boards?.[0];
  if (first === undefined || first === null) {
    throw new ApiError(
      'not_found',
      `Monday returned no board for id ${boardId}`,
      { details: { board_id: boardId } },
    );
  }
  return { metadata: projectBoard(first, boardId), complexity: response.complexity };
};

/**
 * Loads board metadata, preferring a fresh on-disk cache entry over
 * a live fetch. Cache writes are best-effort — if writing fails (disk
 * full, permission flip), the live data still returns and a warning
 * is suppressed (callers can opt in via the future `warnings`
 * channel; v0.1 keeps cache-write errors local). Read errors raise.
 */
export const loadBoardMetadata = async (
  inputs: LoadBoardMetadataInputs,
): Promise<BoardMetadataLoadResult> => {
  /* c8 ignore next — defensive fallback; tests always pass `env`. */
  const env = inputs.env ?? process.env;
  const boardId = BoardIdSchema.parse(inputs.boardId);
  const root = resolveCacheRoot({ env });
  const ttlSeconds = inputs.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  const now = inputs.now;

  if (inputs.noCache !== true && inputs.refresh !== true) {
    let hit: CacheReadResult<BoardMetadata> | undefined;
    try {
      hit = await readEntry<BoardMetadata>(
        root,
        { kind: 'board', boardId },
        parseCacheEntry,
        {
          ttlSeconds,
          ...(now === undefined ? {} : { now }),
        },
      );
    } catch {
      // A corrupt or unreadable cache file is non-fatal — fall through
      // to a live fetch. The on-disk error is surfaced separately by
      // `cache list` / `cache stats`; an end-user metadata fetch
      // shouldn't fail because of stale local state.
      hit = undefined;
    }
    if (hit !== undefined) {
      return {
        metadata: hit.data,
        source: 'cache',
        cacheAgeSeconds: hit.ageSeconds,
        complexity: null,
      };
    }
  }

  const live = await fetchLive(inputs.client, boardId);

  if (inputs.noCache !== true) {
    try {
      await writeEntry(root, { kind: 'board', boardId }, live.metadata);
    } catch {
      // Cache-write failures don't block the user — the live data is
      // good and a future call will simply re-fetch.
    }
  }

  return {
    metadata: live.metadata,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: live.complexity,
  };
};

/**
 * Convenience used by `columns.ts`'s "refresh once before surfacing
 * column_not_found" path. Idempotent; the cache write happens via
 * `loadBoardMetadata({refresh:true})`.
 */
export const refreshBoardMetadata = async (
  inputs: Omit<LoadBoardMetadataInputs, 'refresh'>,
): Promise<BoardMetadataLoadResult> =>
  loadBoardMetadata({ ...inputs, refresh: true });

/**
 * Drops the on-disk metadata for a board. Used by tests and by future
 * `cache clear --board <bid>` flows; M3 doesn't change the existing
 * cache CLI surface.
 */
export const evictBoardMetadata = async (
  boardId: BoardId | string,
  /* c8 ignore next — defensive default; callers pass an explicit env. */
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  const id = BoardIdSchema.parse(boardId);
  const root = resolveCacheRoot({ env });
  await clearEntry(root, { kind: 'board', boardId: id });
};
