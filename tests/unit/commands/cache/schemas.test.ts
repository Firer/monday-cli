import { describe, expect, it } from 'vitest';
import {
  cacheListOutputSchema,
  formatEntry,
} from '../../../../src/commands/cache/list.js';
import { cacheClearOutputSchema } from '../../../../src/commands/cache/clear.js';
import { cacheStatsOutputSchema } from '../../../../src/commands/cache/stats.js';
import type { CacheEntryInfo } from '../../../../src/api/cache.js';

describe('cache.list output schema + formatter', () => {
  const sample: CacheEntryInfo = {
    path: '/x/y/boards/1.json',
    relativePath: 'boards/1.json',
    sizeBytes: 100,
    modifiedAt: '2026-04-29T10:00:00.000Z',
    ageSeconds: 5,
    kind: 'boards',
    id: '1',
  };

  it('formats a CacheEntryInfo into the schema-shape', () => {
    const formatted = formatEntry(sample);
    expect(formatted).toEqual({
      path: sample.path,
      relative_path: sample.relativePath,
      size_bytes: sample.sizeBytes,
      modified_at: sample.modifiedAt,
      age_seconds: sample.ageSeconds,
      kind: 'boards',
      id: '1',
    });
  });

  it('coerces undefined id to null per the schema', () => {
    const formatted = formatEntry({ ...sample, id: undefined, kind: 'users' });
    expect(formatted.id).toBeNull();
  });

  it('passes the full output schema with one populated entry', () => {
    expect(() =>
      cacheListOutputSchema.parse({
        root: '/x/y',
        entries: [formatEntry(sample)],
        total_entries: 1,
        total_bytes: sample.sizeBytes,
      }),
    ).not.toThrow();
  });

  it('rejects negative byte counts', () => {
    expect(() =>
      cacheListOutputSchema.parse({
        root: '/x/y',
        entries: [],
        total_entries: 0,
        total_bytes: -1,
      }),
    ).toThrow();
  });
});

describe('cache.clear output schema', () => {
  it('passes a board-scoped result', () => {
    expect(() =>
      cacheClearOutputSchema.parse({
        root: '/x/y',
        scope: 'board',
        board_id: '12345',
        removed: 1,
        bytes_freed: 200,
      }),
    ).not.toThrow();
  });

  it('passes an all-scope result with null board_id', () => {
    expect(() =>
      cacheClearOutputSchema.parse({
        root: '/x/y',
        scope: 'all',
        board_id: null,
        removed: 0,
        bytes_freed: 0,
      }),
    ).not.toThrow();
  });

  it('rejects an unknown scope', () => {
    expect(() =>
      cacheClearOutputSchema.parse({
        root: '/x/y',
        scope: 'half',
        board_id: null,
        removed: 0,
        bytes_freed: 0,
      }),
    ).toThrow();
  });
});

describe('cache.stats output schema', () => {
  it('passes an exists=false result with null ages', () => {
    expect(() =>
      cacheStatsOutputSchema.parse({
        root: '/x/y',
        exists: false,
        entries: 0,
        bytes: 0,
        oldest_age_seconds: null,
        newest_age_seconds: null,
      }),
    ).not.toThrow();
  });

  it('passes a populated result', () => {
    expect(() =>
      cacheStatsOutputSchema.parse({
        root: '/x/y',
        exists: true,
        entries: 5,
        bytes: 200,
        oldest_age_seconds: 30,
        newest_age_seconds: 5,
      }),
    ).not.toThrow();
  });
});
