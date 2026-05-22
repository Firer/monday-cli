/**
 * `monday webhook list <bid>` — list webhooks for the supplied board
 * (cli-design §2.7 + §4.3 + §13 v0.3 entry; v0.3-plan §3 M27).
 *
 * **Wire shape.** Single `Query.webhooks(board_id:)` round-trip via
 * {@link listWebhooks} with `operationName: 'Webhooks'`. No
 * pagination — Monday returns the full list in one shot (boards
 * rarely carry more than a few dozen webhooks).
 *
 * **Webhooks are live-only at v0.3** per cli-design §8 cache scope.
 * Output `meta.source: "live"`, `meta.cache_age_seconds: null`.
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import { BoardIdSchema } from '../../types/ids.js';
import {
  listWebhooks,
  webhookListOutputSchema,
  type WebhookListOutput,
} from '../../api/webhooks.js';

const inputSchema = z.object({ boardId: BoardIdSchema }).strict();

export const webhookListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WebhookListOutput
> = {
  name: 'webhook.list',
  summary: 'List webhooks configured on the supplied board',
  examples: [
    'monday webhook list 12345678',
    'monday webhook list 12345678 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: webhookListOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'webhook');
    noun
      .command('list <boardId>')
      .description(webhookListCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...webhookListCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (boardIdArg: unknown) => {
        const parsed = parseArgv(webhookListCommand.inputSchema, {
          boardId: boardIdArg,
        });
        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await listWebhooks({
          client,
          boardId: parsed.boardId,
        });
        emitSuccess({
          ctx,
          data: result.webhooks,
          schema: webhookListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          warnings: [],
          source: result.source,
          cacheAgeSeconds: result.cacheAgeSeconds,
          complexity: result.complexity,
          apiVersion,
        });
      });
  },
};
