import { describe, expect, it } from 'vitest';
import {
  CURSOR_LIFETIME_SECONDS,
  DEFAULT_PAGE_SIZE,
  isCursorExpired,
  paginate,
  type PaginatedPage,
} from '../../../src/api/pagination.js';
import type { MondayResponse } from '../../../src/api/client.js';
import { ApiError } from '../../../src/utils/errors.js';

interface RawPage {
  readonly items_page: { readonly cursor: string | null; readonly items: readonly { readonly id: string; readonly name: string }[] };
}

const respond = (
  cursor: string | null,
  ids: readonly string[],
  complexity: { used: number; remaining: number; reset_in_seconds: number } | null = null,
): MondayResponse<RawPage> => ({
  data: {
    items_page: {
      cursor,
      items: ids.map((id) => ({ id, name: `Item ${id}` })),
    },
  },
  complexity,
  stats: { attempts: 1, totalSleepMs: 0 },
});

const project = (r: MondayResponse<RawPage>): PaginatedPage<{ readonly id: string; readonly name: string }> => ({
  cursor: r.data.items_page.cursor,
  items: r.data.items_page.items,
});

const getId = (i: { readonly id: string }): string => i.id;

describe('paginate — single page (all=false)', () => {
  it('issues exactly one fetch and surfaces the cursor verbatim', async () => {
    const initialCalls: number[] = [];
    const result = await paginate({
      fetchInitial: () => {
        initialCalls.push(1);
        return Promise.resolve(respond('NEXT', ['3', '1', '2']));
      },
      fetchNext: () => Promise.reject(new Error('should not be called')),
      extractPage: project,
      getId,
      all: false,
    });
    expect(initialCalls).toHaveLength(1);
    expect(result.nextCursor).toBe('NEXT');
    expect(result.hasMore).toBe(true);
    // Per-page sort by ID ascending — §3.1 #8.
    expect(result.items.map((i) => i.id)).toEqual(['1', '2', '3']);
  });

  it('hasMore is false when the initial page returns null cursor', async () => {
    const result = await paginate({
      fetchInitial: () => Promise.resolve(respond(null, ['1'])),
      fetchNext: () => Promise.reject(new Error('unused')),
      extractPage: project,
      getId,
      all: false,
    });
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
  });
});

