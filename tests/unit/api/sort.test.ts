import { describe, expect, it } from 'vitest';
import { compareNumericId, sortByIdAsc } from '../../../src/api/sort.js';

describe('compareNumericId', () => {
  it('orders decimal-string IDs numerically, not lexicographically', () => {
    // The bug this guards against: "9" > "10" under string < / >.
    // The sort.ts comparator must order numerically.
    expect(compareNumericId('9', '10')).toBeLessThan(0);
    expect(compareNumericId('10', '9')).toBeGreaterThan(0);
  });

  it('returns 0 for equal IDs', () => {
    expect(compareNumericId('12345', '12345')).toBe(0);
  });

  it('handles same-length IDs via lex compare', () => {
    expect(compareNumericId('100', '200')).toBeLessThan(0);
    expect(compareNumericId('999', '100')).toBeGreaterThan(0);
  });

  it('handles IDs that exceed Number.MAX_SAFE_INTEGER', () => {
    // 2^53 = 9_007_199_254_740_992; IDs past that lose precision in
    // JS Number. The string-aware comparator must still order them.
    const a = '9007199254740993';
    const b = '9007199254740994';
    expect(compareNumericId(a, b)).toBeLessThan(0);
    expect(compareNumericId(b, a)).toBeGreaterThan(0);
  });
});

describe('sortByIdAsc', () => {
  it('returns a new array without mutating the input', () => {
    const input = [{ id: '3' }, { id: '1' }, { id: '2' }];
    const sorted = sortByIdAsc(input, (x) => x.id);
    expect(sorted).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
    expect(input.map((x) => x.id)).toEqual(['3', '1', '2']);
  });

  it('orders by numeric ID ascending across length boundaries', () => {
    const input = [{ id: '10' }, { id: '9' }, { id: '100' }, { id: '99' }];
    const sorted = sortByIdAsc(input, (x) => x.id);
    expect(sorted.map((x) => x.id)).toEqual(['9', '10', '99', '100']);
  });

  it('is stable for equal IDs (preserves arrival order)', () => {
    const input = [
      { id: '5', tag: 'a' },
      { id: '5', tag: 'b' },
      { id: '5', tag: 'c' },
    ];
    const sorted = sortByIdAsc(input, (x) => x.id);
    expect(sorted.map((x) => x.tag)).toEqual(['a', 'b', 'c']);
  });

  it('handles empty input', () => {
    expect(sortByIdAsc([] as readonly { id: string }[], (x) => x.id)).toEqual([]);
  });

  it('handles single-element input', () => {
    expect(sortByIdAsc([{ id: '42' }], (x) => x.id)).toEqual([{ id: '42' }]);
  });

  it('sorts items keyed via a nested projection (e.g. paginated edges)', () => {
    const input = [
      { node: { id: '7' } },
      { node: { id: '3' } },
      { node: { id: '11' } },
    ];
    const sorted = sortByIdAsc(input, (x) => x.node.id);
    expect(sorted.map((x) => x.node.id)).toEqual(['3', '7', '11']);
  });

  it('preserves Unicode names alongside numeric IDs', () => {
    // The sort key is the numeric ID; unrelated payload (e.g. names
    // with composed/decomposed Unicode forms) shouldn't affect the
    // ordering or get mangled.
    const input = [
      { id: '20', name: 'Café' }, // composed
      { id: '10', name: 'Café' }, // decomposed
      { id: '30', name: '日本' },
    ];
    const sorted = sortByIdAsc(input, (x) => x.id);
    expect(sorted.map((x) => x.id)).toEqual(['10', '20', '30']);
    expect(sorted[0]?.name).toBe('Café');
    expect(sorted[1]?.name).toBe('Café');
    expect(sorted[2]?.name).toBe('日本');
  });
});
