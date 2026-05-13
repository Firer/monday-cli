/**
 * Polling-based watch surface for the v0.4-M29 `monday item watch <iid>`
 * verb (`cli-design.md` §13 v0.4 entry + §14.4 closure;
 * `v0.4-plan.md` §3 M29).
 *
 * **What `monday item watch` answers:** "wait for changes on this item
 * and emit them as they arrive, without me scripting a polling loop
 * around `monday item history`". A single CLI invocation polls Monday's
 * `boards(ids:){ activity_logs(item_ids:, from:, limit:) }` surface on
 * each tick, projects new events through the M24 `item-history-
 * projection.ts` projector (reused verbatim), and emits one NDJSON
 * record per new event plus a session-summary trailer on exit.
 *
 * **Status: pre-flight stub.** Runtime body of {@link watchItem} ships
 * at M29 IMPL. The module surface (input + result types, projector
 * import, named-operation pin) is finalised here so the cli-design
 * §4.3 row + v0.4-plan §3 M29 deliverables list cite real signatures.
 *
 * **Pinned design clearances (v0.4-plan §3 M29 + cli-design §14.4
 * closure at `31713fb`).**
 *
 *   - **Default cadence: 30s** (`DEFAULT_WATCH_INTERVAL_MS`). Override
 *     range 1000ms–3600000ms (`MIN_WATCH_INTERVAL_MS` /
 *     `MAX_WATCH_INTERVAL_MS`). Per the empirical probe
 *     (`scripts/probe/m29-polling-burn.ts`, 2026-05-13, API `2026-01`)
 *     each poll costs 10 complexity points against a 1,000,000/min
 *     budget — 30s cadence burns 0.002% of the per-minute budget;
 *     politeness + Monday's >30s `activity_logs` propagation lag (M24
 *     probe) are the binding constraints, NOT budget.
 *   - **Reactive circuit breaker** (`CIRCUIT_BREAKER_CONSECUTIVE_FAILS`
 *     = 5). On `complexity_exceeded` / `concurrency_exceeded` /
 *     `rate_limited` wire errors the loop backs off respecting
 *     `reset_in_x_seconds` (60s default cap when absent; 300s
 *     ceiling per `MAX_BACKOFF_SECONDS`); after N consecutive failed
 *     polls the session trips to a failure envelope carrying
 *     `circuit_broken_at` + `failed_polls` in trailer-meta. Each
 *     failure APPENDS a `WatchSessionWarning` to
 *     {@link WatchItemResult}.warnings; the action body folds the
 *     accumulated warnings into the trailer-meta's `_meta.warnings`
 *     slot at session end per cli-design §6.3 (resource lines +
 *     final `_meta`; warnings are NOT interleaved with event lines).
 *   - **No new ERROR_CODE.** `complexity_exceeded` /
 *     `concurrency_exceeded` / `rate_limited` already in §6.5's
 *     29-code registry cover the circuit-breaker exit. The trailer-
 *     meta `circuit_broken_at` slot discriminates which Monday code
 *     tripped the session.
 *   - **Each invocation independent.** No shared registry between
 *     concurrent `monday item watch` invocations; the last-seen-
 *     event-id watermark lives in-memory only. Aligns with cli-design
 *     §3.1 #5.
 *   - **`--since <event-id>` is a one-shot bootstrap watermark, not a
 *     state-machine resume.** The runtime looks up the event's
 *     `created_at` once at startup, sets the initial poll-from
 *     timestamp, and emits any backlog from that point before
 *     entering the polling loop. Distinct from a full `--resume
 *     <token>` mechanism (still open per cli-design §14.6).
 *   - **`--once` vs `--max-events 1` are DISTINCT.** `--once` drains
 *     the backlog from `--since` (or the most-recent N events if no
 *     `--since`) and exits without polling. `--max-events 1` waits
 *     for the NEXT event.
 *
 * **Why polling activity_logs ONLY (not the M24 two-source merge).**
 * The M29 pre-flight probe (`scripts/probe/m29-polling-burn.ts`,
 * 2026-05-13) measured the merged (activity_logs + updates) shape at
 * 20 complexity points per poll vs 10 for activity_logs alone. Polling
 * BOTH sources every tick doubles the burn while emitting comments
 * agents could already poll via `monday update list` on a slower
 * cadence. v0.4-M29 ships activity_logs-only; a `--include-comments`
 * flag that adds a separate slower-cadence updates poll is a v0.4-
 * stretch / v0.5 candidate. `--include update_posted` /
 * `--include update_replied` is accepted at the argv boundary for
 * forward-compat but returns no events at v0.4-M29 (the projector
 * variants are valid but the activity_logs source doesn't surface
 * comment events).
 */
