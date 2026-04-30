/**
 * Filter DSL parser (`cli-design.md` §5.5, `v0.1-plan.md` §3 M4).
 *
 * Two surfaces, one for each `monday item list` knob:
 *
 *   - `--where <token><op><val>` (repeatable) → parsed against §5.5's
 *     allowlist (`=`, `!=`, `~=`, `<`, `<=`, `>`, `>=`, `:is_empty`,
 *     `:is_not_empty`) and emitted as a Monday `query_params.rules`
 *     object. Multiple `--where` flags are AND'd. Token resolution
 *     reuses the M3 column read-resolver (`api/columns.ts`) so the
 *     same NFC + case-fold rules apply across read and write surfaces.
 *
 *   - `--filter-json <json>` is the literal Monday `query_params`
 *     object — never re-parsed. Power users / agents needing OR /
 *     nested groups / `within_last(7d)` use this. v0.1's `--where`
 *     surface is intentionally narrow; `--filter-json` is the escape
 *     hatch.
 *
 * `--where` and `--filter-json` are **mutually exclusive**. Combining
 * them would either force a merge rule (extra contract surface) or
 * silently let one win — both are worse than failing fast with a
 * `usage_error` and asking the agent to pick.
 *
 * **Operator-in-title trap.** When a column title contains an
 * operator (`Plan A=B`), the implicit-resolution path can't
 * disambiguate — `--where Plan A=B=approved` splits on the *first*
 * `=` per §5.3 step 2.b, so the token resolves as `Plan A` and the
 * value is `B=approved`. This is documented behaviour, not a bug.
 * The `title:`/`id:` prefix doesn't help here either — `parseWhereSyntax`
 * splits on the first operator before `parseColumnTokenPrefix`
 * sees the token, so `title:Plan A=B=approved` still cleaves at
 * the first `=`. The supported escape hatch for operator-in-title
 * columns is `--filter-json`, where the agent passes the literal
 * Monday `query_params` JSON; the rule's `column_id` is unambiguous
 * and the value carries through verbatim. Codex M4 pass-2 §4
 * surfaced this as a documentation backfill item — logged in
 * v0.1-plan.md §3 M4 spec-gaps. The unit suite asserts the
 * documented split verbatim so a future "be clever about it"
 * patch fails loudly.
 *
 * **`me` sugar.** Per §5.5 + §5.3, `--where owner=me` against a
 * `people` column resolves through the directory cache to the
 * current user's ID. The resolution is a separate `whoami` query
 * the parser issues on demand; tests inject a stub via the
 * `resolveMe` callback so the pure-syntax layer stays
 * unit-testable.
 *
 * **Result-type meta surface (§14 M3 prophylactic).** Even though
 * filter parsing produces no network-derived data of its own
 * (resolution is delegated to columns.ts + a `me`-resolver
 * callback), the result type carries `warnings` from day one. The
 * meta-source / cache-age / complexity slots travel through the
 * board-metadata loader the caller has already opened — surfacing
 * them again here would be redundant.
 */

import { z } from 'zod';
import { ApiError, UsageError } from '../utils/errors.js';
import { resolveColumn, type ColumnMatch } from './columns.js';
import { isMeToken } from './me-token.js';
import type { BoardColumn, BoardMetadata } from './board-metadata.js';
import type { Warning } from '../utils/output/envelope.js';

/**
 * Full set of `--where` operators per §5.5. The string is the source
 * literal the user types; the kind is the AST tag downstream code
 * consumes.
 */
export type FilterOperatorKind =
  | 'equals'
  | 'not_equals'
  | 'contains_text'
  | 'lower_than'
  | 'lower_than_or_equals'
  | 'greater_than'
  | 'greater_than_or_equals'
  | 'is_empty'
  | 'is_not_empty';

