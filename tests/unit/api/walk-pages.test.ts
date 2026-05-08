import { describe, expect, it } from 'vitest';
import {
  walkPages,
  buildCapWarning,
  DEFAULT_MAX_PAGES,
} from '../../../src/api/walk-pages.js';
import type { MondayResponse } from '../../../src/api/client.js';

interface PageShape {
  readonly items: readonly { readonly id: number }[];
}

const respond = (items: readonly { readonly id: number }[]): MondayResponse<PageShape> => ({
  data: { items },
  complexity: null,
  stats: { attempts: 1, totalSleepMs: 0 },
});

describe('walkPages — single fetch (all=false)', () => {
  it('issues exactly one fetch and reports hasMore based on page fullness', async () => {
    const calls: number[] = [];
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: (page) => {
        calls.push(page);
        return Promise.resolve(respond([{ id: 1 }, { id: 2 }]));
      },
      extractItems: (r) => r.data.items,
      pageSize: 5,
      all: false,
      maxPages: DEFAULT_MAX_PAGES,
    });
    expect(calls).toEqual([1]);
    expect(result.hasMore).toBe(false);
    expect(result.items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('reports hasMore=true when single page is exactly full', async () => {
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: () => Promise.resolve(respond([{ id: 1 }, { id: 2 }, { id: 3 }])),
      extractItems: (r) => r.data.items,
      pageSize: 3,
      all: false,
      maxPages: DEFAULT_MAX_PAGES,
    });
    expect(result.hasMore).toBe(true);
  });
});

describe('walkPages — all=true walking', () => {
  it('stops on a short page', async () => {
    const pages = [
      respond(Array.from({ length: 5 }, (_, i) => ({ id: i }))),
      respond(Array.from({ length: 5 }, (_, i) => ({ id: 5 + i }))),
      respond([{ id: 99 }]),
    ];
    let cursor = 0;
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: () => {
        const out = pages[cursor];
        if (out === undefined) throw new Error('no more pages staged');
        cursor++;
        return Promise.resolve(out);
      },
      extractItems: (r) => r.data.items,
      pageSize: 5,
      all: true,
      maxPages: DEFAULT_MAX_PAGES,
    });
    expect(result.items).toHaveLength(11);
    expect(result.hasMore).toBe(false);
    expect(result.pagesFetched).toBe(3);
  });

  it('stops on an empty page', async () => {
    const pages = [
      respond(Array.from({ length: 5 }, (_, i) => ({ id: i }))),
      respond([]),
    ];
    let cursor = 0;
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: () => {
        const out = pages[cursor];
        if (out === undefined) throw new Error('no more pages staged');
        cursor++;
        return Promise.resolve(out);
      },
      extractItems: (r) => r.data.items,
      pageSize: 5,
      all: true,
      maxPages: DEFAULT_MAX_PAGES,
    });
    expect(result.items).toHaveLength(5);
    expect(result.hasMore).toBe(false);
  });

  it('caps the walk on hasMore=true when every page is full (REGRESSION: prior versions looped indefinitely)', async () => {
    let cursor = 0;
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: () => {
        cursor++;
        return Promise.resolve(
          respond(Array.from({ length: 3 }, (_, i) => ({ id: i }))),
        );
      },
      extractItems: (r) => r.data.items,
      pageSize: 3,
      all: true,
      maxPages: 4,
    });
    expect(result.pagesFetched).toBe(4);
    expect(result.hasMore).toBe(true);
    expect(cursor).toBe(4);
  });

  it('all=true with empty first page reports hasMore=false and stops immediately', async () => {
    let cursor = 0;
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: () => {
        cursor++;
        return Promise.resolve(respond([]));
      },
      extractItems: (r) => r.data.items,
      pageSize: 5,
      all: true,
      maxPages: 10,
    });
    expect(cursor).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.items).toEqual([]);
  });

  it('all=true with a short first page reports hasMore=false', async () => {
    let cursor = 0;
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: () => {
        cursor++;
        return Promise.resolve(respond([{ id: 1 }, { id: 2 }]));
      },
      extractItems: (r) => r.data.items,
      pageSize: 5,
      all: true,
      maxPages: 10,
    });
    expect(cursor).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it('honours startPage as the first page number', async () => {
    const seen: number[] = [];
    await walkPages<{ id: number }, PageShape>({
      fetchPage: (page) => {
        seen.push(page);
        return Promise.resolve(respond([]));
      },
      extractItems: (r) => r.data.items,
      pageSize: 5,
      all: false,
      startPage: 7,
      maxPages: DEFAULT_MAX_PAGES,
    });
    expect(seen).toEqual([7]);
  });
});

describe('buildCapWarning', () => {
  it('packs pages_walked + a hint into details', () => {
    const w = buildCapWarning(5);
    expect(w.code).toBe('pagination_cap_reached');
    expect(w.details.pages_walked).toBe(5);
    expect(w.details.hint).toContain('--limit-pages');
  });
});

