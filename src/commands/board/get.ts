/**
 * `monday board get <bid>` — single board by ID (`cli-design.md` §6.2).
 *
 * Single-resource shape; columns and groups are NOT inlined here —
 * `board describe` is the heavier read for that. Keeps `board get`
 * cheap for agents who just need name / state / kind.
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

const BOARD_GET_QUERY = `
  query BoardGet($ids: [ID!]) {
    boards(ids: $ids) {
      id
      name
      description
      state
      board_kind
      board_folder_id
      workspace_id
      url
      items_count
      updated_at
      permissions
    }
  }
`;

export const boardGetOutputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    state: z.string().nullable(),
    board_kind: z.string().nullable(),
    board_folder_id: z.string().nullable(),
    workspace_id: z.string().nullable(),
    url: z.string().nullable(),
    items_count: z.number().int().nullable(),
    updated_at: z.string().nullable(),
    permissions: z.string().nullable(),
  })
  .strict();

export type BoardGetOutput = z.infer<typeof boardGetOutputSchema>;

const inputSchema = z.object({ boardId: BoardIdSchema }).strict();

interface RawBoards {
  readonly boards: readonly unknown[] | null;
}

export const boardGetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardGetOutput
> = {
  name: 'board.get',
  summary: 'Show one board by ID (lightweight; use board describe for columns)',
  examples: [
    'monday board get 12345',
    'monday board get 12345 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardGetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('get <boardId>')
      .description(boardGetCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardGetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown) => {
        const parsed = parseArgv(boardGetCommand.inputSchema, { boardId });
        const { client, toEmit } = resolveClient(ctx, program.opts());
        const response = await client.raw<RawBoards>(
          BOARD_GET_QUERY,
          { ids: [parsed.boardId] },
          { operationName: 'BoardGet' },
        );
        const first = response.data.boards?.[0];
        if (first === undefined || first === null) {
          throw new ApiError(
            'not_found',
            `Monday returned no board for id ${parsed.boardId}`,
            { details: { board_id: parsed.boardId } },
          );
        }
        emitSuccess({
          ctx,
          data: boardGetCommand.outputSchema.parse(first),
          schema: boardGetCommand.outputSchema,
          programOpts: program.opts(),
          ...toEmit(response),
        });
      });
  },
};
