/**
 * `monday webhook create <bid> --url <u> --event <e> [--config <json>]`
 * — register a new webhook on the supplied board (cli-design §2.7 +
 * §4.3 + §13 v0.3 entry; v0.3-plan §3 M27).
 *
 * **Wire shape.** Single `client.raw` round-trip via
 * {@link createWebhook} against `mutation CreateWebhook` with
 * `operationName: 'CreateWebhook'` (R-NEW-37 W2 audit-point).
 *
 * **Event-type validation (Decision 9 closure).** `--event` is
 * validated against the closed {@link WEBHOOK_EVENT_TYPES} 21-value
 * enum at parse boundary; unknown events surface `usage_error`
 * before hitting the wire. Per cli-design §13 v0.3 entry M27
 * sub-block + the empirical probe finding (2026-05-12, API
 * `2026-01`).
 *
 * **`--config <json>` is parsed at the boundary.** The CLI accepts
 * a JSON-encoded string at argv; malformed JSON surfaces
 * `usage_error` before any wire call fires. The parsed JS value is
 * threaded to Monday's `JSON` scalar input arg verbatim — passing
 * the raw string would result in Monday seeing a JSON-string-of-a-
 * string. Per-event structural validation lives server-side at
 * Monday (rejecting malformed configs surfaces as
 * `validation_failed`).
 *
 * **`--url` requires HTTPS at parse boundary.** Monday rejects
 * non-HTTPS webhook endpoints server-side; surfacing the rejection
 * at the CLI boundary keeps the failure mode local (usage_error
 * before any wire call fires).
 *
 * **`--dry-run` shape** per §3.1 #6 + §6.4. Strictly argv-derived
 * — no wire mutation fires; `meta.source: "none"`. Planned change
 * carries `{operation: 'create_webhook', board_id, url, event,
 * config}` (config is the parsed JS value, or null when absent).
 *
 * **Idempotency caveat.** `create_webhook` is NOT idempotent —
 * re-running with the same args mints a fresh webhook with a new
 * ID. Agents needing register-once semantics should `webhook list`
 * first and skip the create if a matching entry exists.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseJsonArg } from '../../utils/json.js';
import {
  createWebhook,
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
  attach: (program, ctx) => {
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
        async (
          boardIdArg: unknown,
          opts: { url: string; event: string; config?: string },
        ) => {
          const parsed = parseArgv(webhookCreateCommand.inputSchema, {
            boardId: boardIdArg,
            url: opts.url,
            event: opts.event,
            ...(opts.config === undefined ? {} : { config: opts.config }),
          });

          // Parse the opaque `--config` JSON string once at the
          // boundary. Threading the raw string to Monday's `JSON`
          // scalar would double-encode (Monday sees a JSON-string-of-
          // a-string); parsing to a JS value first sends the intended
          // shape. R-NEW-42 lift: shared `parseJsonArg` helper
          // (3-consumer threshold; same shape `monday raw --vars` +
          // `board column-create --settings` use).
          const parsedConfig =
            parsed.config === undefined
              ? undefined
              : parseJsonArg(parsed.config, {
                  context: '--config must be a valid JSON-encoded string',
                  details: {
                    board_id: parsed.boardId,
                    hint: 'check the JSON syntax — strings need double-quotes; the shell may consume quotes if --config is not single-quoted',
                  },
                });

          const { client, globalFlags, apiVersion } = resolveClient(
            ctx,
            program.opts(),
          );

          if (globalFlags.dryRun) {
            // Strictly argv-derived per cli-design §6.4 — no wire
            // call fires. `config` lands in the planned change as
            // the parsed JS value (or null when absent) so an agent
            // sees the exact shape the live mutation would send.
            emitDryRun({
              ctx,
              programOpts: program.opts(),
              plannedChanges: [
                {
                  operation: 'create_webhook',
                  board_id: parsed.boardId,
                  url: parsed.url,
                  event: parsed.event,
                  config: parsedConfig ?? null,
                },
              ],
              source: 'none',
              cacheAgeSeconds: null,
              warnings: [],
              apiVersion,
            });
            return;
          }

          const result = await createWebhook({
            client,
            boardId: parsed.boardId,
            url: parsed.url,
            event: parsed.event,
            ...(parsedConfig === undefined ? {} : { config: parsedConfig }),
          });

          emitMutation({
            ctx,
            data: result.webhook,
            schema: webhookCreateCommand.outputSchema,
            programOpts: program.opts(),
            warnings: [],
            source: result.source,
            cacheAgeSeconds: result.cacheAgeSeconds,
            complexity: result.complexity,
            apiVersion,
          });
        },
      );
  },
};
