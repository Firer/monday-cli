/**
 * `monday notification send --user <uid> --target <iid|bid>
 * --target-type item|board --text <t>` — fire a Monday notification
 * to a single recipient (cli-design §2.7 + §4.3 + §13 v0.3 entry;
 * v0.3-plan §3 M27).
 *
 * **Wire shape.** Single `client.raw` round-trip via
 * {@link sendNotification} against `mutation CreateNotification`
 * with `operationName: 'CreateNotification'` (R-NEW-37 W2 audit-
 * point).
 *
 * **Single-recipient at v0.3.** `--user <uid>` accepts ONE user ID;
 * multi-recipient fan-out is a v0.3.x / v0.4 contract-extension
 * (agents needing fan-out call `notification send` N times). Per
 * v0.3-plan §3 M27 sibling decisions list.
 *
 * **`--target-type` argv is `item|board`** (cli-design §4.3). Both
 * CLI values map to Monday's wire `NotificationTargetType.Project`
 * at the runtime boundary inside {@link sendNotification} — Monday's
 * wire enum doesn't distinguish items from boards. The CLI keeps
 * the 2-value vocabulary for argv-validation discipline AND so the
 * output envelope echoes the agent-supplied kind. Monday's `Post`
 * wire value (Update-targeted notifications) is unreachable at v0.3.
 *
 * **The item-vs-board pairing is trusted, not verified.** The CLI
 * validates the enum (`item|board`) + the numeric ID shape at the
 * parse boundary. Monday validates that `target_id` is a visible
 * `Project` (item OR board) — invisible / non-existent targets
 * surface `not_found`. Monday CANNOT validate that the CLI-declared
 * `--target-type` matches what the ID actually names (the wire enum
 * collapses both to `Project`), so passing `--target-type item`
 * with a board ID succeeds and the envelope echoes `target_type:
 * 'item'` even though the underlying record is a board. Agents
 * needing strict kind verification should pre-read `Query.items` /
 * `Query.boards` themselves; the CLI-side pre-read is deferred to
 * a v0.3.x / v0.4 contract-extension because doubling the wire-call
 * count adds no agent-visible recovery surface.
 *
 * **Idempotency.** `create_notification` is NOT idempotent —
 * re-running mints a fresh notification with a new ID. Agents
 * needing send-once-semantics dedup on the CLI side.
 *
 * **`--dry-run` shape** per §3.1 #6 + §6.4. Strictly argv-derived;
 * no wire mutation fires. `meta.source: "none"`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import { UserIdSchema } from '../../types/ids.js';
import {
  notificationSendOutputSchema,
  notificationTargetTypeSchema,
  sendNotification,
  type NotificationSendOutput,
} from '../../api/notifications.js';

// `target` is either an ItemId or BoardId depending on `target-type`.
// At the argv parse boundary we accept any numeric ID string. The
// kind pairing (item|board ↔ target-id) is trusted, not verified —
// Monday only validates target visibility as a `Project`; the wire
// enum collapses both kinds, so a passing argv with mismatched kind
// still succeeds. See the module header for the full trust-the-argv
// rationale.
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
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'notification');
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
      .action(async (opts: {
        user: string;
        target: string;
        targetType: string;
        text: string;
      }) => {
        const parsed = parseArgv(notificationSendCommand.inputSchema, {
          user: opts.user,
          target: opts.target,
          targetType: opts.targetType,
          text: opts.text,
        });

        const { client, globalFlags, apiVersion } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Strictly argv-derived per cli-design §6.4 — no wire
          // call fires.
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'create_notification',
                user_id: parsed.user,
                target_id: parsed.target,
                target_type: parsed.targetType,
                text: parsed.text,
              },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const result = await sendNotification({
          client,
          userId: parsed.user,
          targetId: parsed.target,
          targetType: parsed.targetType,
          text: parsed.text,
        });

        emitMutation({
          ctx,
          data: result.notification,
          schema: notificationSendCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          source: result.source,
          cacheAgeSeconds: result.cacheAgeSeconds,
          complexity: result.complexity,
          apiVersion,
        });
      });
  },
};
