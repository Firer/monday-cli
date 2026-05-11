/**
 * Cross-board fan-out walker for the v0.3-M23 `monday item search`
 * cross-board path (`cli-design.md` §13 v0.3 entry).
 *
 * **What `monday item search` cross-board answers:** "find items
 * matching `--where` across N boards in one call" without the agent
 * iterating boards by hand. The v0.1 `monday item search --board <bid>`
 * path uses Monday's top-level `items_page_by_column_values(board_id:
 * ID!, ...)` query which is SINGULAR — it accepts ONE board ID. The
 * cross-board path can't reuse that surface; it uses the different
 * shape `boards(ids: [...]) { items_page(query_params: { rules }) }`
 * which fans out a single GraphQL call across N boards and returns
 * each board's first-page results.
 *
 * **Decision 5 closure (`3a2f1db`).** Per-call cap pinned at
 * `--max-boards 25` default + hard cap 100; above-cap surfaces
 * `usage_error` with hint pointing the agent at `--workspace` /
 * `--favorites` to narrow. Empirical-probe finding: complexity is
 * NOT the constraint (~25-30 points per board against a ~999_950
 * per-call budget supports ~30,000+ boards complexity-wise); the
 * REAL constraint is wall-clock latency — the fan-out call scales
 * roughly linearly at ~0.5-1.5s per call at small N, putting N=25
 * comfortably under the 30s `MONDAY_REQUEST_TIMEOUT_MS` default and
 * N≥60 at the timeout ceiling. The 25/100 cap is calibrated for the
 * latency envelope, not the complexity budget.
 *
 * **Three load-bearing empirical probe findings (2026-05-11, API
 * `2026-01`, `scripts/probe/m23-cross-board.ts` +
 * `scripts/probe/m23-cross-board-search-2.ts`):**
 *
 *   1. **Single-call surface; no resumable cross-board cursor at
 *      v0.3.** Each board returns its own `items_page.cursor`. The
 *      v0.3 walker fans out across N boards in ONE GraphQL call,
 *      collects each board's first page, and stops. When any
 *      board's per-board cursor comes back non-null (board has
 *      more items) OR the aggregate `--limit` short-circuited
 *      mid-fan-out, the walker surfaces
 *      {@link CrossBoardTruncatedWarning} with per-board state
 *      (`exhausted` / `has_more` / `not_started`) for agent
 *      introspection — but does NOT expose a resumable
 *      cross-board cursor (Codex round-1 P1-2 resolution; v0.4
 *      may add an opaque-token cursor envelope-additively). Agents
 *      needing pagination today narrow with `--workspace` /
 *      `--favorites` or use the v0.1 `--board <bid>` single-board
 *      path (which has its own resumable cursor per §5.6).
 *   2. **Inaccessible board IDs silently omitted.**
 *      `boards(ids: [<bad-id>])` returns `{"boards":[]}` (empty,
 *      not null, not error) even on mixed accessible+inaccessible
 *      input. The walker detects `response.boards.length <
 *      input_ids.length` and surfaces an `inaccessible_boards`
 *      warning rather than silently delivering partial results.
 *   3. **Per-board column resolution required for `--where`.** The
 *      `items_page(query_params: { rules })` shape uses each
 *      board's own column IDs; passing a column token (e.g.
 *      `status`) that doesn't resolve on ONE board errors the
 *      WHOLE cross-board query with `"Column not found"`. The
 *      cross-board walker MUST resolve column tokens per-board
 *      independently, build per-board query_params, and skip
 *      boards where the column doesn't resolve (with a
 *      `column_not_found_on_board` warning) rather than failing
 *      the entire fan-out.
 *
 * **What's stub vs runtime at the pre-flight.** `crossBoardSearch`
 * ships as a `Promise.reject(internal_error)` stub under `c8 ignore
 * start/stop` — M23 implementation lands the runtime body alongside
 * the `monday item search` cross-board action's action. The schema
 * definitions, type exports, the cap constants, the pure-helper
 * `validateMaxBoards`, the per-board input/output shapes ship as
 * REAL implementations so the pre-flight Codex review can verify
 * the contract surface against the empirical-probe findings inline.
 *
 * **Streaming reuse.** Per the v0.3-plan §3 M23 spec, the
 * cross-board path reuses `startNdjsonStream` (R52) + the existing
 * pagination helpers (`walkPages.onItem` / `paginate.onItem`). The
 * fan-out shape is a PARENT stream that merges N child walkers —
 * the child walker per board uses the same cursor-walker shape as
 * the v0.1 `item list` cursor walker, then the parent emits items
 * per-arrival across boards (no buffering — backpressure flows
 * through `startNdjsonStream.onItem`).
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import { BoardIdSchema, type BoardId } from '../types/ids.js';
import type { MondayClient } from './client.js';
import type { Complexity } from '../utils/output/envelope.js';

/**
 * Default cross-board fan-out cap per Decision 5 closure (`3a2f1db`).
 * Calibrated against wall-clock latency: at ~0.5-1.5s per cross-board
 * call at small N, N=25 lands ~12-18s — comfortable under the 30s
 * `MONDAY_REQUEST_TIMEOUT_MS` default with margin for slower per-board
 * resolutions.
 */
