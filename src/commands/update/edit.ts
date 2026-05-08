/**
 * `monday update edit <uid> --body <md> | --body-file <path>` — change
 * the body of an existing update (`cli-design.md` §4.3 line 695,
 * `v0.2-plan.md` §3 M13).
 *
 * Mutates via Monday's `edit_update(id, body)`. Body sources match
 * `update create` / `update reply` — the shared `readUpdateBody`
 * helper handles --body / --body-file / `--body-file -` for stdin.
 *
 * Idempotent: yes — re-running with the same body is a server-side
 * no-op (Monday's edit_update writes the new body verbatim).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { UpdateIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { readUpdateBody } from './body-source.js';
import {
  projectMutationUpdate,
  UPDATE_FIELDS_FRAGMENT,
  updateProjectionSchema,
  type UpdateProjection,
} from '../../api/update-mutation-result.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';

const EDIT_UPDATE_MUTATION = `
  mutation UpdateEdit($id: ID!, $body: String!) {
    edit_update(id: $id, body: $body) {
      ${UPDATE_FIELDS_FRAGMENT}
    }
  }
`;

export const updateEditOutputSchema = updateProjectionSchema;

export type UpdateEditOutput = UpdateProjection;

const inputSchema = z
  .object({
    updateId: UpdateIdSchema,
    body: z.string().optional(),
  })
  .strict();

const responseSchema = z
  .object({
    edit_update: z.unknown(),
  })
  .loose();

export const updateEditCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UpdateEditOutput
> = {
  name: 'update.edit',
  summary: 'Edit the body of an existing update (comment)',
  examples: [
    'monday update edit 77 --body "Updated: actually shipping today."',
    'monday update edit 77 --body-file ./revised.md',
    'cat revised.md | monday update edit 77 --body-file -',
    'monday update edit 77 --body "preview" --dry-run --json',
  ],
  // edit_update is body-replace — re-running with the same body is a
  // server-side no-op. Mark idempotent: true so agents can retry on
  // transient failure without duplicating state.
  idempotent: true,
  inputSchema,
  outputSchema: updateEditOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'update', 'Update (comment) commands');
    noun
      .command('edit <updateId>')
      .description(updateEditCommand.summary)
      .option('--body <md>', 'inline markdown body (mutually exclusive with --body-file)')
      .addHelpText(
        'after',
        ['', 'Examples:', ...updateEditCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (updateId: unknown, opts: unknown) => {
        const parsed = parseArgv(updateEditCommand.inputSchema, {
          updateId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        const body = await readUpdateBody({
          inlineBody: parsed.body,
          bodyFile: globalFlags.bodyFile,
          stdin: ctx.stdin,
          verbHint:
            'monday update edit requires either --body <md> or ' +
            '--body-file <path>. Use --body-file - to read from stdin.',
        });

        if (globalFlags.dryRun) {
          // Dry-run shape per cli-design §6.4 update-edit variant:
          // operation `edit_update`, update_id, body, body_length.
          // No source read fires — Monday's edit_update doesn't need
          // a preflight; if the id is bogus the live mutation surfaces
          // not_found. `meta.source: 'none'` accordingly.
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'edit_update',
                update_id: parsed.updateId,
                body,
                body_length: body.length,
              },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const response = await client.raw<unknown>(
          EDIT_UPDATE_MUTATION,
          { id: parsed.updateId, body },
          { operationName: 'UpdateEdit' },
        );
        // R42: distinguish missing-root-key (schema-drift →
        // internal_error) from null payload (per-record → not_found
        // via projectMutationUpdate). Must run BEFORE the parse.
        assertResponseFieldPresent({
          data: response.data,
          key: 'edit_update',
          operationLabel: 'UpdateEdit',
          details: { update_id: parsed.updateId },
          nullHandling: 'caller_handles',
        });
        const data = unwrapOrThrow(
          responseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed UpdateEdit response',
            details: { update_id: parsed.updateId },
            hint:
              'this is a data-integrity error in Monday\'s response; ' +
              'verify the response shape and update responseSchema if ' +
              'Monday\'s contract has changed.',
          },
        );
        // Lift R37 (v0.2-plan §20): null-payload + strict-parse seam
        // shared with reply / delete / toggle (mirrors R28's
        // `projectMutationItem`).
        const projected = projectMutationUpdate({
          raw: data.edit_update,
          updateId: parsed.updateId,
          mutationName: 'edit_update',
        });

        emitMutation({
          ctx,
          data: projected,
          schema: updateEditCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
