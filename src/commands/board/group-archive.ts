/**
 * `monday board group-archive <bid> <gid> --yes [--dry-run]` —
 * archive a group on a board (`cli-design.md` §4.3 line 1359,
 * `v0.2-plan.md` §3 M17).
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §8 decision 9: archive
 * is consistently `--yes`-gated across nouns: item / board / M17
 * group). Mirrors `board archive` shape — gate fires BEFORE
 * `resolveClient()` so a missing `--yes` always surfaces as
 * `confirmation_required`, never masked by a `config_error` from
 * `loadConfig()`'s missing-token check (M10 round-1 P2 ordering
 * invariant; R29's `assertConfirmation` helper preserves it via
 * already-parsed `globalFlags`). The `confirmation_required`
 * envelope carries the single-target destructive-gate `details`
 * shape per §6.5: `{board_id, group_id, hint}` — group-archive's
 * wire signature is two-tuple, so both ids echo via R29's
 * `extraDetails` slot. R29 helper count: 8 → 9 (item archive /
 * item delete / update delete / update clear-all / workspace delete
 * / board archive / board delete / column-delete / group-archive);
 * 2nd two-tuple `extraDetails` consumer after M16 column-delete.
 *
 * **`--dry-run` bypasses the confirmation gate** per cli-design
 * §3.1 #7 — dry-run is non-executing and the gate is for live
 * destructive writes only. Mirrors `item archive` / `item delete` /
 * `board archive` / `board delete` / M16 column-delete precedent.
 *
 * **Wire shape.** Single round-trip via `archive_group(board_id,
 * group_id)` per SDK 14.0.0 `MutationArchive_GroupArgs`. Monday's
 * `archive_group` returns `Maybe<Group>` (the group's last-look
 * projection before archive — Monday convention). A null result
 * surfaces as `not_found`.
 *
 * **Dry-run shape** per cli-design §6.4 group-archive variant:
 * `{operation: "archive_group", board_id, group_id, group:
 * <projected source snapshot>}`. The preflight read goes through
 * `loadBoardMetadata` so cache hits are observable; `meta.source:
 * 'live' | 'cache'`. The cached `boardMetadataSchema.groups[*]`
 * projection covers the full Group metadata field set (`{id,
 * title, color, position, archived, deleted}` — every Group field
 * except `items_page`), so the snapshot carries every field agents
 * need for "preview before archive" without requiring a separate
 * read query. Mirrors `board archive`'s snapshot-bearing shape;
 * diverges from `column-delete` / `board-delete` / `group-delete`'s
 * destructive-no-read minimal shape.
 *
 * **Cache-staleness caveat.** Cache-sourced snapshots may lag live
 * state up to TTL — pass `--no-cache` for a force-live preview
 * when freshness is critical (e.g. archiving after a recent rename
 * or color change).
 *
 * **Eager invalidation** (cli-design §8 single-leg call-site
 * contract). On success, calls `invalidateBoard(boardId)` AFTER
 * the success envelope's `data` projection completes; ordered
 * BEFORE `emitMutation` so a cache-unlink failure surfaces through
 * the runner's catch-all. Skipped on the error path (a failed call
 * didn't change board state). Required because archive flips the
 * cached `groups[*].archived` field false → true; without
 * invalidation a same-process `board describe` would return stale
 * archived state until TTL eviction.
 *
 * **Idempotent: true.** Re-archiving an already-archived group is
 * a no-op on Monday's side (per §9.1 idempotency table — same row
 * that covers `archive_item` / `archive_board`).
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
import { findBoardChildOrThrow } from '../../api/board-child-finder.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';
import {
  GROUP_FIELDS_FRAGMENT,
  groupProjectionSchema,
  projectMutationGroup,
  type GroupProjection,
} from '../../api/group-mutation-result.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';

const ARCHIVE_GROUP_MUTATION = `
  mutation GroupArchive($boardId: ID!, $groupId: String!) {
    archive_group(board_id: $boardId, group_id: $groupId) {
      ${GROUP_FIELDS_FRAGMENT}
    }
  }
`;

export const boardGroupArchiveOutputSchema = groupProjectionSchema;
export type BoardGroupArchiveOutput = GroupProjection;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    groupId: GroupIdSchema,
  })
  .strict();

const responseSchema = z
  .object({
    archive_group: z.unknown(),
  })
  .loose();

export const boardGroupArchiveCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardGroupArchiveOutput
> = {
  name: 'board.group-archive',
  summary: 'Archive a group on a board (--yes required)',
  examples: [
    'monday board group-archive 12345 topics --yes',
    'monday board group-archive 12345 topics --dry-run',
    'monday board group-archive 12345 topics --yes --json',
  ],
  // Re-archiving an already-archived group is a no-op on Monday's
  // side per cli-design §9.1; safe to retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: boardGroupArchiveOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board');
    noun
      .command('group-archive <boardId> <groupId>')
      .description(boardGroupArchiveCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardGroupArchiveCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, groupId: unknown) => {
        const parsed = parseArgv(boardGroupArchiveCommand.inputSchema, {
          boardId,
          groupId,
        });

        // Gate fires BEFORE resolveClient() so a missing --yes
        // surfaces as confirmation_required, not config_error
        // (M10 round-1 P2 ordering invariant; R29 helper preserves
        // it via already-parsed globalFlags). The two-tuple wire
        // signature carries both ids in the confirmation envelope
        // per cli-design §6.5: `extraDetails: {board_id}` rides
        // alongside the canonical `group_id` detailKey so agents
        // see both ids without re-parsing argv.
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        enforceDestructiveGate({
          globalFlags,
          verb: 'board group-archive',
          target: parsed.groupId,
          detailKey: 'group_id',
          extraDetails: { board_id: parsed.boardId },
          action: `archive group ${parsed.groupId} on board ${parsed.boardId}`,
          hint:
            'archive is destructive — Monday retains archived ' +
            'groups but exposes no unarchive_group mutation ' +
            '(cli-design §5.4 + §8 decision 9). The archived ' +
            'group becomes invisible to default reads; pass ' +
            '`--include-archived` to surface it again.',
        });

        const { client, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Preflight read via loadBoardMetadata so the v0.1
          // board-metadata cache can serve fresh entries.
          // loadBoardMetadata throws ApiError(not_found) when the
          // board is absent; bubbles to the runner's catch-all.
          const preflight = await loadBoardMetadata({
            client,
            boardId: parsed.boardId,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          // R51 lift — `findBoardChildOrThrow` consolidates the
          // board-level read succeeded but the group ID isn't on
          // the board → not_found-with-details.group_id carve-out
          // shared with `column-update` + `group-update`.
          const current = findBoardChildOrThrow({
            metadata: preflight.metadata,
            kind: 'groups',
            id: parsed.groupId,
            boardId: parsed.boardId,
          });
          // Project to the GroupProjection shape — the cached
          // `boardMetadataSchema.groups[*]` is byte-identical with
          // `groupProjectionSchema`'s field set, so a direct copy
          // is canonical.
          const snapshot: GroupProjection = {
            id: current.id,
            title: current.title,
            color: current.color,
            position: current.position,
            archived: current.archived,
            deleted: current.deleted,
          };
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'archive_group',
                board_id: parsed.boardId,
                group_id: parsed.groupId,
                group: snapshot,
              },
            ],
            source: preflight.source,
            cacheAgeSeconds: preflight.cacheAgeSeconds,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path. archive_group returns the archived Group's
        // last-look projection directly; no preflight read needed.
        //
        // §8 single-leg call-site contract via `withBoardInvalidation
        // SingleLeg` (R46): the helper invalidates AFTER the closure
        // returns (i.e. after `data` projection completes), BEFORE
        // emitMutation so a cache-unlink failure surfaces through
        // the runner's catch-all. The closure's throws on schema
        // drift / null payload bypass invalidation. Required
        // because archive flips the cached `groups[*].archived`
        // field false → true; without invalidation a same-process
        // `board describe` would return stale archived state until
        // TTL eviction.
        const { data: projected, response } = await withBoardInvalidationSingleLeg({
          boardId: parsed.boardId,
          env: ctx.env,
          perform: async () => {
            const wireResponse = await client.raw<unknown>(
              ARCHIVE_GROUP_MUTATION,
              { boardId: parsed.boardId, groupId: parsed.groupId },
              { operationName: 'GroupArchive' },
            );
            const data = unwrapOrThrow(
              responseSchema.safeParse(wireResponse.data),
              {
                context: 'Monday returned a malformed GroupArchive response',
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
              key: 'archive_group',
              operationLabel: 'GroupArchive',
              details: {
                board_id: parsed.boardId,
                group_id: parsed.groupId,
              },
              nullHandling: 'caller_handles',
            });
            // R48 lift: null-payload guard + projection. Archive's
            // null path uses `not_found` (Monday's idiomatic
            // missing-or-no-access response) per the M15 board-
            // archive precedent.
            const projection = projectMutationGroup({
              raw: data.archive_group,
              errorCode: 'not_found',
              errorMessage: `Monday returned no group payload from archive_group for board ${parsed.boardId} group ${parsed.groupId}`,
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
          schema: boardGroupArchiveCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
