/**
 * `monday workspace delete <wid> --yes [--dry-run]` — delete an
 * existing workspace (`cli-design.md` §4.3 line 481, `v0.2-plan.md`
 * §3 M14).
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §10.2). `--yes` is
 * mandatory for the live path; without `--yes` (and without
 * `--dry-run`) the command fails fast with `confirmation_required`
 * (exit 1) carrying `details.workspace_id`. Same shape — and same
 * gate-before-`resolveClient()` ordering — as `item delete` /
 * `item archive` / `update delete` (M10 round-1 P2: the gate's
 * contract is unconditional; a missing token must NOT mask
 * `confirmation_required` as `config_error`).
 *
 * The inline gate replicates the 17-LOC pattern from the four prior
 * destructive-verb sites. R29 lift (v0.2-plan §20) consolidates
 * this block + the four prior sites into
 * `src/api/destructive-gate.ts` after M14 implementation lands —
 * workspace delete is the 5th consumer that triggers the lift.
 *
 * **Wire shape.** Single round-trip via `delete_workspace(workspace_
 * id: ID!)`. Monday returns the deleted `Workspace` so the envelope's
 * `data` is the full projection. A null result surfaces as
 * `not_found` — the standard "id was bogus / already deleted"
 * mapping.
 *
 * **Admin-permission-sensitive.** Non-admin callers surface
 * `forbidden` (mapped from Monday's PERMISSION_DENIED extension).
 *
 * **Dry-run shape** per cli-design §6.4 workspace-delete variant:
 * minimal `{operation: "delete_workspace", workspace_id}`. No
 * preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`. Same shape (modulo `workspace_id` vs
 * `update_id`) as `update delete` — the destructive-no-read pattern
 * is uniform across `item delete` / `update delete` / `workspace
 * delete`.
 *
 * **Idempotent: false.** Re-running surfaces `not_found` past the
 * first call. Same rationale as `item delete` / `update delete` —
 * agents can't safely retry without verifying the id still names
 * the same record.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { WorkspaceIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { ApiError } from '../../utils/errors.js';
import { enforceDestructiveGate } from '../../api/destructive-gate.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import {
  WORKSPACE_FIELDS_FRAGMENT,
  workspaceProjectionSchema,
  type WorkspaceProjection,
} from '../../api/workspace-projection.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';

const DELETE_WORKSPACE_MUTATION = `
  mutation WorkspaceDelete($workspaceId: ID!) {
    delete_workspace(workspace_id: $workspaceId) {
      ${WORKSPACE_FIELDS_FRAGMENT}
    }
  }
`;

export const workspaceDeleteOutputSchema = workspaceProjectionSchema;

export type WorkspaceDeleteOutput = WorkspaceProjection;

const inputSchema = z
  .object({ workspaceId: WorkspaceIdSchema })
  .strict();

const responseSchema = z
  .object({
    delete_workspace: z.unknown(),
  })
  .loose();

export const workspaceDeleteCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WorkspaceDeleteOutput
> = {
  name: 'workspace.delete',
  summary: 'Delete a workspace — --yes required',
  examples: [
    'monday workspace delete 12345 --yes',
    'monday workspace delete 12345 --dry-run',
    'monday workspace delete 12345 --yes --json',
  ],
  // Re-deleting an already-deleted workspace surfaces `not_found`.
  // The CLI marks `idempotent: false` because re-running with the
  // same `<wid>` after an interim `monday workspace create` would
  // target a different record — see `item delete` for the full
  // rationale.
  idempotent: false,
  inputSchema,
  outputSchema: workspaceDeleteOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'workspace');
    noun
      .command('delete <workspaceId>')
      .description(workspaceDeleteCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...workspaceDeleteCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (workspaceId: unknown) => {
        const parsed = parseArgv(workspaceDeleteCommand.inputSchema, { workspaceId });

        // Gate BEFORE `resolveClient()` — Codex M10 round-1 P2.
        // A missing `--yes` must surface as `confirmation_required`
        // per cli-design §3.1 #7's unconditional contract, never
        // masked by `config_error` when no token is configured.
        // R29 lift (v0.2-plan §20): the helper accepts already-
        // parsed globalFlags so the ordering invariant is visible
        // in the call signature. Workspace delete was the 5th
        // consumer that triggered the lift.
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        enforceDestructiveGate({
          globalFlags,
          verb: 'workspace delete',
          target: parsed.workspaceId,
          detailKey: 'workspace_id',
          action: 'delete the workspace',
          hint:
            'delete is destructive — Monday retains deleted workspaces ' +
            'in the trash for ~30 days but exposes no restore mutation; ' +
            'agents needing reversal must recreate via `monday workspace ' +
            'create` (lossy: new id, no boards / users / folders state).',
        });

        if (globalFlags.dryRun) {
          // Minimal dry-run shape — no preflight read fires. Per
          // cli-design §6.4 workspace-delete variant: `operation:
          // "delete_workspace"`, `workspace_id`, nothing else.
          // `meta.source: 'none'` because no API call fires; live
          // surfaces `not_found` for missing ids on its own.
          const { apiVersion } = resolveClient(ctx, program.opts());
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'delete_workspace',
                workspace_id: parsed.workspaceId,
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
          DELETE_WORKSPACE_MUTATION,
          { workspaceId: parsed.workspaceId },
          { operationName: 'WorkspaceDelete' },
        );
        const data = unwrapOrThrow(
          responseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed WorkspaceDelete response',
            details: { workspace_id: parsed.workspaceId },
            hint:
              'this is a data-integrity error in Monday\'s response; ' +
              'verify the response shape and update responseSchema if ' +
              'Monday\'s contract has changed.',
          },
        );
        // R42 (post-v0.2 → v0.3 cleanup follow-up): consolidate the
        // M14 round-3 F1 inline missing-key check onto the shared
        // helper. Distinguishes "root key absent" (schema-drift →
        // internal_error) from "value null" (workspace already
        // deleted / id bogus → not_found via projectDeletedWorkspace).
        assertResponseFieldPresent({
          data,
          key: 'delete_workspace',
          operationLabel: 'WorkspaceDelete',
          details: { workspace_id: parsed.workspaceId },
          nullHandling: 'caller_handles',
        });
        const projected = projectDeletedWorkspace(
          data.delete_workspace,
          parsed.workspaceId,
        );

        emitMutation({
          ctx,
          data: projected,
          schema: workspaceDeleteCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};

const projectDeletedWorkspace = (
  raw: unknown,
  workspaceId: string,
): WorkspaceDeleteOutput => {
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no workspace payload from delete_workspace for id ${workspaceId}`,
      { details: { workspace_id: workspaceId } },
    );
  }
  return unwrapOrThrow(
    workspaceDeleteOutputSchema.safeParse(raw),
    {
      context: `Monday returned a malformed workspace payload for id ${workspaceId}`,
      details: { workspace_id: workspaceId },
    },
  );
};
