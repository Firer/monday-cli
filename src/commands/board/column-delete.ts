/**
 * `monday board column-delete <bid> <cid> --yes [--dry-run]` — delete
 * a column on a board (`cli-design.md` §4.3 line 1098, `v0.2-plan.md`
 * §3 M16).
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §10.2). `--yes` is
 * mandatory for the live path; without `--yes` AND without
 * `--dry-run` the command fails fast with `confirmation_required`
 * (exit 1) carrying `details.{board_id, column_id, hint}` per
 * cli-design §6.5 single-target shape — the wire signature
 * (`delete_column(board_id, column_id)`) is two-tuple, so both ids
 * echo. Same gate-before-`resolveClient()` ordering as `item delete`
 * / `workspace delete` / `board delete`. R29 helper count: 7 → 8
 * (column-delete is the 8th consumer of `enforceDestructiveGate`,
 * the first to use the new `extraDetails` slot for two-tuple
 * destructive verbs).
 *
 * **`--dry-run` bypasses the confirmation gate** per cli-design §3.1
 * #7 — dry-run is non-executing and the gate is for live destructive
 * writes only. `column-delete <bid> <cid> --dry-run` without
 * `--yes` emits the dry-run envelope with `meta.source: 'none'`,
 * matching `item delete` / `update delete` / `workspace delete` /
 * `board delete` precedent.
 *
 * **Wire shape.** Single round-trip via `delete_column(board_id,
 * column_id)`. Monday returns `Maybe<Column>` (the column's last-
 * look projection before deletion). A null result surfaces as
 * `not_found` — the standard "id was bogus / already deleted"
 * mapping.
 *
 * **Dry-run shape** per cli-design §6.4 column-delete variant:
 * minimal `{operation: "delete_column", board_id, column_id}`. No
 * preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`. Mirrors the destructive-no-read pattern
 * uniform across `item delete` / `update delete` / `workspace
 * delete` / `board delete`.
 *
 * **Eager invalidation** (cli-design §8 single-leg call-site
 * contract). On success, calls `invalidateBoard(boardId)` AFTER the
 * success envelope's `data` projection completes; ordered BEFORE
 * `emitMutation` so a cache-unlink failure surfaces through the
 * runner's catch-all rather than double-emitting after a success
 * envelope hit stdout. Skipped on the error path (a failed call
 * didn't change board state).
 *
 * **Idempotent: false.** Re-deleting an already-deleted column
 * surfaces `not_found` past the first call — the wire-level
 * converges, but the CLI-level surfaces a different envelope.
 * Mirrors `item delete` / `update delete` / `workspace delete` /
 * `board delete` rationale.
 *
 * **Note on column-archive divergence.** Monday's API has no
 * `archive_column` mutation — column lifecycle is delete-only,
 * mirroring the underlying API surface. The CLI doesn't surface
 * a `column-archive` verb (cli-design §4.3 column-delete line ~1166).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { ApiError } from '../../utils/errors.js';
import { enforceDestructiveGate } from '../../api/destructive-gate.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { invalidateBoard } from '../../api/cache.js';
import {
  COLUMN_FIELDS_FRAGMENT,
  columnProjectionSchema,
  projectMutationColumn,
  type ColumnProjection,
} from '../../api/column-mutation-result.js';

const DELETE_COLUMN_MUTATION = `
  mutation ColumnDelete($boardId: ID!, $columnId: String!) {
    delete_column(board_id: $boardId, column_id: $columnId) {
      ${COLUMN_FIELDS_FRAGMENT}
    }
  }
`;

export const boardColumnDeleteOutputSchema = columnProjectionSchema;
export type BoardColumnDeleteOutput = ColumnProjection;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    // Column ids are non-numeric strings (e.g. `status_4`,
    // `text__1`); required-non-empty so an empty positional
    // surfaces usage_error at the boundary.
    columnId: z.string().min(1, { message: '<columnId> must be non-empty' }),
  })
  .strict();

const responseSchema = z
  .object({
    delete_column: z.unknown(),
  })
  .loose();

export const boardColumnDeleteCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardColumnDeleteOutput
> = {
  name: 'board.column-delete',
  summary: 'Delete a column from a board — --yes required',
  examples: [
    'monday board column-delete 12345 status_4 --yes',
    'monday board column-delete 12345 status_4 --dry-run',
    'monday board column-delete 12345 status_4 --yes --json',
  ],
  // Re-deleting an already-deleted column surfaces not_found — same
  // rationale as workspace / board / update / item delete.
  idempotent: false,
  inputSchema,
  outputSchema: boardColumnDeleteOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('column-delete <boardId> <columnId>')
      .description(boardColumnDeleteCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardColumnDeleteCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, columnId: unknown) => {
        const parsed = parseArgv(boardColumnDeleteCommand.inputSchema, {
          boardId,
          columnId,
        });

        // Gate fires BEFORE resolveClient() so a missing --yes
        // surfaces as confirmation_required, not config_error
        // (M10 round-1 P2 ordering invariant; R29 helper preserves
        // it via already-parsed globalFlags). The two-tuple wire
        // signature carries both ids in the confirmation envelope
        // per cli-design §6.5: `extraDetails: {board_id}` rides
        // alongside the canonical `column_id` detailKey so agents
        // see both ids without re-parsing argv.
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        enforceDestructiveGate({
          globalFlags,
          verb: 'board column-delete',
          target: parsed.columnId,
          detailKey: 'column_id',
          extraDetails: { board_id: parsed.boardId },
          action: `delete column ${parsed.columnId} from board ${parsed.boardId}`,
          hint:
            'delete is destructive — Monday has no archive_column / ' +
            'restore_column mutation, so column lifecycle is delete-only ' +
            '(cli-design §4.3 column-delete + §8 decision 9). Re-creating ' +
            'a column with the same title yields a fresh id; existing item ' +
            'values for the old column are not migrated.',
        });

        if (globalFlags.dryRun) {
          // Minimal dry-run shape per §6.4 column-delete variant —
          // no preflight read; meta.source: 'none'. Live surfaces
          // not_found for bogus ids on its own.
          const { apiVersion } = resolveClient(ctx, program.opts());
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'delete_column',
                board_id: parsed.boardId,
                column_id: parsed.columnId,
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
          DELETE_COLUMN_MUTATION,
          { boardId: parsed.boardId, columnId: parsed.columnId },
          { operationName: 'ColumnDelete' },
        );
        const data = unwrapOrThrow(
          responseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed ColumnDelete response',
            details: { board_id: parsed.boardId, column_id: parsed.columnId },
            hint:
              "this is a data-integrity error in Monday's response; " +
              'verify the response shape and update responseSchema if ' +
              "Monday's contract has changed.",
          },
        );
        // Distinguish missing-root-key (schema-drift → internal_error)
        // from null payload (column missing → not_found). Mirrors the
        // M15 board-delete + column-create distinction.
        if (!('delete_column' in data)) {
          throw new ApiError(
            'internal_error',
            `Monday's ColumnDelete response is missing the delete_column root field`,
            {
              details: {
                board_id: parsed.boardId,
                column_id: parsed.columnId,
                hint:
                  "this is a schema-drift error in Monday's GraphQL " +
                  'response; verify the mutation declaration and update ' +
                  "the response schema if Monday's contract has changed.",
              },
            },
          );
        }
        // R45 lift: null-payload guard + projection. Delete's null
        // path uses `not_found` (Monday's "id was bogus / already
        // deleted" mapping) per the column-update / column-delete
        // R45 mapping.
        const projected = projectMutationColumn({
          raw: data.delete_column,
          errorCode: 'not_found',
          errorMessage: `Monday returned no column payload from delete_column for board ${parsed.boardId} column ${parsed.columnId}`,
          boardId: parsed.boardId,
          columnIdKey: 'column_id',
          columnIdValue: parsed.columnId,
        });

        // Eager invalidation per §8 single-leg call-site contract:
        // AFTER `data` projection completes, BEFORE the function
        // returns. Skipped on the error path (the throws above
        // bypass this line). Ordered BEFORE emitMutation so a
        // cache-unlink failure surfaces through the runner's catch-
        // all rather than double-emitting after a success envelope
        // hit stdout. Idempotent — invalidating an already-absent
        // entry is a no-op.
        await invalidateBoard(parsed.boardId, ctx.env);

        emitMutation({
          ctx,
          data: projected,
          schema: boardColumnDeleteCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
