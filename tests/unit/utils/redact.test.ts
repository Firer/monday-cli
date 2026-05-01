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

  it('extraKeys with no match leaves the value untouched', () => {
    // Drives the "extraKeys loop iterates without matching" branch
    // — extraKey list is non-empty but the input key doesn't match.
    expect(redact({ harmless: 'value' }, { extraKeys: ['secretField'] })).toEqual(
      { harmless: 'value' },
    );
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

describe('redact — value-scanning (Codex review §1)', () => {
  const TOKEN = 'tok-leakcheck-xxxx';

  it('scrubs the token from a plain string value', () => {
    const out = redact({ url: `https://api.monday.com?t=${TOKEN}` }, {
      secrets: [TOKEN],
    }) as { url: string };
    expect(out.url).toBe('https://api.monday.com?t=[REDACTED]');
  });

  it('scrubs multiple occurrences in a single string', () => {
    const out = redact(
      { line: `${TOKEN} ${TOKEN} ${TOKEN}` },
      { secrets: [TOKEN] },
    ) as { line: string };
    expect(out.line).toBe('[REDACTED] [REDACTED] [REDACTED]');
  });

  it('scrubs the token from Error.message', () => {
    const err = new Error(`request failed with token=${TOKEN}`);
    const out = redact(err, { secrets: [TOKEN] }) as { message: string };
    expect(out.message).toBe('request failed with token=[REDACTED]');
  });

  it('scrubs the token from Error.stack', () => {
    const err = new Error('boom');
    err.stack = `Error: boom (auth=${TOKEN})\n    at frame:1`;
    const out = redact(err, { secrets: [TOKEN] }) as { stack: string };
    expect(out.stack.includes(TOKEN)).toBe(false);
    expect(out.stack).toContain('[REDACTED]');
  });

  it('handles an Error with stack=undefined (custom subclass)', () => {
    // Some custom Error subclasses or env-cleaned errors don't carry
    // `.stack`. The redactor's Error-branch must not blow up — it
    // should just omit the stack from the cloned shape.
    const err = new Error('boom');
    Object.defineProperty(err, 'stack', { value: undefined, configurable: true });
    const out = redact(err, { secrets: [TOKEN] }) as Record<string, unknown>;
    expect(out.message).toBe('boom');
    expect(out).not.toHaveProperty('stack');
  });

  it('scrubs the token from a chained Error.cause.message', () => {
    const inner = new Error(`upstream said: ${TOKEN}`);
    const outer = new Error('outer', { cause: inner });
    const out = redact(outer, { secrets: [TOKEN] }) as {
      cause: { message: string };
    };
    expect(out.cause.message).toBe('upstream said: [REDACTED]');
  });

  it('scrubs the token from logger string payloads', () => {
    const out = redact(`auth=${TOKEN}`, { secrets: [TOKEN] }) as string;
    expect(out).toBe('auth=[REDACTED]');
  });

  it('scrubs the token even when it appears under a non-sensitive key', () => {
    const out = redact(
      { description: `created with auth=${TOKEN}`, id: '5001' },
      { secrets: [TOKEN] },
    ) as { description: string; id: string };
    expect(out.description).toBe('created with auth=[REDACTED]');
    expect(out.id).toBe('5001');
  });

  it('scrubs lowercase `authorization` header values via key path AND value-scan as belt-and-braces', () => {
    // Already key-redacted; just confirm secret-scanning doesn't
    // accidentally undo the [REDACTED] marker on re-application.
    const out = redact(
      { headers: { authorization: TOKEN, 'x-trace': `tagged-${TOKEN}` } },
      { secrets: [TOKEN] },
    ) as { headers: { authorization: string; 'x-trace': string } };
    expect(out.headers.authorization).toBe('[REDACTED]');
    expect(out.headers['x-trace']).toBe('tagged-[REDACTED]');
  });

  it('ignores secrets shorter than the floor (false-positive guard)', () => {
    const out = redact({ note: 'hello world' }, { secrets: ['o'] }) as {
      note: string;
    };
    // Single-char secret skipped — note left intact.
    expect(out.note).toBe('hello world');
  });

  it('handles a plain header-shaped record', () => {
    const headersObj = {
      authorization: TOKEN,
      'content-type': 'application/json',
    };
    const out = redact({ headers: headersObj }, { secrets: [TOKEN] }) as {
      headers: { authorization: string };
    };
    expect(out.headers.authorization).toBe('[REDACTED]');
  });

  it('scrubs the token from a real Headers instance (key path strips it)', () => {
    // `Headers` is not a plain object — `Object.entries` returns
    // empty. Callers that pass `Headers` directly get a deep-clone
    // that drops the entries; the token never reaches output. This
    // documents the actual behaviour rather than claiming Headers
    // gets walked like a Map.
    const headers = new Headers({ authorization: TOKEN });
    const out = redact({ headers }, { secrets: [TOKEN] }) as {
      headers: Record<string, unknown>;
    };
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('scrubs the token from a Map of headers via value-scan', () => {
    // Map isn't walked as an object either, but if a caller has
    // already converted to a plain `{key: value}` shape (which the
    // transport does) and the token is in any string value, the
    // value-scan layer catches it.
    const flat = Object.fromEntries(
      new Map<string, string>([['authorization', TOKEN]]),
    );
    const out = redact(flat, { secrets: [TOKEN] }) as Record<string, string>;
    // Both the key path AND the value-scan path apply.
    expect(out.authorization).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('does not over-scrub when secret is empty', () => {
    const out = redact({ note: 'hello' }, { secrets: [''] }) as {
      note: string;
    };
    expect(out.note).toBe('hello');
  });
});
