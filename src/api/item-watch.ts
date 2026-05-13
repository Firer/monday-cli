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
 *     `reset_in_x_seconds` (60s default cap when absent); after N
 *     consecutive failed polls the session trips to a failure envelope
 *     carrying `circuit_broken_at` + `failed_polls` in trailer-meta.
 *     Each failure emits a `warning` record to the NDJSON stream
 *     first so agents see the trip-mode progression.
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
import { ApiError } from '../utils/errors.js';
import type { MondayClient } from './client.js';
import type { ItemId } from '../types/ids.js';
import type {
  HistoryEvent,
  UnknownEventKindWarning,
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
 * per cli-design §14.4 closure. Each prior failure emits a `warning`
 * record to the NDJSON stream first; the Nth (default 5) failure
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
 *   - `onWarning` — optional hook called per per-poll warning (e.g.,
 *     a circuit-breaker progression warning). The action body wires
 *     this to the NDJSON stream's warning channel.
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
  readonly onWarning?: (warning: WatchSessionWarning) => void | Promise<void>;
}

/**
 * Per-poll warning surfaced during a watch session. Distinct from the
 * M24 projector's {@link UnknownEventKindWarning} (which surfaces
 * unrecognised event kinds) — this shape surfaces session-level
 * progression (circuit-breaker firings, backoff sleeps, stale-
 * cursor recoveries).
 *
 * Discriminated on `code`; emit channel is the NDJSON stream's
 * `warning` shape per cli-design §6.1 `warnings[]` slot.
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
 * Polling-based event-stream walker. **STUB at M29 pre-flight; runtime
 * body lands at M29 IMPL.** Reuses M24's `projectActivityLogRow` for
 * per-event projection; the polling loop owns the cadence + circuit-
 * breaker + watermark state.
 *
 * The runtime body (M29 IMPL):
 *
 *   1. Resolves the initial poll-from timestamp: from `inputs.since`
 *      (look up event-id → created_at) or from `Date.now()`.
 *   2. If `inputs.once === true`: one poll against the watermark,
 *      drain backlog through `onEvent`, exit with
 *      `exit_reason: 'once_complete'`.
 *   3. Otherwise enter the polling loop: each tick fires the
 *      `WATCH_POLL_QUERY`, filters newly-seen events (id > last-seen-
 *      event-id), projects via `projectActivityLogRow`, applies the
 *      `includeKinds` filter, emits via `onEvent`, advances the
 *      watermark.
 *   4. After each poll, awaits Promise.race([setTimeout(intervalMs),
 *      signal.aborted]). On signal: graceful drain + exit
 *      `exit_reason: 'signal'`.
 *   5. On Monday wire errors (`complexity_exceeded` /
 *      `concurrency_exceeded` / `rate_limited`): emit a `poll_failed`
 *      warning, backoff respecting `reset_in_x_seconds` (60s default
 *      cap; 300s ceiling), increment failed-poll counter. After
 *      {@link CIRCUIT_BREAKER_CONSECUTIVE_FAILS} consecutive failures
 *      trip with `exit_reason: 'circuit_broken'`.
 *   6. On `--max-events` / `--max-duration` ceiling reached: clean
 *      exit with the matching `exit_reason`.
 */
/* c8 ignore start */
export const watchItem = (
  inputs: WatchItemInputs,
): Promise<WatchItemResult> => {
  // Touch every input slot so the unused-import / unused-parameter
  // linters don't fire against the stub. Real body at M29 IMPL.
  void inputs.client;
  void inputs.itemId;
  void inputs.boardId;
  void inputs.intervalMs;
  void inputs.since;
  void inputs.once;
  void inputs.maxEvents;
  void inputs.maxDurationSeconds;
  void inputs.includeKinds;
  void inputs.signal;
  void inputs.onEvent;
  void inputs.onWarning;
  return Promise.reject(
    new ApiError(
      'internal_error',
      '`watchItem` stub — runtime body lands at v0.4-M29 IMPL',
      {
        details: {
          milestone: 'v0.4-M29',
          deferred_to: 'v0.4-M29 IMPL',
        },
      },
    ),
  );
};
/* c8 ignore stop */
