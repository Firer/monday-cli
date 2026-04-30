/**
 * `monday board columns <bid>` — list a board's columns
 * (`cli-design.md` §4.3, §6.3).
 *
 * Reads through the cached `loadBoardMetadata` so a follow-up `item set`
 * call (M5b) doesn't pay the same fetch twice. `--no-cache` bypasses
 * (global flag); `--include-archived` opts archived columns back into
 * the view per §5.3 step 6.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { loadBoardMetadata, type BoardColumn } from '../../api/board-metadata.js';

const columnOutSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    type: z.string(),
    description: z.string().nullable(),
    archived: z.boolean().nullable(),
    settings_str: z.string().nullable(),
    width: z.number().nullable(),
  })
  .strict();

export const boardColumnsOutputSchema = z.array(columnOutSchema);
export type BoardColumnsOutput = z.infer<typeof boardColumnsOutputSchema>;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    includeArchived: z.boolean().optional(),
  })
  .strict();

const project = (cols: readonly BoardColumn[]): BoardColumnsOutput =>
  cols.map((c) => ({
    id: c.id,
    title: c.title,
    type: c.type,
    description: c.description,
    archived: c.archived,
    settings_str: c.settings_str,
    width: c.width,
  }));

export const boardColumnsCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardColumnsOutput
> = {
  name: 'board.columns',
  summary: "List a board's columns (cached for the M5b write path)",
  examples: [
    'monday board columns 12345',
    'monday board columns 12345 --include-archived --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardColumnsOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('columns <boardId>')
      .description(boardColumnsCommand.summary)
      .option('--include-archived', 'show archived columns too')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardColumnsCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardColumnsCommand.inputSchema, {
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

        const cols =
          parsed.includeArchived === true
            ? result.metadata.columns
            : result.metadata.columns.filter((c) => c.archived !== true);
        const projected = project(cols);

        // resolveClient seeded `meta.source = 'live'`; override with
        // the actual data origin so the (unused) error path and the
        // success path agree.
        ctx.meta.setSource(result.source);

        emitSuccess({
          ctx,
          data: projected,
          schema: boardColumnsCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          source: result.source,
          apiVersion,
          // Cache hits never have complexity (no GraphQL call ran).
          complexity: null,
          cacheAgeSeconds: result.cacheAgeSeconds,
        });
      });
  },
};
