import { describe, expect, it } from 'vitest';
import {
  buildFilterRules,
  buildQueryParams,
  parseFilterJson,
  parseWhereSyntax,
  type WhereClause,
} from '../../../src/api/filters.js';
import type { BoardMetadata } from '../../../src/api/board-metadata.js';
import { ApiError, UsageError } from '../../../src/utils/errors.js';

const metadata = (
  columns: readonly { readonly id: string; readonly title: string; readonly type?: string }[],
): BoardMetadata => ({
  id: '111',
  name: 'Tasks',
  description: null,
  state: 'active',
  board_kind: 'public',
  board_folder_id: null,
  workspace_id: '5',
  url: null,
  hierarchy_type: null,
  is_leaf: true,
  updated_at: null,
  groups: [],
  columns: columns.map((c) => ({
    id: c.id,
    title: c.title,
    type: c.type ?? 'status',
    description: null,
    archived: null,
    settings_str: null,
    width: null,
  })),
});

describe('parseWhereSyntax — basic operators', () => {
  it('parses --where status=Done', () => {
    const out = parseWhereSyntax('status=Done');
    expect(out.token).toBe('status');
    expect(out.operator.kind).toBe('equals');
    expect(out.operator.literal).toBe('=');
    expect(out.value).toBe('Done');
  });

  it('parses != as not_equals', () => {
    const out = parseWhereSyntax('status!=Done');
    expect(out.operator.kind).toBe('not_equals');
    expect(out.value).toBe('Done');
  });

  it('parses ~= as contains_text', () => {
    const out = parseWhereSyntax('name~=login');
    expect(out.operator.kind).toBe('contains_text');
    expect(out.value).toBe('login');
  });

  it('parses < / <= / > / >= correctly with longest-match-at-position', () => {
    expect(parseWhereSyntax('priority>=3').operator.kind).toBe('greater_than_or_equals');
    expect(parseWhereSyntax('priority>3').operator.kind).toBe('greater_than');
    expect(parseWhereSyntax('priority<=3').operator.kind).toBe('lower_than_or_equals');
    expect(parseWhereSyntax('priority<3').operator.kind).toBe('lower_than');
  });

  it('parses :is_empty as a unary suffix', () => {
    const out = parseWhereSyntax('due:is_empty');
    expect(out.token).toBe('due');
    expect(out.operator.kind).toBe('is_empty');
    expect(out.operator.arity).toBe('unary');
    expect(out.value).toBeUndefined();
  });

  it('parses :is_not_empty without confusing it with :is_empty', () => {
    const out = parseWhereSyntax('due:is_not_empty');
    expect(out.operator.kind).toBe('is_not_empty');
    expect(out.value).toBeUndefined();
  });

  it('preserves leading/trailing whitespace handling — outer trim only', () => {
    // Outer trim is documented; internal whitespace passes through to
    // the resolver (which does its own NFC + collapse). The first
    // char of the token after trim is "s", not " ".
    const out = parseWhereSyntax('  status=Done  ');
    expect(out.token).toBe('status');
    expect(out.value).toBe('Done');
  });
});

describe('parseWhereSyntax — adversarial', () => {
  it('column titles containing operators split on the FIRST operator (documented)', () => {
    // §5.3 step 2.b: the split happens on the first =. The resulting
    // token "Plan A" is what gets resolved — the column "Plan A=B"
    // would not match unless the user uses an explicit prefix or
    // --filter-json. Asserting the documented split here so a future
    // "be clever about it" patch fails loudly.
    const out = parseWhereSyntax('Plan A=B=approved');
    expect(out.token).toBe('Plan A');
    expect(out.value).toBe('B=approved');
  });

  it('operators inside the value pass through unchanged', () => {
    // status~=foo=bar should parse as status ~= "foo=bar" (the FIRST
    // ~= wins, leaving foo=bar in the value half).
    const out = parseWhereSyntax('status~=foo=bar');
    expect(out.operator.kind).toBe('contains_text');
    expect(out.value).toBe('foo=bar');
  });

  it('Unicode column titles in the token round-trip into the value', () => {
    const out = parseWhereSyntax('Café=Open');
    expect(out.token).toBe('Café');
    expect(out.value).toBe('Open');
  });

  it('rejects empty input', () => {
    expect(() => parseWhereSyntax('')).toThrow(UsageError);
    expect(() => parseWhereSyntax('   ')).toThrow(UsageError);
  });

  it('rejects an operator-only clause (missing token)', () => {
    expect(() => parseWhereSyntax('=Done')).toThrow(UsageError);
    expect(() => parseWhereSyntax(':is_empty')).toThrow(UsageError);
  });

  it('rejects an empty value after a binary operator', () => {
    expect(() => parseWhereSyntax('status=')).toThrow(UsageError);
    expect(() => parseWhereSyntax('priority>=')).toThrow(UsageError);
  });

  it('rejects clauses with no operator at all', () => {
    expect(() => parseWhereSyntax('justatoken')).toThrow(/no recognised operator/);
  });
});

