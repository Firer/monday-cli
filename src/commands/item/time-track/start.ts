/**
 * `monday item time-track start <iid> [--column <col>] [--board <bid>]
 *  [--dry-run]` — verb-shaped column-type extension (cli-design §5.2
 * carve-out 2 + §4.3, v0.3-plan §3 M20).
 *
 * **Documentation-only at v0.3.** An empirical probe against Monday's
 * API on 2026-05-10 confirmed `time_tracking` columns cannot be
 * written via `change_simple_column_value` or `change_column_value`,
 * and Monday's mutation root has no time-tracking-related mutation.
 * The verb is registered for forward-compatibility — agent scripts
 * targeting `monday item time-track start` are stable across the
 * eventual API support — and rejects every invocation today with a
 * `usage_error` carrying the `API_UNSUPPORTED_HINT` from
 * `src/api/time-tracking.ts`.
 *
 * **Argv shape mirrors the future implementation.** When Monday
 * ships the wire mutation, the api-layer change is small (replace
 * the rejection body in `time-tracking.ts` with the actual wire
 * call). The command file will also need follow-up wiring at that
 * point — column resolution against board metadata, `--dry-run`
 * branching to emit `planned_changes` per output-shapes.md's
 * future-shape envelope, and an `emitMutation` call wired to the
 * primitive's success result. Today the file does the minimum
 * agent-UX-preserving work: `--board` resolution (so invalid item
 * IDs surface as `not_found` consistently with other item verbs)
 * and call into the rejection-body primitive.
 *
 * **`--board` resolution is preserved at v0.3.** Mirrors `item set` /
 * `item clear` / `item archive`'s standard pattern: explicit
 * `--board <bid>` is authoritative, otherwise `lookupItemBoard`
 * fires and surfaces `not_found` for invalid item IDs. The wasted
 * network call (since the api primitive throws regardless) is
 * acceptable: it preserves the pre-flight contract's
 * `boardId: BoardId` requirement, gives agents the consistent
 * not_found surface for invalid item IDs, and forward-compatibility
 * is preserved without contract narrowing.
 *
 * **`--column` resolution is intentionally skipped at v0.3.** The
 * primitive throws regardless of column validity, so resolving the
 * column would be a second wasted network call (board metadata).
 * Tomorrow's wire-supporting body will need column resolution; that
 * lands at the same time the rejection body does.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { resolveClient } from '../../../api/resolve-client.js';
import { BoardIdSchema, ItemIdSchema } from '../../../types/ids.js';
import { parseArgv } from '../../parse-argv.js';
import { resolveBoardId } from '../../../api/item-board-lookup.js';
import { startTimeTracking } from '../../../api/time-tracking.js';

// `outputSchema` describes the shape `data` will carry once Monday
// ships the wire mutation. Today the verb always rejects so this
// schema never validates a real payload — it ships for the
// `monday schema` introspection surface and the future drop-in.
const startResultSchema = z
  .object({
    operation: z.literal('start_time_tracking'),
    item_id: z.string(),
    column_id: z.string(),
    running: z.literal(true),
    started_at: z.string(),
  })
  .strict();

export type ItemTimeTrackStartOutput = z.infer<typeof startResultSchema>;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    column: z.string().min(1).optional(),
    board: BoardIdSchema.optional(),
  })
  .strict();

export const itemTimeTrackStartCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemTimeTrackStartOutput
> = {
  name: 'item.time-track.start',
  summary:
    'Start a time-tracking session on an item (documentation-only at v0.3 — Monday API support pending)',
  examples: [
    'monday item time-track start 12345 --column duration',
    'monday item time-track start 12345 --column id:duration_a --board 67890',
    'monday item time-track start 12345',
  ],
  // Future contract: `start` is non-idempotent (each call against a
  // stopped column appends a new history session). Today the verb
  // rejects on every call; idempotency is moot. Preserved as `false`
  // so the schema introspection matches the future wire contract.
  idempotent: false,
  inputSchema,
  outputSchema: startResultSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    const subnoun = ensureSubcommand(
      noun,
      'time-track',
      'Time-tracking column verbs (cli-design §5.2 carve-out 2)',
    );
    subnoun
      .command('start <itemId>')
      .description(itemTimeTrackStartCommand.summary)
      .option(
        '--column <col>',
        "Column to operate on. v0.3: echoed verbatim into the rejection envelope's details (no validation today — the api primitive throws regardless). Future: resolved via cli-design §5.3 step 2; required if the item has more than one time_tracking column.",
      )
      .option(
        '--board <bid>',
        "Board ID — explicit is authoritative (cli-design §5.3 step 1); without it, the CLI looks up the item's board",
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...itemTimeTrackStartCommand.examples.map((e) => `  ${e}`),
          '',
          'NOTE: This verb is registered for forward-compatibility but',
          "cannot fire today — Monday's public API does not currently",
          'support writing to time_tracking columns. Use Monday\'s UI',
          'to start time-tracking sessions until API support ships.',
          '',
        ].join('\n'),
      )
      .action(
        async (
          itemIdArg: unknown,
          opts: { column?: string; board?: string },
        ) => {
          const parsed = parseArgv(itemTimeTrackStartCommand.inputSchema, {
            itemId: itemIdArg,
            ...(opts.column !== undefined ? { column: opts.column } : {}),
            ...(opts.board !== undefined ? { board: opts.board } : {}),
          });

          // resolveClient up front — token validation needs to happen
          // before we let the rejection through, mirrors every other
          // item-mutation verb's pre-network ordering.
          const { client } = resolveClient(ctx, program.opts());

          // `--board` resolution per cli-design §5.3 step 1. Explicit
          // is authoritative; without it, the lookup fires (one
          // round-trip) and surfaces `not_found` for invalid item IDs
          // — preserves the agent UX consistency across item verbs.
          const boardId = BoardIdSchema.parse(
            await resolveBoardId({
              client,
              itemId: parsed.itemId,
              explicit: parsed.board,
            }),
          );

          // Call the api primitive — it throws `usage_error` per
          // `API_UNSUPPORTED_HINT` (see src/api/time-tracking.ts).
          // The thrown ApiError surfaces through the runner's
          // standard envelope-emitting catch as exit code 1.
          await startTimeTracking({
            client,
            boardId,
            itemId: parsed.itemId,
            columnId: parsed.column ?? '',
            env: ctx.env,
          });
        },
      );
  },
};