export interface FilterOperator {
  readonly kind: FilterOperatorKind;
  /** The literal operator string the user typed. */
  readonly literal: string;
  /**
   * Whether the operator carries a value (`=`, `!=`, `~=`, `<`, `<=`,
   * `>`, `>=`) or is a unary suffix (`:is_empty`, `:is_not_empty`).
   * Drives the parser's value-extraction step.
   */
  readonly arity: 'unary' | 'binary';
}

const OPERATORS_BINARY: readonly FilterOperator[] = [
  // Two-character operators must come before their one-character
  // prefixes so the position-by-position scan picks the longest
  // match at any given index.
  { kind: 'lower_than_or_equals', literal: '<=', arity: 'binary' },
  { kind: 'greater_than_or_equals', literal: '>=', arity: 'binary' },
  { kind: 'not_equals', literal: '!=', arity: 'binary' },
  { kind: 'contains_text', literal: '~=', arity: 'binary' },
  { kind: 'lower_than', literal: '<', arity: 'binary' },
  { kind: 'greater_than', literal: '>', arity: 'binary' },
  { kind: 'equals', literal: '=', arity: 'binary' },
];

/**
 * Maps the AST kind to the Monday `query_params` operator name.
 * Frozen so a future import can't mutate the table mid-process.
 */
const MONDAY_OPERATOR_NAME: Readonly<Record<FilterOperatorKind, string>> =
  Object.freeze({
    equals: 'any_of',
    not_equals: 'not_any_of',
    contains_text: 'contains_text',
    lower_than: 'lower_than',
    lower_than_or_equals: 'lower_than_or_equals',
    greater_than: 'greater_than',
    greater_than_or_equals: 'greater_than_or_equals',
    is_empty: 'is_empty',
    is_not_empty: 'is_not_empty',
  });

/**
 * Result of parsing one `--where` argument's *syntax*: the column
 * token, operator, and (optional) value. No semantic resolution
 * happens here — that's `buildFilterRules`'s job. Pure / synchronous
 * by design so the unit suite can drive every adversarial input
 * without a network mock.
 */
export interface WhereClause {
  readonly token: string;
  readonly operator: FilterOperator;
  readonly value: string | undefined;
  /** The original raw `--where` argument, kept for error messages. */
  readonly raw: string;
}

/**
 * Splits one raw `--where` argument into a {@link WhereClause}.
 *
 * Algorithm (left-to-right, longest-match-at-position):
 *
 *  1. Match `:is_not_empty` / `:is_empty` suffix on the right (with
 *     `:is_not_empty` checked first so it doesn't get truncated to
 *     the shorter form).
 *  2. Otherwise scan position-by-position from index 1 (token must
 *     be non-empty), trying each binary operator at that position.
 *     The first match wins — earliest-leftmost-with-longest-tie-break.
 *  3. If no operator is found, raise `UsageError`.
 *
 * Per §5.3 step 2.b, the split happens on the *first* operator
 * occurrence — a column title containing an operator (`Plan A=B`)
 * needs the explicit `title:` prefix or `--filter-json` to round-trip.
 */
