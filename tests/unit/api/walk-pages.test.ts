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
