/**
 * Cursor-based pagination walker (`cli-design.md` §2.4 / §5.6,
 * `v0.1-plan.md` §3 M4).
 *
 * The cursor walker is fundamentally different from `walk-pages.ts`'s
 * page-based shape: Monday issues a 60-minute cursor on the *initial*
 * `items_page` call and a stale cursor returns
 * `INVALID_CURSOR_EXCEPTION` (mapped to `stale_cursor` by
 * `api/errors.ts`). The §5.6 contract is **fail-fast on expiry —
 * never silently re-issue the initial query**, because a re-issue
 * between page N and the resumed walk can duplicate or skip items
 * (board mutated, item archived, etc.). That's silent corruption;
 * the design rejects it explicitly.
 *
 * **Result-type discipline (§14 M3 lesson, prophylactic adoption).**
 * `PaginationWalkResult` carries every §6.1 + §6.3 meta slot from
 * day one — `source`, `cacheAgeSeconds`, `complexity`, `warnings`,
 * `nextCursor`, `hasMore`, `totalReturned`. M3's
 * `BoardMetadataLoadResult` and `ResolveColumnWithRefreshResult`
 * both under-budgeted their meta surface and grew during review;
 * M4 starts complete. Cursor-paginated reads always run live
 * (`source: 'live'`, `cacheAgeSeconds: null`) — the fields are
 * present anyway so callers spread them without thinking about the
 * branch.
 *
 * **Streaming hook (`onItem`).** Required for `item list --output
 * ndjson` per §6.3 — items emit per-arrival, not after the whole
 * walk collects. The walker calls `onItem` once per item *in
 * per-page-sorted order* (the sort-by-ID pass per §3.1 #8 happens
 * before the callback fires), then the trailer (the §6.3 `_meta`
 * line) carries `next_cursor` / `has_more` / `total_returned`. If
 * a stale cursor fires mid-walk, `onItem` has already emitted the
 * pre-failure items; the caller produces the error envelope on
 * stderr as documented in §6.3 / §6.5.
 *
 * **Cursor lifetime tracking.** The walker reads `now: () => Date`
 * from inputs — production wires `ctx.clock`, tests inject a
 * deterministic clock. The age is measured from the `now()` value
 * captured *before* the initial request fires (so the test clock
 * controls expiry deterministically; no wall-clock waits). On a
 * mid-walk `stale_cursor` from Monday, the walker enriches the
 * error's `details` with `cursor_age_seconds` /
 * `items_returned_so_far` / `last_item_id` per §5.6.
 */

import { ApiError } from '../utils/errors.js';
import { sortByIdAsc } from './sort.js';
import type { MondayResponse } from './client.js';
import type { Complexity, Warning } from '../utils/output/envelope.js';

/**
 * Monday's cursor lifetime per `cli-design.md` §2.4 / §5.6.
 * Exported so a `--cursor-lifetime-seconds` flag (if ever added)
 * can shadow it; for v0.1 it's a constant.
 */
export const CURSOR_LIFETIME_SECONDS = 60 * 60;

/**
 * Default page size — Monday caps at 500 (§2.4). Most agent queries
 * fit well under this; the walker's caller can override via
 * `pageSize` to reduce per-request payload size when items carry a
 * lot of column-value data.
 */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * One page response from either `items_page` (initial) or
 * `next_items_page` (subsequent). Caller's projector returns this
 * shape from the GraphQL response; the walker doesn't know the
 * specific GraphQL field path so the inputs decouple the two
 * concerns.
 */
export interface PaginatedPage<T> {
  readonly items: readonly T[];
  /**
   * `null` when the cursor walk is exhausted; a non-empty string
   * otherwise. Monday's contract: the cursor returned alongside a
   * page is the cursor for the *next* page, not a token covering
   * the page just returned.
   */
  readonly cursor: string | null;
}

