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
 * **Pre-flight stub action.** The action body is a stub under
 * `c8 ignore start/stop` — it parses the argv schema (real;
 * mirrors the M21 oauth precedent that ships argv shape pinned at
 * pre-flight so agent scripts targeting `monday item history` are
 * stable across the M24 implementation drop-in) and rejects with
 * `internal_error`. M24 implementation lands the runtime body:
 * item-board lookup → `fetchItemHistory` → optional
 * `--kinds`-projection-filter → optional `--stream` NDJSON via
 * `startNdjsonStream` → `emitSuccess` per cli-design §6.1.
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { ItemIdSchema } from '../../types/ids.js';
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  HARD_CAP_HISTORY_PAGE_SIZE,
  historyEventOutputSchema,
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
  attach: (program, _ctx) => {
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
          'NOTE: Pre-flight stub — runtime two-source walker lands at',
          'v0.3-M24 implementation. The verb registers the argv shape so',
          'agent scripts targeting `monday item history <iid>` are stable',
          'across the M24 drop-in.',
          '',
        ].join('\n'),
      )
      .action(async (iid: string, rawOpts: unknown) => {
        // Parse-validate argv via the schema. `--kinds` splits on `,`
        // + validates each entry against the discriminator literals
        // before reaching the action body; `--since` / `--until`
        // pass through as raw strings (M24 impl forwards verbatim to
        // Monday's ISO8601DateTime args).
        const merged = { ...(rawOpts as Record<string, unknown>), iid };
        parseArgv(itemHistoryCommand.inputSchema, merged);
        // Pre-flight stub — every invocation rejects. M24
        // implementation replaces this with item-board lookup +
        // `fetchItemHistory` + optional `--kinds` filter + optional
        // `--stream` NDJSON + `emitSuccess`.
        /* c8 ignore start */
        await Promise.reject(
          new ApiError(
            'internal_error',
            '`monday item history <iid>` is a v0.3-M24 pre-flight stub — runtime two-source walker (activity_logs + updates) lands at M24 implementation.',
            {
              details: {
                item_id: iid,
                hint: 'M24 implementation kickoff (next session) lands the runtime body in `src/api/item-history-projection.ts` (per-event projector + walker) and replaces this stub with the real action body.',
              },
            },
          ),
        );
        /* c8 ignore stop */
      });
  },
};
