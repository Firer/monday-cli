import { describe, expect, it } from 'vitest';
import { ME_TOKENS, isMeToken } from '../../../src/api/me-token.js';

describe('isMeToken', () => {
  it.each([
    ['me'],
    ['ME'],
    ['Me'],
    ['mE'],
    [' me '],
    ['  ME  '],
    ['\tme\n'],
  ])('matches %j (case-insensitive after trim)', (input) => {
    expect(isMeToken(input)).toBe(true);
  });

  it.each([
    [''],
    [' '],
    ['mee'],
    ['m'],
    ['my'],
    ['me,me'],
    ['alice@example.com'],
    ['12345'],
    ['0'],
    ['mE!'],
    [' me me '],
  ])('rejects %j', (input) => {
    expect(isMeToken(input)).toBe(false);
  });
});

describe('ME_TOKENS', () => {
  it('contains exactly the v0.1 alias set (lowercase canonical forms)', () => {
    // Frozen contract — extending the array is the v0.2 extension
    // path. Dropping `me` is a breaking change. Pin the exact shape
    // so a future contributor accidentally widening the array
    // without updating cli-design.md fails CI.
    expect(ME_TOKENS).toEqual(['me']);
  });

  it('every entry is its own lowercase form', () => {
    // The helper lowercases the input before checking against
    // `ME_TOKENS`; entries here must already be lowercase or the
    // match will silently miss the lowercase input.
    for (const token of ME_TOKENS) {
      expect(token).toBe(token.toLowerCase());
    }
  });
});
