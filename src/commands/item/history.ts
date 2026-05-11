/**
 * `monday item history <iid>` — per-item activity log + comment
 * thread merged chronologically (cli-design §13 v0.3 entry;
 * v0.3-plan §3 M24).
 *
 * **What this verb answers:** "show me every change + comment on
 * this item, chronologically, in one stream". Two Monday surfaces
 * feed it — `boards.activity_logs(item_ids:, ...)` for board-stored
 * activity events (status / column / assignment changes) +
 * `items.updates(...)` for the comment thread — and the projector
 * merges them by `created_at` ascending. See
 * `src/api/item-history-projection.ts` for the load-bearing
 * Decision-2-closure docstring (empirical probe 2026-05-11,
 * `a1f3025`).
 *
 * **Eventual-consistency caveat.** Monday's `activity_logs` has an
 * empirically-measured propagation lag **>30s** on freshly-edited
 * boards. The verb's help text + cli-design §13 v0.3 entry pin
 * this caveat so agents polling history after a write know to
 * wait at least 30s before expecting the new event to surface.
 *
 * **Action shape.** Item-board lookup via `lookupItemBoard` →
 * `fetchItemHistory` two-source walker → optional `--kinds`-
 * projection filter (applied inside the walker; warnings still
 * surface for filtered kinds) → optional `--stream` NDJSON via
 * `startNdjsonStream` → `emitSuccess` per cli-design §6.1.
 * `SourceAggregator` folds the item-board lookup's `'live'`
 * source with the walker's `'live'` constant — current envelope
 * always shows `meta.source: "live"`; the aggregator's seat keeps
 * the envelope correct when a future cache layer lifts in for
 * the lookup.
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { parseArgv } from '../parse-argv.js';
import { resolveClient } from '../../api/resolve-client.js';
import { lookupItemBoard } from '../../api/item-board-lookup.js';
import { SourceAggregator } from '../../api/source-aggregator.js';
import { selectOutput } from '../../utils/output/select.js';
import {
  buildStreamingTrailerMeta,
  startNdjsonStream,
} from '../../utils/output/ndjson.js';
import { collectSecrets } from '../../cli/envelope-out.js';
import { ItemIdSchema } from '../../types/ids.js';
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  HARD_CAP_HISTORY_PAGE_SIZE,
  fetchItemHistory,
  historyEventOutputSchema,
  toEnvelopeWarnings,
  type HistoryEvent,
  type HistoryEventOutput,
} from '../../api/item-history-projection.js';

/**
 * The `--kinds` flag accepts a comma-separated list of literal
 * kind values; the parser splits on `,`, trims whitespace, and
 * validates each entry against the discriminated-union kind
 * literals. Unknown kinds raise `usage_error` at the parse
 * boundary (not silently ignored — an agent typo would otherwise
 * produce an empty result with no signal).
 *
 * **Why a closed set at the parse boundary, when the projector
 * has an open `unknown` variant.** The projector accepts unknown
 * server-side events for forward-compat; the `--kinds` flag is
 * client-supplied so a closed set surfaces typos. Filtering for
 * `--kinds unknown` is supported (agents debugging the projector's
 * coverage gap).
 */
const HISTORY_KIND_LITERALS = [
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

const historyKindSchema = z.enum(HISTORY_KIND_LITERALS);

/**
 * Parses `--kinds <list>` (comma-separated; commander hands it
 * over as a raw string). Empty entries (trailing comma) are
 * filtered before validation so `--kinds update_posted,` doesn't
 * raise `usage_error`.
 */
const kindsListSchema = z
  .string()
  .transform((raw) => raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
  .pipe(z.array(historyKindSchema).min(1));

/**
 * ISO-8601 timestamp validator for `--since` / `--until`. Open-ended
 * (any ISO-8601 surface Date.parse accepts) so agents can pass
 * `2026-05-11`, `2026-05-11T10:00:00Z`, `2026-05-11T10:00:00+01:00`,
 * etc. The wall-clock cap threading lands at M24 implementation
 * (the action passes the raw string through to `fetchItemHistory`
 * which forwards to Monday's `from:` / `to:` ISO8601DateTime args).
 */
const isoTimestampSchema = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: 'must be an ISO-8601 timestamp (e.g. 2026-05-11 or 2026-05-11T10:00:00Z)',
  });