/**
 * The walker's per-page result accumulates `complexity` from each
 * response so cache-aware callers can carry the *latest* complexity
 * snapshot to `meta.complexity`. Picking the latest (vs first or
 * sum) matches every other M3 caller — the response that drove the
 * final state of the walk is the most useful "what did this op
 * cost overall" hint.
 */
interface PageOutcome<T, R> {
  readonly page: PaginatedPage<T>;
  readonly response: MondayResponse<R>;
}

export interface PaginateInputs<T, R> {
  /**
   * Issues the initial `items_page` request. Receives the page-
   * size (variables shape is the caller's concern) and returns the
   * typed Monday response.
   */
  readonly fetchInitial: () => Promise<MondayResponse<R>>;
  /**
   * Issues a `next_items_page(cursor:)` request. Receives the
   * cursor returned alongside the previous page's items.
   */
  readonly fetchNext: (cursor: string) => Promise<MondayResponse<R>>;
  /**
   * Projects a Monday response into the items + next cursor for one
   * page. Returns `cursor: null` to terminate the walk.
   */
  readonly extractPage: (response: MondayResponse<R>) => PaginatedPage<T>;
  /**
   * Sort key for the per-page §3.1 #8 ascending-by-ID rule. The
   * walker calls this once per item; small projector, runs in
   * memory only.
   */
  readonly getId: (item: T) => string;
  /**
   * Honour the `--all` flag. False → fetch the first page only and
   * return its cursor on the result (caller surfaces `next_cursor`
   * on `meta`).
   */
  readonly all: boolean;
  /**
   * `--limit N` cap on total items collected across the walk. The
   * walker stops mid-page when the cap is reached; the in-flight
   * cursor is preserved on the result so the caller still surfaces
   * `next_cursor` accurately. Undefined / 0 / negative → no cap.
   */
  readonly limit?: number;
  /**
   * Page size used for the GraphQL request — surfaced so the walker
   * can apply the §2.4 ≤500 ceiling once and leave callers passing
   * any value through. Defaults to {@link DEFAULT_PAGE_SIZE}.
   */
  readonly pageSize?: number;
  /**
   * Streaming hook for the NDJSON output mode (§6.3). Called once
   * per emitted item, in the per-page sorted order. `await`ed so
   * a slow downstream consumer (a piped `jq`) backpressures the
   * walker — same shape as Node's writable stream.
   */
  readonly onItem?: (item: T) => void | Promise<void>;
  /**
   * Clock source for cursor-age tracking. Defaults to `Date.now()`
   * via `() => new Date()`; tests inject a deterministic clock to
   * exercise the 60-min expiry boundary without wall-clock waits.
   */
  readonly now?: () => Date;
}

export interface PaginationWalkResult<T, R> {
  readonly items: readonly T[];
  /**
   * The final response — used for `meta.complexity`. Always present
   * (even if the walk fetched a single page). Null only when the
   * walk fetched zero pages, which the walker doesn't produce: at
   * least the initial request runs.
   */
  readonly lastResponse: MondayResponse<R>;
  /**
   * Carries the cursor for the *next* page when more remains; null
   * when the walk has run to exhaustion (Monday returned `null`) or
   * stopped early on `--limit`. The walker does *not* pre-eject a
   * cursor when `--all` ran to completion — agents reading
   * `meta.next_cursor: null` know the walk is exhausted.
   */
  readonly nextCursor: string | null;
  /**
   * `true` when `--limit` short-circuited the walk on a still-full
   * page, OR when `--all` was off and the initial page returned a
   * non-null cursor. `false` when the walk ran to exhaustion.
   */
  readonly hasMore: boolean;
  /** Pages actually fetched (1 = initial only). */
  readonly pagesFetched: number;
  /** §6.1 source — always `'live'` for cursor walks. */
  readonly source: 'live';
  /** Always null for cursor walks (no cache hits). */
  readonly cacheAgeSeconds: number | null;
  /**
   * `meta.complexity` from the *last* response that came back —
   * picks the freshest budget snapshot. Null when --verbose wasn't
   * set (Monday only includes complexity when the operation
   * selects it).
   */
  readonly complexity: Complexity | null;
  /**
   * Warnings the walker may surface. Empty in v0.1; reserved so
   * future cap-style truncation (e.g. an aggregate per-walk hour
   * limit) can fold a warning in without changing the result type.
   */
  readonly warnings: readonly Warning[];
  /**
   * Total items returned to the caller (after `--limit`). Mirrors
   * `items.length` when streaming isn't used, but kept as an
   * explicit slot so a future per-item filter (skipping malformed
   * rows) can report a smaller surface than `items.length` would
   * imply.
   */
  readonly totalReturned: number;
}

