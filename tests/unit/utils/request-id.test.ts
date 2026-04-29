import { describe, expect, it } from 'vitest';
import {
  defaultRequestIdGenerator,
  fixedRequestIdGenerator,
} from '../../../src/utils/request-id.js';

describe('defaultRequestIdGenerator', () => {
  it('produces a UUID-shaped string', () => {
    expect(defaultRequestIdGenerator()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  it('produces different values across calls', () => {
    const a = defaultRequestIdGenerator();
    const b = defaultRequestIdGenerator();
    expect(a).not.toBe(b);
  });
});

describe('fixedRequestIdGenerator', () => {
  it('yields each canned ID in order', () => {
    const gen = fixedRequestIdGenerator(['id-1', 'id-2', 'id-3']);
    expect(gen()).toBe('id-1');
    expect(gen()).toBe('id-2');
    expect(gen()).toBe('id-3');
  });

  it('falls back to a real UUID once the sequence is exhausted', () => {
    const gen = fixedRequestIdGenerator(['only']);
    expect(gen()).toBe('only');
    expect(gen()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  it('handles an empty sequence gracefully', () => {
    const gen = fixedRequestIdGenerator([]);
    expect(gen()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });
});
