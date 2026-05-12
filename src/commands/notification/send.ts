/**
 * `monday notification send --user <uid> --target <iid|bid>
 * --target-type item|board --text <t>` — fire a Monday notification
 * to a single recipient (cli-design §2.7 + §4.3 + §13 v0.3 entry;
 * v0.3-plan §3 M27).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M27 implementation lands the
 * runtime body via `client.raw` against the `CreateNotification`
 * mutation with `operationName: 'CreateNotification'` (R-NEW-37
 * watch-item: keep doc-named-operation + wire-operationName in
 * sync).
 *
 * **Single-recipient at v0.3.** `--user <uid>` accepts ONE user ID;
 * multi-recipient fan-out is a v0.3.x / v0.4 contract-extension
 * (agents needing fan-out call `notification send` N times). Per
 * v0.3-plan §3 M27 sibling decisions list.
 *
 * **`--target-type` argv is `item|board`** (cli-design §4.3). The
 * CLI's 2-value vocabulary maps to Monday's wire
 * `NotificationTargetType.Project` (which represents both items and
 * boards). The runtime body at M27 IMPL preserves the item-vs-board
 * argv distinction for CLI-side validation discipline (verifying the
 * supplied `--target <id>` actually names an item or board to match
 * the supplied type before firing the wire mutation). Monday's wire
 * enum has only two values (`Post` / `Project`); the `Post` value
 * (Update-targeted notifications) is unreachable at v0.3 — a
 * v0.3.x / v0.4 contract-extension may add a CLI third target-type
 * `update` that dispatches to wire `Post`.
 *
 * **Idempotency.** `create_notification` is NOT idempotent —
 * re-running mints a fresh notification with a new ID. Agents
 * needing send-once-semantics dedup on the CLI side.
 *
 * **`--dry-run` support per §3.1 #6.** Argv parse + target-type
 * validation only; no wire mutation fires. Envelope shape pinned
 * in output-shapes.md; runtime engine lands at M27 IMPL.
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { UserIdSchema } from '../../types/ids.js';
import {
  notificationSendOutputSchema,
  notificationTargetTypeSchema,
  type NotificationSendOutput,
} from '../../api/notifications.js';

// `target` is either an ItemId or BoardId depending on `target-type`.
// At the argv parse boundary we accept any numeric ID string and let
// the runtime body (M27 IMPL) verify the ID kind matches `target-type`
// via a wire round-trip; surfacing the mismatch as `usage_error` per
// cli-design §6.5.
const numericIdRegex = /^\d+$/u;

const inputSchema = z
  .object({
    user: UserIdSchema,
    target: z.string().regex(numericIdRegex, {
      message: 'expected a numeric ID',
    }),
    targetType: notificationTargetTypeSchema,
    text: z.string().min(1),
  })
  .strict();

export const notificationSendCommand: CommandModule<
  z.infer<typeof inputSchema>,
  NotificationSendOutput
> = {
  name: 'notification.send',
  summary:
    'Send a Monday notification to a single recipient about an item or board',
  examples: [
    'monday notification send --user 12345 --target 67890 --target-type item --text "Please review"',
    'monday notification send --user 12345 --target 67890 --target-type board --text "Board ownership updated" --json',
  ],
  idempotent: false,
  inputSchema,
  outputSchema: notificationSendOutputSchema,
  attach: (program) => {
    const noun = ensureSubcommand(
      program,
      'notification',
      'Notification commands (outbound writes via Monday\'s create_notification mutation)',
    );
    noun
      .command('send')
      .description(notificationSendCommand.summary)
      .requiredOption(
        '--user <uid>',
        'Recipient user ID (single-recipient at v0.3 per cli-design §4.3; multi-recipient is a v0.3.x / v0.4 contract-extension).',
      )
      .requiredOption(
        '--target <id>',
        'Target ID — an item ID when --target-type is `item`, a board ID when --target-type is `board`.',
      )
      .requiredOption(
        '--target-type <type>',
        'Target kind. One of: item, board. Both map to Monday\'s wire `NotificationTargetType.Project` enum value; the CLI keeps the distinction for argv validation.',
      )
      .requiredOption(
        '--text <t>',
        'Notification text. Non-empty.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...notificationSendCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M27 IMPL */
        async (opts: {
          user: string;
          target: string;
          targetType: string;
          text: string;
        }) => {
          parseArgv(notificationSendCommand.inputSchema, {
            user: opts.user,
            target: opts.target,
            targetType: opts.targetType,
            text: opts.text,
          });
          await Promise.reject(
            new ApiError(
              'internal_error',
              'monday notification send not yet implemented (v0.3-M27 pre-flight stub)',
              {
                details: {
                  hint: 'M27 implementation lands the runtime body; see docs/v0.3-plan.md §3 M27',
                },
              },
            ),
          );
        },
        /* c8 ignore stop */
      );
  },
};
