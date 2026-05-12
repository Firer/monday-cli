/**
 * `monday webhook create <bid> --url <u> --event <e> [--config <json>]`
 * — register a new webhook on the supplied board (cli-design §2.7 +
 * §4.3 + §13 v0.3 entry; v0.3-plan §3 M27).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M27 implementation lands the
 * runtime body via `client.raw` against the `CreateWebhook` mutation
 * with `operationName: 'CreateWebhook'` (R-NEW-37 watch-item: keep
 * doc-named-operation + wire-operationName in sync).
 *
 * **Event-type validation (Decision 9 closure).** `--event` is
 * validated against the closed {@link WEBHOOK_EVENT_TYPES} 21-value
 * enum at parse boundary; unknown events surface `usage_error`
 * before hitting the wire. Per cli-design §13 v0.3 entry M27
 * sub-block + the empirical probe finding (2026-05-12, API
 * `2026-01`).
 *
 * **`--config <json>` is an opaque JSON string.** The CLI accepts
 * the value as a raw string at argv (no per-event sub-shape
 * validation); the runtime body at M27 IMPL threads it through to
 * Monday's `JSON` scalar input arg. Per-event structural validation
 * lives server-side at Monday (rejecting malformed configs surfaces
 * as `validation_failed`).
 *
 * **`--url` requires HTTPS at parse boundary.** Monday rejects
 * non-HTTPS webhook endpoints server-side; surfacing the rejection
 * at the CLI boundary keeps the failure mode local (usage_error
 * before any wire call fires).
 *
 * **`--dry-run` support per §3.1 #6.** Argv parse + URL/event
 * validation only; no wire mutation fires. Envelope shape pinned
 * in output-shapes.md; runtime engine lands at M27 IMPL.
 *
 * **Idempotency caveat.** `create_webhook` is NOT idempotent —
 * re-running with the same args mints a fresh webhook with a new
 * ID. Agents needing register-once semantics should `webhook list`
 * first and skip the create if a matching entry exists.
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { BoardIdSchema } from '../../types/ids.js';
import {
  webhookCreateOutputSchema,
  webhookEventTypeSchema,
  type WebhookCreateOutput,
} from '../../api/webhooks.js';

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    url: z.url({ protocol: /^https$/u }),
    event: webhookEventTypeSchema,
    config: z.string().optional(),
  })
  .strict();

export const webhookCreateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WebhookCreateOutput
> = {
  name: 'webhook.create',
  summary: 'Register a new webhook on the supplied board',
  examples: [
    'monday webhook create 12345678 --url https://example.com/hook --event create_item',
    'monday webhook create 12345678 --url https://example.com/hook --event change_status_column_value --config \'{"columnId":"status"}\'',
  ],
  idempotent: false,
  inputSchema,
  outputSchema: webhookCreateOutputSchema,
  attach: (program) => {
    const noun = ensureSubcommand(
      program,
      'webhook',
      'Webhook commands (board-scoped; CLI never receives — see cli-design §1 permanent non-goals)',
    );
    noun
      .command('create <boardId>')
      .description(webhookCreateCommand.summary)
      .requiredOption(
        '--url <u>',
        'Public HTTPS URL Monday POSTs webhook events to. Must be reachable from Monday.com.',
      )
      .requiredOption(
        '--event <e>',
        'Webhook event type. One of: change_column_value, change_name, change_specific_column_value, change_status_column_value, change_subitem_column_value, change_subitem_name, create_column, create_item, create_subitem, create_subitem_update, create_update, delete_update, edit_update, item_archived, item_deleted, item_moved_to_any_group, item_moved_to_specific_group, item_restored, move_subitem, subitem_archived, subitem_deleted',
      )
      .option(
        '--config <json>',
        'Event-specific configuration as a JSON-encoded string. Opaque to the CLI; per-event sub-shape validation happens server-side at Monday.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...webhookCreateCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M27 IMPL */
        async (
          boardIdArg: unknown,
          opts: { url: string; event: string; config?: string },
        ) => {
          parseArgv(webhookCreateCommand.inputSchema, {
            boardId: boardIdArg,
            url: opts.url,
            event: opts.event,
            ...(opts.config === undefined ? {} : { config: opts.config }),
          });
          await Promise.reject(
            new ApiError(
              'internal_error',
              'monday webhook create not yet implemented (v0.3-M27 pre-flight stub)',
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