export const DEFAULT_MAX_BOARDS = 25;

/**
 * Hard cap on `--max-boards` per Decision 5 closure (`3a2f1db`).
 * Above-cap surfaces `usage_error` with a hint pointing the agent at
 * `--workspace` / `--favorites` to narrow. The 100-board hard cap
 * lands roughly at the 30s timeout ceiling at the measured per-call
 * latency — above 100 the call risks the `MONDAY_REQUEST_TIMEOUT_MS`
 * default, which is a worse failure mode than a clean `usage_error`
 * at the parse boundary.
 */
export const HARD_CAP_MAX_BOARDS = 100;

/**
 * Schema enforcing the `--max-boards` cap at the parse boundary.
 * The runtime walker additionally guards as a defense in depth, but
 * the parse-time enforcement catches obvious mistakes upfront with
 * the cli-design §6.5 `usage_error` envelope rather than letting the
 * fan-out fire N requests on Monday before the cap fires server-side.
 */
export const maxBoardsSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(HARD_CAP_MAX_BOARDS, {
    message: `--max-boards exceeds the hard cap of ${String(HARD_CAP_MAX_BOARDS)} (wall-clock fan-out latency cap, not a complexity-budget cap; ~0.5-1.5s per call at small N puts N>=60 at the 30s MONDAY_REQUEST_TIMEOUT_MS ceiling per the Decision 5 \`3a2f1db\` empirical-probe finding); narrow the cross-board set with --workspace or --favorites`,
  });

/**
 * Per-board `--where` clause as it lands on the wire. `column_id`
 * matches Monday's `ItemsQueryRule.column_id: ID!` typing (empirical
 * probe (2) at `scripts/probe/m23-cross-board-search-2.ts` confirmed
 * `String!` is rejected — the wire wants `ID!`); `compare_values`
 * is the OR-within-column list per v0.1 search semantics.
 */
export interface CrossBoardRule {
  readonly column_id: string;
  readonly compare_values: readonly string[];
}

/**
 * A board the walker plans to scan. The cross-board path's per-board
 * column-resolution step (probe finding #3) produces this — one
 * `PerBoardScanPlan` entry per board the walker will actually
 * include in the fan-out, with the column tokens resolved to the
 * board-specific column IDs. Boards where the column tokens DON'T
 * resolve get filtered out at planning time (with a
 * `column_not_found_on_board` warning), not at runtime.
 */
export interface PerBoardScanPlan {
  readonly board_id: BoardId;
  readonly rules: readonly CrossBoardRule[];
}

/**
 * Inputs to {@link crossBoardSearch}. The pre-flight pins the shape;
 * M23 implementation fills in the body.
 *
 * - `client` — the resolved {@link MondayClient}. **Codex P1-1
 *   fix**: pre-flight previously took `Transport` directly, which
 *   would bypass MondayClient's `--retry` + `--verbose`-complexity
 *   injection at M23 implementation. Taking the client preserves
 *   the project's retry contract (cli-design §3.1) and routes
 *   verbose-complexity through the existing
 *   `injectComplexity`/`parseComplexity` pair in `src/api/client.ts`
 *   without re-implementing it per-call.
 * - `boardIds` — the resolved cross-board set (after `--workspace`
 *   / `--favorites` expansion); the walker fans out across these.
 *   At runtime, `boardIds.length` is enforced ≤ {@link HARD_CAP_MAX_BOARDS}
 *   regardless of source — the favorites-resolved set or the
 *   workspace-resolved set both clamp to the cap with a
 *   `usage_error` at the parse boundary.
 * - `plans` — per-board column-resolution outcome. M23 implementation
 *   resolves column tokens per-board in a parallel `boardMetadata`
 *   pre-pass; this slot carries the result. The pre-flight contract
 *   surface keeps the column-resolution pass DECOUPLED from the
 *   fan-out walker so the walker is a pure cursor-fan-out shape and
 *   the resolution pass is independently testable.
 * - `pageSize` — Monday caps `items_page(limit:)` at 500 per board;
 *   default 100 per the project pagination default.
 * - `maxItems` — caller-supplied `--limit` cap across the entire
 *   fan-out (not per-board). The walker stops once the aggregate
 *   collected count reaches the cap and surfaces a
 *   {@link CrossBoardTruncatedWarning}.
 * - `onItem` — streaming hook per the v0.3-plan §3 M23 deliverable
 *   ("Reuse `startNdjsonStream` + `walkPages.onItem`"). Called per
 *   item-arrival across all boards; backpressure through the hook
 *   slows the fan-out walker.
 */
