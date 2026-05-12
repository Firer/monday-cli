/**
 * Unit tests for `src/utils/json.ts` (R-NEW-27 `isPlainObject` +
 * R-NEW-42 `parseJsonArg` lifts).
 *
 * `isPlainObject` is exercised indirectly across the codebase
 * (4 production sites + 2 test sites pre-lift); the direct
 * tests below pin the branch matrix so a future refactor that
 * accidentally widens the type guard surfaces inline.
 *
 * `parseJsonArg` is exercised by the 3 consumer sites
 * (`monday raw` / `board column-create` / `webhook create`)
 * via their integration tests; the direct tests below cover
 * the helper's signature + the `details === undefined`
 * branch the integration consumers don't exercise (all 3
 * pass `details`).
 */
import { describe, expect, it } from 'vitest';
import { isPlainObject, parseJsonArg } from '../../../src/utils/json.js';
import { UsageError } from '../../../src/utils/errors.js';

describe('isPlainObject', () => {
  it('narrows plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('rejects arrays + null + primitives', () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject('s')).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
  });
});

describe('parseJsonArg', () => {
  it('returns the parsed value for well-formed JSON', () => {
    expect(parseJsonArg('{"a":1}', { context: 'x' })).toEqual({ a: 1 });
    expect(parseJsonArg('[1,2]', { context: 'x' })).toEqual([1, 2]);
    expect(parseJsonArg('null', { context: 'x' })).toBeNull();
    expect(parseJsonArg('42', { context: 'x' })).toBe(42);
    expect(parseJsonArg('"hello"', { context: 'x' })).toBe('hello');
  });

  it('throws UsageError on malformed JSON with the context + parse-error interpolated', () => {
    expect(() => parseJsonArg('{not-json', { context: 'monday foo: bad input' })).toThrow(
      UsageError,
    );
    try {
      parseJsonArg('{not-json', { context: 'monday foo: bad input' });
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const u = err as UsageError;
      expect(u.code).toBe('usage_error');
      // Message includes the context AND the parse-error text
      expect(u.message).toMatch(/^monday foo: bad input \(/u);
    }
  });

  it('threads details verbatim onto the UsageError envelope', () => {
    try {
      parseJsonArg('{not-json', {
        context: 'x',
        details: { board_id: '12345', hint: 'check syntax' },
      });
    } catch (err) {
      const u = err as UsageError;
      expect(u.details).toEqual({ board_id: '12345', hint: 'check syntax' });
    }
  });

  it('omits details when not supplied', () => {
    // Covers the `options.details === undefined` branch the 3
    // consumer sites don't exercise (they all pass details).
    try {
      parseJsonArg('{not-json', { context: 'x' });
    } catch (err) {
      const u = err as UsageError;
      expect(u.details).toBeUndefined();
    }
  });

  it('preserves the underlying SyntaxError as cause', () => {
    try {
      parseJsonArg('{not-json', { context: 'x' });
    } catch (err) {
      const u = err as UsageError;
      expect(u.cause).toBeInstanceOf(SyntaxError);
    }
  });
});