export const parseWhereSyntax = (raw: string): WhereClause => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new UsageError(
      `--where: empty filter clause`,
      { details: { clause: raw } },
    );
  }

  // Step 1: unary `:is_empty` / `:is_not_empty` suffix. Order matters
  // so the longer literal binds first.
  const unarySuffixes: readonly { readonly suffix: string; readonly kind: FilterOperatorKind }[] = [
    { suffix: ':is_not_empty', kind: 'is_not_empty' },
    { suffix: ':is_empty', kind: 'is_empty' },
  ];
  for (const u of unarySuffixes) {
    if (trimmed.endsWith(u.suffix)) {
      const tokenPart = trimmed.slice(0, trimmed.length - u.suffix.length);
      if (tokenPart.length === 0) {
        throw new UsageError(
          `--where: missing column token before ${u.suffix}`,
          { details: { clause: raw } },
        );
      }
      return {
        token: tokenPart,
        operator: { kind: u.kind, literal: u.suffix.slice(1), arity: 'unary' },
        value: undefined,
        raw,
      };
    }
  }

  // Step 2: scan left-to-right from index 1 (a leading operator
  // would mean an empty token, rejected). At each index, prefer the
  // longest matching operator literal.
  for (let i = 1; i < trimmed.length; i++) {
    for (const op of OPERATORS_BINARY) {
      if (trimmed.startsWith(op.literal, i)) {
        const token = trimmed.slice(0, i);
        const value = trimmed.slice(i + op.literal.length);
        // Token mustn't end with whitespace + operator-only — but a
        // non-empty token + non-empty value is always valid. Empty
        // value (`status=`) is technically allowed by §5.5 but
        // pragmatically meaningless; reject so agents notice.
        if (value.length === 0) {
          throw new UsageError(
            `--where: missing value after ${op.literal} (use ${op.literal}'<value>')`,
            { details: { clause: raw, operator: op.literal } },
          );
        }
        return { token, operator: op, value, raw };
      }
    }
  }

  throw new UsageError(
    `--where: no recognised operator in ${JSON.stringify(raw)}; ` +
      `expected one of =, !=, ~=, <, <=, >, >=, :is_empty, :is_not_empty`,
    { details: { clause: raw } },
  );
};

/**
 * Filter rule emitted to Monday's `query_params.rules` array. The
 * rule shape is intentionally weak (`compare_value: unknown`) — the
 * v0.1 surface only types what we actually check; future operators
 * (between, within_last) ride through `--filter-json` until M5b
 * needs them.
 */
export interface FilterRule {
  readonly column_id: string;
  readonly operator: string;
  readonly compare_value?: unknown;
}

export interface QueryParams {
  readonly rules: readonly FilterRule[];
}

export interface BuildFilterRulesInputs {
  readonly metadata: BoardMetadata;
  /**
   * Resolves the `me` token to the current user's ID. Async because
   * the production path issues a `me { id }` query; tests stub it
   * synchronously. Called at most once per build call regardless of
   * how many `me` tokens appear in the clauses.
   */
  readonly resolveMe: () => Promise<string>;
  readonly clauses: readonly WhereClause[];
  /**
   * Optional cache-miss refresh callback — when provided, the parser
   * fires it once on the first `column_not_found` to retry the
   * resolution against fresh metadata (Codex M4 §1: filters must
   * honour §5.3 step 5). Caller should plumb `refreshBoardMetadata`
   * here when the metadata came from cache; pass `undefined` when
   * the metadata was already live (no refresh would help).
   */
  readonly onColumnNotFound?: () => Promise<BoardMetadata>;
}

export interface BuildFilterRulesResult {
  readonly queryParams: QueryParams | undefined;
  readonly warnings: readonly Warning[];
  /**
   * `true` when `onColumnNotFound` fired — caller flips
   * `meta.source` to `'mixed'` and emits a `stale_cache_refreshed`
   * warning per §5.3 step 5.
   */
  readonly refreshed: boolean;
}

/**
 * Resolves each parsed `WhereClause` against the board metadata and
 * emits the Monday `query_params` payload. Empty `clauses` →
 * `queryParams: undefined` (caller omits the variable from the
 * GraphQL request). Multiple clauses are AND'd by Monday's default
 * rule-array semantics — no nested groups in v0.1.
 *
 * Throws `ApiError` (`column_not_found` / `ambiguous_column`) when
 * column resolution fails — same shape `--set` will surface in M5b
 * so agents key off the same code regardless of the read vs write
 * channel.
 */