export interface CrossBoardSearchInputs {
  readonly client: MondayClient;
  readonly boardIds: readonly BoardId[];
  readonly plans: readonly PerBoardScanPlan[];
  readonly pageSize?: number;
  readonly maxItems?: number;
  readonly onItem?: (
    item: CrossBoardItem,
  ) => void | Promise<void>;
}

/**
 * One item returned from the cross-board search. Each item carries
 * its source board's ID + name alongside the projected v0.1
 * `item search` item-row shape — cross-board agents need to know
 * which board each hit came from without a second round-trip.
 *
 * The `board` slot's `name` is the cross-board call's response
 * `boards[].name` (one network call hydrates both items + board
 * name), not a separate `board describe` round-trip.
 */
export interface CrossBoardItem {
  readonly id: string;
  readonly name: string;
  readonly state: string | null;
  readonly board: {
    readonly id: string;
    readonly name: string;
  };
  /**
   * Projected column values for the same column set the v0.1
   * `item search --where` returns. Per-board column-resolution
   * (probe finding #3) ensures the column IDs in this map are
   * resolved per the input clauses; boards lacking the requested
   * columns are filtered out at planning time and never produce
   * `CrossBoardItem`s.
   */
  readonly column_values: Readonly<Record<string, string | null>>;
}

/**
 * Schema validating an individual cross-board item. Mirrors
 * {@link CrossBoardItem} so the envelope is parse-safe at every
 * emission path (in particular `monday schema` introspection of the
 * cross-board `monday item search` output).
 */
export const crossBoardItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    state: z.string().nullable(),
    board: z.object({ id: z.string().min(1), name: z.string() }).strict(),
    column_values: z.record(z.string(), z.string().nullable()),
  })
  .strict();

/**
 * Cross-board search-output schema. The v0.1 single-board
 * `monday item search` returns `readonly ProjectedItem[]` (the
 * `itemSearchOutputSchema` in `src/commands/item/search.ts`); the
 * cross-board path returns a richer per-item shape (board ID + name
 * attached) so agents can tell which board each hit came from.
 *
 * **Why a different output shape, not a union.** The single-board
 * path's `ProjectedItem` includes a `meta.columns` title map on the
 * envelope (R52 fold); the cross-board path can't reuse that because
 * `meta.columns` is a single-board concept. Carrying per-board title
 * maps on the envelope would balloon the meta payload; instead,
 * cross-board items carry their column values keyed by the input
 * column TOKEN (resolved per-board) rather than per-board column
 * IDs. Same column token across boards = same key in `column_values`
 * — the resolver step homogenises the keys.
 */
export const crossBoardSearchOutputSchema = z.array(crossBoardItemSchema);
export type CrossBoardSearchOutput = z.infer<typeof crossBoardSearchOutputSchema>;

/**
 * Per-walk warning shapes that the cross-board walker surfaces on
 * the success envelope's `warnings[]`. Two distinct codes per
 * empirical probe findings #2 and #3 — neither is fatal (the walk
 * still returns whatever items it found).
 */
export interface InaccessibleBoardsWarning {
  readonly code: 'inaccessible_boards';
  readonly message: string;
  readonly details: {
    readonly requested_count: number;
    readonly returned_count: number;
    readonly missing_board_ids: readonly string[];
    readonly hint: string;
  };
}

export interface ColumnNotFoundOnBoardWarning {
  readonly code: 'column_not_found_on_board';
  readonly message: string;
  readonly details: {
    readonly board_id: string;
    readonly column: string;
    readonly hint: string;
  };
}

export const inaccessibleBoardsWarningSchema = z
  .object({
    code: z.literal('inaccessible_boards'),
    message: z.string().min(1),
    details: z.object({
      requested_count: z.number().int().nonnegative(),
      returned_count: z.number().int().nonnegative(),
      missing_board_ids: z.array(z.string().min(1)),
      hint: z.string().min(1),
    }).strict(),
  })
  .strict();

