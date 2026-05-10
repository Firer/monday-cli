import { describe, expect, it } from 'vitest';
import { isENOENT } from '../../../src/utils/fs.js';

describe('isENOENT', () => {
  it('returns true for a Node Error with code "ENOENT"', () => {
    const err = Object.assign(new Error('file not found'), {
      code: 'ENOENT',
    });
    expect(isENOENT(err)).toBe(true);
  });

  it('returns false for a Node Error with a different code', () => {
    const err = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    expect(isENOENT(err)).toBe(false);
  });

  it('returns false for a plain Error without a `code` property', () => {
    expect(isENOENT(new Error('something else'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isENOENT(null)).toBe(false);
  });

  it('returns false for a non-object value (string)', () => {
    expect(isENOENT('ENOENT')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isENOENT(undefined)).toBe(false);
  });

  it('treats a plain object literal with code:"ENOENT" as ENOENT', () => {
    // The helper checks the shape, not the prototype — a fixture
    // that hand-shapes an object with code:"ENOENT" still matches.
    expect(isENOENT({ code: 'ENOENT' })).toBe(true);
  });
});