import { z } from 'zod';
import { ApiError, UsageError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import type { ErrorCode } from '../utils/errors.js';
import type { MondayClient } from './client.js';
import type { ItemId } from '../types/ids.js';
import {
  ITEM_SCOPED_ENTITY,
  buildUnknownEventKindWarning,
  projectActivityLogRow,
  rawActivityLogRowSchema,
  type HistoryEvent,
  type RawActivityLogRow,
  type UnknownEventKindWarning,
} from './item-history-projection.js';

/**
 * Default polling interval (30,000ms / 30s) per cli-design §14.4
 * closure. Pinned by the M29 pre-flight empirical probe — burns
 * ~0.002% of the per-minute complexity budget at this cadence, and
 * matches Monday's documented >30s `activity_logs` propagation lag so
 * faster polling would just generate polls against unpropagated data.
 */
export const DEFAULT_WATCH_INTERVAL_MS = 30_000;

/**
 * Floor on `--interval <ms>` per cli-design §14.4 closure. Faster than
 * 1s would generate Monday request-rate concerns + crosses the
 * propagation-lag threshold where successive polls would see the same
 * window of unpropagated events.
 */
export const MIN_WATCH_INTERVAL_MS = 1_000;

/**
 * Ceiling on `--interval <ms>` per cli-design §14.4 closure. Beyond
 * 1h the verb crosses the "no longer a watch, just a poll" boundary —
 * agents should use `cron + monday item history` for hourly+ cadences
 * rather than a long-running CLI session.
 */
export const MAX_WATCH_INTERVAL_MS = 3_600_000;

/**
 * Number of consecutive failed polls before the circuit breaker trips
 * per cli-design §14.4 closure. Each prior failure APPENDS a
 * `WatchSessionWarning` to {@link WatchItemResult}.warnings (folded
 * into the trailer's `_meta.warnings[]` slot at session end per §6.3
 * — NOT interleaved with event lines); the Nth (default 5) failure
 * trips the session to a failure envelope.
 */
export const CIRCUIT_BREAKER_CONSECUTIVE_FAILS = 5;

/**
 * Default `reset_in_x_seconds` fallback when Monday's wire error
 * doesn't carry the field. 60s mirrors Monday's per-minute complexity
 * window so the backoff aligns with the budget-reset cycle.
 */
export const DEFAULT_BACKOFF_SECONDS = 60;

/**
 * Cap on `reset_in_x_seconds` backoff per cli-design §14.4 closure.
 * Beyond 5min the session may as well exit + let an agent re-invoke
 * later — sleeping a watch loop for >5min defeats the "react quickly"
 * purpose.
 */
export const MAX_BACKOFF_SECONDS = 300;

/**
 * Default number of recent events to drain at session startup when
 * `--once` is set without `--since`. Mirrors the M24 `--limit` default
 * so an agent calling `monday item watch <iid> --once` without bounds
 * sees the same backlog `monday item history <iid> --limit 100` would
 * (just streamed via the NDJSON envelope).
 */
export const DEFAULT_ONCE_BACKLOG_LIMIT = 100;

/**
 * Reason a watch session exited. Discriminates the trailer-meta's
 * exit context so agents key off a single field rather than parsing
 * the trailer for clues. Mirrors the v0.3-M22 status probe's
 * status-discriminator pattern.
 *
 *   - `max_events` — `--max-events <n>` ceiling fired; success envelope.
 *   - `max_duration` — `--max-duration <seconds>` ceiling fired; success.
 *   - `once_complete` — `--once` backlog drained; success.
 *   - `signal` — SIGINT / SIGTERM graceful drain; exit code 130 per §7.
 *   - `circuit_broken` — N consecutive failed polls; failure envelope
 *     carrying `circuit_broken_at` + the underlying Monday error code.
 */
export type WatchExitReason =
  | 'max_events'
  | 'max_duration'
  | 'once_complete'
  | 'signal'
  | 'circuit_broken';

/**
 * Inputs to {@link watchItem}. The action-layer (`src/commands/item/
 * watch.ts`) constructs this from parsed argv + the resolved
 * {@link MondayClient} + the SIGINT-driven {@link AbortSignal}.
 *
 *   - `client` — resolved {@link MondayClient} so polls inherit
 *     `--retry` + `--verbose`-complexity injection (mirrors M22's
 *     `fetchUsage` + M24's `fetchItemHistory` shape).
 *   - `itemId` — target item. Branded {@link ItemId}; parsed at the
 *     command argv boundary.
 *   - `boardId` — Monday's `activity_logs` resolver lives under
 *     `boards(ids:)`, so the watcher needs the item's parent board ID.
 *     Action body looks up via `lookupItemBoard` before constructing
 *     inputs (same one-shot pattern as M24's `fetchItemHistory`).
 *   - `intervalMs` — poll cadence (1000ms–3600000ms; default
 *     {@link DEFAULT_WATCH_INTERVAL_MS}). Parsed at argv boundary so
 *     ms semantics are unambiguous (cli-design §14.4 closure pins
 *     `--interval <ms>`, not bare seconds — distinguishes 30 from
 *     30000 unambiguously).
 *   - `since` — last-seen-event-id watermark. The runtime looks it up
 *     against Monday's activity_logs once at startup, resolves the
 *     `created_at`, sets the initial poll-from timestamp. Omitted →
 *     starts the watermark at session-start time (catches only
 *     events AFTER `monday item watch` was invoked).
 *   - `once` — drain backlog from `--since` (or recent N events) and
 *     exit; do NOT enter the polling loop. Distinct from
 *     `maxEvents: 1` which waits for the next event.
 *   - `maxEvents` — emit ceiling. Session exits with
 *     `exit_reason: 'max_events'` once the count is reached.
 *   - `maxDurationSeconds` — wall-clock ceiling. Session exits with
 *     `exit_reason: 'max_duration'` once the duration is reached
 *     (current in-flight poll completes first).
 *   - `includeKinds` — projection-time filter against the M24 closed
 *     event-kind taxonomy (see {@link HistoryEvent['kind']}).
 *     Forward-compat for the M24 9-kind taxonomy; v0.4-M29 only
 *     emits activity_logs-sourced kinds (no `update_posted` /
 *     `update_replied` until comment-polling lands in v0.4-stretch /
 *     v0.5).
 *   - `signal` — REQUIRED `AbortSignal` for SIGINT graceful drain.
 *     The polling loop awaits a Promise.race between the cadence
 *     timer + signal.aborted; on abort, the current in-flight poll
 *     completes or aborts cleanly, the trailer-meta emits, and the
 *     session exits 130. Mirrors the v0.3-M22 status probe's
 *     signal-handling pattern.
 *   - `onEvent` — REQUIRED streaming hook. The polling loop calls this
 *     per-emitted-event so the action body wires NDJSON via
 *     `startNdjsonStream`. Awaiting each call preserves backpressure
 *     when stdout is a slow consumer (e.g., piped through `jq` to a
 *     network sink).
 *
 * Warnings accumulate inside the polling loop and surface in
 * {@link WatchItemResult}.warnings (NOT a per-warning hook) per
 * cli-design §6.3's NDJSON contract: resource lines + final `_meta`;
 * warnings live under `_meta.warnings`, NOT interleaved with event
 * records. The action body folds them into the trailer-meta's
 * `warnings[]` slot at session end.
 */
export interface WatchItemInputs {
  readonly client: MondayClient;
  readonly itemId: ItemId;
  readonly boardId: string;
  readonly intervalMs: number;
  readonly since?: string;
  readonly once?: boolean;
  readonly maxEvents?: number;
  readonly maxDurationSeconds?: number;
  readonly includeKinds?: readonly HistoryEvent['kind'][];
  readonly signal: AbortSignal;
  readonly onEvent: (event: HistoryEvent) => void | Promise<void>;
}

/**
 * Per-poll warning surfaced during a watch session. Distinct from the
 * M24 projector's {@link UnknownEventKindWarning} (which surfaces
 * unrecognised event kinds) — this shape surfaces session-level
 * progression (circuit-breaker firings, backoff sleeps, stale-
 * cursor recoveries).
 *
 * Discriminated on `code`. Accumulates inside the polling loop and
 * lands on {@link WatchItemResult}.warnings at session end; the
 * action body folds the array into the trailer-meta's
 * `_meta.warnings[]` slot per cli-design §6.1 `Warning[]` + §6.3
 * streaming-trailer contract. NEVER emitted as a standalone NDJSON
 * line (warnings are NOT interleaved with event records).
 */
export type WatchSessionWarning =
  | {
      readonly code: 'poll_failed';
      readonly message: string;
      readonly details: {
        readonly consecutive_failures: number;
        readonly monday_code: string;
        readonly backoff_seconds: number;
      };
    }
  | {
      readonly code: 'circuit_breaker_armed';
      readonly message: string;
      readonly details: {
        readonly polls_until_trip: number;
        readonly monday_code: string;
      };
    }
  | UnknownEventKindWarning;

/**
 * Result of a completed watch session. Drives the trailer-meta
 * envelope shape per cli-design §14.4 closure + v0.4-plan §3 M29 D3
 * (session-summary trailer schema).
 *
 *   - `events_emitted` — number of NDJSON event records emitted
 *     across the session (excludes warnings).
 *   - `polls_made` — number of successful polls (failed polls
 *     contribute to `failed_polls`, not here).
 *   - `failed_polls` — count of polls that hit a Monday wire error.
 *     Mid-session failures that recovered before the circuit breaker
 *     tripped count here; the trailer-meta surfaces both counters so
 *     agents diagnose health vs hard-fail.
 *   - `watch_duration_seconds` — wall-clock from session start to
 *     trailer emit. Pinned for the agent-facing "how long did I
 *     watch" answer.
 *   - `last_seen_event_id` — for restart. The most recent activity-
 *     log event ID emitted. `null` when no events emitted (e.g., a
 *     `--once --since <id>` with no backlog past the watermark).
 *   - `circuit_broken_at` — ISO timestamp when the circuit breaker
 *     tripped; `null` for clean exits. Only set when
 *     `exit_reason === 'circuit_broken'`.
 *   - `exit_reason` — discriminates trailer interpretation. See
 *     {@link WatchExitReason}.
 *   - `source` — always `'live'` for v0.4. Polling against Monday is
 *     the source of truth; no per-call cache.
 */
export interface WatchItemResult {
  readonly events_emitted: number;
  readonly polls_made: number;
  readonly failed_polls: number;
  readonly watch_duration_seconds: number;
  readonly last_seen_event_id: string | null;
  readonly circuit_broken_at: string | null;
  readonly exit_reason: WatchExitReason;
  /**
   * Session-accumulated warnings. The action body folds these into
   * the trailer-meta's `warnings[]` slot per cli-design §6.3
   * (resource lines + final `_meta` with warnings under
   * `_meta.warnings`). NOT interleaved with event records.
   */
  readonly warnings: readonly WatchSessionWarning[];
  readonly source: 'live';
}

/**
 * Pinned GraphQL document for the per-tick poll. Mirrors M24's
 * `ACTIVITY_LOGS_QUERY` verbatim — M29's runtime body reuses M24's
 * projector (`projectActivityLogRow`) on the same wire-shape rows.
 * The `complexity` selection is co-located so each poll's response
 * carries per-call cost + remaining-budget for circuit-breaker
 * decisions (mirrors the M29 pre-flight probe shape).
 *
 * **R-NEW-37 W2 audit-point: operationName is `ItemWatchPoll`.**
 * Pinned literal here + threaded into the {@link watchItem} fetcher's
 * `client.raw(..., { operationName: 'ItemWatchPoll' })` call once IMPL
 * lands. Safely-by-construction per the M27 round-1 P2-1 precedent
 * (`6f59a83`): no caller-overridable operationName input slot on
 * {@link WatchItemInputs}.
 */
export const WATCH_POLL_QUERY = `
  query ItemWatchPoll(
    $bid: [ID!]!,
    $iid: [ID!]!,
    $from: ISO8601DateTime!,
    $limit: Int!
  ) {
    complexity { before after query reset_in_x_seconds }
    boards(ids: $bid) {
      id
      activity_logs(
        item_ids: $iid,
        from: $from,
        limit: $limit
      ) {
        id
        event
        entity
        user_id
        created_at
        data
      }
    }
  }
`;

/**
 * Wire-codes that arm the circuit breaker per cli-design §14.4
 * closure D1. These are Monday's rate-limit codes already in §6.5's
 * 29-code registry; the breaker reuses them rather than introducing
 * a new ERROR_CODE (count stays at 29). Non-matching wire errors
 * (`not_found` from a deleted item mid-watch, `unauthorized` from a
 * revoked token, `internal_error` from a parse boundary) propagate
 * unchanged — they're not "Monday is asking us to slow down" signals.
 */
const CIRCUIT_BREAKER_CODES: readonly ErrorCode[] = [
  'complexity_exceeded',
  'concurrency_exceeded',
  'rate_limited',
];

/**
 * Wire-shape schema for the per-tick {@link WATCH_POLL_QUERY}
 * response. Mirrors M24's `activityLogsResponseSchema` for the
 * `boards.activity_logs` sub-tree; `.loose()` so forward-compat
 * Monday surface extensions don't break the parse.
 */
const watchPollResponseSchema = z
  .object({
    boards: z
      .array(
        z
          .object({
            id: z.string().min(1),
            activity_logs: z.array(rawActivityLogRowSchema).nullable(),
          })
          .loose()
          .nullable(),
      )
      .nullable(),
  })
  .loose();

/**
 * Promise that resolves after `ms` milliseconds OR rejects when the
 * supplied {@link AbortSignal} fires. Mirrors `src/api/retry.ts`'s
 * `defaultSleep` + the R-NEW-26 race-window guard: a sync
 * `signal.aborted` check BEFORE listener registration handles the
 * case where the abort fires synchronously between the caller's last
 * `signal.aborted` check and our `addEventListener` call (Node's
 * AbortSignal does NOT replay 'abort' for listeners attached after
 * the event dispatched).
 */
const sleepWithSignal = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    // Defensive race-window guard (R-NEW-26): handles the narrow case
    // where the abort fires synchronously between the caller's last
    // `signal.aborted` check and our `addEventListener` registration.
    // Not reachable from the integration tests since the runner
    // checks `signal.aborted` after every await; production-only.
    /* c8 ignore start */
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('aborted'));
      return;
    }
    /* c8 ignore stop */
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Whether an error represents Monday signalling rate-limit /
 * complexity-budget exhaustion (matched by ErrorCode rather than
 * English message per `.claude/rules/security.md` + cli-design §6.5
 * agent-keys-off-code discipline).
 */
