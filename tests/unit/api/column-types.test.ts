import { describe, expect, it } from 'vitest';
import {
  WRITABLE_COLUMN_TYPES,
  isWritableColumnType,
  parseColumnSettings,
} from '../../../src/api/column-types.js';

describe('WRITABLE_COLUMN_TYPES', () => {
  it('matches the v0.1 §5.3.3 allowlist exactly, in declared order', () => {
    expect(WRITABLE_COLUMN_TYPES).toEqual([
      'text',
      'long_text',
      'numbers',
      'status',
      'dropdown',
      'date',
      'people',
    ]);
  });
});

describe('isWritableColumnType', () => {
  it.each(WRITABLE_COLUMN_TYPES)('returns true for allowlisted type %s', (type) => {
    expect(isWritableColumnType(type)).toBe(true);
  });

  it.each([
    'mirror',
    'formula',
    'battery',
    'item_assignees',
    'time_tracking',
    'auto_number',
    'creation_log',
    'last_updated',
    'phone',
    'rating',
    '',
    'TEXT', // case-sensitive — Monday types are stable lowercase strings
  ])('returns false for non-allowlisted type %s', (type) => {
    expect(isWritableColumnType(type)).toBe(false);
  });

  it('narrows the input type so callers can switch without re-casting', () => {
    const candidate = 'status' as string;
    if (isWritableColumnType(candidate)) {
      // Compile-time check: this would not type-check if the predicate
      // didn't narrow `candidate` to `WritableColumnType`.
      const narrowed: 'text' | 'long_text' | 'numbers' | 'status' | 'dropdown' | 'date' | 'people' = candidate;
      expect(narrowed).toBe('status');
    } else {
      throw new Error('expected status to be writable');
    }
  });
});

describe('parseColumnSettings', () => {
  it('returns null for null input', () => {
    expect(parseColumnSettings(null)).toBeNull();
  });

  it('returns null for empty-string input', () => {
    expect(parseColumnSettings('')).toBeNull();
  });

  it('returns null for malformed JSON without throwing', () => {
    expect(parseColumnSettings('not-json')).toBeNull();
    expect(parseColumnSettings('{ unterminated')).toBeNull();
    expect(parseColumnSettings('{"a":}')).toBeNull();
  });

  it('parses well-formed JSON objects', () => {
    expect(parseColumnSettings('{"labels":{"0":"Backlog"}}')).toEqual({
      labels: { '0': 'Backlog' },
    });
  });

  it('parses well-formed JSON arrays', () => {
    expect(parseColumnSettings('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses JSON primitives — Monday occasionally returns them', () => {
    expect(parseColumnSettings('null')).toBeNull();
    expect(parseColumnSettings('42')).toBe(42);
    expect(parseColumnSettings('"hi"')).toBe('hi');
    expect(parseColumnSettings('true')).toBe(true);
  });
});