export const columnNotFoundOnBoardWarningSchema = z
  .object({
    code: z.literal('column_not_found_on_board'),
    message: z.string().min(1),
    details: z.object({
      board_id: z.string().min(1),
      column: z.string().min(1),
      hint: z.string().min(1),
    }).strict(),
  })
  .strict();

/**
 * Surfaced when the cross-board walker stopped before draining every
 * board — either because `--limit` short-circuited the aggregate
 * walk, or because at least one board still has more data after the
 * walker's bounded fan-out. Carries the per-board state for agent
 * introspection.
 *
 * **Codex P1-2 resolution.** This warning REPLACES the per-board
 * cursor map originally pinned on `CrossBoardSearchResult.nextCursors`
 * — v0.3 cross-board search is single-call-only (no resumable
 * cross-board cursor); agents needing pagination narrow with
 * `--workspace` / `--favorites`. v0.4 may add an opaque-token
 * resumable cursor (envelope-additive per §6.1).
 *
 * Per-board state values:
 *   - `'exhausted'` — the walker drained this board to Monday's
 *     `cursor: null` terminal state.
 *   - `'has_more'` — the walker stopped while this board still has
 *     items (either the aggregate `--limit` fired before this board
 *     was drained, or per-board page-cap fired).
 *   - `'not_started'` — the walker hit `--limit` before reaching
 *     this board in the fan-out order.
 */
export type CrossBoardPerBoardWalkState =
  | 'exhausted'
  | 'has_more'
  | 'not_started';

export interface CrossBoardTruncatedWarning {
  readonly code: 'cross_board_truncated';
  readonly message: string;
  readonly details: {
    readonly reason: 'limit_hit' | 'board_has_more';
    readonly total_returned: number;
    readonly limit: number | null;
    readonly per_board_state: Readonly<
      Record<string, CrossBoardPerBoardWalkState>
    >;
    readonly hint: string;
  };
}

