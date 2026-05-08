/**
 * `monday board group-delete <bid> <gid> --yes [--dry-run]` —
 * delete a group from a board (`cli-design.md` §4.3 line 1506,
 * `v0.2-plan.md` §3 M17).
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §10.2). `--yes` is
 * mandatory for the live path; without `--yes` AND without
 * `--dry-run` the command fails fast with `confirmation_required`
 * (exit 1) carrying `details.{board_id, group_id, hint}` per
 * cli-design §6.5 single-target shape — the wire signature
 * (`delete_group(board_id, group_id)`) is two-tuple, so both ids
 * echo. Same gate-before-`resolveClient()` ordering as `item
 * delete` / `workspace delete` / `board delete` / `column-delete`
 * / `group-archive`. R29 helper count: 9 → 10 (group-delete is the
 * 10th consumer of `enforceDestructiveGate`); 3rd two-tuple
 * `extraDetails` consumer after column-delete + group-archive.
 *
 * **`--dry-run` bypasses the confirmation gate** per cli-design
 * §3.1 #7 — dry-run is non-executing and the gate is for live
 * destructive writes only. `group-delete <bid> <gid> --dry-run`
 * without `--yes` emits the dry-run envelope with `meta.source:
 * 'none'`, matching `item delete` / `update delete` / `workspace
 * delete` / `board delete` / `column-delete` precedent.
 *
 * **Wire shape.** Single round-trip via `delete_group(board_id,
 * group_id)` per SDK 14.0.0 `MutationDelete_GroupArgs`. Monday
 * returns `Maybe<Group>` (the group's last-look projection before
 * deletion). A null result surfaces as `not_found` — the standard
 * "id was bogus / already deleted" mapping.
 *
 * **Dry-run shape** per cli-design §6.4 group-delete variant:
 * minimal `{operation: "delete_group", board_id, group_id}`. No
 * preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`. Mirrors the destructive-no-read pattern
 * uniform across `item delete` / `update delete` / `workspace
 * delete` / `board delete` / M16 `column-delete`. Note the
 * deliberate divergence from `group-archive`'s snapshot-bearing
 * dry-run shape: archive carries the source snapshot
 * (item-archive / board-archive precedent — recoverable
 * destructive; preview shows what will be hidden), delete is
 * minimal (workspace-delete / board-delete / column-delete
 * precedent — irrecoverable destructive past Monday's retention
 * window; the agent already knows what they're deleting).
 *
 * **Eager invalidation** (cli-design §8 single-leg call-site
 * contract). On success, calls `invalidateBoard(boardId)` AFTER
 * the success envelope's `data` projection completes; ordered
 * BEFORE `emitMutation` so a cache-unlink failure surfaces
 * through the runner's catch-all. Skipped on the error path.
 * Required because the deleted group must drop from the cached
 * `groups: [...]` list; without invalidation a same-process
 * `board describe` / `monday board groups <bid>` would surface a
 * phantom group until TTL eviction.
 *
 * **Idempotent: false.** Re-deleting an already-deleted group
 * surfaces `not_found` past the first call — the wire-level
 * converges, but the CLI-level surfaces a different envelope.
 * Mirrors `item delete` / `update delete` / `workspace delete` /
 * `board delete` / `column-delete` rationale.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, GroupIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { enforceDestructiveGate } from '../../api/destructive-gate.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { withBoardInvalidationSingleLeg } from '../../api/board-mutation-invalidation.js';
import {
  GROUP_FIELDS_FRAGMENT,
  groupProjectionSchema,
  projectMutationGroup,
  type GroupProjection,
} from '../../api/group-mutation-result.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';

const DELETE_GROUP_MUTATION = `
  mutation GroupDelete($boardId: ID!, $groupId: String!) {
    delete_group(board_id: $boardId, group_id: $groupId) {
      ${GROUP_FIELDS_FRAGMENT}
    }
  }
`;

export const boardGroupDeleteOutputSchema = groupProjectionSchema;
export type BoardGroupDeleteOutput = GroupProjection;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    groupId: GroupIdSchema,
  })
  .strict();

const responseSchema = z
  .object({
    delete_group: z.unknown(),
  })
  .loose();

export const boardGroupDeleteCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardGroupDeleteOutput
> = {
  name: 'board.group-delete',
  summary: 'Delete a group from a board — --yes required',
  examples: [
    'monday board group-delete 12345 topics --yes',
    'monday board group-delete 12345 topics --dry-run',
    'monday board group-delete 12345 topics --yes --json',
  ],
  // Re-deleting an already-deleted group surfaces not_found —
  // same rationale as workspace / board / update / item / column
  // delete.
  idempotent: false,
  inputSchema,
  outputSchema: boardGroupDeleteOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('group-delete <boardId> <groupId>')
      .description(boardGroupDeleteCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardGroupDeleteCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, groupId: unknown) => {
        const parsed = parseArgv(boardGroupDeleteCommand.inputSchema, {
          boardId,
          groupId,
        });

        // Gate fires BEFORE resolveClient() so a missing --yes
        // surfaces as confirmation_required, not config_error
        // (M10 round-1 P2 ordering invariant; R29 helper preserves
        // it via already-parsed globalFlags). The two-tuple wire
        // signature carries both ids in the confirmation envelope
        // per cli-design §6.5: `extraDetails: {board_id}` rides
        // alongside the canonical `group_id` detailKey.
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        enforceDestructiveGate({
          globalFlags,
          verb: 'board group-delete',
          target: parsed.groupId,
          detailKey: 'group_id',
          extraDetails: { board_id: parsed.boardId },
          action: `delete group ${parsed.groupId} from board ${parsed.boardId}`,
          hint:
            'delete is destructive — Monday retains deleted groups ' +
            'past their retention window; pass `--dry-run` first to ' +
            'preview, or use `monday board group-archive` for a ' +
            'recoverable hide (cli-design §4.3 group-delete + §8 ' +
            'decision 9).',
        });

        if (globalFlags.dryRun) {
          // Minimal dry-run shape per §6.4 group-delete variant —
          // no preflight read; meta.source: 'none'. Live surfaces
          // not_found for bogus ids on its own.
          const { apiVersion } = resolveClient(ctx, program.opts());
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'delete_group',
                board_id: parsed.boardId,
                group_id: parsed.groupId,
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

        // §8 single-leg call-site contract via `withBoardInvalidation
        // SingleLeg` (R46): invalidate AFTER the closure returns
        // (i.e. after `data` projection completes), BEFORE
        // emitMutation so a cache-unlink failure surfaces through
        // the runner's catch-all. The closure's throws on schema
        // drift / null payload bypass invalidation — a failed call
        // didn't change board state.
        const { data: projected, response } = await withBoardInvalidationSingleLeg({
          boardId: parsed.boardId,
          env: ctx.env,
          perform: async () => {
            const wireResponse = await client.raw<unknown>(
              DELETE_GROUP_MUTATION,
              { boardId: parsed.boardId, groupId: parsed.groupId },
              { operationName: 'GroupDelete' },
            );
            const data = unwrapOrThrow(
              responseSchema.safeParse(wireResponse.data),
              {
                context: 'Monday returned a malformed GroupDelete response',
                details: { board_id: parsed.boardId, group_id: parsed.groupId },
                hint:
                  "this is a data-integrity error in Monday's response; " +
                  'verify the response shape and update responseSchema if ' +
                  "Monday's contract has changed.",
              },
            );
            // R42: consolidate the inline missing-key check.
            assertResponseFieldPresent({
              data,
              key: 'delete_group',
              operationLabel: 'GroupDelete',
              details: {
                board_id: parsed.boardId,
                group_id: parsed.groupId,
              },
              nullHandling: 'caller_handles',
            });
            // R48 lift: null-payload guard + projection. Delete's
            // null path uses `not_found` (Monday's "id was bogus /
            // already deleted" mapping).
            const projection = projectMutationGroup({
              raw: data.delete_group,
              errorCode: 'not_found',
              errorMessage: `Monday returned no group payload from delete_group for board ${parsed.boardId} group ${parsed.groupId}`,
              boardId: parsed.boardId,
              idKey: 'group_id',
              idValue: parsed.groupId,
            });
            return { data: projection, response: wireResponse };
          },
        });

        emitMutation({
          ctx,
          data: projected,
          schema: boardGroupDeleteCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