const isCircuitBreakerError = (err: unknown): err is ApiError =>
  err instanceof ApiError &&
  (CIRCUIT_BREAKER_CODES as readonly string[]).includes(err.code);

/**
 * Computes the per-failure backoff in seconds. Monday's wire error
 * may carry `retry_after_seconds` (mapped through `api/errors.ts`'s
 * `extractRetryInSeconds`); when absent we default to
 * {@link DEFAULT_BACKOFF_SECONDS}. Either way we clamp at
 * {@link MAX_BACKOFF_SECONDS} so the loop doesn't sleep past the
 * 5-min ceiling (cli-design §14.4 closure: "beyond 5min the session
 * may as well exit + let an agent re-invoke later").
 */
const backoffSecondsFrom = (err: ApiError): number => {
  const seconds = err.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS;
  return Math.min(seconds, MAX_BACKOFF_SECONDS);
};

/**
 * Loads one page of `activity_logs` against the watch surface,
 * filtered to the target item via the `iid` arg + the
 * `from: <watermark>` ISO-timestamp pin. Reuses M24's wire shape
 * (same `ACTIVITY_LOGS_QUERY` selection set, minus the per-page
 * pagination args that watch doesn't paginate). Returns the raw
 * rows so the caller can apply walker-side entity filter +
 * projection + dedup.
 */
