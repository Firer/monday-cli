/**
 * `monday board delete <bid> --yes [--dry-run]` — delete a board
 * (`cli-design.md` §4.3 line 705, `v0.2-plan.md` §3 M15).
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §10.2). `--yes` is
 * mandatory for the live path; without `--yes` (and without
 * `--dry-run`) the command fails fast with `confirmation_required`
 * (exit 1) carrying `details.board_id`. Same shape — and same
 * gate-before-`resolveClient()` ordering — as `item delete` /
 * `workspace delete` / `update delete`. R29 helper count: 6 → 7
 * (board delete is the 7th consumer of `enforceDestructiveGate`).
 *
 * **Wire shape.** Single round-trip via `delete_board(board_id:
 * ID!)`. Monday returns the deleted `Board` so the envelope's
 * `data` is the full projection. A null result surfaces as
 * `not_found` — the standard "id was bogus / already deleted"
 * mapping.
 *
 * **Dry-run shape** per cli-design §6.4 board-delete variant:
 * minimal `{operation: "delete_board", board_id}`. No preflight
 * read fires; the dry-run is purely argv-derived. `meta.source:
 * 'none'`. Same shape (modulo `board_id`) as `workspace delete` —
 * the destructive-no-read pattern is uniform across `item delete`
 * / `update delete` / `workspace delete` / `board delete`.
 *
 * **Note on board archive vs board delete divergence.** Archive
 * carries the source snapshot (mirroring item-archive's
 * recoverability-aware shape — soft, reversible-via-30-day-window),
 * delete is minimal (mirroring workspace-delete's destructive-no-
 * read shape — hard, irrecoverable past Monday's 30-day window).
 * Both patterns are preserved.
 *
 * **Idempotent: false.** Re-running surfaces `not_found` past the
 * first call. Mirrors `item delete` / `update delete` / `workspace
 * delete` rationale — agents can't safely retry without verifying
 * the id still names the same record.
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
import {
  BOARD_FIELDS_FRAGMENT,
  boardProjectionSchema,
  type BoardProjection,
} from '../../api/board-projection.js';
import { projectMutationBoard } from '../../api/board-mutation-result.js';

const DELETE_BOARD_MUTATION = `
  mutation BoardDelete($boardId: ID!) {
    delete_board(board_id: $boardId) {
      ${BOARD_FIELDS_FRAGMENT}
    }
  }
`;

export const boardDeleteOutputSchema = boardProjectionSchema;
export type BoardDeleteOutput = BoardProjection;

const inputSchema = z.object({ boardId: BoardIdSchema }).strict();

const responseSchema = z
  .object({
    delete_board: z.unknown(),
  })
  .loose();

export const boardDeleteCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardDeleteOutput
> = {
  name: 'board.delete',
  summary: 'Delete a board — --yes required',
  examples: [
    'monday board delete 12345 --yes',
    'monday board delete 12345 --dry-run',
    'monday board delete 12345 --yes --json',
  ],
  // Re-deleting an already-deleted board surfaces `not_found`. Same
  // rationale as workspace delete — agents can't safely retry
  // without verifying the id still names the same record.
  idempotent: false,
  inputSchema,
  outputSchema: boardDeleteOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('delete <boardId>')
      .description(boardDeleteCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardDeleteCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown) => {
        const parsed = parseArgv(boardDeleteCommand.inputSchema, { boardId });

        // Gate fires BEFORE resolveClient() so a missing --yes
        // surfaces as confirmation_required, not config_error
        // (M10 round-1 P2 ordering invariant; R29 helper preserves
        // it via already-parsed globalFlags).
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        enforceDestructiveGate({
          globalFlags,
          verb: 'board delete',
          target: parsed.boardId,
          detailKey: 'board_id',
          action: 'delete the board',
          hint:
            'delete is destructive — Monday retains deleted boards ' +
            'in the trash for ~30 days but exposes no restore ' +
            'mutation; agents needing reversal must recreate via ' +
            '`monday board create` (lossy: new id, no items / columns ' +
            '/ groups / subscribers state).',
        });

        if (globalFlags.dryRun) {
          // Minimal dry-run shape per §6.4 board-delete variant —
          // no preflight read; meta.source: 'none'. Live surfaces
          // not_found for bogus ids on its own.
          const { apiVersion } = resolveClient(ctx, program.opts());
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'delete_board',
                board_id: parsed.boardId,
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
          DELETE_BOARD_MUTATION,
          { boardId: parsed.boardId },
          { operationName: 'BoardDelete' },
        );
        const data = unwrapOrThrow(
          responseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed BoardDelete response',
            details: { board_id: parsed.boardId },
            hint:
              'this is a data-integrity error in Monday\'s response; ' +
              'verify the response shape and update responseSchema if ' +
              'Monday\'s contract has changed.',
          },
        );
        // Distinguish missing-root-key (schema-drift →
        // internal_error) from null payload (board missing →
        // not_found). M14 round-2 / round-3 distinction landed
        // proactively for M15.
        if (!('delete_board' in data)) {
          throw new ApiError(
            'internal_error',
            `Monday's BoardDelete response is missing the delete_board root field`,
            {
              details: {
                board_id: parsed.boardId,
                hint:
                  'this is a schema-drift error in Monday\'s GraphQL ' +
                  'response; verify the mutation declaration and update ' +
                  'the response schema if Monday\'s contract has changed.',
              },
            },
          );
        }
        // R43 lift (api/board-mutation-result.ts): null-payload
        // guard + projection. Delete's null path uses `not_found`
        // (Monday's "id was bogus / already deleted" mapping) per
        // M14 round-2 / round-3 missing-root vs null distinction.
        const projected = projectMutationBoard({
          raw: data.delete_board,
          errorCode: 'not_found',
          errorMessage: `Monday returned no board payload from delete_board for id ${parsed.boardId}`,
          detailKey: 'board_id',
          detailValue: parsed.boardId,
        });

        emitMutation({
          ctx,
          data: projected,
          schema: boardDeleteCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