export const buildFilterRules = async (
  inputs: BuildFilterRulesInputs,
): Promise<BuildFilterRulesResult> => {
  if (inputs.clauses.length === 0) {
    return { queryParams: undefined, warnings: [], refreshed: false };
  }

  const warnings: Warning[] = [];
  const rules: FilterRule[] = [];
  let cachedMe: string | undefined;
  const me = async (): Promise<string> => {
    cachedMe ??= await inputs.resolveMe();
    return cachedMe;
  };

  let metadata = inputs.metadata;
  let refreshed = false;

  for (const clause of inputs.clauses) {
    let match: ColumnMatch;
    try {
      match = resolveColumn(metadata, clause.token);
    } catch (err) {
      // Cache-miss-refresh per §5.3 step 5: if the resolution fails
      // with column_not_found AND the caller supplied a refresh
      // callback AND we haven't already refreshed, fire the refresh
      // once and retry. Other resolution errors (ambiguous_column)
      // bubble — refreshing wouldn't change them.
      const isMissing =
        err instanceof ApiError && err.code === 'column_not_found';
      if (
        !isMissing ||
        inputs.onColumnNotFound === undefined ||
        refreshed
      ) {
        throw err;
      }
      metadata = await inputs.onColumnNotFound();
      refreshed = true;
      warnings.push({
        code: 'stale_cache_refreshed',
        message:
          'Cache miss for filter token; refreshed board metadata to resolve.',
        details: { token: clause.token, board_id: metadata.id },
      });
      match = resolveColumn(metadata, clause.token);
    }
    foldCollisionWarning(match, warnings);

    const rule = await buildRuleForClause(clause, match.column, me);
    rules.push(rule);
  }

  return {
    queryParams: { rules },
    warnings,
    refreshed,
  };
};

const foldCollisionWarning = (
  match: ColumnMatch,
  warnings: Warning[],
): void => {
  if (match.collisionCandidates.length === 0) return;
  warnings.push({
    code: 'column_token_collision',
    message:
      `Filter token matched column id "${match.column.id}" and ` +
      `${String(match.collisionCandidates.length)} title(s); the ID match wins.`,
    details: {
      via: match.via,
      resolved_id: match.column.id,
      candidates: match.collisionCandidates,
    },
  });
};

const buildRuleForClause = async (
  clause: WhereClause,
  column: BoardColumn,
  resolveMe: () => Promise<string>,
): Promise<FilterRule> => {
  const operator = clause.operator;
  if (operator.arity === 'unary') {
    return {
      column_id: column.id,
      operator: MONDAY_OPERATOR_NAME[operator.kind],
    };
  }
  // Binary operator — extract value, resolve `me` if applicable.
  /* c8 ignore next 7 — defensive guard. The parser's output shape
     guarantees `value` is defined whenever `arity: 'binary'`; the
     check exists for type narrowing under
     `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`. */
  if (clause.value === undefined) {
    throw new ApiError(
      'internal_error',
      `binary operator ${operator.literal} produced no value during build`,
    );
  }

  const compareValue = await resolveCompareValue(
    clause.value,
    column,
    operator,
    resolveMe,
  );
  return {
    column_id: column.id,
    operator: MONDAY_OPERATOR_NAME[operator.kind],
    compare_value: compareValue,
  };
};

const resolveCompareValue = async (
  rawValue: string,
  column: BoardColumn,
  operator: FilterOperator,
  resolveMe: () => Promise<string>,
): Promise<unknown> => {
  // `me` sugar resolves only on people-style columns. Other types
  // pass through verbatim so a stray `me` against a text column
  // surfaces as Monday's validation_failed rather than a silent
  // identity swap.
  //
  // `isMeToken` is the shared (`api/me-token.ts`, R15) recogniser
  // used by all three `me`-aware surfaces — `--where Owner=me`
  // here, `item search --where Owner=me` in commands/item/search.ts,
  // and `--set Owner=me` in api/people.ts. One rule across read
  // filters and `--set` writes per cli-design §5.3 step 3 line
  // 704-707. cli-design doesn't pin case-sensitivity explicitly;
  // the people-session Codex passes settled on case-insensitive
  // (logged as a v0.1-plan §3 M5a spec gap for backfill).
  if (column.type === 'people' && isMeToken(rawValue)) {
    const id = await resolveMe();
    return wrapForOperator([id], operator);
  }
  // contains_text takes a bare string. Everything else takes an
  // array (any_of / not_any_of) or a scalar (lt/gt/le/ge — number
  // or date string). For v0.1 we pass strings as-is and let Monday
  // coerce; Monday accepts both string and number for numeric
  // columns when the value parses as a number.
  return wrapForOperator(rawValue, operator);
};

