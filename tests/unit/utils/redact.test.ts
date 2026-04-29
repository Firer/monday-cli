import { describe, expect, it } from 'vitest';
import { redact } from '../../../src/utils/redact.js';

describe('redact — defaults', () => {
  it('redacts apiToken', () => {
    expect(redact({ apiToken: 'secret-1234' })).toEqual({
      apiToken: '[REDACTED]',
    });
  });

  it('redacts Authorization header', () => {
    expect(
      redact({ headers: { Authorization: 'tok-abc', 'Content-Type': 'json' } }),
    ).toEqual({
      headers: { Authorization: '[REDACTED]', 'Content-Type': 'json' },
    });
  });

  it('redacts MONDAY_API_TOKEN', () => {
    expect(redact({ env: { MONDAY_API_TOKEN: 'secret', PATH: '/usr/bin' } }))
      .toEqual({ env: { MONDAY_API_TOKEN: '[REDACTED]', PATH: '/usr/bin' } });
  });

  it('matches sensitive keys case-insensitively', () => {
    expect(redact({ AUTHORIZATION: 'x' })).toEqual({
      AUTHORIZATION: '[REDACTED]',
    });
    expect(redact({ apitoken: 'x' })).toEqual({ apitoken: '[REDACTED]' });
  });

  it('redacts via the generic *token* / *secret* pattern', () => {
    const out = redact({
      accessToken: 'a',
      RefreshToken: 'b',
      clientSecret: 'c',
      api_key: 'd',
      apiKey: 'e',
      password: 'f',
      bearerToken: 'g',
    });
    expect(out).toEqual({
      accessToken: '[REDACTED]',
      RefreshToken: '[REDACTED]',
      clientSecret: '[REDACTED]',
      api_key: '[REDACTED]',
      apiKey: '[REDACTED]',
      password: '[REDACTED]',
      bearerToken: '[REDACTED]',
    });
  });

  it('leaves non-sensitive keys untouched', () => {
    expect(redact({ name: 'Alice', count: 3, active: true })).toEqual({
      name: 'Alice',
      count: 3,
      active: true,
    });
  });
});

describe('redact — recursion', () => {
  it('redacts in deeply nested objects', () => {
    expect(
      redact({
        request: {
          headers: { Authorization: 'tok-abc' },
          body: { ok: true },
        },
      }),
    ).toEqual({
      request: {
        headers: { Authorization: '[REDACTED]' },
        body: { ok: true },
      },
    });
  });

  it('redacts inside arrays of objects', () => {
    const out = redact({
      requests: [
        { id: 1, apiToken: 'a' },
        { id: 2, apiToken: 'b' },
      ],
    });
    expect(out).toEqual({
      requests: [
        { id: 1, apiToken: '[REDACTED]' },
        { id: 2, apiToken: '[REDACTED]' },
      ],
    });
  });

  it('preserves array order', () => {
    const out = redact([{ apiToken: 'a' }, { name: 'b' }]) as unknown[];
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ apiToken: '[REDACTED]' });
    expect(out[1]).toEqual({ name: 'b' });
  });
});

describe('redact — primitives & nullish', () => {
  it('returns primitives unchanged', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBeUndefined();
  });
});

describe('redact — circular references', () => {
  it('terminates on a self-referencing object', () => {
    interface Node {
      apiToken: string;
      self?: Node;
    }
    const node: Node = { apiToken: 'leak' };
    node.self = node;

    const out = redact(node) as { apiToken: string; self: unknown };
    expect(out.apiToken).toBe('[REDACTED]');
    expect(out.self).toBe('[Circular]');
  });

  it('terminates on a mutual circular pair', () => {
    interface A {
      kind: 'a';
      b?: B;
    }
    interface B {
      kind: 'b';
      apiToken: string;
      a?: A;
    }
    const a: A = { kind: 'a' };
    const b: B = { kind: 'b', apiToken: 'leak' };
    a.b = b;
    b.a = a;

    const out = redact(a) as { kind: 'a'; b: { apiToken: string; a: unknown } };
    expect(out.b.apiToken).toBe('[REDACTED]');
    expect(out.b.a).toBe('[Circular]');
  });
});

describe('redact — Error instances', () => {
  it('round-trips Error fields and redacts the cause chain', () => {
    const inner = new Error('inner');
    Object.assign(inner, { apiToken: 'leak' });
    const outer = new Error('outer', { cause: inner });
    Object.assign(outer, { code: 'config_error' });

    const out = redact(outer) as {
      name: string;
      message: string;
      cause: { apiToken: string };
      code: string;
    };
    expect(out.name).toBe('Error');
    expect(out.message).toBe('outer');
    expect(out.code).toBe('config_error');
    expect(out.cause.apiToken).toBe('[REDACTED]');
  });

  it('does not blow up on a circular Error.cause', () => {
    const err = new Error('boom');
    Object.assign(err, { cause: err });
    expect(() => redact(err)).not.toThrow();
  });
});

describe('redact — extension points', () => {
  it('honours extraKeys', () => {
    expect(redact({ tokenLike: 'a' }, { extraKeys: ['tokenLike'] })).toEqual({
      tokenLike: '[REDACTED]',
    });
  });

  it('honours extraPattern', () => {
    expect(
      redact({ wsKey: 'a', other: 'b' }, { extraPattern: /^ws/iu }),
    ).toEqual({ wsKey: '[REDACTED]', other: 'b' });
  });

  it('honours a custom placeholder', () => {
    expect(redact({ apiToken: 'x' }, { placeholder: '<hidden>' })).toEqual({
      apiToken: '<hidden>',
    });
  });
});

describe('redact — token-string scrub end-to-end', () => {
  it('the literal token never appears in the JSON-stringified output', () => {
    const literal = 'tok-leakcheck-xxxx';
    const payload = {
      env: { MONDAY_API_TOKEN: literal },
      headers: { Authorization: literal },
      cause: new Error('boom') as unknown as Record<string, unknown>,
    };
    payload.cause.apiToken = literal;
    const stringified = JSON.stringify(redact(payload));
    expect(stringified.includes(literal)).toBe(false);
  });
});
