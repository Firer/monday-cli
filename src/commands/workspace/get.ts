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
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ApiError } from '../../utils/errors.js';
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

interface RawWorkspaces {
  readonly workspaces: readonly unknown[] | null;
}

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
        const { client, toEmit } = resolveClient(ctx, program.opts());
        const response = await client.raw<RawWorkspaces>(
          WORKSPACE_GET_QUERY,
          { ids: [parsed.workspaceId] },
          { operationName: 'WorkspaceGet' },
        );
        const first = response.data.workspaces?.[0];
        if (first === undefined || first === null) {
          throw new ApiError(
            'not_found',
            `Monday returned no workspace for id ${parsed.workspaceId}`,
            { details: { workspace_id: parsed.workspaceId } },
          );
        }
        emitSuccess({
          ctx,
          data: workspaceGetCommand.outputSchema.parse(first),
          schema: workspaceGetCommand.outputSchema,
          programOpts: program.opts(),
          ...toEmit(response),
        });
      });
  },
};