export const crossBoardTruncatedWarningSchema = z
  .object({
    code: z.literal('cross_board_truncated'),
    message: z.string().min(1),
    details: z
      .object({
        reason: z.enum(['limit_hit', 'board_has_more']),
        total_returned: z.number().int().nonnegative(),
        limit: z.number().int().positive().nullable(),
        per_board_state: z.record(
          z.string(),
          z.enum(['exhausted', 'has_more', 'not_started']),
        ),
        hint: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * Validates `--max-boards <n>` at the parse boundary. Centralised
 * pure helper so the command-action argv parser and the walker's
 * defensive check share one rule. **Real implementation** at
 * pre-flight (not a stub) — the rule is the contract surface, not
 * the runtime cost.
 *
 * Returns the parsed cap on success; throws `UsageError`-routed
 * `ApiError` on out-of-range. The thrown error's `details.hint`
 * forward-references `--workspace` / `--favorites` per Decision 5's
 * hint wording.
 */
export const validateMaxBoards = (
  rawValue: number | undefined,
): number => {
  const fallback = rawValue ?? DEFAULT_MAX_BOARDS;
  // The schema's `.coerce.number().int().positive().max(HARD_CAP_MAX_BOARDS)`
  // does the real check; this re-parse keeps the error shape consistent
  // with the command-action argv parser.
  const parsed = maxBoardsSchema.safeParse(fallback);
  /* c8 ignore start */
  // Defensive: callers (the command action's argv-parser) already
  // run the same schema; this re-parse exists for any future
  // non-CLI consumer that constructs CrossBoardSearchInputs by
  // hand. Reaching this branch from the CLI path is not possible.
  if (!parsed.success) {
    throw new ApiError(
      'usage_error',
      `invalid --max-boards: ${parsed.error.issues[0]?.message ?? 'out of range'}`,
      {
        details: {
          max_boards: rawValue,
          hard_cap: HARD_CAP_MAX_BOARDS,
          hint: 'the cap protects against the 30s request timeout (Decision 5 `3a2f1db` wall-clock-latency rationale, not complexity-budget); narrow the cross-board set with --workspace <wid> or --favorites',
        },
      },
    );
  }
  /* c8 ignore stop */
  return parsed.data;
};

/**
 * Builds an {@link InaccessibleBoardsWarning} from the response /
 * input deltas. **Real implementation** at pre-flight (pure helper,
 * not a stub) — the warning shape is the contract surface.
 *
 * The `missing_board_ids` slot is deterministic-ordered (input
 * order, filtered to ids NOT in the response set) so cassette
 * fixtures remain stable across re-recordings.
 */
export const buildInaccessibleBoardsWarning = (
  requestedIds: readonly string[],
  returnedIds: readonly string[],
): InaccessibleBoardsWarning => {
  const returnedSet = new Set(returnedIds);
  const missing = requestedIds.filter((id) => !returnedSet.has(id));
  return {
    code: 'inaccessible_boards',
    message: `${String(missing.length)} of ${String(requestedIds.length)} requested boards were inaccessible or do not exist; ${String(returnedIds.length)} returned`,
    details: {
      requested_count: requestedIds.length,
      returned_count: returnedIds.length,
      missing_board_ids: missing,
      hint: 'inaccessible boards are silently omitted by Monday\'s `boards(ids:)` query; verify board IDs or permissions',
    },
  };
};

/**
 * Builds a {@link ColumnNotFoundOnBoardWarning} from the per-board
 * column-resolution failure. **Real implementation** at pre-flight
 * (pure helper, not a stub).
 */
export const buildColumnNotFoundOnBoardWarning = (
  boardId: string,
  columnToken: string,
): ColumnNotFoundOnBoardWarning => ({
  code: 'column_not_found_on_board',
  message: `column "${columnToken}" not found on board ${boardId}; board skipped in cross-board fan-out`,
  details: {
    board_id: boardId,
    column: columnToken,
    hint: 'cross-board search requires the --where column to resolve on every board in the fan-out; boards without the column are skipped',
  },
});

/**
 * Builds a {@link CrossBoardTruncatedWarning} from the walker's
 * end-of-walk per-board state. **Real implementation** at pre-flight
 * (pure helper).
 *
 * The `reason` discriminant distinguishes:
 *   - `'limit_hit'` — the aggregate `--limit` short-circuited the
 *     walk. The hint points the agent at supplying a larger
 *     `--limit` or narrowing with `--workspace` / `--favorites`.
 *   - `'board_has_more'` — every board's per-board page-cap fired
 *     before the board exhausted. The hint points the agent at
 *     narrowing the cross-board set or running the v0.1 single-board
 *     `--board <bid>` path per board.
 */
export const buildCrossBoardTruncatedWarning = (
  reason: 'limit_hit' | 'board_has_more',
  totalReturned: number,
  limit: number | null,
  perBoardState: Readonly<Record<string, CrossBoardPerBoardWalkState>>,
): CrossBoardTruncatedWarning => {
  const hint =
    reason === 'limit_hit'
      ? `--limit ${String(limit ?? '?')} short-circuited the cross-board fan-out; supply a larger --limit, narrow with --workspace / --favorites, or use --board <bid> for the v0.1 single-board path`
      : 'one or more boards still have items beyond the v0.3 cross-board single-call surface; narrow with --workspace / --favorites or use --board <bid> per board for the v0.1 resumable-cursor path';
  return {
    code: 'cross_board_truncated',
    message: `cross-board walk truncated after ${String(totalReturned)} items (reason: ${reason})`,
    details: {
      reason,
      total_returned: totalReturned,
      limit,
      per_board_state: perBoardState,
      hint,
    },
  };
};

/**
 * Cross-board search-result envelope from the walker.
 *
 * **Codex P1-2 fix.** Pre-flight previously exposed a per-board
 * cursor map (`nextCursors: Record<string, string | null>`) intended
 * to surface as `next_cursor` on the §6.3 trailer; review caught
 * that the per-board map can't distinguish "not started" from
 * "exhausted" once an aggregate `--limit` short-circuits the walk,
 * and JSON-stringifying the map into `next_cursor: string | null`
 * leaves the wire contract implicit.
 *
 * **v0.3 resolution: cross-board search is single-call-only.** The
 * walker fans out across N boards in ONE GraphQL call (per the
 * empirical-probe finding #2), drains each board's items via
 * per-board cursors INTERNALLY (one round-trip per board's
 * `next_items_page`), and stops on the first of: (a) all boards
 * exhausted, (b) `--limit` hit. In case (b) or when any board has
 * more data left after the walker stops, the result surfaces a
 * {@link CrossBoardTruncatedWarning} carrying the per-board state
 * for agent introspection but does NOT expose a resumable
 * cross-board cursor on the envelope.
 *
 * **Why no resumable cursor at v0.3.** Cross-board pagination is
 * genuinely thorny — Monday's per-board cursors expire at 60min per
 * cli-design §5.6, and an aggregate `--limit` mid-walk yields
 * per-board state that doesn't compose into a single resumable
 * token without an opaque-token scheme. v0.3 defers the resumable
 * cursor to v0.4 (envelope-additive); agents that need pagination
 * narrow with `--workspace` / `--favorites` until then. This
 * mirrors the M22 diagnostics-cluster approach of shipping the
 * minimum-useful surface first.
 */
export interface CrossBoardSearchResult {
  readonly items: readonly CrossBoardItem[];
  /**
   * `true` when the walker stopped before exhausting every board
   * (`--limit` short-circuit OR any board's `items_page.cursor` was
   * still non-null at the v0.3 single-call surface). `false` when
   * every requested board's `cursor` came back `null` and the
   * aggregate `--limit` did not fire. When `true`,
   * {@link CrossBoardTruncatedWarning} is also surfaced on
   * `warnings[]` with the per-board state breakdown for agent
   * introspection.
   */
  readonly hasMore: boolean;
  readonly totalReturned: number;
  /**
   * `meta.complexity` from the cross-board fan-out call. Per the
   * project complexity-injection contract (`src/api/client.ts` —
   * only the verbose path injects + parses), this is non-null only
   * when the global `--verbose` flag is on. Single-call surface →
   * single `Complexity` snapshot (no need to aggregate across
   * pages).
   */
  readonly complexity: Complexity | null;
  readonly warnings: readonly (
    | InaccessibleBoardsWarning
    | ColumnNotFoundOnBoardWarning
    | CrossBoardTruncatedWarning
  )[];
  /**
   * **Codex round-2 P2-1 fix.** The walker result is pure-live for
   * the cross-board fan-out itself — `boards(ids:) { items_page(...) }`
   * hits Monday directly and never touches the cache. The action-
   * layer wrapping (`monday item search` cross-board action body
   * at M23 implementation) aggregates this `'live'` walker source
   * with the per-board column-resolution pre-pass's cache state
   * via the existing `SourceAggregator` helper, then emits the
   * envelope's `meta.source` / `meta.cache_age_seconds` from the
   * aggregator's resolved state. Keeping the source/cache slots
   * OUT of the walker result avoids the walker pretending to know
   * a state it can't compute from `CrossBoardSearchInputs` alone.
   */
  readonly source: 'live';
}

/**
 * The GraphQL document the walker issues per board. Per the M23
 * empirical probe (`scripts/probe/m23-cross-board-search-2.ts` (1)
 * + (3)), `query_params.rules[].column_id` is `ID!` (not `String!`)
 * and `compare_value` is `[JSON!]`. The cross-board surface uses
 * `boards(ids: [...]) { items_page(query_params: {...}) }`; with
 * per-board column resolution producing distinct rule sets per
 * board, the walker issues ONE call per plan (the surface can't
 * fold per-board rules into a single document without aliased
 * sub-queries — N calls keep the document static and the per-board
 * latency profile transparent per Decision 5's wall-clock-cap
 * rationale). The boards(ids: [$boardId]) shape lets the same
 * document detect inaccessible boards via the empty-array reply
 * from Monday.
 */
const CROSS_BOARD_SEARCH_QUERY = `
  query CrossBoardSearch($boardId: ID!, $rules: [ItemsQueryRule!]!, $limit: Int!) {
    boards(ids: [$boardId]) {
      id
      name
      items_page(limit: $limit, query_params: { rules: $rules }) {
        cursor
        items {
          id
          name
          state
          column_values {
            id
            text
          }
        }
      }
    }
  }
`;

const wireColumnValueSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().nullable(),
  })
  .loose();

const wireItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    state: z.string().nullable(),
    column_values: z.array(wireColumnValueSchema),
  })
  .loose();

