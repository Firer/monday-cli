/**
 * `monday workspace update <wid> [--name <n>] [--kind open|closed]
 * [--description <d>] [--dry-run]` — change one or more workspace
 * fields (`cli-design.md` §4.3 line 462, `v0.2-plan.md` §3 M14).
 *
 * **Wire shape.** Single round-trip via `update_workspace(id,
 * attributes: UpdateWorkspaceAttributesInput)`. The SDK marks the
 * mutation's `id?` argument as optional but it's required in
 * practice; the CLI takes it as a required positional.
 * `attributes` is `{name?, kind?, description?}` — only the fields
 * the agent provided land on the wire (omitting a flag means
 * "leave unchanged"; partial-input is the SDK's intended shape).
 *
 * **Argv discipline.** At least one of `--name` / `--kind` /
 * `--description` is required — zero-flag invocation surfaces as
 * `usage_error` (exit 1) at argv-parse, before any network leg.
 * Mirrors `item update`'s "at least one of --name / --set / --set-
 * raw required" rule.
 *
 * **Dry-run shape** per cli-design §6.4 workspace-update variant:
 * a field-level diff with `from → to` per provided field. The
 * `from` state requires a preflight `workspace get` read leg, so
 * dry-run is two-leg (read + diff-build); `meta.source: 'live'`
 * because the read fired (workspace metadata isn't cached in v0.2).
 * When the workspace itself doesn't exist, the preflight surfaces
 * `not_found` (exit 2) — agents shouldn't have to interpret a
 * would-fail dry-run shape (mirrors the `item move --to-board`
 * unmatched-columns rule).
 *
 * **Idempotent: yes.** Re-applying the same field values is a no-op
 * on Monday's side — `update_workspace` writes the new attributes
 * verbatim. Mark `idempotent: true` so agents can retry on transient
 * failure without divergence.
 *
 * **NOT destructive** (no `--yes` gate per cli-design §3.1 #7 — the
 * gate is reserved for destructive ops only).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { WorkspaceIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import {
  WORKSPACE_FIELDS_FRAGMENT,
  workspaceProjectionSchema,
  type WorkspaceProjection,
} from '../../api/workspace-projection.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';

const WORKSPACE_UPDATE_PREFLIGHT_QUERY = `
  query WorkspaceUpdatePreflight($ids: [ID!]) {
    workspaces(ids: $ids) {
      ${WORKSPACE_FIELDS_FRAGMENT}
    }
  }
`;

const UPDATE_WORKSPACE_MUTATION = `
  mutation WorkspaceUpdate($id: ID!, $attributes: UpdateWorkspaceAttributesInput!) {
    update_workspace(id: $id, attributes: $attributes) {
      ${WORKSPACE_FIELDS_FRAGMENT}
    }
  }
`;

export const workspaceUpdateOutputSchema = workspaceProjectionSchema;

export type WorkspaceUpdateOutput = WorkspaceProjection;

const inputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    name: z
      .string()
      .refine((s) => s.trim().length > 0, {
        message: '--name must be non-empty (whitespace-only is rejected)',
      })
      .optional(),
    kind: z.enum(['open', 'closed']).optional(),
    description: z.string().optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.kind !== undefined || v.description !== undefined,
    {
      message:
        'workspace update requires at least one of --name / --kind / --description',
    },
  );

const preflightResponseSchema = z
  .object({
    workspaces: z.array(z.unknown()).nullable().optional(),
  })
  .loose();

const liveResponseSchema = z
  .object({
    update_workspace: z.unknown(),
  })
  .loose();

interface FieldDiff {
  readonly from: unknown;
  readonly to: unknown;
}

export const workspaceUpdateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WorkspaceUpdateOutput
> = {
  name: 'workspace.update',
  summary: 'Update one or more fields of a workspace',
  examples: [
    'monday workspace update 12345 --name "Marketing — EU"',
    'monday workspace update 12345 --kind closed',
    'monday workspace update 12345 --name "Renamed" --description "Updated"',
    'monday workspace update 12345 --kind closed --dry-run --json',
  ],
  // update_workspace is body-replace per provided field — re-running
  // with the same values is a server-side no-op. Mark idempotent so
  // agents can retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: workspaceUpdateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'workspace');
    noun
      .command('update <workspaceId>')
      .description(workspaceUpdateCommand.summary)
      .option('--name <n>', 'new workspace name')
      .option('--kind <k>', 'new workspace kind: open|closed')
      .option('--description <d>', 'new workspace description')
      .addHelpText(
        'after',
        ['', 'Examples:', ...workspaceUpdateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (workspaceId: unknown, opts: unknown) => {
        const parsed = parseArgv(workspaceUpdateCommand.inputSchema, {
          workspaceId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        // Trim post-parse so the wire call sends the canonical form;
        // the schema's `.refine()` already rejected whitespace-only
        // input but didn't strip surrounding whitespace. Description
        // is intentionally left untrimmed — workspace descriptions
        // legitimately carry leading whitespace for formatting.
        const trimmedName = parsed.name?.trim();

        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Preflight `workspaces(ids:)` read to surface the `from`
          // state per provided field. `meta.source: 'live'` — the
          // read fires; workspace metadata isn't cached in v0.2.
          const preflight = await client.raw<unknown>(
            WORKSPACE_UPDATE_PREFLIGHT_QUERY,
            { ids: [parsed.workspaceId] },
            { operationName: 'WorkspaceUpdatePreflight' },
          );
          const preflightData = unwrapOrThrow(
            preflightResponseSchema.safeParse(preflight.data),
            {
              context:
                'Monday returned a malformed WorkspaceUpdatePreflight response',
              details: { workspace_id: parsed.workspaceId },
            },
          );
          const first: unknown = (preflightData.workspaces ?? [])[0];
          if (first === undefined || first === null) {
            throw new ApiError(
              'not_found',
              `Monday returned no workspace for id ${parsed.workspaceId}`,
              { details: { workspace_id: parsed.workspaceId } },
            );
          }
          const current = unwrapOrThrow(
            workspaceUpdateOutputSchema.safeParse(first),
            {
              context: 'Monday returned a malformed workspace payload (preflight)',
              details: { workspace_id: parsed.workspaceId },
            },
          );

          const diff: Record<string, FieldDiff> = {};
          if (trimmedName !== undefined) {
            diff.name = { from: current.name, to: trimmedName };
          }
          if (parsed.kind !== undefined) {
            diff.kind = { from: current.kind, to: parsed.kind };
          }
          if (parsed.description !== undefined) {
            diff.description = {
              from: current.description,
              to: parsed.description,
            };
          }

          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'update_workspace',
                workspace_id: parsed.workspaceId,
                diff,
              },
            ],
            source: 'live',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path. Build the partial `attributes` payload —
        // only set keys for fields the agent explicitly provided so
        // Monday leaves untouched fields alone.
        const attributes: Record<string, unknown> = {};
        if (trimmedName !== undefined) attributes.name = trimmedName;
        if (parsed.kind !== undefined) attributes.kind = parsed.kind;
        if (parsed.description !== undefined) {
          attributes.description = parsed.description;
        }
        // Defensive: the schema's `.refine()` already enforces "at
        // least one of --name / --kind / --description", but if a
        // future regression bypassed argv-parse the empty `attributes`
        // would surface as a Monday-side validation error — surface
        // it as `usage_error` so the failure mode stays consistent.
        /* c8 ignore next 6 */
        if (Object.keys(attributes).length === 0) {
          throw new UsageError(
            'workspace update requires at least one of --name / --kind / --description',
            { details: { workspace_id: parsed.workspaceId } },
          );
        }

        const response = await client.raw<unknown>(
          UPDATE_WORKSPACE_MUTATION,
          { id: parsed.workspaceId, attributes },
          { operationName: 'WorkspaceUpdate' },
        );
        const data = unwrapOrThrow(
          liveResponseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed WorkspaceUpdate response',
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
        // internal_error) from "value null" (workspace missing →
        // not_found via projectUpdatedWorkspace). M14 workspace verbs
        // were missed by the initial R42 sweep (the §22 sites list
        // jumped M13 → M15); folded in here.
        assertResponseFieldPresent({
          data,
          key: 'update_workspace',
          operationLabel: 'WorkspaceUpdate',
          details: { workspace_id: parsed.workspaceId },
          nullHandling: 'caller_handles',
        });
        const projected = projectUpdatedWorkspace(
          data.update_workspace,
          parsed.workspaceId,
        );

        emitMutation({
          ctx,
          data: projected,
          schema: workspaceUpdateCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};

const projectUpdatedWorkspace = (
  raw: unknown,
  workspaceId: string,
): WorkspaceUpdateOutput => {
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no workspace payload from update_workspace for id ${workspaceId}`,
      { details: { workspace_id: workspaceId } },
    );
  }
  return unwrapOrThrow(
    workspaceUpdateOutputSchema.safeParse(raw),
    {
      context: `Monday returned a malformed workspace payload for id ${workspaceId}`,
      details: { workspace_id: workspaceId },
    },
  );
};
