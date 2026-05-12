/**
 * `monday webhook list <bid>` — list webhooks for the supplied board
 * (cli-design §2.7 + §4.3 + §13 v0.3 entry; v0.3-plan §3 M27).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M27 implementation lands the
 * runtime body: a single `Query.webhooks(board_id:)` round-trip,
 * projected through `webhookSchema`. No pagination — Monday returns
 * the full list in one shot (boards rarely carry more than a few
 * dozen webhooks).
 *
 * **Webhooks are live-only at v0.3** per cli-design §8 cache scope.
 * Output `meta.source: "live"`, `meta.cache_age_seconds: null`.
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { BoardIdSchema } from '../../types/ids.js';
import {
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
  attach: (program) => {
    const noun = ensureSubcommand(
      program,
      'webhook',
      'Webhook commands (board-scoped; CLI never receives — see cli-design §1 permanent non-goals)',
    );
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
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M27 IMPL */
        async (boardIdArg: unknown) => {
          parseArgv(webhookListCommand.inputSchema, { boardId: boardIdArg });
          await Promise.reject(
            new ApiError(
              'internal_error',
              'monday webhook list not yet implemented (v0.3-M27 pre-flight stub)',
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
