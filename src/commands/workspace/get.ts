/**
 * `monday workspace get <wid>` — fetch one workspace by ID
 * (`cli-design.md` §4.3, §6.2).
 *
 * GraphQL: `workspaces(ids: [<wid>])` returns the workspace as the
 * first (only) entry. Monday returns an empty list — not an error —
 * for an unknown ID; we surface that as `not_found`.
 *
 * Idempotent: yes — pure read.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { runByIdLookup } from '../run-by-id-lookup.js';
import { WorkspaceIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';

const WORKSPACE_GET_QUERY = `
  query WorkspaceGet($ids: [ID!]) {
    workspaces(ids: $ids) {
      id
      name
      description
      kind
      state
      is_default_workspace
      created_at
      settings {
        icon {
          color
          image
        }
      }
    }
  }
`;

const iconSchema = z
  .object({
    color: z.string().nullable(),
    image: z.string().nullable(),
  })
  .strict();

const settingsSchema = z
  .object({
    icon: iconSchema.nullable(),
  })
  .strict();

export const workspaceGetOutputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    kind: z.string().nullable(),
    state: z.string().nullable(),
    is_default_workspace: z.boolean().nullable(),
    created_at: z.string().nullable(),
    settings: settingsSchema.nullable(),
  })
  .strict();

export type WorkspaceGetOutput = z.infer<typeof workspaceGetOutputSchema>;

const inputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
  })
  .strict();

export const workspaceGetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WorkspaceGetOutput
> = {
  name: 'workspace.get',
  summary: 'Show a single workspace by ID',
  examples: [
    'monday workspace get 12345',
    'monday workspace get 12345 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: workspaceGetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'workspace', 'Workspace commands');
    noun
      .command('get <workspaceId>')
      .description(workspaceGetCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...workspaceGetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (workspaceId: unknown) => {
        const parsed = parseArgv(workspaceGetCommand.inputSchema, { workspaceId });
        await runByIdLookup({
          ctx,
          programOpts: program.opts(),
          query: WORKSPACE_GET_QUERY,
          operationName: 'WorkspaceGet',
          collectionKey: 'workspaces',
          id: parsed.workspaceId,
          errorDetailKey: 'workspace_id',
          kind: 'workspace',
          schema: workspaceGetCommand.outputSchema,
        });
      });
  },
};