describe('buildFilterRules', () => {
  const meta = metadata([
    { id: 'status_4', title: 'Status', type: 'status' },
    { id: 'person', title: 'Owner', type: 'people' },
    { id: 'date4', title: 'Due date', type: 'date' },
    { id: 'numbers', title: 'Priority', type: 'numbers' },
  ]);
  const resolveMe = (): Promise<string> => Promise.resolve('user-99');

  it('emits any_of compare_value as an array for =', async () => {
    const clauses: readonly WhereClause[] = [parseWhereSyntax('status=Done')];
    const out = await buildFilterRules({ metadata: meta, resolveMe, clauses });
    expect(out.queryParams?.rules).toEqual([
      { column_id: 'status_4', operator: 'any_of', compare_value: ['Done'] },
    ]);
    expect(out.warnings).toEqual([]);
  });

  it('emits not_any_of for !=', async () => {
    const out = await buildFilterRules({
      metadata: meta,
      resolveMe,
      clauses: [parseWhereSyntax('status!=Backlog')],
    });
    expect(out.queryParams?.rules[0]).toEqual({
      column_id: 'status_4',
      operator: 'not_any_of',
      compare_value: ['Backlog'],
    });
  });

  it('emits contains_text as bare string for ~=', async () => {
    const m = metadata([{ id: 'name', title: 'Name', type: 'text' }]);
    const out = await buildFilterRules({
      metadata: m,
      resolveMe,
      clauses: [parseWhereSyntax('name~=login')],
    });
    expect(out.queryParams?.rules[0]?.operator).toBe('contains_text');
    expect(out.queryParams?.rules[0]?.compare_value).toBe('login');
  });

  it('emits scalar compare_value for numeric < / <= / > / >=', async () => {
    const out = await buildFilterRules({
      metadata: meta,
      resolveMe,
      clauses: [parseWhereSyntax('Priority>=3')],
    });
    expect(out.queryParams?.rules[0]).toEqual({
      column_id: 'numbers',
      operator: 'greater_than_or_equals',
      compare_value: '3',
    });
  });

  it('emits no compare_value for unary :is_empty / :is_not_empty', async () => {
    const out = await buildFilterRules({
      metadata: meta,
      resolveMe,
      clauses: [parseWhereSyntax('Due date:is_empty')],
    });
    expect(out.queryParams?.rules[0]).toEqual({
      column_id: 'date4',
      operator: 'is_empty',
    });
  });

  it('resolves `me` against a people column via resolveMe', async () => {
    let calls = 0;
    const out = await buildFilterRules({
      metadata: meta,
      resolveMe: () => {
        calls++;
        return Promise.resolve('user-99');
      },
      clauses: [parseWhereSyntax('Owner=me')],
    });
    expect(out.queryParams?.rules[0]?.compare_value).toEqual(['user-99']);
    expect(calls).toBe(1);
  });

  it('caches `me` resolution across multiple clauses', async () => {
    let calls = 0;
    const out = await buildFilterRules({
      metadata: meta,
      resolveMe: () => {
        calls++;
        return Promise.resolve('user-99');
      },
      clauses: [
        parseWhereSyntax('Owner=me'),
        parseWhereSyntax('Owner!=me'),
      ],
    });
    expect(calls).toBe(1);
    expect(out.queryParams?.rules).toHaveLength(2);
  });

  it('does NOT apply `me` sugar to non-people columns', async () => {
    const out = await buildFilterRules({
      metadata: meta,
      resolveMe: () => {
        throw new Error('should not be called');
      },
      clauses: [parseWhereSyntax('Status=me')],
    });
    expect(out.queryParams?.rules[0]?.compare_value).toEqual(['me']);
  });

  it('AND-joins multiple clauses (no nested groups in v0.1)', async () => {
    const out = await buildFilterRules({
      metadata: meta,
      resolveMe,
      clauses: [
        parseWhereSyntax('Status=Done'),
        parseWhereSyntax('Owner=alice@example.com'),
      ],
    });
    expect(out.queryParams?.rules).toHaveLength(2);
  });

  it('column_token_collision surfaces as a warning, ID match wins', async () => {
    const collisionMeta = metadata([
      { id: 'status', title: 'Other Title', type: 'status' },
      { id: 'banana', title: 'status', type: 'status' },
    ]);
    const out = await buildFilterRules({
      metadata: collisionMeta,
      resolveMe,
      clauses: [parseWhereSyntax('status=Done')],
    });
    expect(out.queryParams?.rules[0]?.column_id).toBe('status');
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]?.code).toBe('column_token_collision');
  });

  it('raises ambiguous_column when two titles NFC-equal each other', async () => {
    const ambiguousMeta = metadata([
      { id: 'a1', title: 'Owner', type: 'people' },
      { id: 'a2', title: 'Owner', type: 'people' },
    ]);
    await expect(
      buildFilterRules({
        metadata: ambiguousMeta,
        resolveMe,
        clauses: [parseWhereSyntax('Owner=alice@example.com')],
      }),
    ).rejects.toMatchObject({ code: 'ambiguous_column' });
  });

  it('raises column_not_found when the token resolves nowhere', async () => {
    await expect(
      buildFilterRules({
        metadata: meta,
        resolveMe,
        clauses: [parseWhereSyntax('NoSuchColumn=Done')],
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('honours the title:/id: prefix on the resolver', async () => {
    const out = await buildFilterRules({
      metadata: meta,
      resolveMe,
      clauses: [parseWhereSyntax('title:Status=Done')],
    });
    expect(out.queryParams?.rules[0]?.column_id).toBe('status_4');
  });

  it('handles NFC-distinct visually-identical column titles', async () => {
    // "Café" composed (one code point) vs "Café" decomposed (two
    // code points). After NFC normalisation both round-trip to the
    // same target.
    const composed = 'Café';
    const decomposed = 'Café';
    const m = metadata([{ id: 'cafe_1', title: composed, type: 'status' }]);
    const out = await buildFilterRules({
      metadata: m,
      resolveMe,
      clauses: [parseWhereSyntax(`${decomposed}=Open`)],
    });
    expect(out.queryParams?.rules[0]?.column_id).toBe('cafe_1');
  });

  it('returns queryParams: undefined for empty clauses', async () => {
    const out = await buildFilterRules({ metadata: meta, resolveMe, clauses: [] });
    expect(out.queryParams).toBeUndefined();
  });
});

describe('parseFilterJson', () => {
  it('returns the parsed object verbatim', () => {
    const out = parseFilterJson('{"rules":[{"column_id":"status","operator":"any_of","compare_value":["Done"]}]}');
    expect(out).toMatchObject({ rules: expect.any(Array) as unknown });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseFilterJson('{not json')).toThrow(UsageError);
  });

  it('rejects non-object JSON values', () => {
    expect(() => parseFilterJson('"string"')).toThrow(UsageError);
    expect(() => parseFilterJson('[]')).toThrow(UsageError);
    expect(() => parseFilterJson('null')).toThrow(UsageError);
  });
});

describe('buildQueryParams — top-level helper', () => {
  const meta = metadata([{ id: 'status_4', title: 'Status', type: 'status' }]);
  const resolveMe = (): Promise<string> => Promise.resolve('user-99');

  it('returns undefined when neither --where nor --filter-json is set', async () => {
    const out = await buildQueryParams({
      metadata: meta,
      resolveMe,
      whereClauses: [],
      filterJson: undefined,
    });
    expect(out.queryParams).toBeUndefined();
  });

  it('builds rules from --where', async () => {
    const out = await buildQueryParams({
      metadata: meta,
      resolveMe,
      whereClauses: ['status=Done'],
      filterJson: undefined,
    });
    expect(out.queryParams).toMatchObject({ rules: [{ column_id: 'status_4' }] });
  });

  it('passes --filter-json through verbatim', async () => {
    const json = '{"rules":[{"column_id":"foo","operator":"any_of","compare_value":["bar"]}]}';
    const out = await buildQueryParams({
      metadata: meta,
      resolveMe,
      whereClauses: [],
      filterJson: json,
    });
    expect(out.queryParams).toEqual({
      rules: [{ column_id: 'foo', operator: 'any_of', compare_value: ['bar'] }],
    });
  });

  it('rejects --where + --filter-json simultaneously', async () => {
    await expect(
      buildQueryParams({
        metadata: meta,
        resolveMe,
        whereClauses: ['status=Done'],
        filterJson: '{}',
      }),
    ).rejects.toThrow(UsageError);
  });
});
