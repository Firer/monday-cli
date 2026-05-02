import { describe, it, expect } from 'vitest';
import { injectComplexity, parseComplexity } from '../../../src/api/complexity.js';

describe('injectComplexity', () => {
  it('appends the selection inside a simple anonymous query', () => {
    const out = injectComplexity('{ me { id } }');
    expect(out.injected).toBe(true);
    expect(out.query).toContain('complexity { before after query reset_in_x_seconds }');
    expect(out.query.endsWith('}')).toBe(true);
    // Sanity: balanced braces.
    expect((out.query.match(/\{/gu) ?? []).length).toBe(
      (out.query.match(/\}/gu) ?? []).length,
    );
  });

  it('handles named query with variable declarations', () => {
    const out = injectComplexity(
      'query GetItem($id: ID!) { items(ids: [$id]) { id name } }',
    );
    expect(out.injected).toBe(true);
    expect(out.query).toContain('complexity {');
    expect(out.query).toMatch(/items\(ids: \[\$id\]\) \{ id name \}/u);
  });

  it('does not duplicate when complexity is already present', () => {
    const q = '{ me { id } complexity { before after query reset_in_x_seconds } }';
    const out = injectComplexity(q);
    expect(out.query).toBe(q);
    expect(out.injected).toBe(false);
  });

  it('handles mutations', () => {
    const out = injectComplexity(
      'mutation X { change_simple_column_value(item_id: 1, board_id: 2, column_id: "x", value: "y") { id } }',
    );
    expect(out.injected).toBe(true);
    expect(out.query).toContain('complexity {');
  });

  it('returns the input unchanged when no operation body is recognised', () => {
    expect(injectComplexity('not graphql')).toEqual({
      query: 'not graphql',
      injected: false,
    });
    expect(injectComplexity('')).toEqual({ query: '', injected: false });
  });

  it('does not get confused by braces inside string literals', () => {
    const q = 'query X { account { name(suffix: "{") } }';
    const out = injectComplexity(q);
    expect(out.injected).toBe(true);
    expect(out.query).toContain('complexity {');
    expect(out.query).toMatch(/name\(suffix: "\{"\)/u);
  });

  it('skips block-string literals when scanning braces', () => {
    const q = 'query Z { board(id: "1") { description(default: """{stuff}""") } }';
    const out = injectComplexity(q);
    expect(out.injected).toBe(true);
    expect(out.query).toContain('complexity {');
  });

  it('respects an explicit selection override', () => {
    const out = injectComplexity('{ me { id } }', {
      selection: 'complexity { query }',
    });
    expect(out.query).toContain('complexity { query }');
    expect(out.query).not.toContain('reset_in_x_seconds');
  });

  it('returns input unchanged on unbalanced braces (defensive)', () => {
    const q = '{ me { id }';
    expect(injectComplexity(q)).toEqual({ query: q, injected: false });
  });

  it('honours backslash escapes inside string literals', () => {
    // The escape branch in the brace-scanner: a `\"` inside a "-string
    // must not close the string. Without the branch, `"\""` would
    // close after the `"` and then the trailing `}` would prematurely
    // exit the body scan.
    const q = 'query E { account { name(suffix: "\\"end") } }';
    const out = injectComplexity(q);
    expect(out.injected).toBe(true);
    expect(out.query).toContain('complexity {');
  });

  it('returns input unchanged when braces close below depth zero', () => {
    // Stray `}` ahead of any open brace — the depth-negative branch
    // bails out via `return undefined` rather than scanning forever or
    // reporting a bogus end position.
    const q = '} query Bad { me { id } }';
    expect(injectComplexity(q)).toEqual({ query: q, injected: false });
  });
});

describe('parseComplexity', () => {
  it('extracts from a top-level body shape', () => {
    expect(
      parseComplexity({
        data: {
          me: { id: '1' },
          complexity: { before: 5_000_000, after: 4_999_999, query: 1, reset_in_x_seconds: 30 },
        },
      }),
    ).toEqual({ used: 1, remaining: 4_999_999, reset_in_seconds: 30 });
  });

  it('accepts a peeled `data` object', () => {
    expect(
      parseComplexity({
        complexity: { before: 0, after: 0, query: 0, reset_in_x_seconds: 0 },
      }),
    ).toEqual({ used: 0, remaining: 0, reset_in_seconds: 0 });
  });

  it('accepts the complexity leaf directly', () => {
    expect(
      parseComplexity({ before: 1, after: 2, query: 3, reset_in_x_seconds: 4 }),
    ).toEqual({ used: 3, remaining: 2, reset_in_seconds: 4 });
  });

  it('returns null when no complexity block is present', () => {
    expect(parseComplexity({ data: { me: { id: '1' } } })).toBeNull();
    expect(parseComplexity(null)).toBeNull();
    expect(parseComplexity('not an object')).toBeNull();
  });

  it('falls back through the alias names', () => {
    expect(
      parseComplexity({
        complexity: { used: 99, remaining: 1, reset_in_seconds: 7 },
      }),
    ).toEqual({ used: 99, remaining: 1, reset_in_seconds: 7 });
  });

  it('coerces non-finite numbers to 0 (defensive)', () => {
    expect(
      parseComplexity({
        complexity: { query: NaN, after: Infinity, reset_in_x_seconds: 'oops' },
      }),
    ).toEqual({ used: 0, remaining: 0, reset_in_seconds: 0 });
  });
});
