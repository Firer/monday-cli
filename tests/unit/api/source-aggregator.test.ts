/**
 * Unit tests for `src/api/source-aggregator.ts` — the `mergeSource` /
 * `mergeCacheAge` / `mergeSourceWithPreflight` standalone helpers and
 * the `SourceAggregator` class lifted in §16 R30 (post-M11).
 *
 * Coverage: every branch of every export. The class wraps the two
 * standalone merge helpers, so the class suite focuses on the
 * constructor / record-sequencing / fallback semantics — the merge
 * rules themselves are pinned by the standalone helper suites.
 */
import { describe, expect, it } from 'vitest';
import {
  SourceAggregator,
  mergeCacheAge,
  mergeSource,
  mergeSourceWithPreflight,
} from '../../../src/api/source-aggregator.js';

describe('mergeSource', () => {
  it('seeds the first leg when the running aggregate is undefined', () => {
    expect(mergeSource(undefined, 'live')).toBe('live');
    expect(mergeSource(undefined, 'cache')).toBe('cache');
    expect(mergeSource(undefined, 'mixed')).toBe('mixed');
  });

  it('returns the unanimous value when both legs agree', () => {
    expect(mergeSource('live', 'live')).toBe('live');
    expect(mergeSource('cache', 'cache')).toBe('cache');
    expect(mergeSource('mixed', 'mixed')).toBe('mixed');
  });

  it('promotes any cache+live combination to mixed', () => {
    expect(mergeSource('live', 'cache')).toBe('mixed');
    expect(mergeSource('cache', 'live')).toBe('mixed');
  });

  it('keeps mixed contagious in either slot', () => {
    expect(mergeSource('mixed', 'live')).toBe('mixed');
    expect(mergeSource('mixed', 'cache')).toBe('mixed');
    expect(mergeSource('live', 'mixed')).toBe('mixed');
    expect(mergeSource('cache', 'mixed')).toBe('mixed');
  });
});

describe('mergeSourceWithPreflight', () => {
  it("returns the planner source unchanged when no preflight leg fired", () => {
    expect(mergeSourceWithPreflight('live', undefined)).toBe('live');
    expect(mergeSourceWithPreflight('cache', undefined)).toBe('cache');
    expect(mergeSourceWithPreflight('mixed', undefined)).toBe('mixed');
    expect(mergeSourceWithPreflight('none', undefined)).toBe('none');
  });

  it("lets the preflight leg win when the planner claims 'none'", () => {
    expect(mergeSourceWithPreflight('none', 'live')).toBe('live');
    expect(mergeSourceWithPreflight('none', 'cache')).toBe('cache');
    expect(mergeSourceWithPreflight('none', 'mixed')).toBe('mixed');
  });

  it('falls back to the mergeSource rule when both legs fired', () => {
    expect(mergeSourceWithPreflight('live', 'live')).toBe('live');
    expect(mergeSourceWithPreflight('cache', 'live')).toBe('mixed');
    expect(mergeSourceWithPreflight('live', 'cache')).toBe('mixed');
    expect(mergeSourceWithPreflight('mixed', 'live')).toBe('mixed');
  });
});

describe('mergeCacheAge', () => {
  it('keeps the running aggregate when the next leg is null (live)', () => {
    expect(mergeCacheAge(null, null)).toBeNull();
    expect(mergeCacheAge(42, null)).toBe(42);
  });

  it('seeds the aggregate with the next leg when it is currently null', () => {
    expect(mergeCacheAge(null, 17)).toBe(17);
  });

  it('keeps the OLDEST cache age across legs (worst-case staleness)', () => {
    expect(mergeCacheAge(10, 30)).toBe(30);
    expect(mergeCacheAge(30, 10)).toBe(30);
    expect(mergeCacheAge(0, 5)).toBe(5);
  });
});

describe('SourceAggregator', () => {
  describe('constructor', () => {
    it('starts empty when no seed is passed (result returns the fallback)', () => {
      const agg = new SourceAggregator();
      expect(agg.result()).toEqual({ source: 'live', cacheAgeSeconds: null });
    });

    it('seeds source + cacheAge from the seed object', () => {
      const agg = new SourceAggregator({
        source: 'cache',
        cacheAgeSeconds: 42,
      });
      expect(agg.result()).toEqual({ source: 'cache', cacheAgeSeconds: 42 });
    });

    it('accepts a seed with a null cacheAge', () => {
      const agg = new SourceAggregator({
        source: 'live',
        cacheAgeSeconds: null,
      });
      expect(agg.result()).toEqual({ source: 'live', cacheAgeSeconds: null });
    });
  });

  describe('record', () => {
    it('seeds the source on the first record when no seed was passed', () => {
      const agg = new SourceAggregator();
      agg.record('cache', 17);
      expect(agg.result()).toEqual({ source: 'cache', cacheAgeSeconds: 17 });
    });

    it('mirrors mergeSource when folding subsequent legs', () => {
      const agg = new SourceAggregator();
      agg.record('cache', 5);
      agg.record('live', null);
      // cache + live → mixed; cache age stays at 5 (live leg is null).
      expect(agg.result()).toEqual({ source: 'mixed', cacheAgeSeconds: 5 });
    });

    it('mirrors mergeCacheAge — keeps the oldest age across cache legs', () => {
      const agg = new SourceAggregator();
      agg.record('cache', 10);
      agg.record('cache', 30);
      agg.record('cache', 20);
      expect(agg.result()).toEqual({ source: 'cache', cacheAgeSeconds: 30 });
    });

    it('promotes a seeded aggregate when a divergent leg lands', () => {
      const agg = new SourceAggregator({
        source: 'live',
        cacheAgeSeconds: null,
      });
      agg.record('cache', 7);
      expect(agg.result()).toEqual({ source: 'mixed', cacheAgeSeconds: 7 });
    });

    it('preserves multi-leg sequencing — five legs across all source types', () => {
      const agg = new SourceAggregator();
      agg.record('live', null);
      agg.record('live', null);
      agg.record('cache', 60);
      agg.record('live', null);
      agg.record('cache', 120);
      // Mixed (cache + live), oldest cache age = 120.
      expect(agg.result()).toEqual({ source: 'mixed', cacheAgeSeconds: 120 });
    });
  });

  describe('result', () => {
    it("defaults the fallback to 'live' when no leg was recorded", () => {
      const agg = new SourceAggregator();
      expect(agg.result().source).toBe('live');
    });

    it('honours an explicit fallback when no leg was recorded', () => {
      const agg = new SourceAggregator();
      expect(agg.result('cache').source).toBe('cache');
      expect(agg.result('mixed').source).toBe('mixed');
    });

    it('ignores the fallback once any leg has been recorded', () => {
      const agg = new SourceAggregator();
      agg.record('cache', 9);
      // Fallback is irrelevant — the recorded leg wins.
      expect(agg.result('live').source).toBe('cache');
    });

    it('returns a snapshot — subsequent records reflect in the next result', () => {
      const agg = new SourceAggregator();
      agg.record('live', null);
      const first = agg.result();
      expect(first).toEqual({ source: 'live', cacheAgeSeconds: null });
      agg.record('cache', 12);
      const second = agg.result();
      expect(second).toEqual({ source: 'mixed', cacheAgeSeconds: 12 });
    });
  });
});
