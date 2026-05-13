/**
 * `monday item watch <iid>` — polling-based event stream over the
 * v0.3-M24 `item-history-projection.ts` projector. **STUB at M29
 * pre-flight; runtime body lands at M29 IMPL.** Pinned per cli-design
 * §13 v0.4 entry + §14.4 closure (`31713fb`) + v0.4-plan §3 M29.
 *
 * **What this verb answers:** "wait for changes on this item + emit
 * them as they arrive". Single CLI invocation polls Monday's
 * `boards(ids:){ activity_logs(item_ids:, from:, limit:) }` surface
 * each tick, projects new rows through the M24 projector, emits one
 * NDJSON record per new event plus a session-summary trailer on exit.
 *
 * **GraphQL operation:** `ItemWatchPoll` (one per poll tick;
 * R-NEW-37 W2 audit-point — operationName pinned in
 * `WATCH_POLL_QUERY` literal at `src/api/item-watch.ts`).
 *
 * **Action shape (M29 IMPL).** Item-board lookup via
 * `lookupItemBoard` → `watchItem` polling loop with NDJSON
 * `onEvent` streaming hook + per-event projection via M24's
 * `projectActivityLogRow` → trailer-meta emit on graceful exit.
 * SIGINT graceful drain via `ctx.signal` (the same AbortSignal seam
 * M22 status uses). The polling loop owns:
 *
 *   - Cadence (default 30s; range 1s–1h; `--interval <ms>`).
 *   - Watermark advance (last-seen-event-id; `--since <event-id>`
 *     bootstraps).
 *   - Circuit breaker (reactive on Monday wire errors; trip after 5
 *     consecutive failures; per-failure warnings accumulate on
 *     `WatchItemResult.warnings` and fold into the trailer's
 *     `_meta.warnings` slot at session end per cli-design §6.3 —
 *     NOT interleaved with event lines).
 *   - Limit enforcement (`--max-events <n>` / `--max-duration
 *     <seconds>`).
 *   - `--once` short-circuit (drain backlog and exit; do NOT poll).
 *
 * **Output:** NDJSON only at v0.4-M29 — `--json` / `--table` /
 * `--output` global flags ignored (this is a streaming verb).
 * Trailer-meta carries seven M29-specific slots:
 * `events_emitted` + `polls_made` + `failed_polls` +
 * `watch_duration_seconds` + `last_seen_event_id` +
 * `circuit_broken_at` + `exit_reason`. Plus the standard §6.3
 * `_meta.warnings[]` slot collects any `WatchSessionWarning`
 * records the polling loop accumulated (poll_failed,
 * circuit_breaker_armed, unknown_event_kind) — warnings are NOT
 * interleaved with event lines.
 *
 * Idempotent: yes (pure read; re-running with the same `--since` is
 * safe).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { resolveClient } from '../../api/resolve-client.js';
import { lookupItemBoard } from '../../api/item-board-lookup.js';
import {
  buildStreamingTrailerMeta,
  startNdjsonStream,
} from '../../utils/output/ndjson.js';
import { collectSecrets } from '../../cli/envelope-out.js';
import { ItemIdSchema } from '../../types/ids.js';
import {
  CIRCUIT_BREAKER_CONSECUTIVE_FAILS,
  DEFAULT_WATCH_INTERVAL_MS,
  MAX_WATCH_INTERVAL_MS,
  MIN_WATCH_INTERVAL_MS,
  watchItem,
} from '../../api/item-watch.js';
import {
  historyEventSchema,
  type HistoryEvent,
} from '../../api/item-history-projection.js';

/**
 * The `--include` flag accepts a comma-separated list of literal kind
 * values from the M24 closed event-kind taxonomy (9 kinds). Mirrors
 * `item history`'s `--kinds` enum verbatim — forward-compat at the
 * argv boundary even though v0.4-M29 only emits activity-log-sourced
 * kinds (the projector's `update_posted` / `update_replied` variants
 * are from the updates source, which v0.4-M29 doesn't poll; agents
 * passing those kinds get no events at v0.4 but the argv accepts them
 * for v0.5+ comment-polling compatibility).
 */
const WATCH_KIND_LITERALS = [
  'update_column_value',
  'create_column',
  'create_group',
  'update_board_name',
  'update_board_nickname',
  'board_workspace_id_changed',
  'update_posted',
  'update_replied',
  'unknown',
] as const satisfies readonly HistoryEvent['kind'][];

const watchKindSchema = z.enum(WATCH_KIND_LITERALS);