const fetchPoll = async (args: {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly itemId: ItemId;
  readonly from: string;
  readonly limit: number;
}): Promise<readonly RawActivityLogRow[]> => {
  const response = await args.client.raw<unknown>(
    WATCH_POLL_QUERY,
    {
      bid: [args.boardId],
      iid: [args.itemId],
      from: args.from,
      limit: args.limit,
    },
    { operationName: 'ItemWatchPoll' },
  );
  const parsed = unwrapOrThrow(
    watchPollResponseSchema.safeParse(response.data),
    {
      context: 'Monday `boards.activity_logs` watch-poll response',
      details: { item_id: args.itemId, board_id: args.boardId },
      hint: 'Monday may have amended the `boards(ids:) { activity_logs }` surface — re-probe via `scripts/probe/m29-polling-burn.ts` and amend cli-design §14.4 closure if so',
    },
  );
  const rows: RawActivityLogRow[] = [];
  for (const board of parsed.boards ?? []) {
    if (board === null) continue;
    rows.push(...(board.activity_logs ?? []));
  }
  return rows;
};

/**
 * Looks up the `--since <event-id>` watermark by scanning a recent
 * window of activity_logs for the matching id. Monday's GraphQL
 * surface has no `activity_log(id:)` resolver; we fetch a generous
 * recent slice and search client-side. If the id isn't in the
 * window, throws `usage_error` so an agent passing a stale id sees
 * a clear cause (not a silent no-op session).
 */
