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
import {
  buildCapWarning,
  DEFAULT_MAX_PAGES,
  walkPages,
} from '../../api/walk-pages.js';
import type { Warning } from '../../utils/output/envelope.js';

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
    limitPages: z.coerce.number().int().positive().max(500).optional(),
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
      .option(
        '--limit-pages <n>',
        `max pages under --all (1-500, default ${String(DEFAULT_MAX_PAGES)})`,
      )
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
        const maxPages = parsed.limitPages ?? DEFAULT_MAX_PAGES;
        const result = await walkPages<unknown, RawWorkspaces>({
          fetchPage: (page) => {
            const variables: Record<string, unknown> = { limit, page };
            if (parsed.kind !== undefined) variables.kind = parsed.kind;
            if (parsed.state !== undefined) variables.state = parsed.state;
            return client.raw<RawWorkspaces>(
              WORKSPACE_LIST_QUERY,
              variables,
              { operationName: 'WorkspaceList' },
            );
          },
          extractItems: (r) => r.data.workspaces ?? [],
          pageSize: limit,
          all: parsed.all === true,
          startPage: parsed.page ?? 1,
          maxPages,
        });

        const projected = projectMany(result.items);
        const warnings: Warning[] = [];
        if (parsed.all === true && result.hasMore) {
          warnings.push(buildCapWarning(result.pagesFetched));
        }
        emitSuccess({
          ctx,
          data: projected,
          schema: workspaceListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          hasMore: result.hasMore,
          warnings,
          ...toEmit(result.lastResponse),
        });
      });
  },
};
