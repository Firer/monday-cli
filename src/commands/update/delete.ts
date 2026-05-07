/**
 * `monday update delete <uid> --yes [--dry-run]` — delete an existing
 * update (`cli-design.md` §4.3 line 695, `v0.2-plan.md` §3 M13).
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §10.2). `--yes` is
 * mandatory for the live path; without `--yes` (and without
 * `--dry-run`) the command fails fast with `confirmation_required`
 * carrying `details.update_id`. Same shape — and same gate-before-
 * `resolveClient()` ordering — as `item delete` / `item archive`
 * (Codex M10 round-1 P2: the gate's contract is unconditional;
 * a missing token must NOT mask `confirmation_required` as
 * `config_error`).
 *
 * **Live path.** Single round-trip via `delete_update(id: ID!)`.
 * Monday returns the deleted `Update` so the envelope's `data` is
 * the full projection. A null result surfaces as `not_found` —
 * mirrors `update reply` / `update edit`'s null-payload mapping
 * (M10 R28 lifecycle pattern).
 *
 * **Dry-run shape** per cli-design §6.4 update-delete variant:
 * minimal `{ operation: "delete_update", update_id }`. No
 * preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`.
 *
 * **Idempotent: false.** Re-running surfaces `not_found` past the
 * first call. Same rationale as `item delete` — agents can't
 * safely retry without verifying the id still names the same
 * record.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { UpdateIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { ConfirmationRequiredError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import {
  projectMutationUpdate,
  UPDATE_FIELDS_FRAGMENT,
  updateProjectionSchema,
  type UpdateProjection,
} from '../../api/update-mutation-result.js';

const DELETE_UPDATE_MUTATION = `
  mutation UpdateDelete($id: ID!) {
    delete_update(id: $id) {
      ${UPDATE_FIELDS_FRAGMENT}
    }
  }
`;

export const updateDeleteOutputSchema = updateProjectionSchema;

export type UpdateDeleteOutput = UpdateProjection;

const inputSchema = z.object({ updateId: UpdateIdSchema }).strict();

const responseSchema = z
  .object({
    delete_update: z.unknown(),
  })
  .loose();

export const updateDeleteCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UpdateDeleteOutput
> = {
  name: 'update.delete',
  summary: 'Delete an update (comment) — --yes required',
  examples: [
    'monday update delete 77 --yes',
    'monday update delete 77 --dry-run',
    'monday update delete 77 --yes --json',
  ],
  // Re-deleting an already-deleted update surfaces `not_found`. The
  // CLI marks `idempotent: false` because re-running with the same
  // `<uid>` after an interim `monday update create` would target a
  // different record — see `item delete` for the full rationale.
  idempotent: false,
  inputSchema,
  outputSchema: updateDeleteOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'update', 'Update (comment) commands');
    noun
      .command('delete <updateId>')
      .description(updateDeleteCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...updateDeleteCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (updateId: unknown) => {
        const parsed = parseArgv(updateDeleteCommand.inputSchema, { updateId });

        // Gate BEFORE `resolveClient()` — Codex M10 round-1 P2.
        // A missing `--yes` must surface as `confirmation_required`
        // per cli-design §3.1 #7's unconditional contract, never
        // masked by `config_error` when no token is configured.
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        if (!globalFlags.dryRun && !globalFlags.yes) {
          throw new ConfirmationRequiredError(
            `monday update delete ${parsed.updateId} would delete the ` +
              `update. Re-run with --yes to confirm, or --dry-run to ` +
              `preview.`,
            {
              details: {
                update_id: parsed.updateId,
                hint:
                  'delete is destructive — Monday retains deleted ' +
                  'updates in the trash for ~30 days but exposes no ' +
                  'restore mutation; agents needing reversal must ' +
                  'recreate via `monday update create` (lossy: new id, ' +
                  'no like / pin / reply state).',
              },
            },
          );
        }

        if (globalFlags.dryRun) {
          // Minimal dry-run shape — no preflight read fires. Per
          // cli-design §6.4 update-delete variant: `operation:
          // "delete_update"`, `update_id`, nothing else.
          // `meta.source: 'none'` because no API call fires; live
          // surfaces `not_found` for missing ids on its own.
          const { apiVersion } = resolveClient(ctx, program.opts());
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'delete_update',
                update_id: parsed.updateId,
              },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const { client, toEmit } = resolveClient(ctx, program.opts());
        const response = await client.raw<unknown>(
          DELETE_UPDATE_MUTATION,
          { id: parsed.updateId },
          { operationName: 'UpdateDelete' },
        );
        const data = unwrapOrThrow(
          responseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed UpdateDelete response',
            details: { update_id: parsed.updateId },
            hint:
              'this is a data-integrity error in Monday\'s response; ' +
              'verify the response shape and update responseSchema if ' +
              'Monday\'s contract has changed.',
          },
        );
        // Lift R37 (v0.2-plan §20): null-payload + strict-parse seam
        // shared with reply / edit / toggle.
        const projected = projectMutationUpdate({
          raw: data.delete_update,
          updateId: parsed.updateId,
          mutationName: 'delete_update',
        });

        emitMutation({
          ctx,
          data: projected,
          schema: updateDeleteCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
