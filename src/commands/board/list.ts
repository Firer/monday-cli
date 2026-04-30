/**
 * `monday board list` — list visible boards (`cli-design.md` §4.3, §6.3).
 *
 * GraphQL: `boards(limit:, page:, ids:, workspace_ids:, state:,
 * order_by:)`. Page-based, same flag surface as `workspace list`.
 *
 * Idempotent: yes — pure read.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { UsageError } from '../../utils/errors.js';
import { WorkspaceIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';

const BOARD_LIST_QUERY = `
  query BoardList(
    $limit: Int
    $page: Int
    $workspaceIds: [ID]
    $state: State
  ) {
    boards(
      limit: $limit
      page: $page
      workspace_ids: $workspaceIds
      state: $state
    ) {
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
    }
  }
`;

const boardSchema = z
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
  })
  .strict();

export const boardListOutputSchema = z.array(boardSchema);
export type BoardListOutput = z.infer<typeof boardListOutputSchema>;

const inputSchema = z
  .object({
    workspace: WorkspaceIdSchema.optional(),
    state: z.enum(['active', 'archived', 'deleted', 'all']).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    all: z.boolean().optional(),
  })
  .strict();

interface RawBoards {
  readonly boards: readonly unknown[] | null;
}

export const boardListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardListOutput
> = {
  name: 'board.list',
  summary: 'List boards (optionally scoped to a workspace)',
  examples: [
    'monday board list',
    'monday board list --workspace 12345 --state active',
    'monday board list --all --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardListOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('list')
      .description(boardListCommand.summary)
      .option('--workspace <wid>', 'restrict to one workspace')
      .option('--state <s>', 'active|archived|deleted|all')
      .option('--limit <n>', 'page size (1-100, default 25)')
      .option('--page <n>', '1-indexed page')
      .option('--all', 'walk every page')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardListCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(boardListCommand.inputSchema, opts);
        if (parsed.all === true && parsed.page !== undefined) {
          throw new UsageError('--all and --page are mutually exclusive');
        }
        const { client, toEmit } = resolveClient(ctx, program.opts());

        const limit = parsed.limit ?? 25;
        const collected: unknown[] = [];
        let page = parsed.page ?? 1;
        let hasMore: boolean;
        let lastResponse: Awaited<ReturnType<typeof client.raw<RawBoards>>>;
        for (;;) {
          const variables: Record<string, unknown> = { limit, page };
          if (parsed.workspace !== undefined) {
            variables.workspaceIds = [parsed.workspace];
          }
          if (parsed.state !== undefined) {
            variables.state = parsed.state;
          }
          const response = await client.raw<RawBoards>(
            BOARD_LIST_QUERY,
            variables,
            { operationName: 'BoardList' },
          );
          lastResponse = response;
          const pageData = response.data.boards ?? [];
          if (pageData.length === 0) {
            hasMore = false;
            break;
          }
          collected.push(...pageData);
          hasMore = pageData.length === limit;
          if (parsed.all !== true || !hasMore) break;
          page++;
        }
        const projected = boardListCommand.outputSchema.parse(collected);
        emitSuccess({
          ctx,
          data: projected,
          schema: boardListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          hasMore: parsed.all === true ? false : hasMore,
          ...toEmit(lastResponse),
        });
      });
  },
};
