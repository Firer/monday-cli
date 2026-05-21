/**
 * `monday webhook delete <wid> --yes [--dry-run]` — remove a webhook
 * by ID (cli-design §2.7 + §4.3 + §13 v0.3 entry; v0.3-plan §3 M27).
 *
 * **Wire shape.** Single `client.raw` round-trip via
 * {@link deleteWebhook} against `mutation DeleteWebhook` with
 * `operationName: 'DeleteWebhook'` (R-NEW-37 W2 audit-point).
 *
 * **Confirmation gate** (cli-design §3.1 #7). `--yes` is mandatory
 * for the live path; without `--yes` (and without `--dry-run`) the
 * command fails fast with `confirmation_required` carrying
 * `details.webhook_id`. Mirrors `item delete` / `board delete` /
 * `board column-delete` / `board group-delete` shape. The gate
 * fires BEFORE `resolveClient` so a missing token doesn't mask
 * `confirmation_required` as `config_error` — same M10 round-1 P2
 * invariant the destructive-gate helper enforces.
 *
 * **`--dry-run` shape** per §3.1 #6 + §6.4. Strictly argv-derived
 * — no pre-mutation read; `meta.source: "none"`. Planned change
 * carries `{operation: 'delete_webhook', webhook_id}` only.
 * Monday's `webhooks(board_id:)` query is board-scoped but this
 * verb's argv carries no board ID, so the dry-run cannot enrich the
 * planned change with the to-be-deleted webhook's `event` / `config`
 * (that enrichment would require a §4.3 amendment adding `--board
 * <bid>` and is out of M27 scope — round-3 P2-1'' closure).
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
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { enforceDestructiveGate } from '../../api/destructive-gate.js';
import { WebhookIdSchema } from '../../types/ids.js';
import {
  deleteWebhook,
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
  // Re-running against a fresh webhook with the same ID string is
  // not safe (Monday assigns new IDs); marked non-idempotent to push
  // agents toward verify-before-retry.
  idempotent: false,
  inputSchema,
  outputSchema: webhookDeleteOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(
      program,
      'webhook',
      'Manage board webhooks (register, list, delete)',
    );
    noun
      .command('delete <webhookId>')
      .description(webhookDeleteCommand.summary)
      // `--yes` and `--dry-run` are global flags (`src/cli/program.ts`).
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...webhookDeleteCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (webhookIdArg: unknown) => {
        const parsed = parseArgv(webhookDeleteCommand.inputSchema, {
          webhookId: webhookIdArg,
        });

        // Gate fires BEFORE resolveClient (M10 round-1 P2 invariant):
        // a missing token must NOT mask `confirmation_required` as
        // `config_error`. cli-design §3.1 #7 pins the gate as
        // unconditional. The gate-error envelope's `meta.source`
        // stays at the runner's `'none'` default because no wire
        // call fires.
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        enforceDestructiveGate({
          globalFlags,
          verb: 'webhook delete',
          target: parsed.webhookId,
          detailKey: 'webhook_id',
          action: 'delete the webhook',
          hint:
            'delete is destructive — Monday exposes no restore ' +
            'mutation for webhooks; re-creating after delete mints ' +
            'a fresh ID with a new URL subscription.',
        });

        // Gate cleared — resolve the client. Both dry-run + live
        // paths need `MondayClient` (the dry-run path uses
        // `apiVersion` for the envelope's `meta.api_version`); a
        // missing token here legitimately surfaces as `config_error`
        // (the user opted into the wire path via `--yes` or
        // `--dry-run`).
        const { client, apiVersion } = resolveClient(ctx, program.opts());

        if (globalFlags.dryRun) {
          // Strictly argv-derived per round-3 P2-1'' closure. No
          // pre-mutation read: Monday's `webhooks(board_id:)` is
          // board-scoped but the verb's argv carries no board ID,
          // so the planned change carries only `webhook_id`.
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'delete_webhook',
                webhook_id: parsed.webhookId,
              },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const result = await deleteWebhook({
          client,
          webhookId: parsed.webhookId,
        });

        emitMutation({
          ctx,
          data: result.webhook,
          schema: webhookDeleteCommand.outputSchema,
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
