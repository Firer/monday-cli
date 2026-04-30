/**
 * Page-based pagination walker shared by every M3 list command
 * (workspace / board / user / update). Codex M3 pass-1 §1 caught
 * the original per-command walkers all looped without an upper
 * bound — `--all` against a misbehaving fixture or proxy that kept
 * returning a full page would burn quota until timeout.
 *
 * The walker:
 *   - always issues at least one request (the bare `monday X list`
 *     case calls this with `all: false` and `page: 1`);
 *   - on a short page (`< limit`) terminates with `hasMore: false`;
 *   - on a full page with `all: true`, increments and continues;
 *   - on hitting `maxPages`, stops and reports `hasMore: true` —
 *     the caller raises a `pagination_cap_reached` warning so the
 *     agent knows the result is truncated.
 *
 * Cursor-based pagination (M4 `item list`) gets its own walker —
 * §5.6 calls out the stale-cursor contract and the silent-retry
 * forbid that doesn't apply to page-based reads.
 */

import type { MondayResponse } from './client.js';

export interface WalkPagesInputs<T, R> {
  /**
   * Per-page request executor. Receives the 1-indexed page number,
   * returns the typed `MondayResponse<R>` of one page. The walker
   * accumulates the projection.
   */
  readonly fetchPage: (page: number) => Promise<MondayResponse<R>>;
  /**
   * Extracts the array of items from one page's response. Returning
   * an empty array signals exhaustion (no further pages).
   */
  readonly extractItems: (response: MondayResponse<R>) => readonly T[];
  /** Page size the caller passed to the GraphQL query. Used to
   *  tell whether a returned page is "full" (= maybe more) vs
   *  "short" (= terminal). */
  readonly pageSize: number;
  /** Honour the `--all` flag. */
  readonly all: boolean;
  /**
   * 1-indexed starting page. When `all: false` and `startPage`
   * is set, the walker fetches exactly that page. Default 1.
   */
  readonly startPage?: number;
  /**
   * Hard cap on pages to walk under `--all`. Per Codex M3 pass-1 §1,
   * every list command must cap; the caller propagates this through
   * `--limit-pages`. Default in caller, surfaced as a usage option.
   */
  readonly maxPages: number;
}

export interface WalkPagesResult<T, R> {
  /** All items collected across walked pages, in arrival order. */
  readonly items: readonly T[];
  /** The final response — used for `meta.complexity` etc. */
  readonly lastResponse: MondayResponse<R>;
  /**
   * `true` when the walker stopped early (cap hit on a still-full
   * page). Drives a `pagination_cap_reached` warning at the caller;
   * also lands on `meta.has_more`.
   */
  readonly hasMore: boolean;
  /** How many pages the walker actually fetched. */
  readonly pagesFetched: number;
}

export const walkPages = async <T, R>(
  inputs: WalkPagesInputs<T, R>,
): Promise<WalkPagesResult<T, R>> => {
  const { fetchPage, extractItems, pageSize, all, maxPages } = inputs;
  const startPage = inputs.startPage ?? 1;

  // First request always runs. Page count includes this attempt.
  let lastResponse = await fetchPage(startPage);
  const collected: T[] = [];
  let pagesFetched = 1;

  const firstPage = extractItems(lastResponse);
  collected.push(...firstPage);

  // No-walk case: caller asked for one page only.
  if (!all) {
    return {
      items: collected,
      lastResponse,
      hasMore: firstPage.length === pageSize,
      pagesFetched,
    };
  }

  // Walk while pages are full and we're under the cap. Empty page or
  // short page terminates the walk; cap hit on a full page surfaces
  // hasMore=true so the caller can warn.
  if (firstPage.length === 0 || firstPage.length < pageSize) {
    return { items: collected, lastResponse, hasMore: false, pagesFetched };
  }
  let page = startPage + 1;
  while (pagesFetched < maxPages) {
    lastResponse = await fetchPage(page);
    pagesFetched++;
    const pageData = extractItems(lastResponse);
    if (pageData.length === 0) {
      return { items: collected, lastResponse, hasMore: false, pagesFetched };
    }
    collected.push(...pageData);
    if (pageData.length < pageSize) {
      return { items: collected, lastResponse, hasMore: false, pagesFetched };
    }
    page++;
  }
  // Cap hit on a full page — more might exist.
  return { items: collected, lastResponse, hasMore: true, pagesFetched };
};

export interface PaginationCapWarning {
  readonly code: 'pagination_cap_reached';
  readonly message: string;
  readonly details: {
    readonly pages_walked: number;
    readonly hint: string;
  };
}

export const buildCapWarning = (
  pagesWalked: number,
  flagName = '--limit-pages',
): PaginationCapWarning => ({
  code: 'pagination_cap_reached',
  message: `--all stopped after ${String(pagesWalked)} pages; more results may exist`,
  details: {
    pages_walked: pagesWalked,
    hint: `Increase ${flagName} or narrow the query (e.g. --workspace, --state).`,
  },
});

/** Default cap shared by every M3 list command's `--all` walk. */
export const DEFAULT_MAX_PAGES = 50;
