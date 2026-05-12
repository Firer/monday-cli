/**
 * `monday webhook delete <wid> --yes [--dry-run]` — remove a webhook
 * by ID (cli-design §2.7 + §4.3 + §13 v0.3 entry; v0.3-plan §3 M27).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M27 implementation lands the
 * runtime body via `client.raw` against the `DeleteWebhook`
 * mutation with `operationName: 'DeleteWebhook'` (R-NEW-37 watch-
 * item: keep doc-named-operation + wire-operationName in sync).
 *
 * **Confirmation gate** (cli-design §3.1 #7). `--yes` is mandatory
 * for the live path; without `--yes` (and without `--dry-run`) the
 * command fails fast with `confirmation_required` carrying
 * `details.webhook_id`. Mirrors `item delete` / `board delete` /
 * `board column-delete` / `board group-delete` shape. Gate landing
 * at M27 IMPL alongside the runtime body.
 *
 * **`--dry-run` support per §3.1 #6.** Argv parse only — strictly
 * argv-derived (no pre-mutation read), `meta.source: "none"`,
 * planned change carries `{operation: 'delete_webhook',
 * webhook_id}`. Monday's `webhooks(board_id:)` query is board-
 * scoped but this verb's argv carries no board ID, so the
 * dry-run cannot enrich the planned change with the to-be-deleted
 * webhook's `event` / `config` (that enrichment would require a
 * §4.3 amendment adding `--board <bid>` and is out of M27 scope).
 * Envelope shape pinned in output-shapes.md; runtime engine lands
 * at M27 IMPL.
 *
 * **Idempotency caveat.** Re-deleting an already-deleted webhook
 * surfaces `not_found` (matches the M10 `item delete` shape so
 * agents key off one error code regardless of which delete verb
 * they ran). `idempotent: false` because re-running with the same
 * `<wid>` after an interim `webhook create` would target the new
 * webhook (Monday assigns fresh IDs; same wid string can't
 * reference a recreated webhook).
 *
 * **Live mutation path is uncached** — no cache invalidation
 * needed; webhooks aren't cached at v0.3 per cli-design §8 scope.
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { WebhookIdSchema } from '../../types/ids.js';
import {
  webhookDeleteOutputSchema,
  type WebhookDeleteOutput,
} from '../../api/webhooks.js';

const inputSchema = z.object({ webhookId: WebhookIdSchema }).strict();

export const webhookDeleteCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WebhookDeleteOutput
> = {
  name: 'webhook.delete',
  summary: 'Delete a webhook by ID (--yes required; --dry-run supported)',
  examples: [
    'monday webhook delete 98765 --yes',
    'monday webhook delete 98765 --dry-run',
    'monday webhook delete 98765 --yes --json',
  ],
  // See module docstring: re-running against a fresh webhook with
  // the same ID string is not safe (Monday assigns new IDs); marked
  // non-idempotent to push agents toward verify-before-retry.
  idempotent: false,
  inputSchema,
  outputSchema: webhookDeleteOutputSchema,
  attach: (program) => {
    const noun = ensureSubcommand(
      program,
      'webhook',
      'Webhook commands (board-scoped; CLI never receives — see cli-design §1 permanent non-goals)',
    );
    noun
      .command('delete <webhookId>')
      .description(webhookDeleteCommand.summary)
      // `--yes` is a global flag (`src/cli/program.ts`); confirmation
      // gate fires at M27 IMPL alongside the runtime body.
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...webhookDeleteCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M27 IMPL */
        async (webhookIdArg: unknown) => {
          parseArgv(webhookDeleteCommand.inputSchema, {
            webhookId: webhookIdArg,
          });
          await Promise.reject(
            new ApiError(
              'internal_error',
              'monday webhook delete not yet implemented (v0.3-M27 pre-flight stub)',
              {
                details: {
                  hint: 'M27 implementation lands the runtime body + confirmation gate; see docs/v0.3-plan.md §3 M27',
                },
              },
            ),
          );
        },
        /* c8 ignore stop */
      );
  },
};
