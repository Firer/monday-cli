/**
 * `monday board subscribers <bid>` — list users subscribed to a board
 * (`cli-design.md` §4.3).
 *
 * GraphQL: `boards(ids: [<bid>]) { subscribers { id name email is_guest enabled } }`.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ApiError } from '../../utils/errors.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';

const BOARD_SUBSCRIBERS_QUERY = `
  query BoardSubscribers($ids: [ID!]) {
    boards(ids: $ids) {
      id
      subscribers {
        id
        name
        email
        is_guest
        enabled
      }
    }
  }
`;

const subscriberSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
    is_guest: z.boolean().nullable(),
    enabled: z.boolean().nullable(),
  })
  .strict();

export const boardSubscribersOutputSchema = z.array(subscriberSchema);
export type BoardSubscribersOutput = z.infer<typeof boardSubscribersOutputSchema>;

const inputSchema = z.object({ boardId: BoardIdSchema }).strict();

interface RawBoards {
  readonly boards: readonly { readonly subscribers?: readonly unknown[] }[] | null;
}

export const boardSubscribersCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardSubscribersOutput
> = {
  name: 'board.subscribers',
  summary: 'List users subscribed to a board',
  examples: [
    'monday board subscribers 12345',
    'monday board subscribers 12345 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardSubscribersOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('subscribers <boardId>')
      .description(boardSubscribersCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardSubscribersCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown) => {
        const parsed = parseArgv(boardSubscribersCommand.inputSchema, { boardId });
        const { client, toEmit } = resolveClient(ctx, program.opts());
        const response = await client.raw<RawBoards>(
          BOARD_SUBSCRIBERS_QUERY,
          { ids: [parsed.boardId] },
          { operationName: 'BoardSubscribers' },
        );
        const first = response.data.boards?.[0];
        if (first === undefined) {
          throw new ApiError(
            'not_found',
            `Monday returned no board for id ${parsed.boardId}`,
            { details: { board_id: parsed.boardId } },
          );
        }
        const subs = boardSubscribersCommand.outputSchema.parse(
          first.subscribers ?? [],
        );
        emitSuccess({
          ctx,
          data: subs,
          schema: boardSubscribersCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          // Subscribers come back inline with no pagination — the
          // GraphQL `subscribers` field returns the full set in one
          // request. `has_more` is unconditionally false; agents
          // expecting the §6.3 collection meta read this rather
          // than infer it from a missing key.
          hasMore: false,
          ...toEmit(response),
        });
      });
  },
};