const resolveSinceWatermark = async (args: {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly itemId: ItemId;
  readonly sinceEventId: string;
}): Promise<RawActivityLogRow> => {
  // Use a unix-epoch floor so we get the full recent backlog; the
  // 500-row limit caps how far back resumption reaches in a single
  // call (sufficient for "resume from a recent session" — the
  // documented intent per cli-design §14.4 closure).
  const rows = await fetchPoll({
    client: args.client,
    boardId: args.boardId,
    itemId: args.itemId,
    from: '1970-01-01T00:00:00Z',
    limit: 500,
  });
  const match = rows.find((r) => r.id === args.sinceEventId);
  if (match === undefined) {
    throw new UsageError(
      `--since event-id ${args.sinceEventId} not found in the recent activity-log window for item ${args.itemId}`,
      {
        details: {
          item_id: args.itemId,
          since_event_id: args.sinceEventId,
          window_size: rows.length,
          hint: 'Monday\'s activity_logs has no direct event-id resolver; the CLI scans the 500 most recent rows. Pass a more recent event-id, or omit --since to start the watch session from now.',
        },
      },
    );
  }
  return match;
};

/**
 * Sorts raw activity-log rows chronologically ascending so the polling
 * loop emits in real-time order. Tie-breaks on `id` (numeric compare
 * via BigInt — Monday's ids can exceed `Number.MAX_SAFE_INTEGER`).
 */
const sortChronological = (
  rows: readonly RawActivityLogRow[],
): RawActivityLogRow[] => {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    return compareBigIntStrings(a.id, b.id);
  });
  return copy;
};

/**
 * Numeric compare for Monday's id strings without loss of precision.
 * Activity-log ids can be 13+ digits, exceeding the JS Number safe
 * range; BigInt parsing avoids the lossy `Number(...)` shape.
 * Lexicographic compare would mis-order ids of different lengths
 * (`"9"` > `"10"` lex; `9n < 10n` numerically).
 */
const compareBigIntStrings = (a: string, b: string): number => {
  try {
    const ba = BigInt(a);
    const bb = BigInt(b);
    if (ba === bb) return 0;
    return ba < bb ? -1 : 1;
  } /* c8 ignore start */ catch {
    // Defensive: non-numeric id shouldn't happen (Monday's wire
    // schema is `String!` but always digits per the M24 probe);
    // fall back to lex compare so we never throw out of a sort.
    if (a === b) return 0;
    return a < b ? -1 : 1;
  } /* c8 ignore stop */
};

