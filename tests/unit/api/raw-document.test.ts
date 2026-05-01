/**
 * Unit tests for `analyzeRawDocument` (M6 close P1 fix).
 *
 * Covers each branch of the analyzer: parse failure, fragment-only
 * documents, mutation gate (with and without --allow-mutation),
 * subscription rejection, the three op-count cases for operationName
 * selection, and every disagreement variant on --operation-name.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRawDocument } from '../../../src/api/raw-document.js';
import { UsageError } from '../../../src/utils/errors.js';

describe('analyzeRawDocument — parse failures', () => {
  it('throws usage_error on syntactically invalid GraphQL', () => {
    expect(() =>
      analyzeRawDocument({
        query: '{ me { id',
        explicitOperationName: undefined,
        allowMutation: false,
      }),
    ).toThrow(UsageError);
  });

  it('throws usage_error on a fragment-only document', () => {
    expect(() =>
      analyzeRawDocument({
        query: 'fragment X on Me { id }',
        explicitOperationName: undefined,
        allowMutation: false,
      }),
    ).toThrow(/no executable operations/iu);
  });
});

describe('analyzeRawDocument — single anonymous operation', () => {
  it('returns operationName=undefined for `{ me { id } }`', () => {
    const r = analyzeRawDocument({
      query: '{ me { id } }',
      explicitOperationName: undefined,
      allowMutation: false,
    });
    expect(r.operationName).toBeUndefined();
    expect(r.selectedOperationKind).toBe('query');
    expect(r.operations).toHaveLength(1);
    expect(r.operations[0]).toEqual({
      operation: 'query',
      name: undefined,
    });
    expect(r.hasMutation).toBe(false);
    expect(r.hasSubscription).toBe(false);
  });

  it('rejects --operation-name set when only op is anonymous', () => {
    expect(() =>
      analyzeRawDocument({
        query: '{ me { id } }',
        explicitOperationName: 'Foo',
        allowMutation: false,
      }),
    ).toThrow(/anonymous/iu);
  });
});

describe('analyzeRawDocument — single named operation', () => {
  it('returns the operation name for `query Foo { me { id } }`', () => {
    const r = analyzeRawDocument({
      query: 'query Foo { me { id } }',
      explicitOperationName: undefined,
      allowMutation: false,
    });
    expect(r.operationName).toBe('Foo');
  });

  it('accepts a matching --operation-name', () => {
    const r = analyzeRawDocument({
      query: 'query Foo { me { id } }',
      explicitOperationName: 'Foo',
      allowMutation: false,
    });
    expect(r.operationName).toBe('Foo');
  });

  it('rejects a mismatched --operation-name', () => {
    expect(() =>
      analyzeRawDocument({
        query: 'query Foo { me { id } }',
        explicitOperationName: 'Bar',
        allowMutation: false,
      }),
    ).toThrow(/doesn't match/iu);
  });
});

describe('analyzeRawDocument — multi-operation documents', () => {
  it('requires --operation-name when more than one op is present', () => {
    expect(() =>
      analyzeRawDocument({
        query: 'query A { me { id } } query B { me { name } }',
        explicitOperationName: undefined,
        allowMutation: false,
      }),
    ).toThrow(/operation-name/iu);
  });

  it('selects by --operation-name when one matches', () => {
    const r = analyzeRawDocument({
      query: 'query A { me { id } } query B { me { name } }',
      explicitOperationName: 'B',
      allowMutation: false,
    });
    expect(r.operationName).toBe('B');
    expect(r.operations).toHaveLength(2);
  });

  it('rejects --operation-name when none of the ops match', () => {
    expect(() =>
      analyzeRawDocument({
        query: 'query A { me { id } } query B { me { name } }',
        explicitOperationName: 'C',
        allowMutation: false,
      }),
    ).toThrow(/doesn't match any operation/iu);
  });
});

describe('analyzeRawDocument — mutation gate', () => {
  it('rejects mutations when allowMutation=false', () => {
    expect(() =>
      analyzeRawDocument({
        query: 'mutation { create_workspace(name: "X", kind: open) { id } }',
        explicitOperationName: undefined,
        allowMutation: false,
      }),
    ).toThrow(/blocked by default/iu);
  });

  it('rejects multi-op documents that mix queries and mutations', () => {
    // The mutation gate fires before the operationName selection,
    // so even if `--operation-name` would have selected the query, the
    // presence of a mutation in the document still triggers a reject.
    expect(() =>
      analyzeRawDocument({
        query:
          'query Read { me { id } } mutation Write { create_workspace(name: "X", kind: open) { id } }',
        explicitOperationName: 'Read',
        allowMutation: false,
      }),
    ).toThrow(/mutation/iu);
  });

  it('accepts mutations when allowMutation=true', () => {
    const r = analyzeRawDocument({
      query:
        'mutation Bump { create_workspace(name: "X", kind: open) { id } }',
      explicitOperationName: undefined,
      allowMutation: true,
    });
    expect(r.operationName).toBe('Bump');
    expect(r.hasMutation).toBe(true);
  });

  it('does not match the literal string "mutation" outside an operation keyword', () => {
    // Field named `mutation_test` is a query field, not a mutation.
    // A naive `.includes('mutation')` check would mis-flag this; the
    // AST walk gets it right.
    const r = analyzeRawDocument({
      query: '{ mutation_test { id } }',
      explicitOperationName: undefined,
      allowMutation: false,
    });
    expect(r.hasMutation).toBe(false);
    expect(r.operations[0]?.operation).toBe('query');
  });

  it('does not match a comment containing "mutation"', () => {
    const r = analyzeRawDocument({
      query: '# comment about the mutation API\n{ me { id } }',
      explicitOperationName: undefined,
      allowMutation: false,
    });
    expect(r.hasMutation).toBe(false);
  });
});

describe('analyzeRawDocument — subscription gate', () => {
  it('rejects subscriptions even with allowMutation=true', () => {
    expect(() =>
      analyzeRawDocument({
        query: 'subscription { itemUpdated { id } }',
        explicitOperationName: undefined,
        allowMutation: true,
      }),
    ).toThrow(/subscription/iu);
  });
});

describe('analyzeRawDocument — selectedOperationKind', () => {
  // Codex M6 pass-5 P2: dry-run gating must key off the *selected*
  // op's kind, not the document-wide `hasMutation`. A mixed doc
  // selecting a query is read-only at execution time.
  it('returns "query" when --operation-name selects the query in a mixed doc', () => {
    const r = analyzeRawDocument({
      query:
        'query Read { me { id } } mutation Write { create_workspace(name: "X", kind: open) { id } }',
      explicitOperationName: 'Read',
      allowMutation: true,
    });
    expect(r.selectedOperationKind).toBe('query');
    expect(r.operationName).toBe('Read');
    expect(r.hasMutation).toBe(true);
  });

  it('returns "mutation" when --operation-name selects the mutation in a mixed doc', () => {
    const r = analyzeRawDocument({
      query:
        'query Read { me { id } } mutation Write { create_workspace(name: "X", kind: open) { id } }',
      explicitOperationName: 'Write',
      allowMutation: true,
    });
    expect(r.selectedOperationKind).toBe('mutation');
    expect(r.operationName).toBe('Write');
  });

  it('returns the kind directly for a single-op doc', () => {
    const r = analyzeRawDocument({
      query:
        'mutation Bump { create_workspace(name: "X", kind: open) { id } }',
      explicitOperationName: undefined,
      allowMutation: true,
    });
    expect(r.selectedOperationKind).toBe('mutation');
  });
});
