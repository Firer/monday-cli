/**
 * Complexity selection + extraction (`v0.1-plan.md` §3 M2,
 * `cli-design.md` §6.1).
 *
 * Two halves:
 *
 *  - **Injection.** When `--verbose` is on, every Monday GraphQL
 *    request gets a `complexity { used remaining reset_in_seconds }`
 *    selection appended at the operation root. This costs ~1
 *    complexity point per call but lets the CLI surface the budget
 *    in `meta.complexity` without a separate query. Without
 *    `--verbose`, `meta.complexity` is `null` per §6.1.
 *
 *  - **Extraction.** Reads the `complexity` field off the response
 *    body and projects the SDK's three integer fields (`query`,
 *    `after`, `reset_in_x_seconds`) onto the CLI's stable shape
 *    (`used`, `remaining`, `reset_in_seconds`). The CLI re-spells
 *    Monday's field names so a future API renaming doesn't ripple
 *    through every command's output schema.
 *
 * The injector lives at the *string* level rather than via an AST
 * because:
 *  - `graphql-request` ships no AST helper at the SDK we depend on;
 *    pulling in `graphql/parser` for one selection is a heavy cost.
 *  - The transformation is mechanical and bounded: locate the first
 *    top-level `query`/`mutation`/`{` and inject the field at the
 *    end of its outermost selection set. Edge cases (operation
 *    name, variable declarations, fragments) leave the injection
 *    site unchanged.
 *
 * The implementation is conservative: if the query string is not
 * recognised as a single top-level operation, the injector returns
 * the input unchanged and the caller proceeds without complexity
 * tracking. That trades absolute coverage for resilience — `monday
 * raw` accepts arbitrary GraphQL, and we'd rather lose verbose
 * complexity on a custom multi-operation document than break the
 * query.
 */

import type { Complexity } from '../utils/output/envelope.js';

export interface ComplexityInjectionOptions {
  /**
   * The selection to append. Defaults to the documented v0.1 set;
   * tests can override to assert on the wire shape, but commands
   * should leave it on the default so the field stays consistent
   * across the surface.
   */
  readonly selection?: string;
}

const DEFAULT_COMPLEXITY_SELECTION =
  'complexity { before after query reset_in_x_seconds }';

/**
 * Returns true when `query` already declares a top-level
 * `complexity` selection — we don't want to inject a duplicate.
 *
 * Match is intentionally narrow: a literal `complexity {` outside a
 * variable declaration. Arguments named `complexity:` (rare, but
 * possible in mutation inputs) won't match because the regex
 * insists on the `{` delimiter immediately after.
 */
const hasComplexitySelection = (query: string): boolean =>
  /\bcomplexity\s*\{/u.test(query);

/**
 * Locates the closing `}` of the *outermost* selection set inside the
 * GraphQL document — i.e. the operation body. Returns the index of
 * that `}` on success, or undefined if the document doesn't have a
 * recognisable single-operation shape.
 *
 * The scan walks brace depth: the first `{` is the operation body's
 * opener; we count up/down until we land back at depth 0. String
 * literals (block strings or quoted strings inside arguments) are
 * skipped to avoid mis-counting braces buried in `description: "{"`.
 */
const findOperationBodyClose = (query: string): number | undefined => {
  let firstBrace = -1;
  let depth = 0;
  let inBlockString = false;
  let inString = false;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (inBlockString) {
      if (ch === '"' && query.slice(i, i + 3) === '"""') {
        inBlockString = false;
        i += 2;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\' && i + 1 < query.length) {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && query.slice(i, i + 3) === '"""') {
      inBlockString = true;
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (firstBrace === -1) firstBrace = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && firstBrace !== -1) {
        return i;
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return undefined;
};

export interface ComplexityInjectionResult {
  /** The (possibly modified) GraphQL document. */
  readonly query: string;
  /**
   * True if a `complexity { ... }` selection was added by this
   * call. False when the document already contained one (no-op) or
   * when the injector couldn't find a single recognisable operation
   * body. Callers use this to know whether to strip the field from
   * the response (it was theirs to add) or leave it (it was the
   * caller's own selection — e.g. `account complexity` directly
   * queries the field as its only payload).
   */
  readonly injected: boolean;
}

/**
 * Returns `query` (possibly modified) plus a flag indicating
 * whether the injector actually appended the selection. If the
 * document doesn't have a single top-level operation we can
 * identify, returns the input unchanged with `injected: false`.
 */
export const injectComplexity = (
  query: string,
  options: ComplexityInjectionOptions = {},
): ComplexityInjectionResult => {
  if (hasComplexitySelection(query)) {
    return { query, injected: false };
  }
  const selection = options.selection ?? DEFAULT_COMPLEXITY_SELECTION;
  const close = findOperationBodyClose(query);
  if (close === undefined) {
    return { query, injected: false };
  }
  // Insert before the closing `}` with surrounding whitespace so the
  // result still parses cleanly. Don't try to indent — Monday's
  // server doesn't care, and aligning to existing whitespace would
  // double the cost of this function for no observable difference.
  return {
    query: `${query.slice(0, close)} ${selection} ${query.slice(close)}`,
    injected: true,
  };
};

/**
 * Reads the `complexity` field from a Monday GraphQL response body,
 * shaping it into the CLI's `meta.complexity` contract.
 *
 *  - `used`     ← Monday's `query` field (cost of the query).
 *  - `remaining`← Monday's `after` (budget left after this call).
 *  - `reset_in_seconds` ← Monday's `reset_in_x_seconds`.
 *
 * Returns `null` (not undefined) when the response carries no
 * `complexity` block, matching `cli-design.md` §6.1's rule that
 * `meta.complexity` is always present and either an object or `null`.
 *
 * The function is permissive about which shape gets handed in:
 *  - `body` may be the entire response body (`{ data: { complexity }
 *     }`), the `data` object, or just the `complexity` object itself.
 *  - Numeric fields that aren't finite numbers fall back through the
 *    chain so a partial response (Monday's reverse-proxy returning
 *    half the fields) still produces something usable.
 */
export const parseComplexity = (body: unknown): Complexity | null => {
  if (body === null || typeof body !== 'object') {
    return null;
  }
  const obj = body as Record<string, unknown>;

  // Try to peel back the wrappings: `{data: {complexity: ...}}` →
  // `{complexity: ...}` → the leaf object.
  let leaf: Record<string, unknown> | undefined;
  if (
    'complexity' in obj &&
    typeof obj.complexity === 'object' &&
    obj.complexity !== null
  ) {
    leaf = obj.complexity as Record<string, unknown>;
  } else if (
    'data' in obj &&
    typeof obj.data === 'object' &&
    obj.data !== null
  ) {
    const data = obj.data as Record<string, unknown>;
    if (
      'complexity' in data &&
      typeof data.complexity === 'object' &&
      data.complexity !== null
    ) {
      leaf = data.complexity as Record<string, unknown>;
    }
  } else if ('query' in obj || 'after' in obj || 'reset_in_x_seconds' in obj) {
    leaf = obj;
  }
  if (leaf === undefined) {
    return null;
  }

  const finiteNumber = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const used = finiteNumber(leaf.query) ?? finiteNumber(leaf.used) ?? 0;
  const remaining =
    finiteNumber(leaf.after) ?? finiteNumber(leaf.remaining) ?? 0;
  const resetInSeconds =
    finiteNumber(leaf.reset_in_x_seconds) ??
    finiteNumber(leaf.reset_in_seconds) ??
    0;

  return {
    used,
    remaining,
    reset_in_seconds: resetInSeconds,
  };
};