describe('walkPages — onItem streaming hook (M18)', () => {
  // Mirrors paginate.onItem's contract from pagination.ts:369 —
  // per-item-arrival-order, push-then-await. Tests pin the
  // ordering invariant so a future regression that swapped
  // push/await would break here loudly.

  it('fires onItem per item in arrival order across pages', async () => {
    const pages = [
      respond([{ id: 1 }, { id: 2 }, { id: 3 }]),
      respond([{ id: 4 }, { id: 5 }, { id: 6 }]),
      respond([{ id: 7 }]),
    ];
    let cursor = 0;
    const seen: number[] = [];
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: () => {
        const out = pages[cursor];
        if (out === undefined) throw new Error('no more pages staged');
        cursor++;
        return Promise.resolve(out);
      },
      extractItems: (r) => r.data.items,
      pageSize: 3,
      all: true,
      maxPages: DEFAULT_MAX_PAGES,
      onItem: (item) => {
        seen.push(item.id);
      },
    });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.items).toEqual([
      { id: 1 }, { id: 2 }, { id: 3 },
      { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 },
    ]);
  });

  it('does not invoke a hook when onItem is undefined', async () => {
    // Defensive: the existing call sites that don't stream must
    // still work — the optional onItem must short-circuit cleanly.
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: () => Promise.resolve(respond([{ id: 1 }, { id: 2 }])),
      extractItems: (r) => r.data.items,
      pageSize: 5,
      all: false,
      maxPages: DEFAULT_MAX_PAGES,
    });
    expect(result.items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('awaits an async onItem so a slow consumer backpressures the walk', async () => {
    // Async hook must be awaited. If the walker fired-and-forgot,
    // the loop would race ahead and the assertion below would see
    // the items in arrival-order but the resolved-completion tag
    // wouldn't match.
    const seen: string[] = [];
    await walkPages<{ id: number }, PageShape>({
      fetchPage: () => Promise.resolve(respond([{ id: 1 }, { id: 2 }])),
      extractItems: (r) => r.data.items,
      pageSize: 5,
      all: false,
      maxPages: DEFAULT_MAX_PAGES,
      onItem: async (item) => {
        seen.push(`enter-${String(item.id)}`);
        await new Promise((r) => setTimeout(r, 1));
        seen.push(`exit-${String(item.id)}`);
      },
    });
    // If awaited correctly, every enter/exit pair is contiguous.
    expect(seen).toEqual(['enter-1', 'exit-1', 'enter-2', 'exit-2']);
  });

  it('fires onItem before the cap-hit hasMore=true return', async () => {
    // Cap-warning semantic: when --all hits maxPages on a full page,
    // every collected item must have hit the hook before the result
    // surfaces. Otherwise an agent receiving hasMore=true might
    // think items were dropped — but they're in `collected` and
    // were emitted to the stream.
    let cursor = 0;
    const seen: number[] = [];
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: () => {
        cursor++;
        return Promise.resolve(
          respond(Array.from({ length: 2 }, (_, i) => ({ id: cursor * 10 + i }))),
        );
      },
      extractItems: (r) => r.data.items,
      pageSize: 2,
      all: true,
      maxPages: 3,
      onItem: (item) => {
        seen.push(item.id);
      },
    });
    expect(result.hasMore).toBe(true);
    expect(result.pagesFetched).toBe(3);
    // 3 pages × 2 items each = 6 items, all hit the hook.
    expect(seen).toEqual([10, 11, 20, 21, 30, 31]);
    expect(result.items.length).toBe(6);
  });

  it('does not fire onItem on an empty subsequent page (early termination)', async () => {
    // When --all hits an empty page mid-walk, the walker exits
    // without firing the hook on the empty page. The hook only
    // fires for items that actually arrive.
    const pages = [
      respond([{ id: 1 }, { id: 2 }]),
      respond([]),
    ];
    let cursor = 0;
    const seen: number[] = [];
    const result = await walkPages<{ id: number }, PageShape>({
      fetchPage: () => {
        const out = pages[cursor];
        if (out === undefined) throw new Error('no more pages staged');
        cursor++;
        return Promise.resolve(out);
      },
      extractItems: (r) => r.data.items,
      pageSize: 2,
      all: true,
      maxPages: DEFAULT_MAX_PAGES,
      onItem: (item) => {
        seen.push(item.id);
      },
    });
    expect(seen).toEqual([1, 2]);
    expect(result.hasMore).toBe(false);
  });

  it('pushes to collected before awaiting onItem (deterministic prefix on hook throw)', async () => {
    // The push-then-await ordering invariant: if onItem throws on
    // item N, items 0..N-1 are still in `collected` because the
    // push happens first. Mirrors paginate.emitItems' contract.
    const seen: number[] = [];
    let thrownError: unknown;
    try {
      await walkPages<{ id: number }, PageShape>({
        fetchPage: () => Promise.resolve(respond([{ id: 1 }, { id: 2 }, { id: 3 }])),
        extractItems: (r) => r.data.items,
        pageSize: 5,
        all: false,
        maxPages: DEFAULT_MAX_PAGES,
        onItem: (item) => {
          seen.push(item.id);
          if (item.id === 2) {
            throw new Error('downstream consumer broke');
          }
        },
      });
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).toBeInstanceOf(Error);
    // The hook fired for items 1 and 2 (it threw on 2); item 3
    // was never reached.
    expect(seen).toEqual([1, 2]);
  });
});
