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
 *   1. **Per-board cursor walker.** Each board returns its own
 *      `items_page.cursor`; the fan-out walker maintains N
 *      per-board cursors (parent stream merges N child walkers).
 *      No parent cursor across boards — the trailer-meta shape is
 *      a per-board cursor map, not a single string.
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
import { BoardIdSchema, type BoardId } from '../types/ids.js';
import type { Transport } from './transport.js';

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
    message: `--max-boards exceeds the hard cap of ${String(HARD_CAP_MAX_BOARDS)}; narrow the cross-board set with --workspace or --favorites`,
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
 *   collected count reaches the cap.
 * - `onItem` — streaming hook per the v0.3-plan §3 M23 deliverable
 *   ("Reuse `startNdjsonStream` + `walkPages.onItem`"). Called per
 *   item-arrival across all boards; backpressure through the hook
 *   slows the fan-out walker.
 * - `signal` — AbortSignal threaded through to the transport for
 *   SIGINT support (cli.md "Signal handling").
 */
export interface CrossBoardSearchInputs {
  readonly transport: Transport;
  readonly boardIds: readonly BoardId[];
  readonly plans: readonly PerBoardScanPlan[];
  readonly pageSize?: number;
  readonly maxItems?: number;
  readonly onItem?: (
    item: CrossBoardItem,
  ) => void | Promise<void>;
  readonly signal?: AbortSignal;
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
    readonly column_token: string;
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
      column_token: z.string().min(1),
      hint: z.string().min(1),
    }).strict(),
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
          hint: 'narrow the cross-board set with --workspace <wid> or --favorites',
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
    column_token: columnToken,
    hint: 'cross-board search requires the --where column to resolve on every board in the fan-out; boards without the column are skipped',
  },
});

/**
 * Cross-board search-result envelope from the walker. Mirrors the
 * v0.1 single-board search return-shape's spirit (items + meta +
 * warnings) but adds the per-board cursor map for the trailer-meta
 * shape, and the per-walk warnings array for the two warning codes
 * above.
 */
export interface CrossBoardSearchResult {
  readonly items: readonly CrossBoardItem[];
  /**
   * Per-board cursors for the next page on each board, keyed by
   * board ID. Boards exhausted on the first call surface as
   * `null`; boards with more items surface a non-null cursor.
   * `next_cursor` on the §6.3 trailer is this map JSON-stringified.
   * Renamed from `nextCursor` (singular) — cross-board fan-out has
   * N cursors, not one.
   */
  readonly nextCursors: Readonly<Record<string, string | null>>;
  /**
   * `true` when ANY board in the fan-out returned a non-null cursor
   * OR `--limit` short-circuited mid-walk. `false` when every board
   * exhausted in one call.
   */
  readonly hasMore: boolean;
  readonly totalReturned: number;
  /**
   * `source: 'live'` for the fan-out (cross-board search doesn't
   * cache items); `source: 'cache'` / `'mixed'` may bubble up via
   * the per-board column-resolution pass (`boardMetadata` cache hits)
   * — the walker reports the AGGREGATE source so a single cached
   * board-metadata resolution surfaces as `'mixed'` at the envelope.
   */
  readonly source: 'live' | 'cache' | 'mixed';
  readonly warnings: readonly (
    | InaccessibleBoardsWarning
    | ColumnNotFoundOnBoardWarning
  )[];
}

const stubReject = (): Promise<CrossBoardSearchResult> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'crossBoardSearch is a v0.3-M23 pre-flight stub — runtime fan-out walker lands at M23 implementation alongside the `monday item search` cross-board action.',
      {
        details: {
          hint: 'M23 implementation lands the boards(ids:) { items_page(query_params:) } fan-out walker, per-board cursor tracking, inaccessible-boards detection, and the streaming-onItem composition.',
        },
      },
    ),
  );

/**
 * Cross-board fan-out walker entry point. Issues `boards(ids: $ids)
 * { id name items_page(query_params: { rules: ... }) { cursor items
 * { ... } } }` with per-board rule plans, walks per-board cursors to
 * exhaustion (or until `--limit` short-circuits), streams items
 * per-arrival via `onItem`, detects inaccessible boards via the
 * response.boards.length delta, and surfaces the
 * `inaccessible_boards` warning.
 *
 * Stub at the M23 pre-flight — the runtime body lands at M23
 * implementation kickoff alongside the cross-board action's item-
 * search verb extension. Throws `internal_error` until M23
 * implementation swaps the body.
 *
 * Boards in `boardIds` that don't appear in `plans` are NOT scanned —
 * the column-resolution pre-pass already filtered them (with a
 * `column_not_found_on_board` warning surfaced by the action, not
 * the walker). The walker's contract is "fan out across `plans` and
 * detect inaccessibility against `boardIds`", separating the two
 * concerns for independent testability.
 */
// Stub: M23 implementation issues the boards(ids:) { items_page
// (query_params: { rules }) } fan-out via inputs.transport, walks
// per-board cursors, emits items via onItem, and surfaces the
// inaccessible_boards + column_not_found_on_board warnings per the
// empirical probe findings. The pre-flight diff pins the contract
// surface; the runtime body lands at M23 implementation.
/* c8 ignore start */
export const crossBoardSearch = (
  _inputs: CrossBoardSearchInputs,
): Promise<CrossBoardSearchResult> => stubReject();
/* c8 ignore stop */

// Pin BoardId import so this module surfaces the type that
// downstream consumers (commands/item/search.ts at M23 implementation)
// will use for the `boardIds` slot — keeps imports clean across the
// pre-flight → impl drop without a separate re-export pass.
export type { BoardId };
export { BoardIdSchema };