const inputSchema = z
  .object({
    iid: ItemIdSchema,
    since: isoTimestampSchema.optional(),
    until: isoTimestampSchema.optional(),
    /**
     * Activity-log page (1-indexed; Monday's `activity_logs` resolver
     * is page-numbered per the Decision 2 closure). Defaults to 1.
     */
    activityLogsPage: z.coerce.number().int().positive().optional(),
    /**
     * Updates page (1-indexed; Monday's `updates` resolver is
     * page-numbered with a different denominator than activity_logs).
     * Defaults to 1.
     */
    updatesPage: z.coerce.number().int().positive().optional(),
    /**
     * Per-source per-call slice size. Default
     * {@link DEFAULT_HISTORY_PAGE_SIZE}; hard cap
     * {@link HARD_CAP_HISTORY_PAGE_SIZE} (Monday's documented
     * server-side ceiling on both `activity_logs.limit` +
     * `updates.limit`).
     */
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(HARD_CAP_HISTORY_PAGE_SIZE)
      .optional(),
    /**
     * Comma-separated list of event kinds to retain in the projected
     * output. Filter is applied AFTER the merge projector — narrows
     * `data` array but doesn't affect the unknown-event-kind warning
     * aggregation (which still surfaces for filtered kinds).
     */
    kinds: kindsListSchema.optional(),
    /**
     * NDJSON streaming output per cli-design §6.3. When set, emits
     * one event per stdout line + a final `{"_meta":{...}}` trailer.
     * Reuses `startNdjsonStream` (R52) at M24 implementation.
     */
    stream: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.since !== undefined &&
      value.until !== undefined &&
      Date.parse(value.since) > Date.parse(value.until)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '--since must be on or before --until',
        path: ['since'],
      });
    }
  });

export const itemHistoryCommand: CommandModule<
  z.infer<typeof inputSchema>,
  HistoryEventOutput