/**
 * Polling-based event-stream walker. Reuses M24's
 * `projectActivityLogRow` for per-event projection; the polling
 * loop owns the cadence + circuit-breaker + watermark state.
 *
 *   1. Resolves the initial poll-from timestamp from `inputs.since`
 *      (look up event-id → created_at) or from now.
 *   2. If `inputs.once === true`: drains backlog through `onEvent`,
 *      exits with `exit_reason: 'once_complete'`.
 *   3. Otherwise enters the polling loop: each tick fires
 *      `WATCH_POLL_QUERY`, filters newly-seen events (dedup Set +
 *      walker-side `entity === 'pulse'`), projects via
 *      `projectActivityLogRow`, applies the `includeKinds` filter,
 *      emits via `onEvent`, advances the watermark.
 *   4. After each poll awaits the cadence interval as a Promise
 *      racing the {@link AbortSignal}. On signal: graceful exit
 *      `exit_reason: 'signal'`.
 *   5. On Monday rate-limit wire errors (`complexity_exceeded` /
 *      `concurrency_exceeded` / `rate_limited`): appends a
 *      `poll_failed` warning to the in-flight accumulator (folded
 *      into the trailer's `_meta.warnings[]` at session end — NOT
 *      emitted as an interleaved NDJSON line per §6.3), backs off
 *      `retry_after_seconds` (60s default cap; 300s ceiling per
 *      {@link MAX_BACKOFF_SECONDS}), increments failed-poll counter.
 *      After {@link CIRCUIT_BREAKER_CONSECUTIVE_FAILS} consecutive
 *      failures trips with `exit_reason: 'circuit_broken'` and
 *      `circuit_broken_at` set; the action body inspects the result
 *      after the trailer emits and re-throws an `ApiError` so the
 *      runner emits a §6.5 failure envelope on stderr.
 *   6. On `--max-events` / `--max-duration` ceiling reached: clean
 *      exit with the matching `exit_reason`.
 */