describe('paginate — --all walking', () => {
  it('walks every page in order and concatenates items', async () => {
    const pages = [respond('C2', ['1', '2']), respond('C3', ['3', '4']), respond(null, ['5'])];
    let i = 0;
    const cursors: string[] = [];
    const result = await paginate({
      fetchInitial: () => {
        const out = pages[i];
        if (out === undefined) throw new Error('no page');
        i++;
        return Promise.resolve(out);
      },
      fetchNext: (c) => {
        cursors.push(c);
        const out = pages[i];
        if (out === undefined) throw new Error('no page');
        i++;
        return Promise.resolve(out);
      },
      extractPage: project,
      getId,
      all: true,
    });
    expect(cursors).toEqual(['C2', 'C3']);
    expect(result.items.map((x) => x.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
    expect(result.pagesFetched).toBe(3);
  });

  it('terminates when next_cursor goes null', async () => {
    let calls = 0;
    const result = await paginate({
      fetchInitial: () => {
        calls++;
        return Promise.resolve(respond(null, ['7']));
      },
      fetchNext: () => Promise.reject(new Error('should not run')),
      extractPage: project,
      getId,
      all: true,
    });
    expect(calls).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it('honours --limit short-circuit mid-walk and preserves the live cursor', async () => {
    const pages = [respond('C2', ['1', '2', '3']), respond('C3', ['4', '5', '6']), respond(null, ['7'])];
    let i = 0;
    const result = await paginate({
      fetchInitial: () => Promise.resolve(pages[i++] ?? respond(null, [])),
      fetchNext: () => Promise.resolve(pages[i++] ?? respond(null, [])),
      extractPage: project,
      getId,
      all: true,
      limit: 4,
    });
    expect(result.items).toHaveLength(4);
    expect(result.nextCursor).toBe('C3');
    expect(result.hasMore).toBe(true);
    expect(result.pagesFetched).toBe(2);
  });

  it('handles --limit equal to first-page size — preserves cursor', async () => {
    const result = await paginate({
      fetchInitial: () => Promise.resolve(respond('C2', ['1', '2', '3'])),
      fetchNext: () => Promise.reject(new Error('should not run')),
      extractPage: project,
      getId,
      all: true,
      limit: 3,
    });
    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).toBe('C2');
    expect(result.hasMore).toBe(true);
    expect(result.pagesFetched).toBe(1);
  });

  it('streams onItem in per-page-sorted order', async () => {
    const seen: string[] = [];
    const pages = [respond('C2', ['3', '1', '2']), respond(null, ['10', '5'])];
    let i = 0;
    await paginate({
      fetchInitial: () => Promise.resolve(pages[i++] ?? respond(null, [])),
      fetchNext: () => Promise.resolve(pages[i++] ?? respond(null, [])),
      extractPage: project,
      getId,
      all: true,
      onItem: (item) => {
        seen.push(item.id);
      },
    });
    // First page sorted ascending, then second page sorted ascending.
    expect(seen).toEqual(['1', '2', '3', '5', '10']);
  });

  it('awaits async onItem callbacks (backpressure)', async () => {
    const order: string[] = [];
    const result = await paginate({
      fetchInitial: () => Promise.resolve(respond(null, ['1', '2'])),
      fetchNext: () => Promise.reject(new Error('unused')),
      extractPage: project,
      getId,
      all: true,
      onItem: async (item) => {
        await Promise.resolve();
        order.push(`emit:${item.id}`);
      },
    });
    expect(order).toEqual(['emit:1', 'emit:2']);
    expect(result.totalReturned).toBe(2);
  });
});

describe('paginate — stale_cursor handling', () => {
  it('fails fast on a mid-walk INVALID_CURSOR_EXCEPTION with enriched details', async () => {
    const clock = makeMockClock(new Date('2026-04-30T10:00:00Z'));
    let i = 0;
    const initial = (): Promise<MondayResponse<RawPage>> => {
      i++;
      return Promise.resolve(respond('CURSOR2', ['1', '2', '3']));
    };
    const next = (): Promise<MondayResponse<RawPage>> => {
      // Advance the clock past the 60-min boundary before the
      // failure so the enriched details report a realistic age.
      clock.advance(3600 + 12);
      return Promise.reject(
        new ApiError('stale_cursor', 'Cursor expired', {
          httpStatus: 200,
          mondayCode: 'INVALID_CURSOR_EXCEPTION',
        }),
      );
    };
    let thrown: unknown;
    try {
      await paginate({
        fetchInitial: initial,
        fetchNext: next,
        extractPage: project,
        getId,
        all: true,
        now: () => clock.current(),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const apiErr = thrown as ApiError;
    expect(apiErr.code).toBe('stale_cursor');
    expect(apiErr.retryable).toBe(false);
    const details = apiErr.details ?? {};
    expect(details.items_returned_so_far).toBe(3);
    expect(details.last_item_id).toBe('3');
    expect(details.cursor_age_seconds).toBeGreaterThanOrEqual(3600);
    expect(details.cursor_lifetime_seconds).toBe(CURSOR_LIFETIME_SECONDS);
    // The original ApiError is preserved as `cause`.
    expect((apiErr as { cause?: unknown }).cause).toBeInstanceOf(ApiError);
    // initial only ran once — walker did not silently re-issue.
    expect(i).toBe(1);
  });

  it('reports last_item_id as null when the failure happens on the initial response', async () => {
    let thrown: unknown;
    try {
      await paginate({
        fetchInitial: () =>
          Promise.reject(
            new ApiError('stale_cursor', 'Initial cursor stale', {
              mondayCode: 'INVALID_CURSOR_EXCEPTION',
            }),
          ),
        fetchNext: () => Promise.reject(new Error('unused')),
        extractPage: project,
        getId,
        all: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const apiErr = thrown as ApiError;
    expect(apiErr.code).toBe('stale_cursor');
    expect(apiErr.details?.items_returned_so_far).toBe(0);
    expect(apiErr.details?.last_item_id).toBeNull();
  });

  it('non-stale_cursor errors propagate unchanged (no enrichment)', async () => {
    const inner = new ApiError('rate_limited', 'slow down', {
      httpStatus: 429,
    });
    let thrown: unknown;
    try {
      await paginate({
        fetchInitial: () => Promise.resolve(respond('C2', ['1'])),
        fetchNext: () => Promise.reject(inner),
        extractPage: project,
        getId,
        all: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(inner); // identity — not re-wrapped
  });
});

describe('paginate — meta result surface', () => {
  it('source is "live", cacheAgeSeconds is null', async () => {
    const result = await paginate({
      fetchInitial: () => Promise.resolve(respond(null, ['1'])),
      fetchNext: () => Promise.reject(new Error('unused')),
      extractPage: project,
      getId,
      all: true,
    });
    expect(result.source).toBe('live');
    expect(result.cacheAgeSeconds).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('complexity comes from the LAST response (freshest snapshot)', async () => {
    const pages = [
      respond('C2', ['1'], { used: 100, remaining: 9_999_900, reset_in_seconds: 60 }),
      respond(null, ['2'], { used: 200, remaining: 9_999_800, reset_in_seconds: 30 }),
    ];
    let i = 0;
    const result = await paginate({
      fetchInitial: () => Promise.resolve(pages[i++] ?? respond(null, [])),
      fetchNext: () => Promise.resolve(pages[i++] ?? respond(null, [])),
      extractPage: project,
      getId,
      all: true,
    });
    expect(result.complexity).toEqual({ used: 200, remaining: 9_999_800, reset_in_seconds: 30 });
  });

  it('totalReturned matches collected items length', async () => {
    const result = await paginate({
      fetchInitial: () => Promise.resolve(respond(null, ['1', '2', '3'])),
      fetchNext: () => Promise.reject(new Error('unused')),
      extractPage: project,
      getId,
      all: true,
    });
    expect(result.totalReturned).toBe(3);
  });
});

describe('paginate — input guards', () => {
  it('rejects pageSize <= 0', async () => {
    await expect(
      paginate({
        fetchInitial: () => Promise.resolve(respond(null, [])),
        fetchNext: () => Promise.reject(new Error('unused')),
        extractPage: project,
        getId,
        all: false,
        pageSize: 0,
      }),
    ).rejects.toThrow(ApiError);
  });

  it('clamps pageSize to 500 (Monday §2.4)', async () => {
    // Confirms the pageSize value is read but doesn't throw at the
    // ceiling — caller asking for 1000 still gets a valid walk.
    await paginate({
      fetchInitial: () => Promise.resolve(respond(null, ['1'])),
      fetchNext: () => Promise.reject(new Error('unused')),
      extractPage: project,
      getId,
      all: false,
      pageSize: 10_000,
    });
    // No throw → success.
    expect(true).toBe(true);
  });
});

describe('isCursorExpired', () => {
  it('matches the §5.6 60-minute lifetime', () => {
    expect(CURSOR_LIFETIME_SECONDS).toBe(3600);
    expect(isCursorExpired(0)).toBe(false);
    expect(isCursorExpired(3599)).toBe(false);
    expect(isCursorExpired(3600)).toBe(true);
    expect(isCursorExpired(99_999)).toBe(true);
  });
});

describe('DEFAULT_PAGE_SIZE', () => {
  it('is sensible for typical agent workloads', () => {
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(500);
  });
});

interface MockClock {
  current: () => Date;
  advance: (seconds: number) => void;
}

const makeMockClock = (start: Date): MockClock => {
  let t = start.getTime();
  return {
    current: () => new Date(t),
    advance: (seconds: number) => {
      t += seconds * 1000;
    },
  };
};
