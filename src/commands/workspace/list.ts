/**
 * `monday workspace list` — list every visible workspace
 * (`cli-design.md` §4.3, §6.3).
 *
 * GraphQL: `workspaces(limit:, page:, kind:, state:, ids:, order_by:)`
 *
 * Idempotent: yes — pure read.
 *
 * Pagination model. Monday's `workspaces` query is page-based (not
 * cursor-based — the §5.6 stale-cursor contract applies only to
 * `items_page` in M4). We expose `--limit <n>` (max 100 per Monday)
 * and `--page <n>` so an agent can walk pages explicitly. `--all`
 * iterates from page 1 until a short page lands; the result is one
 * flat array. The collection envelope (§6.3) carries
 * `total_returned`, `has_more`, and the page number used.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { UsageError } from '../../utils/errors.js';
import { parseArgv } from '../parse-argv.js';

const WORKSPACE_LIST_QUERY = `
  query WorkspaceList($limit: Int, $page: Int, $kind: WorkspaceKind, $state: State) {
    workspaces(limit: $limit, page: $page, kind: $kind, state: $state) {
      id
      name
      description
      kind
      state
      is_default_workspace
      created_at
    }
  }
`;

const workspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    kind: z.string().nullable(),
    state: z.string().nullable(),
    is_default_workspace: z.boolean().nullable(),
    created_at: z.string().nullable(),
  })
  .strict();

export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceListOutputSchema = z.array(workspaceSchema);
export type WorkspaceListOutput = z.infer<typeof workspaceListOutputSchema>;

const inputSchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    kind: z.enum(['open', 'closed']).optional(),
    state: z.enum(['active', 'archived', 'deleted', 'all']).optional(),
    all: z.boolean().optional(),
  })
  .strict();

interface RawWorkspaces {
  readonly workspaces: readonly unknown[] | null;
}

const projectMany = (input: readonly unknown[]): readonly Workspace[] =>
  workspaceListOutputSchema.parse(input);

export const workspaceListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WorkspaceListOutput
> = {
  name: 'workspace.list',
  summary: 'List visible workspaces',
  examples: [
    'monday workspace list',
    'monday workspace list --json',
    'monday workspace list --kind open --state active',
    'monday workspace list --all --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: workspaceListOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'workspace', 'Workspace commands');
    noun
      .command('list')
      .description(workspaceListCommand.summary)
      .option('--limit <n>', 'max workspaces per page (1-100, default 25)')
      .option('--page <n>', 'page number (1-indexed)')
      .option('--kind <k>', 'filter by kind: open|closed')
      .option('--state <s>', 'filter by state: active|archived|deleted|all')
      .option('--all', 'walk every page')
      .addHelpText(
        'after',
        ['', 'Examples:', ...workspaceListCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(workspaceListCommand.inputSchema, opts);
        if (parsed.all === true && parsed.page !== undefined) {
          throw new UsageError('--all and --page are mutually exclusive');
        }
        const { client, toEmit } = resolveClient(ctx, program.opts());

        const limit = parsed.limit ?? 25;
        const collected: unknown[] = [];
        let page = parsed.page ?? 1;
        let lastResponse: Awaited<ReturnType<typeof client.raw<RawWorkspaces>>>;
        let hasMore: boolean;

        for (;;) {
          const variables: Record<string, unknown> = { limit, page };
          if (parsed.kind !== undefined) {
            variables.kind = parsed.kind;
          }
          if (parsed.state !== undefined) {
            variables.state = parsed.state;
          }
          const response = await client.raw<RawWorkspaces>(
            WORKSPACE_LIST_QUERY,
            variables,
            { operationName: 'WorkspaceList' },
          );
          lastResponse = response;
          const pageData = response.data.workspaces ?? [];
          if (pageData.length === 0) {
            hasMore = false;
            break;
          }
          collected.push(...pageData);
          hasMore = pageData.length === limit;
          if (parsed.all !== true || !hasMore) {
            break;
          }
          page++;
        }

        const projected = projectMany(collected);
        emitSuccess({
          ctx,
          data: projected,
          schema: workspaceListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          // Page-based — no cursor surface. `has_more` is best-effort:
          // when the last page came back full at the requested limit
          // there might be more; a short page guarantees not.
          hasMore: parsed.all === true ? false : hasMore,
          ...toEmit(lastResponse),
        });
      });
  },
};