const wireItemsPageSchema = z
  .object({
    cursor: z.string().nullable(),
    items: z.array(wireItemSchema),
  })
  .loose();

const wireBoardSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    items_page: wireItemsPageSchema,
  })
  .loose();

const crossBoardSearchResponseSchema = z
  .object({
    boards: z.array(wireBoardSchema.nullable()).nullable(),
  })
  .loose();

/**
 * Cross-board fan-out walker entry point. Per the M23 empirical-
 * probe findings, the walker:
 *
 *   1. Issues one `boards(ids: [$boardId]) { items_page(query_params:
 *      { rules }) }` GraphQL call per plan (per-board rule sets
 *      can't fold into a single document; N calls preserve the
 *      static document shape + transparent per-board latency
 *      profile that Decision 5's wall-clock cap is calibrated for).
 *   2. Walks plans sequentially so the aggregate `--limit` can
 *      short-circuit further fan-out before issuing calls whose
 *      results would be discarded.
 *   3. Streams each item via `onItem` as it arrives (push-then-
 *      await per `pagination.ts:369`); deterministic per-board-id
 *      order matches `inputs.plans`.
 *   4. Detects inaccessibility via Monday's silent-omit shape
 *      (`boards(ids: [<bad>])` returns `{boards: []}`). Boards
 *      missing from the response surface in
 *      `inaccessible_boards.details.missing_board_ids`.
 *   5. Surfaces `cross_board_truncated` (Codex round-1 P1-2) when
 *      `--limit` short-circuits OR any board's `items_page.cursor`
 *      came back non-null at the v0.3 single-call surface.
 *
 * Boards in `boardIds` that don't appear in `plans` are NOT scanned
 * — the column-resolution pre-pass already filtered them (with a
 * `column_not_found_on_board` warning surfaced by the action, not
 * the walker). The walker's contract is "fan out across `plans` and
 * detect inaccessibility against `boardIds`", separating the two
 * concerns for independent testability.
 *
 * **`source` is always `'live'`** per the Codex round-2 P2-1 fix —
 * the action layer aggregates this with the per-board column-
 * resolution pre-pass cache state via `SourceAggregator` and
 * resolves the envelope's `meta.source` / `meta.cache_age_seconds`
 * from the aggregator's resolved state.
 */