export const watchItem = async (
  inputs: WatchItemInputs,
): Promise<WatchItemResult> => {
  const sessionStartMs = Date.now();
  const sessionStartIso = new Date(sessionStartMs).toISOString();
  // Epoch floor sentinel reused for "give me the recent backlog"
  // fetches (`--once` without `--since`, `--since` lookup). Monday's
  // `activity_logs(from:, limit:)` returns most-recent-first up to
  // `limit`; with an epoch `from:` the slice covers the entire
  // recent window the caller asked for. The chronological sort
  // inside `processRows` then re-orders for emission.
  const EPOCH_FLOOR = '1970-01-01T00:00:00Z';
  const includeKinds =
    inputs.includeKinds === undefined
      ? undefined
      : new Set<HistoryEvent['kind']>(inputs.includeKinds);

  const warnings: WatchSessionWarning[] = [];
  const unknownTracker = new Map<
    string,
    { event: string; entity: string; count: number }
  >();
  let eventsEmitted = 0;
  let pollsMade = 0;
  let failedPolls = 0;
  let consecutiveFailures = 0;
  let armedFor: string | undefined; // monday_code that armed; cleared on success
  let lastSeenEventId: string | null = null;
  let circuitBrokenAt: string | null = null;

  // Read `signal.aborted` via a function so TS narrowing on the
  // top-of-loop `if (inputs.signal.aborted)` doesn't lock the type
  // into `false` for subsequent post-await reads — the runtime value
  // can flip between awaits when the thunk's own abort fires mid-
  // call. Mirrors `src/api/retry.ts:withRetry`'s `isAborted` shape.
  const isAborted = (): boolean => inputs.signal.aborted;

  /**
   * Builds the immutable result snapshot. Defined upfront so the
   * pre-loop bootstrap (`resolveSinceWatermark`) can also exit via
   * `signal` cleanly with a trailer (Codex impl review round-1 P1-1
   * fix: aborts during in-flight wire calls must surface the
   * `exit_reason: 'signal'` trailer rather than rethrowing past the
   * action body's `stream.writeTrailer`).
   */
  const buildResult = (
    exitReason: WatchExitReason,
  ): WatchItemResult => {
    const finalUnknownWarnings: UnknownEventKindWarning[] = Array.from(
      unknownTracker.values(),
    )
      .sort((a, b) =>
        /* c8 ignore next */
        a.event < b.event ? -1 : a.event > b.event ? 1 : 0,
      )
      .map((entry) =>
        buildUnknownEventKindWarning(entry.event, entry.entity, entry.count),
      );
    return {
      events_emitted: eventsEmitted,
      polls_made: pollsMade,
      failed_polls: failedPolls,
      watch_duration_seconds: (Date.now() - sessionStartMs) / 1000,
      last_seen_event_id: lastSeenEventId,
      circuit_broken_at: circuitBrokenAt,
      exit_reason: exitReason,
      warnings: [...warnings, ...finalUnknownWarnings],
      source: 'live',
    };
  };

  // Initial poll-from watermark + the optional `--since` boundary
  // that excludes already-seen events. `--since`: look up the
  // event's created_at; absent → now (only events strictly after
  // session start surface in the polling loop; `--once` overrides
  // with the epoch floor below to drain the recent backlog).
  let watermark: string;
  // `sinceBoundary` excludes events <= the boundary (Codex impl
  // review round-1 P2-1 fix): without it, a `--since` resume across
  // a same-timestamp tuple re-emits events the prior session already
  // emitted. Compared via `compareBigIntStrings` (numeric, not lex).
  let sinceBoundary: { readonly createdAt: string; readonly id: string } | undefined;
  const seenEventIds = new Set<string>();
  if (inputs.since !== undefined) {
    try {
      const sinceRow = await resolveSinceWatermark({
        client: inputs.client,
        boardId: inputs.boardId,
        itemId: inputs.itemId,
        sinceEventId: inputs.since,
      });
      sinceBoundary = { createdAt: sinceRow.created_at, id: sinceRow.id };
      watermark = sinceRow.created_at;
      seenEventIds.add(sinceRow.id);
    } catch (err) {
      // P1-1 fix scope: if SIGINT fired mid-lookup, emit a clean
      // signal trailer instead of letting the transport's abort
      // wrap propagate as `internal_error`. UsageError (unknown
      // event-id) propagates unchanged.
      if (isAborted() && !(err instanceof UsageError)) {
        return buildResult('signal');
      }
      throw err;
    }
  } else {
    watermark = sessionStartIso;
  }

  /**
   * Per-tick processor: chronological sort, walker-side entity
   * filter, dedup via the Set, projection, `--include` filter, and
   * per-event emit via `onEvent`. Returns the early-exit reason when
   * a ceiling fires mid-poll; otherwise undefined (continue looping).
   */
  const processRows = async (
    rows: readonly RawActivityLogRow[],
  ): Promise<WatchExitReason | undefined> => {
    const sorted = sortChronological(rows);
    for (const row of sorted) {
      if (seenEventIds.has(row.id)) continue;
      // P2-1 fix: skip rows at-or-before the `--since` boundary
      // (by created_at, with BigInt id tie-break). Without this,
      // a resumed session re-emits events sharing a created_at
      // tuple with the bootstrap event.
      if (sinceBoundary !== undefined) {
        if (row.created_at < sinceBoundary.createdAt) continue;
        if (
          row.created_at === sinceBoundary.createdAt &&
          compareBigIntStrings(row.id, sinceBoundary.id) <= 0
        ) {
          continue;
        }
      }
      seenEventIds.add(row.id);
      // Always advance the wall-clock watermark — even for filtered
      // rows — so the next poll's `from:` doesn't re-fetch them.
      if (row.created_at > watermark) {
        watermark = row.created_at;
      }
      // Walker-side entity filter per M24 Decision 2 closure (single
      // source of truth at the walker layer; projector does NOT
      // re-filter). Drops board-scoped events that leak through the
      // `iid` arg.
      if (row.entity !== ITEM_SCOPED_ENTITY) continue;
      const event = projectActivityLogRow({ row });
      // Track unknown event kinds for warning aggregation; one
      // warning per unique kind at session end (matches M24's
      // unknownByKey shape so re-walks against the same stream
      // produce identical envelopes).
      if (event.kind === 'unknown') {
        const key = `${event.event}\x00${event.entity}`;
        const entry = unknownTracker.get(key);
        if (entry === undefined) {
          unknownTracker.set(key, {
            event: event.event,
            entity: event.entity,
            count: 1,
          });
        } else {
          entry.count++;
        }
      }
      // `--include` filter applied AFTER projection so unknown-event-
      // kind aggregation still surfaces (mirrors M24's filter
      // semantics).
      if (includeKinds !== undefined && !includeKinds.has(event.kind)) {
        continue;
      }
      await inputs.onEvent(event);
      eventsEmitted++;
      lastSeenEventId = row.id;
      if (
        inputs.maxEvents !== undefined &&
        eventsEmitted >= inputs.maxEvents
      ) {
        return 'max_events';
      }
    }
    return undefined;
  };

  // --once short-circuit: one poll, drain backlog, exit. P1-2 fix:
  // without `--since`, the backlog drain pulls from the epoch floor
  // (Monday returns the most-recent N events; chronological sort
  // re-orders for emission), NOT from session start — the contract
  // is "drain the recent N events", not "wait for new events". With
  // `--since`, the `--since` row's created_at is the lower bound;
  // limit 500 covers the resumption window.
  if (inputs.once === true) {
    try {
      const rows = await fetchPoll({
        client: inputs.client,
        boardId: inputs.boardId,
        itemId: inputs.itemId,
        from: inputs.since === undefined ? EPOCH_FLOOR : watermark,
        limit:
          inputs.since === undefined ? DEFAULT_ONCE_BACKLOG_LIMIT : 500,
      });
      pollsMade++;
      const early = await processRows(rows);
      return buildResult(early ?? 'once_complete');
    } catch (err) {
      // P1-1 fix scope: SIGINT mid-once-poll → trailer with signal
      // exit rather than rethrow.
      if (isAborted()) {
        return buildResult('signal');
      }
      throw err;
    }
  }

  // P2-2 fix: compute a deadline once so cadence/backoff sleeps can
  // shrink to `min(intervalMs, remainingMs)` and don't overshoot
  // `--max-duration`. Without the deadline-aware sleep, a
  // `--max-duration 5` with default 30s cadence would exit at ~30s
  // (full cadence then top-of-loop check), and a circuit-breaker
  // backoff could overshoot by up to `MAX_BACKOFF_SECONDS` (300s).
  const deadlineMs =
    inputs.maxDurationSeconds === undefined
      ? Number.POSITIVE_INFINITY
      : sessionStartMs + inputs.maxDurationSeconds * 1000;
  const remainingMs = (): number =>
    Math.max(0, deadlineMs - Date.now());

  // Polling loop. Each iteration: signal check → ceiling check →
  // poll → process events → cadence wait. Early exits route through
  // `buildResult` for uniform shape.
  for (;;) {
    // Defensive: in practice the cadence-wait below catches the
    // abort signal and exits via the catch-and-return-signal branch;
    // this top-of-loop check covers the narrow race where the
    // cadence completed cleanly but the signal aborted between then
    // and the next iteration. Hard to drive deterministically from
    // an integration test (the cadence catch wins almost always).
    /* c8 ignore start */
    if (isAborted()) {
      return buildResult('signal');
    }
    /* c8 ignore stop */
    if (remainingMs() <= 0) {
      return buildResult('max_duration');
    }

    try {
      const rows = await fetchPoll({
        client: inputs.client,
        boardId: inputs.boardId,
        itemId: inputs.itemId,
        from: watermark,
        limit: 100,
      });
      pollsMade++;
      consecutiveFailures = 0;
      armedFor = undefined;
      const early = await processRows(rows);
      if (early !== undefined) {
        return buildResult(early);
      }
    } catch (err) {
      // P1-1 fix: SIGINT mid-poll surfaces as a non-circuit-breaker
      // error from the transport's abort wrap. Detect via
      // `isAborted()` and exit with `signal` trailer instead of
      // rethrowing past the action body's `stream.writeTrailer`.
      if (isAborted()) {
        return buildResult('signal');
      }
      if (!isCircuitBreakerError(err)) throw err;
      failedPolls++;
      consecutiveFailures++;
      const backoffSeconds = backoffSecondsFrom(err);
      warnings.push({
        code: 'poll_failed',
        message: `poll ${String(pollsMade + failedPolls)} failed with ${err.code} (${String(consecutiveFailures)}/${String(CIRCUIT_BREAKER_CONSECUTIVE_FAILS)} consecutive); backing off ${String(backoffSeconds)}s`,
        details: {
          consecutive_failures: consecutiveFailures,
          monday_code: err.code,
          backoff_seconds: backoffSeconds,
        },
      });
      // Trip on the Nth consecutive failure — circuit_broken exit;
      // the action body re-throws after the trailer emits so a §6.5
      // failure envelope surfaces on stderr.
      if (consecutiveFailures >= CIRCUIT_BREAKER_CONSECUTIVE_FAILS) {
        circuitBrokenAt = new Date().toISOString();
        return buildResult('circuit_broken');
      }
      // Arm at the N-1 boundary (once per arming window) — surfaces
      // a single `circuit_breaker_armed` warning per arming so the
      // accumulator stays bounded even on prolonged bursts.
      if (
        consecutiveFailures === CIRCUIT_BREAKER_CONSECUTIVE_FAILS - 1 &&
        armedFor !== err.code
      ) {
        armedFor = err.code;
        warnings.push({
          code: 'circuit_breaker_armed',
          message: `circuit breaker armed: one more ${err.code} failure trips the session`,
          details: {
            polls_until_trip: 1,
            monday_code: err.code,
          },
        });
      }
      // Backoff sleep — capped at the `--max-duration` remaining
      // window so the breaker can't overshoot the wall-clock
      // ceiling. A 0ms sleep (`retry_in_seconds: 0` from Monday's
      // hint) is fine — the loop top picks up immediately. Signal-
      // driven graceful exit interrupts via the sleep's rejection.
      const backoffMs = Math.min(backoffSeconds * 1000, remainingMs());
      if (backoffMs > 0) {
        try {
          await sleepWithSignal(backoffMs, inputs.signal);
        } catch {
          return buildResult('signal');
        }
      }
      continue;
    }

    // Cadence wait between successful polls — capped at the
    // `--max-duration` remaining window so the next iteration's
    // ceiling-check exits with `max_duration` precisely rather than
    // overshooting by up to a full interval. `intervalMs >= 1000`
    // per the argv schema so the only way `cadenceMs` is 0 is when
    // the deadline already elapsed; the top-of-loop check catches
    // that on the next iteration.
    const cadenceMs = Math.min(inputs.intervalMs, remainingMs());
    if (cadenceMs > 0) {
      try {
        await sleepWithSignal(cadenceMs, inputs.signal);
      } catch {
        return buildResult('signal');
      }
    }
  }
};