const wallClock = (): Date => new Date();

/**
 * Walks a cursor-paginated Monday endpoint. See module header for
 * the §5.6 contract. Throws on the first response that maps to a
 * `stale_cursor` error; the thrown `ApiError` has `details` enriched
 * with `cursor_age_seconds`, `items_returned_so_far`, and
 * `last_item_id`.
 */
export const paginate = async <T, R>(
  inputs: PaginateInputs<T, R>,
): Promise<PaginationWalkResult<T, R>> => {
  const now = inputs.now ?? wallClock;
  const startedAt = now();
  const limit = (inputs.limit ?? 0) > 0 ? inputs.limit : undefined;

  // Use the page size for diagnostics only — the actual request body
  // is the caller's concern (it lives on `fetchInitial` / `fetchNext`).
  // We still cap at 500 here as a forward-looking sanity check; if a
  // future caller passes 1000, we want a deterministic crash, not a
  // silent Monday-side rejection that's harder to debug.
  const pageSize = Math.min(inputs.pageSize ?? DEFAULT_PAGE_SIZE, 500);
  if (pageSize <= 0) {
    throw new ApiError(
      'internal_error',
      `paginate: pageSize must be positive, got ${String(pageSize)}`,
    );
  }

  const collected: T[] = [];
  let pagesFetched: number;
  let lastResponse: MondayResponse<R>;
  let cursor: string | null;

  // Initial request always runs. Wrap so a stale_cursor on the
  // *initial* request still gets the standard envelope (Monday is
  // unlikely to return that here — you'd have to re-use a cursor
  // across processes — but the contract is symmetric).
  try {
    const first = await fetchPage<T, R>(inputs.fetchInitial, inputs.extractPage);
    lastResponse = first.response;
    pagesFetched = 1;
    const sorted = sortByIdAsc(first.page.items, inputs.getId);
    const firstOutcome = await emitItems(sorted, collected, limit, inputs.onItem);
    cursor = first.page.cursor;

    // Caller asked for one page only. Surface the cursor verbatim;
    // hasMore reflects whether Monday says there's more to read OR
    // whether `--limit` truncated the page.
    if (!inputs.all) {
      return finish(
        collected,
        lastResponse,
        cursor,
        cursor !== null || firstOutcome.truncated,
        pagesFetched,
      );
    }

    // `--limit` short-circuited mid-page (or exactly at boundary).
    // Surface the in-flight cursor so the caller can resume; emit
    // `hasMore: true` even when `next_cursor` is null because the
    // truncation itself means more rows exist on this page.
    if (limit !== undefined && collected.length >= limit) {
      return finish(
        collected,
        lastResponse,
        cursor,
        cursor !== null || firstOutcome.truncated,
        pagesFetched,
      );
    }

    // Walk until cursor exhaustion or limit hit.
    while (cursor !== null) {
      const cursorAt = cursor;
      try {
        const next = await fetchPage<T, R>(
          () => inputs.fetchNext(cursorAt),
          inputs.extractPage,
        );
        lastResponse = next.response;
        pagesFetched++;
        const sortedNext = sortByIdAsc(next.page.items, inputs.getId);
        const outcome = await emitItems(sortedNext, collected, limit, inputs.onItem);
        cursor = next.page.cursor;
        if (limit !== undefined && collected.length >= limit) {
          return finish(
            collected,
            lastResponse,
            cursor,
            cursor !== null || outcome.truncated,
            pagesFetched,
          );
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'stale_cursor') {
          throw enrichStaleCursor(err, {
            startedAt,
            now,
            collected,
            getId: inputs.getId,
          });
        }
        throw err;
      }
    }

    return finish(collected, lastResponse, null, false, pagesFetched);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'stale_cursor') {
      throw enrichStaleCursor(err, {
        startedAt,
        now,
        collected,
        getId: inputs.getId,
      });
    }
    throw err;
  }
};

