/**
 * `monday workspace folders <wid>` — list folders inside a workspace
 * (`cli-design.md` §4.3).
 *
 * GraphQL: `folders(workspace_ids: [<wid>], limit:, page:)` —
 * page-based pagination, same shape as `workspace list`. Folders
 * carry a `children: [Board]` array so the agent can see board
 * groupings inline; we project minimally (id + name) — the full
 * board metadata lives behind `board describe`.
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
import {
  buildCapWarning,
  DEFAULT_MAX_PAGES,
  walkPages,
} from '../../api/walk-pages.js';
import type { Warning } from '../../utils/output/envelope.js';

const WORKSPACE_FOLDERS_QUERY = `
  query WorkspaceFolders($workspaceIds: [ID], $limit: Int, $page: Int) {
    folders(workspace_ids: $workspaceIds, limit: $limit, page: $page) {
      id
      name
      color
      created_at
      owner_id
      parent {
        id
        name
      }
      children {
        id
        name
      }
    }
  }
`;

const folderRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
  })
  .strict();

const folderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    color: z.string().nullable(),
    created_at: z.string().nullable(),
    owner_id: z.string().nullable(),
    parent: folderRefSchema.nullable(),
    children: z.array(folderRefSchema.nullable()),
  })
  .strict();

export const workspaceFoldersOutputSchema = z.array(folderSchema);
export type WorkspaceFoldersOutput = z.infer<typeof workspaceFoldersOutputSchema>;

const inputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    limit: z.coerce.number().int().positive().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    all: z.boolean().optional(),
    limitPages: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

interface RawFolders {
  readonly folders: readonly unknown[] | null;
}

export const workspaceFoldersCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WorkspaceFoldersOutput
> = {
  name: 'workspace.folders',
  summary: 'List folders inside a workspace',
  examples: [
    'monday workspace folders 12345',
    'monday workspace folders 12345 --all --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: workspaceFoldersOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'workspace', 'Workspace commands');
    noun
      .command('folders <workspaceId>')
      .description(workspaceFoldersCommand.summary)
      .option('--limit <n>', 'max folders per page (1-100)')
      .option('--page <n>', 'page number (1-indexed)')
      .option('--all', 'walk every page')
      .option(
        '--limit-pages <n>',
        `max pages under --all (1-500, default ${String(DEFAULT_MAX_PAGES)})`,
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...workspaceFoldersCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (workspaceId: unknown, opts: unknown) => {
        const parsed = parseArgv(workspaceFoldersCommand.inputSchema, {
          workspaceId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        if (parsed.all === true && parsed.page !== undefined) {
          throw new UsageError('--all and --page are mutually exclusive');
        }
        const { client, toEmit } = resolveClient(ctx, program.opts());

        const limit = parsed.limit ?? 25;
        const maxPages = parsed.limitPages ?? DEFAULT_MAX_PAGES;
        const result = await walkPages<unknown, RawFolders>({
          fetchPage: (page) =>
            client.raw<RawFolders>(
              WORKSPACE_FOLDERS_QUERY,
              { workspaceIds: [parsed.workspaceId], limit, page },
              { operationName: 'WorkspaceFolders' },
            ),
          extractItems: (r) => r.data.folders ?? [],
          pageSize: limit,
          all: parsed.all === true,
          startPage: parsed.page ?? 1,
          maxPages,
        });

        const projected = workspaceFoldersCommand.outputSchema.parse(result.items);
        const warnings: Warning[] = [];
        if (parsed.all === true && result.hasMore) {
          warnings.push(buildCapWarning(result.pagesFetched));
        }
        emitSuccess({
          ctx,
          data: projected,
          schema: workspaceFoldersCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          hasMore: result.hasMore,
          warnings,
          ...toEmit(result.lastResponse),
        });
      });
  },
};