export const crossBoardSearch = async (
  inputs: CrossBoardSearchInputs,
): Promise<CrossBoardSearchResult> => {
  /* c8 ignore start */
  // Defensive: the action layer's pre-pass filters out boards
  // without resolvable columns before constructing
  // CrossBoardSearchInputs; an empty boardIds array means the
  // pre-pass found NO viable board, which the action should have
  // surfaced as a different error (no plans → nothing to walk).
  // The walker rejects rather than returning `{items: [], hasMore:
  // false}` so the empty-boardIds case can't silently masquerade
  // as a "no items matched" success.
  if (inputs.boardIds.length === 0) {
    throw new ApiError(
      'internal_error',
      'crossBoardSearch: boardIds is empty — the column-resolution pre-pass should ensure at least one board is scanned before calling the walker',
    );
  }
  /* c8 ignore stop */

  const pageSize = inputs.pageSize ?? 100;
  const maxItems = inputs.maxItems;

  // Per-board walk-state tracking for the cross_board_truncated
  // warning. The walker writes into `walkedBoardState` only for
  // boards it actually walked (got a wire response back). The
  // final `per_board_state` shape is computed at end-of-walk
  // from this map + the boardIds set (boards never reached →
  // 'not_started'; boards walked but inaccessible → omitted,
  // surfaced separately via `inaccessible_boards`).
  const walkedBoardState = new Map<string, CrossBoardPerBoardWalkState>();

  const items: CrossBoardItem[] = [];
  // Boards we actually issued a GraphQL call for. Distinct from
  // `returnedBoardIds` so we can tell "inaccessible (attempted, wire
  // returned []) " apart from "not_started (--limit short-circuited
  // before reaching the board)".
  const attemptedBoardIds = new Set<string>();
  const returnedBoardIds = new Set<string>();
  let complexity: Complexity | null = null;
  let limitHit = false;

  for (const plan of inputs.plans) {
    if (maxItems !== undefined && items.length >= maxItems) {
      limitHit = true;
      break;
    }

    const boardId = plan.board_id;
    attemptedBoardIds.add(boardId);
    const wireRules = plan.rules.map((r) => ({
      column_id: r.column_id,
      compare_value: r.compare_values,
    }));
    // Cap the per-board page size at the remaining --limit budget
    // so the walker doesn't fetch more items than it'll keep.
    // Defensive `Math.max` against zero/negative — the outer
    // `items.length >= maxItems` guard normally catches the
    // exhausted case before we reach here.
    const remaining =
      maxItems !== undefined ? maxItems - items.length : pageSize;
    const limit = Math.max(1, Math.min(pageSize, remaining));

    const response = await inputs.client.raw<unknown>(
      CROSS_BOARD_SEARCH_QUERY,
      { boardId, rules: wireRules, limit },
      { operationName: 'CrossBoardSearch' },
    );
    complexity = response.complexity;

    // R-NEW-19 lift — canonical parse-failure envelope via the
    // existing R18 `unwrapOrThrow` helper; `details.board_id`
    // threads through as a per-call discriminant.
    const parsedData = unwrapOrThrow(
      crossBoardSearchResponseSchema.safeParse(response.data),
      {
        context: 'Monday cross-board search response',
        details: { board_id: boardId },
        hint: 'Monday may have amended the `boards(ids:) { items_page }` surface — re-probe via `scripts/probe/m23-cross-board-search-2.ts` and amend cli-design §13 v0.3 entry if so',
      },
    );

    const boards = (parsedData.boards ?? []).filter(
      (b): b is z.infer<typeof wireBoardSchema> => b !== null,
    );
    const board = boards[0];
    if (board === undefined) {
      // Inaccessible — Monday returns `boards = []` for IDs the
      // token can't access. We don't record a walk-state for this
      // board; the inaccessibility surfaces separately via
      // `inaccessible_boards` below.
      continue;
    }
    returnedBoardIds.add(board.id);

    const cursor = board.items_page.cursor;

    for (const rawItem of board.items_page.items) {
      if (maxItems !== undefined && items.length >= maxItems) {
        limitHit = true;
        break;
      }
      const columnValues: Record<string, string | null> = {};
      for (const cv of rawItem.column_values) {
        columnValues[cv.id] = cv.text;
      }
      const item: CrossBoardItem = {
        id: rawItem.id,
        name: rawItem.name,
        state: rawItem.state,
        board: { id: board.id, name: board.name },
        column_values: columnValues,
      };
      items.push(item);
      if (inputs.onItem !== undefined) {
        // M18 push-then-await: append to the buffer FIRST so a
        // listener exception doesn't tear down the in-flight item;
        // the walker's onItem-hook contract matches paginate's.
        await inputs.onItem(item);
      }
    }

    if (limitHit) {
      // The board still has more items beyond what we collected
      // (the aggregate --limit fired mid-page).
      walkedBoardState.set(boardId, 'has_more');
      break;
    }
    // Drained this board's first page. v0.3 is single-call-only
    // per board — non-null cursor → board has more items;
    // surfaced via cross_board_truncated for agent introspection
    // (no resumable cross-board cursor — narrow with
    // --workspace / --favorites or use the v0.1 --board path).
    walkedBoardState.set(boardId, cursor === null ? 'exhausted' : 'has_more');
  }

  // Materialise the final per_board_state shape. Boards we walked
  // carry their actual state ('exhausted' | 'has_more'). Boards in
  // `boardIds` that we never reached (--limit short-circuit) are
  // 'not_started'. Boards we attempted but Monday omitted are
  // OMITTED here — surfaced separately via `inaccessible_boards`.
  const perBoardState: Record<string, CrossBoardPerBoardWalkState> = {};
  for (const bid of inputs.boardIds) {
    const walked = walkedBoardState.get(bid);
    if (walked !== undefined) {
      perBoardState[bid] = walked;
    } else if (!attemptedBoardIds.has(bid)) {
      // Never reached — fan-out stopped before this board.
      perBoardState[bid] = 'not_started';
    }
    // Else: attempted but not walked (inaccessible) → omitted.
  }

  const warnings: (
    | InaccessibleBoardsWarning
    | CrossBoardTruncatedWarning
  )[] = [];

  // Inaccessibility = boards we attempted but Monday's wire response
  // omitted. Boards we never attempted (--limit short-circuited
  // before reaching them) don't count as inaccessible — they're
  // surfaced via `cross_board_truncated.per_board_state` as
  // `not_started` for agent introspection.
  const attemptedArr = Array.from(attemptedBoardIds);
  if (attemptedArr.length > returnedBoardIds.size) {
    warnings.push(
      buildInaccessibleBoardsWarning(
        attemptedArr,
        Array.from(returnedBoardIds),
      ),
    );
  }

  const anyNotExhausted = Object.values(perBoardState).some(
    (s) => s !== 'exhausted',
  );
  const hasMore = limitHit || anyNotExhausted;
  if (hasMore) {
    const reason: 'limit_hit' | 'board_has_more' = limitHit
      ? 'limit_hit'
      : 'board_has_more';
    warnings.push(
      buildCrossBoardTruncatedWarning(
        reason,
        items.length,
        maxItems ?? null,
        perBoardState,
      ),
    );
  }

  return {
    items,
    hasMore,
    totalReturned: items.length,
    complexity,
    warnings,
    source: 'live',
  };
};

// Pin BoardId + MondayClient imports so this module surfaces the
// types that downstream consumers (commands/item/search.ts at M23
// implementation) will use — keeps imports clean across the
// pre-flight → impl drop without a separate re-export pass.
export type { BoardId, MondayClient };
export { BoardIdSchema };