const wrapForOperator = (
  value: string | readonly string[],
  operator: FilterOperator,
): unknown => {
  switch (operator.kind) {
    case 'equals':
    case 'not_equals':
      return Array.isArray(value) ? value : [value];
    case 'contains_text':
      return Array.isArray(value) ? value[0] : value;
    case 'lower_than':
    case 'lower_than_or_equals':
    case 'greater_than':
    case 'greater_than_or_equals':
      return Array.isArray(value) ? value[0] : value;
    /* c8 ignore start — unary kinds never reach this helper; the
       caller only invokes wrapForOperator for binary operators. */
    case 'is_empty':
    case 'is_not_empty':
      return undefined;
    /* c8 ignore stop */
  }
};

const filterJsonSchema = z.object({}).loose();

/**
 * Validates a raw `--filter-json` string into a `query_params`-shaped
 * object. Per §5.5, the payload is "never parsed; passed through as
 * the GraphQL var" — the JSON.parse here is just a syntax check so a
 * malformed input produces `usage_error` instead of a server-side
 * parse error. Field-level shape validation stays on Monday's side.
 */
export const parseFilterJson = (raw: string): Readonly<Record<string, unknown>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `--filter-json: input is not valid JSON`,
      { details: { input: raw }, cause: err },
    );
  }
  const result = filterJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new UsageError(
      `--filter-json: expected a JSON object`,
      { details: { input: raw } },
    );
  }
  return result.data;
};

/**
 * Top-level helper for command actions. Consumes the two raw inputs
 * (repeatable `--where` strings + optional `--filter-json` string)
 * and returns a single `queryParams` object suitable for splatting
 * into the GraphQL variables.
 *
 * The two inputs are mutually exclusive: passing both raises
 * `usage_error`. Either one can be empty / undefined; both empty →
 * `queryParams: undefined`.
 */
export interface BuildQueryParamsInputs {
  readonly metadata: BoardMetadata;
  readonly resolveMe: () => Promise<string>;
  readonly whereClauses: readonly string[];
  readonly filterJson: string | undefined;
  /** Forwarded to `buildFilterRules` — see that interface. */
  readonly onColumnNotFound?: () => Promise<BoardMetadata>;
}

export interface BuildQueryParamsResult {
  readonly queryParams: Readonly<Record<string, unknown>> | undefined;
  readonly warnings: readonly Warning[];
  /** Forwarded from `buildFilterRules`. */
  readonly refreshed: boolean;
}

export const buildQueryParams = async (
  inputs: BuildQueryParamsInputs,
): Promise<BuildQueryParamsResult> => {
  const hasWhere = inputs.whereClauses.length > 0;
  const filterJson = inputs.filterJson;
  const hasFilterJson = filterJson !== undefined && filterJson.length > 0;
  if (hasWhere && hasFilterJson) {
    throw new UsageError(
      '--where and --filter-json are mutually exclusive; pick one',
    );
  }
  if (hasFilterJson) {
    return {
      queryParams: parseFilterJson(filterJson),
      warnings: [],
      refreshed: false,
    };
  }
  if (!hasWhere) {
    return { queryParams: undefined, warnings: [], refreshed: false };
  }

  const clauses = inputs.whereClauses.map(parseWhereSyntax);
  const result = await buildFilterRules({
    metadata: inputs.metadata,
    resolveMe: inputs.resolveMe,
    clauses,
    ...(inputs.onColumnNotFound === undefined
      ? {}
      : { onColumnNotFound: inputs.onColumnNotFound }),
  });
  return {
    queryParams: result.queryParams as Readonly<Record<string, unknown>> | undefined,
    warnings: result.warnings,
    refreshed: result.refreshed,
  };
};