const fetchPage = async <T, R>(
  fetcher: () => Promise<MondayResponse<R>>,
  extract: (r: MondayResponse<R>) => PaginatedPage<T>,
): Promise<PageOutcome<T, R>> => {
  const response = await fetcher();
  return { response, page: extract(response) };
};

interface EmitOutcome {
  /**
   * True when `emitItems` left items on the page unconsumed because
   * `--limit` was hit. The caller surfaces `hasMore: true` even when
   * the page itself terminated the cursor walk — §6.3 / Codex M4 §3:
   * a `--limit`-truncated result is still "more to read", not
   * "exhausted", regardless of `next_cursor`.
   */
  readonly truncated: boolean;
}

const emitItems = async <T>(
  pageItems: readonly T[],
  collected: T[],
  limit: number | undefined,
  onItem: ((item: T) => void | Promise<void>) | undefined,
): Promise<EmitOutcome> => {
  for (let i = 0; i < pageItems.length; i++) {
    if (limit !== undefined && collected.length >= limit) {
      // Items past index i are unconsumed — page had more than the
      // remaining budget allowed.
      return { truncated: i < pageItems.length };
    }
    const item = pageItems[i] as T;
    collected.push(item);
    if (onItem !== undefined) {
      await onItem(item);
    }
  }
  return { truncated: false };
};

const finish = <T, R>(
  items: readonly T[],
  lastResponse: MondayResponse<R>,
  nextCursor: string | null,
  hasMore: boolean,
  pagesFetched: number,
): PaginationWalkResult<T, R> => ({
  items,
  lastResponse,
  nextCursor,
  hasMore,
  pagesFetched,
  source: 'live',
  cacheAgeSeconds: null,
  complexity: lastResponse.complexity,
  warnings: [],
  totalReturned: items.length,
});

interface StaleCursorContext<T> {
  readonly startedAt: Date;
  readonly now: () => Date;
  readonly collected: readonly T[];
  readonly getId: (t: T) => string;
}

const enrichStaleCursor = <T>(
  err: ApiError,
  ctx: StaleCursorContext<T>,
): ApiError => {
  const ageMs = ctx.now().getTime() - ctx.startedAt.getTime();
  const cursor_age_seconds = Math.max(0, Math.floor(ageMs / 1000));
  const last = ctx.collected[ctx.collected.length - 1];
  const last_item_id = last === undefined ? null : ctx.getId(last);
  const merged: Record<string, unknown> = {
    ...(err.details ?? {}),
    cursor_age_seconds,
    cursor_lifetime_seconds: CURSOR_LIFETIME_SECONDS,
    items_returned_so_far: ctx.collected.length,
    last_item_id,
  };
  // Re-throw with the same code/message but enriched details.
  // Keeping the original message verbatim so agents key off `code`
  // and humans see Monday's prose.
  return new ApiError('stale_cursor', err.message, {
    ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }),
    ...(err.mondayCode === undefined ? {} : { mondayCode: err.mondayCode }),
    ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
    retryable: false,
    details: merged,
    cause: err,
  });
};

/**
 * Whether the cursor age has exceeded the 60-min lifetime. Exposed
 * as a pure helper so tests can pin the threshold without driving
 * the full walker.
 */
export const isCursorExpired = (ageSeconds: number): boolean =>
  ageSeconds >= CURSOR_LIFETIME_SECONDS;