> = {
  name: 'item.history',
  summary:
    "Show an item's activity log + comment thread merged chronologically",
  examples: [
    'monday item history 1234567890',
    'monday item history 1234567890 --since 2026-05-01',
    'monday item history 1234567890 --kinds update_column_value,update_posted',
    'monday item history 1234567890 --stream --limit 500',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: historyEventOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('history <iid>')
      .description(itemHistoryCommand.summary)
      .option(
        '--since <iso>',
        'wall-clock floor (ISO-8601) — only events at or after this timestamp',
      )
      .option(
        '--until <iso>',
        'wall-clock ceiling (ISO-8601) — only events at or before this timestamp',
      )
      .option(
        '--activity-logs-page <n>',
        '1-indexed page for the activity_logs source (Monday paginates page-numbered)',
      )
      .option(
        '--updates-page <n>',
        '1-indexed page for the updates source (independent of --activity-logs-page)',
      )
      .option(
        '--limit <n>',
        `per-source per-call slice (1-${String(HARD_CAP_HISTORY_PAGE_SIZE)}, default ${String(DEFAULT_HISTORY_PAGE_SIZE)})`,
      )
      .option(
        '--kinds <list>',
        'comma-separated event kinds to retain (e.g. update_column_value,update_posted); applied after merge so warnings still surface',
      )
      .option(
        '--stream',
        'NDJSON streaming output (one event per line; final {"_meta":{...}} trailer per §6.3)',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...itemHistoryCommand.examples.map((e) => `  ${e}`),
          '',
          'NOTE: Monday\'s activity_logs has an empirically-measured',
          'propagation lag >30s on freshly-edited boards (M24 pre-flight',
          'empirical probe finding, 2026-05-11). Polling history after a',
          'write should wait at least 30s before expecting the new event',
          'to surface.',
          '',
        ].join('\n'),
      )
      .action(async (iid: string, rawOpts: unknown) => {
        // Parse-validate argv via the schema. `--kinds` splits on `,`
        // + validates each entry against the discriminator literals
        // before reaching the action body; `--since` / `--until`
        // pass through as raw strings (forwarded verbatim to
        // Monday's ISO8601DateTime args).
        const merged = { ...(rawOpts as Record<string, unknown>), iid };
        const parsed = parseArgv(itemHistoryCommand.inputSchema, merged);

        const { client, apiVersion } = resolveClient(ctx, program.opts());

        // Step 1 — item-board lookup. Raises `not_found` for both
        // missing-item and null-board paths per the shared helper.
        // The lookup hits Monday directly (no per-call cache on
        // `ItemBoardLookup`); `SourceAggregator` records it as
        // `'live'` so the envelope's `meta.source` stays correct
        // when a future cache layer lifts in here.
        const { boardId } = await lookupItemBoard({
          client,
          itemId: parsed.iid,
        });

        const aggregator = new SourceAggregator();
        aggregator.record('live', null);

        const format = selectOutput({
          json: program.opts<{ json?: boolean }>().json === true,
          table: program.opts<{ table?: boolean }>().table === true,
          ...((program.opts<{ output?: string }>().output === undefined)
            ? {}
            : { output: program.opts<{ output: string }>().output }),
          env: ctx.env,
          isTTY: ctx.isTTY,
        });

        // Build the walker inputs once — both the streaming +
        // non-streaming paths consume the same spread shape;
        // duplicating the per-flag ternaries across both paths
        // would double the branch denominator without adding
        // observable behaviour.
        const baseFetchInputs = {
          client,
          itemId: parsed.iid,
          boardId,
          ...(parsed.since === undefined ? {} : { since: parsed.since }),
          ...(parsed.until === undefined ? {} : { until: parsed.until }),
          ...(parsed.activityLogsPage === undefined
            ? {}
            : { activityLogsPage: parsed.activityLogsPage }),
          ...(parsed.updatesPage === undefined
            ? {}
            : { updatesPage: parsed.updatesPage }),
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
          ...(parsed.kinds === undefined ? {} : { kinds: parsed.kinds }),
        };

        // Step 2 — streaming NDJSON path. Emits items per-merged-
        // event (post-merge — the merge isn't incremental per the
        // mergeByCreatedAt docstring); writes the §6.3 trailer
        // with per-source pagination state for resumption.
        if (format === 'ndjson') {
          const stream = startNdjsonStream<HistoryEvent>({
            stream: ctx.stdout,
            secrets: collectSecrets(ctx.env, ctx.runtimeSecrets),
            project: (event) => event,
          });
          const result = await fetchItemHistory({
            ...baseFetchInputs,
            onItem: stream.onItem,
          });
          aggregator.record(result.source, null);
          const aggregated = aggregator.result('live');
          const hasMore =
            result.pagination.activity_logs.last_page !== null ||
            result.pagination.updates.last_page !== null;
          stream.writeTrailer(
            buildStreamingTrailerMeta({
              ctx: {
                cliVersion: ctx.cliVersion,
                requestId: ctx.requestId,
                clock: ctx.clock,
              },
              apiVersion,
              source: aggregated.source,
              cacheAgeSeconds: aggregated.cacheAgeSeconds,
              result: {
                hasMore,
                totalReturned: result.events.length,
                complexity: result.complexity,
              },
            }),
          );
          return;
        }

        // Step 3 — non-streaming path. Run the full walker, then
        // emit via the §6.1 success envelope.
        const result = await fetchItemHistory(baseFetchInputs);
        aggregator.record(result.source, null);
        const aggregated = aggregator.result('live');
        const hasMore =
          result.pagination.activity_logs.last_page !== null ||
          result.pagination.updates.last_page !== null;
        emitSuccess({
          ctx,
          data: [...result.events] as HistoryEventOutput,
          schema: itemHistoryCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          source: aggregated.source,
          cacheAgeSeconds: aggregated.cacheAgeSeconds,
          warnings: toEnvelopeWarnings(result.warnings),
          complexity: result.complexity,
          hasMore,
          apiVersion,
        });
      });
  },
};
