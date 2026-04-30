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
import { runByIdLookup } from '../run-by-id-lookup.js';
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
        await runByIdLookup({
          ctx,
          programOpts: program.opts(),
          query: BOARD_GET_QUERY,
          operationName: 'BoardGet',
          collectionKey: 'boards',
          id: parsed.boardId,
          errorDetailKey: 'board_id',
          kind: 'board',
          schema: boardGetCommand.outputSchema,
        });
      });
  },
};
