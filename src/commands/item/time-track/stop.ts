/**
 * `monday item time-track stop <iid> [--column <col>] [--board <bid>]
 *  [--dry-run]` — sibling of `monday item time-track start`. See
 * `start.ts` for the full rationale on documentation-only verbs +
 * the empirical-probe finding that motivated this shape.
 *
 * **Same documentation-only behavior as `start`.** The api primitive
 * `stopTimeTracking` rejects with the same `usage_error` +
 * `API_UNSUPPORTED_HINT`; the only difference vs `start` is the
 * verb name in the message (so agents grepping `error.message`
 * disambiguate the call site).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { resolveClient } from '../../../api/resolve-client.js';
import { BoardIdSchema, ItemIdSchema } from '../../../types/ids.js';
import { parseArgv } from '../../parse-argv.js';
import { resolveBoardId } from '../../../api/item-board-lookup.js';
import { stopTimeTracking } from '../../../api/time-tracking.js';

// Future-shape — never validates a real payload at v0.3 (the verb
// rejects). Mirrors `start.ts` for symmetry; the two extra fields
// (`ended_at` / `duration_seconds`) reflect the just-stopped
// session.
const stopResultSchema = z
  .object({
    operation: z.literal('stop_time_tracking'),
    item_id: z.string(),
    column_id: z.string(),
    running: z.literal(false),
    started_at: z.string().nullable(),
    ended_at: z.string(),
    duration_seconds: z.number().nullable(),
  })
  .strict();

export type ItemTimeTrackStopOutput = z.infer<typeof stopResultSchema>;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    column: z.string().min(1).optional(),
    board: BoardIdSchema.optional(),
  })
  .strict();

export const itemTimeTrackStopCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemTimeTrackStopOutput
> = {
  name: 'item.time-track.stop',
  summary:
    'Stop the current time-tracking session on an item (documentation-only — Monday API support pending)',
  examples: [
    'monday item time-track stop 12345 --column duration',
    'monday item time-track stop 12345 --column id:duration_a --board 67890',
    'monday item time-track stop 12345',
  ],
  // Future contract: `stop` is non-idempotent (re-running against a
  // now-stopped column will surface `usage_error` with
  // `details.running: false` per Decision 4.2). Today rejects always.
  idempotent: false,
  inputSchema,
  outputSchema: stopResultSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item');
    const subnoun = ensureSubcommand(noun, 'time-track');
    subnoun
      .command('stop <itemId>')
      .description(itemTimeTrackStopCommand.summary)
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
          ...itemTimeTrackStopCommand.examples.map((e) => `  ${e}`),
          '',
          'NOTE: This verb is registered for forward-compatibility but',
          "cannot fire today — Monday's public API does not currently",
          'support writing to time_tracking columns. Use Monday\'s UI',
          'to stop time-tracking sessions until API support ships.',
          '',
        ].join('\n'),
      )
      .action(
        async (
          itemIdArg: unknown,
          opts: { column?: string; board?: string },
        ) => {
          const parsed = parseArgv(itemTimeTrackStopCommand.inputSchema, {
            itemId: itemIdArg,
            ...(opts.column !== undefined ? { column: opts.column } : {}),
            ...(opts.board !== undefined ? { board: opts.board } : {}),
          });

          const { client } = resolveClient(ctx, program.opts());

          const boardId = BoardIdSchema.parse(
            await resolveBoardId({
              client,
              itemId: parsed.itemId,
              explicit: parsed.board,
            }),
          );

          await stopTimeTracking({
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