/**
 * Parses `--include <list>` (comma-separated; commander hands it over
 * as a raw string). Empty entries filtered before validation so
 * `--include update_column_value,` doesn't raise `usage_error`. Empty
 * arrays after the filter raise `usage_error` rather than silently
 * meaning "include everything" — an agent passing `--include ,,` is
 * almost certainly bug, not intent.
 */
const includeListSchema = z
  .string()
  .transform((raw) => raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
  .pipe(z.array(watchKindSchema).min(1));

/**
 * Event-ID validator for `--since <event-id>`. Numeric string per
 * Monday's `ActivityLogType.id` shape (NON_NULL String at the wire
 * level but always digits in practice per the M24 probe). Open shape
 * (no length cap) — Monday's event IDs are typically 13+ digits.
 */
const eventIdSchema = z
  .string()
  .min(1)
  .regex(/^\d+$/u, { message: 'must be a numeric event ID (digits only)' });

/**
 * Argv input schema for `monday item watch <iid>`. Validates at the
 * parse boundary; the action body consumes the validated shape
 * directly (no defensive re-checks).
 *
 * Mutual-exclusion rules (superRefine):
 *
 *   - `--once` is incompatible with `--max-events` / `--max-duration`.
 *     `--once` already pins the exit (drain then return); a max-event
 *     ceiling would be redundant and a max-duration ceiling could
 *     race the backlog drain.
 *   - `--interval <ms>` requires the bare-integer ms form; the closure
 *     pins ms semantics (not bare seconds) to disambiguate 30 vs
 *     30000 unambiguously. Range 1000–3600000 (1s–1h).
 */
const inputSchema = z
  .object({
    iid: ItemIdSchema,
    /**
     * Polling cadence in milliseconds. Default
     * {@link DEFAULT_WATCH_INTERVAL_MS} (30000ms / 30s) per cli-design
     * §14.4 closure. Range {@link MIN_WATCH_INTERVAL_MS} (1000ms /
     * 1s; faster trips Monday's request-rate concerns + the
     * propagation-lag floor) to {@link MAX_WATCH_INTERVAL_MS}
     * (3600000ms / 1h; slower crosses the "no longer a watch" line —
     * use `cron + monday item history` for hourly cadences).
     */
    interval: z.coerce
      .number()
      .int()
      .min(MIN_WATCH_INTERVAL_MS)
      .max(MAX_WATCH_INTERVAL_MS)
      .optional(),
    /**
     * Last-seen-event-id watermark for session restart. One-shot
     * bootstrap — the runtime looks up the event's `created_at`
     * once, sets the initial poll-from timestamp, emits any backlog
     * past the watermark, then enters the polling loop. Distinct
     * from a full `--resume <token>` mechanism (still open per
     * cli-design §14.6).
     */
    since: eventIdSchema.optional(),
    /**
     * Drain backlog from `--since` (or recent N if no `--since`) and
     * exit without polling. Distinct from `--max-events 1` which
     * waits for the NEXT event.
     */
    once: z.boolean().optional(),
    /**
     * Cap on emitted events. Session exits with
     * `exit_reason: 'max_events'` once the count is reached
     * (success envelope).
     */
    maxEvents: z.coerce.number().int().positive().optional(),
    /**
     * Wall-clock ceiling in seconds. Session exits with
     * `exit_reason: 'max_duration'` once the duration is reached
     * (current in-flight poll completes first).
     */
    maxDuration: z.coerce.number().int().positive().optional(),
    /**
     * Comma-separated list of event kinds to retain. Filter applied
     * at projection time (Monday doesn't expose a server-side filter
     * on `activity_logs.event`). Accepts all 9 M24 kinds for
     * forward-compat; v0.4-M29 only emits activity-log-sourced
     * kinds.
     */
    include: includeListSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.once === true && value.maxEvents !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '--once is incompatible with --max-events (pick one)',
        path: ['once'],
      });
    }
    if (value.once === true && value.maxDuration !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '--once is incompatible with --max-duration (pick one)',
        path: ['once'],
      });
    }
  });

export const itemWatchCommand: CommandModule<
  z.infer<typeof inputSchema>,
  HistoryEvent
