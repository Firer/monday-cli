/**
 * `monday workspace create --name <n> [--kind open|closed]
 * [--description <d>] [--dry-run]` — create a new workspace
 * (`cli-design.md` §4.3 line 444, `v0.2-plan.md` §3 M14).
 *
 * **Wire shape.** Single round-trip via `create_workspace(name, kind,
 * description?)`. Monday's GraphQL signature pins `kind:
 * WorkspaceKind!` (required at the wire); the CLI defaults `--kind`
 * to `open` when omitted so agents don't have to remember the wire
 * constraint. `--description` is optional; omitting it sends no
 * argument and Monday's server-side default (empty string in
 * practice) applies.
 *
 * **Live-envelope projection.** Returned `Workspace` is projected
 * through `workspaceGetOutputSchema` (the shape `workspace get`
 * already pins). Sharing the schema keeps create/get/update/delete
 * envelopes byte-identical for the same record — a downstream
 * `monday workspace get <wid>` after a successful create returns the
 * same JSON shape.
 *
 * **Dry-run shape** per cli-design §6.4 workspace-create variant:
 * minimal `{operation: "create_workspace", name, kind, description?}`.
 * No preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`.
 *
 * **Idempotent: false.** Re-running creates a duplicate workspace
 * with the same name. Agents needing dedupe should call
 * `monday workspace list` first. NOT destructive (no `--yes` gate).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import {
  workspaceGetOutputSchema,
  type WorkspaceGetOutput,
} from './get.js';

const CREATE_WORKSPACE_MUTATION = `
  mutation WorkspaceCreate($name: String!, $kind: WorkspaceKind!, $description: String) {
    create_workspace(name: $name, kind: $kind, description: $description) {
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

export const workspaceCreateOutputSchema = workspaceGetOutputSchema;

export type WorkspaceCreateOutput = WorkspaceGetOutput;

// Argv schema. `name` carries the same min(1)-after-trim discipline
// as `item create` — Monday accepts whitespace-only names but they
// produce un-findable workspaces; reject at the boundary. Use
// `.refine()` not `.transform()` so the schema stays JSON-Schema-
// representable (the schema-export pipeline rejects transforms);
// trim happens inside the action body before the wire call.
const inputSchema = z
  .object({
    name: z.string().refine((s) => s.trim().length > 0, {
      message: '--name must be non-empty (whitespace-only is rejected)',
    }),
    kind: z.enum(['open', 'closed']).default('open'),
    description: z.string().optional(),
  })
  .strict();

const responseSchema = z
  .object({
    create_workspace: z.unknown(),
  })
  .loose();

export const workspaceCreateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WorkspaceCreateOutput
> = {
  name: 'workspace.create',
  summary: 'Create a new workspace',
  examples: [
    'monday workspace create --name "Marketing"',
    'monday workspace create --name "Marketing — EU" --kind closed --description "EU-only campaigns"',
    'monday workspace create --name "Test" --dry-run --json',
  ],
  // create_workspace is non-idempotent — re-running creates a second
  // workspace with the same name. Mirrors `update create`'s rationale.
  idempotent: false,
  inputSchema,
  outputSchema: workspaceCreateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'workspace', 'Workspace commands');
    noun
      .command('create')
      .description(workspaceCreateCommand.summary)
      .requiredOption('--name <n>', 'workspace name')
      .option('--kind <k>', 'workspace kind: open|closed (default: open)')
      .option('--description <d>', 'workspace description')
      .addHelpText(
        'after',
        ['', 'Examples:', ...workspaceCreateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(workspaceCreateCommand.inputSchema, opts);
        // Trim post-parse: the schema's `.refine()` rejects whitespace-
        // only input but doesn't strip surrounding whitespace; the
        // wire call should send the canonical (trimmed) form so a
        // round-trip workspace name matches what the agent intended.
        const name = parsed.name.trim();
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Per cli-design §6.4 workspace-create variant: minimal
          // `{operation, name, kind, description?}`. No preflight
          // read leg fires — the dry-run is purely argv-derived;
          // `meta.source: 'none'`. The defaulted `kind: 'open'` is
          // surfaced explicitly so the agent sees what the live
          // mutation would send.
          const planned: Record<string, unknown> = {
            operation: 'create_workspace',
            name,
            kind: parsed.kind,
          };
          if (parsed.description !== undefined) {
            planned.description = parsed.description;
          }
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [planned],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path. Send `description` only when the agent provided
        // one — passing `description: null` would explicitly clear
        // server-side state Monday otherwise defaults sensibly.
        const variables: Record<string, unknown> = {
          name,
          kind: parsed.kind,
        };
        if (parsed.description !== undefined) {
          variables.description = parsed.description;
        }
        const response = await client.raw<unknown>(
          CREATE_WORKSPACE_MUTATION,
          variables,
          { operationName: 'WorkspaceCreate' },
        );
        const data = unwrapOrThrow(
          responseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed WorkspaceCreate response',
            details: { workspace_name: name },
            hint:
              'this is a data-integrity error in Monday\'s response; ' +
              'verify the response shape and update responseSchema if ' +
              'Monday\'s contract has changed.',
          },
        );
        const projected = projectCreatedWorkspace(data.create_workspace, name);

        emitMutation({
          ctx,
          data: projected,
          schema: workspaceCreateCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};

const projectCreatedWorkspace = (
  raw: unknown,
  workspaceName: string,
): WorkspaceCreateOutput => {
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned no workspace payload from create_workspace for name ${JSON.stringify(workspaceName)}.`,
      { details: { workspace_name: workspaceName } },
    );
  }
  return unwrapOrThrow(
    workspaceCreateOutputSchema.safeParse(raw),
    {
      context: `Monday returned a malformed workspace payload for name ${JSON.stringify(workspaceName)}`,
      details: { workspace_name: workspaceName },
    },
  );
};
