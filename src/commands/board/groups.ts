/**
 * `monday board groups <bid>` — list a board's groups
 * (`cli-design.md` §4.3).
 *
 * Reads through `loadBoardMetadata` so the shared cache covers
 * `board describe` / `board columns` / `board groups` with one
 * fetch.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';

const groupOutSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    color: z.string().nullable(),
    position: z.string().nullable(),
    archived: z.boolean().nullable(),
    deleted: z.boolean().nullable(),
  })
  .strict();

export const boardGroupsOutputSchema = z.array(groupOutSchema);
export type BoardGroupsOutput = z.infer<typeof boardGroupsOutputSchema>;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    includeArchived: z.boolean().optional(),
  })
  .strict();

export const boardGroupsCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardGroupsOutput
> = {
  name: 'board.groups',
  summary: "List a board's groups",
  examples: [
    'monday board groups 12345',
    'monday board groups 12345 --include-archived --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardGroupsOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('groups <boardId>')
      .description(boardGroupsCommand.summary)
      .option('--include-archived', 'show archived/deleted groups too')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardGroupsCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardGroupsCommand.inputSchema, {
          boardId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion } = resolveClient(
          ctx,
          program.opts(),
        );

        const result = await loadBoardMetadata({
          client,
          boardId: parsed.boardId,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });

        const groups =
          parsed.includeArchived === true
            ? result.metadata.groups
            : result.metadata.groups.filter(
                (g) => g.archived !== true && g.deleted !== true,
              );

        ctx.meta.setSource(result.source);
        emitSuccess({
          ctx,
          data: boardGroupsCommand.outputSchema.parse(groups),
          schema: boardGroupsCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          source: result.source,
          apiVersion,
          complexity: null,
          cacheAgeSeconds: result.cacheAgeSeconds,
        });
      });
  },
};