> = {
  name: 'item.watch',
  summary:
    "Poll Monday for activity-log events on an item; stream NDJSON as they arrive (v0.4-M29 pre-flight stub)",
  examples: [
    'monday item watch 1234567890',
    'monday item watch 1234567890 --interval 60000        # 60s cadence',
    'monday item watch 1234567890 --since 999999          # resume from event-id',
    'monday item watch 1234567890 --once                  # drain backlog + exit',
    'monday item watch 1234567890 --max-events 10',
    'monday item watch 1234567890 --max-duration 3600     # 1h ceiling',
    'monday item watch 1234567890 --include update_column_value,update_posted',
  ],
  idempotent: true,
  inputSchema,
  // Mirrors M24 `item history`: the output schema describes the
  // per-event record shape an agent sees on the NDJSON stream — NOT
  // the session-summary trailer (the trailer-meta shape is documented
  // in output-shapes.md + cli-design §4.3, but a streaming verb has no
  // buffered `data` payload). `monday schema item.watch` reflects
  // the event-record shape so agents pin their per-line parsers
  // against the same discriminated-union taxonomy `item history`
  // uses.
  outputSchema: historyEventSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('watch <iid>')
      .description(itemWatchCommand.summary)
      .option(
        '--interval <ms>',
        `polling cadence in milliseconds (${String(MIN_WATCH_INTERVAL_MS)}–${String(MAX_WATCH_INTERVAL_MS)}, default ${String(DEFAULT_WATCH_INTERVAL_MS)})`,
      )
      .option(
        '--since <event-id>',
        'resume from a previous session\'s last-seen-event-id (numeric ID from trailer-meta)',
      )
      .option(
        '--once',
        'drain backlog from --since (or recent events) and exit without polling',
      )
      .option(
        '--max-events <n>',
        'exit cleanly after emitting N events',
      )
      .option(
        '--max-duration <seconds>',
        'exit cleanly after N wall-clock seconds',
      )
      .option(
        '--include <list>',
        'comma-separated event kinds to retain (e.g. update_column_value,update_posted)',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...itemWatchCommand.examples.map((e) => `  ${e}`),
          '',
          `NOTE: emits NDJSON only (one event per line + trailing meta).`,
          `Default cadence ${String(DEFAULT_WATCH_INTERVAL_MS)}ms (${String(DEFAULT_WATCH_INTERVAL_MS / 1000)}s); circuit-breaker trips after`,
          `${String(CIRCUIT_BREAKER_CONSECUTIVE_FAILS)} consecutive failed polls. Resume across sessions via`,
          '--since <event-id> from the prior trailer-meta\'s last_seen_event_id.',
          'SIGINT triggers a graceful drain + trailer emit + exit 130.',
          '',
          'Monday\'s activity_logs has an empirically-measured propagation lag',
          '>30s on freshly-edited boards (M24 pre-flight finding 2026-05-11);',
          'cadence faster than 30s would generate polls against unpropagated data.',
          '',
        ].join('\n'),
      )
      /* c8 ignore start */
      .action(async (iid: string, rawOpts: unknown) => {
        // Stub action body — argv parsing runs (the parse-boundary
        // path is the contract surface), then the watchItem stub
        // throws internal_error. Runtime body wires the NDJSON
        // stream + watchItem call + trailer emit at M29 IMPL.
        const merged = { ...(rawOpts as Record<string, unknown>), iid };
        const parsed = parseArgv(itemWatchCommand.inputSchema, merged);

        const { client, apiVersion } = resolveClient(ctx, program.opts());

        const { boardId } = await lookupItemBoard({
          client,
          itemId: parsed.iid,
        });

        const stream = startNdjsonStream<HistoryEvent>({
          stream: ctx.stdout,
          secrets: collectSecrets(ctx.env, ctx.runtimeSecrets),
          project: (event) => event,
        });

        const result = await watchItem({
          client,
          itemId: parsed.iid,
          boardId,
          intervalMs: parsed.interval ?? DEFAULT_WATCH_INTERVAL_MS,
          ...(parsed.since === undefined ? {} : { since: parsed.since }),
          ...(parsed.once === undefined ? {} : { once: parsed.once }),
          ...(parsed.maxEvents === undefined ? {} : { maxEvents: parsed.maxEvents }),
          ...(parsed.maxDuration === undefined ? {} : { maxDurationSeconds: parsed.maxDuration }),
          ...(parsed.include === undefined ? {} : { includeKinds: parsed.include }),
          signal: ctx.signal,
          onEvent: stream.onItem,
        });

        stream.writeTrailer(
          buildStreamingTrailerMeta({
            ctx: {
              cliVersion: ctx.cliVersion,
              requestId: ctx.requestId,
              clock: ctx.clock,
            },
            apiVersion,
            source: result.source,
            cacheAgeSeconds: null,
            result: {
              hasMore: result.exit_reason !== 'circuit_broken',
              totalReturned: result.events_emitted,
              complexity: null,
            },
          }),
        );
      });
      /* c8 ignore stop */
  },
};
