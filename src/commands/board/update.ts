/**
 * `monday board update <bid> [--name <n>] [--description <d>]
 * [--dry-run]` — change one or more board fields
 * (`cli-design.md` §4.3 line 631, `v0.2-plan.md` §3 M15).
 *
 * **Wire shape — divergence from `update_workspace`.** Monday's
 * `update_board(board_id, board_attribute: BoardAttributes!,
 * new_value: String!)` is **per-attribute** — each wire call
 * updates exactly one field. The CLI fans out one wire call per
 * provided flag: `board update <bid> --name X --description Y`
 * fires two sequential `update_board` calls. Sequential per §8
 * decision 8 (parallel waits for v0.4 `--concurrency`).
 *
 * **Whole-call envelope — no partial-success leak.** The envelope
 * is `ok: true` only when EVERY per-field call succeeded; on any
 * per-field failure the envelope is `ok: false` with the failed
 * call's error code. This matches `update_workspace`'s single-
 * mutation surface from M14 — agents see a uniform "all fields
 * applied or the call failed" envelope shape regardless of how
 * many wire calls fired underneath.
 *
 * **Live-path partial-application caveat.** Server-side state is
 * NOT transactional across per-attribute mutations: if call #1
 * succeeds and call #2 fails, fields from #1 stay committed
 * server-side and are not rolled back. Agents re-issuing after
 * failure should re-read the board to see what landed before
 * retrying the unapplied tail.
 *
 * **Force-live final read.** The post-mutation `boards(ids:)`
 * read MUST bypass the v0.1 board-metadata cache — pre-flight
 * Codex round-2 F2 pinned this as load-bearing for the success
 * envelope (a cached read could surface stale `data.name`
 * post-update). The CLI fires the read via `client.raw` directly
 * rather than `loadBoardMetadata`, which keeps it always-live;
 * `meta.source: 'live'` for the live success path. M16's eager-
 * invalidation contract will additionally invalidate the cache
 * entry post-success so subsequent commands also see fresh state.
 *
 * **Argv discipline.** At least one of `--name` / `--description`
 * is required — zero-flag invocation surfaces as `usage_error`
 * (exit 1) at argv-parse, before any network leg. Mirrors
 * `workspace update`'s "at least one of --name / --kind /
 * --description required" rule.
 *
 * **Dry-run shape** per cli-design §6.4 board-update variant: a
 * field-level `from → to` diff per provided field. The `from`
 * state requires a preflight `board get` read — routed through
 * `loadBoardMetadata` so cache hits are observable;
 * `meta.source: 'live' | 'cache'`. When the board doesn't exist,
 * the preflight surfaces `not_found` (exit 2). Cache-staleness
 * caveat: the `from` snapshot may lag live state up to the cache
 * TTL; pass `--no-cache` for a force-live preflight when preview
 * freshness is critical.
 *
 * **Idempotent: yes.** Re-applying the same field values is a
 * no-op on Monday's side. NOT destructive (no `--yes` gate).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { withBoardInvalidationFanOut } from '../../api/board-mutation-invalidation.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';
import {
  BOARD_FIELDS_FRAGMENT,
  boardProjectionSchema,
  type BoardProjection,
} from '../../api/board-projection.js';
import { projectMutationBoard } from '../../api/board-mutation-result.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';

const UPDATE_BOARD_MUTATION = `
  mutation BoardUpdate(
    $boardId: ID!,
    $boardAttribute: BoardAttributes!,
    $newValue: String!
  ) {
    update_board(
      board_id: $boardId,
      board_attribute: $boardAttribute,
      new_value: $newValue
    )
  }
`;

const BOARD_FINAL_READ_QUERY = `
  query BoardUpdateFinalRead($ids: [ID!]) {
    boards(ids: $ids) {
      ${BOARD_FIELDS_FRAGMENT}
    }
  }
`;

export const boardUpdateOutputSchema = boardProjectionSchema;

export type BoardUpdateOutput = BoardProjection;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    name: z
      .string()
      .refine((s) => s.trim().length > 0, {
        message: '--name must be non-empty (whitespace-only is rejected)',
      })
      .optional(),
    description: z.string().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'board update requires at least one of --name / --description',
  });

const updateMutationResponseSchema = z
  .object({
    update_board: z.unknown(),
  })
  .loose();

const finalReadResponseSchema = z
  .object({
    boards: z.array(z.unknown()).nullable().optional(),
  })
  .loose();

interface FieldDiff {
  readonly from: unknown;
  readonly to: unknown;
}

// Deterministic dispatch order: name first, then description. The
// iteration order isn't observable on success (single envelope) but
// IS observable on partial-application failure (server-side state
// shows fields applied in order before the failure). Pinning the
// order makes failure-recovery testable.
const FIELD_DISPATCH_ORDER = ['name', 'description'] as const;

export const boardUpdateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardUpdateOutput
> = {
  name: 'board.update',
  summary: 'Update one or more fields of a board',
  examples: [
    'monday board update 12345 --name "Engineering — EU"',
    'monday board update 12345 --description "EU team board"',
    'monday board update 12345 --name "Renamed" --description "Updated"',
    'monday board update 12345 --name "Preview" --dry-run --json',
  ],
  // update_board is per-attribute body-replace — re-running with
  // the same values is a server-side no-op. Mark idempotent so
  // agents can retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: boardUpdateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board');
    noun
      .command('update <boardId>')
      .description(boardUpdateCommand.summary)
      .option('--name <n>', 'new board name')
      .option('--description <d>', 'new board description')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardUpdateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardUpdateCommand.inputSchema, {
          boardId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const trimmedName = parsed.name?.trim();

        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Preflight `boards(ids:)` read via loadBoardMetadata so
          // the v0.1 board-metadata cache can serve fresh entries.
          // `meta.source: 'live' | 'cache'`. Cache-staleness caveat:
          // `from` values may lag up to TTL; agents pass
          // `--no-cache` when preview freshness is critical.
          // loadBoardMetadata throws ApiError(not_found) when the
          // board is absent — bubbles up through the runner's
          // catch-all for the dry-run-not-found contract.
          const preflight = await loadBoardMetadata({
            client,
            boardId: parsed.boardId,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          const current = preflight.metadata;

          const diff: Record<string, FieldDiff> = {};
          if (trimmedName !== undefined) {
            diff.name = { from: current.name, to: trimmedName };
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
                operation: 'update_board',
                board_id: parsed.boardId,
                diff,
              },
            ],
            source: preflight.source,
            cacheAgeSeconds: preflight.cacheAgeSeconds,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path. Per-field fan-out: one update_board wire call
        // per provided flag. Sequential per §8 decision 8. Defensive
        // (schema's .refine() already enforces "at least one flag",
        // but if a regression bypassed argv-parse the empty list
        // would emit a confusing zero-call success).
        const dispatchPlan: { attribute: string; value: string }[] = [];
        for (const attribute of FIELD_DISPATCH_ORDER) {
          if (attribute === 'name' && trimmedName !== undefined) {
            dispatchPlan.push({ attribute: 'name', value: trimmedName });
          } else if (
            attribute === 'description' &&
            parsed.description !== undefined
          ) {
            dispatchPlan.push({
              attribute: 'description',
              value: parsed.description,
            });
          }
        }
        /* c8 ignore next 6 */
        if (dispatchPlan.length === 0) {
          throw new UsageError(
            'board update requires at least one of --name / --description',
            { details: { board_id: parsed.boardId } },
          );
        }

        // §8 fan-out call-site contract via `withBoardInvalidation
        // FanOut` (R46): the helper owns the high-water-mark counter
        // and the partial-application invalidation gate; the closure
        // here drives the per-attribute loop + the final force-live
        // read + the projection, calling `recordLegSuccess()` after
        // each successful per-attribute call.
        //
        // The final-read leg lives INSIDE `runFanOut` (matching
        // pre-R46 structure per Codex M16 round-1 F1) so a final-
        // read failure with succeededLegs > 0 still triggers
        // invalidation — the per-attribute mutations already
        // committed server-side state, so the cache must reflect
        // them even if the trailing read couldn't surface the
        // post-update snapshot.
        const { data: projected, response: finalResponse } =
          await withBoardInvalidationFanOut({
            boardId: parsed.boardId,
            env: ctx.env,
            runFanOut: async ({ recordLegSuccess }) => {
              for (const { attribute, value } of dispatchPlan) {
                const response = await client.raw<unknown>(
                  UPDATE_BOARD_MUTATION,
                  {
                    boardId: parsed.boardId,
                    boardAttribute: attribute,
                    newValue: value,
                  },
                  { operationName: 'BoardUpdate' },
                );
                const data = unwrapOrThrow(
                  updateMutationResponseSchema.safeParse(response.data),
                  {
                    context: 'Monday returned a malformed BoardUpdate response',
                    details: {
                      board_id: parsed.boardId,
                      board_attribute: attribute,
                    },
                    hint:
                      'this is a data-integrity error in Monday\'s response; ' +
                      'verify the mutation response shape and update the schema ' +
                      'if Monday\'s contract has changed.',
                  },
                );
                // Distinguish "root key absent" (schema-drift →
                // internal_error) from "value null" (Monday-side
                // failure with no errors[] — Codex M15
                // implementation round-1 F1: a 200 response with
                // `update_board: null` and no errors[] is NOT a
                // per-field success; it's a null-payload failure
                // that must abort the sequence BEFORE the final
                // read fires false-success.
                // R42: consolidate the inline missing-key check onto
                // `assertResponseFieldPresent`. Distinguishes missing-
                // root-key (schema-drift → internal_error) from null
                // payload (handled by the explicit check below per the
                // M15 round-1 F1 abort-the-sequence contract).
                assertResponseFieldPresent({
                  data,
                  key: 'update_board',
                  operationLabel: 'BoardUpdate',
                  details: {
                    board_id: parsed.boardId,
                    board_attribute: attribute,
                  },
                  nullHandling: 'caller_handles',
                });
                if (data.update_board === null || data.update_board === undefined) {
                  throw new ApiError(
                    'internal_error',
                    `Monday's BoardUpdate returned a null update_board payload for board_attribute ${attribute}`,
                    {
                      details: {
                        board_id: parsed.boardId,
                        board_attribute: attribute,
                        hint:
                          'a null payload with no GraphQL errors[] is a server-side ' +
                          'failure path; agents should retry after re-reading the ' +
                          'board to see what landed before this call.',
                      },
                    },
                  );
                }
                void response;
                recordLegSuccess();
              }

              // Final force-live read for the success envelope's
              // `data` slot. `client.raw` doesn't go through the
              // cache, so this always fires fresh — pre-flight
              // Codex round-2 F2 pinned this as load-bearing (a
              // cached read could surface stale post-update name).
              const finalReadResponse = await client.raw<unknown>(
                BOARD_FINAL_READ_QUERY,
                { ids: [parsed.boardId] },
                { operationName: 'BoardUpdateFinalRead' },
              );
              const finalData = unwrapOrThrow(
                finalReadResponseSchema.safeParse(finalReadResponse.data),
                {
                  context:
                    'Monday returned a malformed BoardUpdateFinalRead response',
                  details: { board_id: parsed.boardId },
                },
              );
              const first: unknown = (finalData.boards ?? [])[0];
              // R43 lift (api/board-mutation-result.ts): null-
              // payload guard + projection. Defensive
              // `internal_error` per M14 round-2 / round-3
              // missing-root vs null distinction — per-field calls
              // succeeded but the final read couldn't find the
              // board, so surface contract anomaly rather than a
              // no-op success.
              const finalProjected = projectMutationBoard({
                raw: first,
                errorCode: 'internal_error',
                errorMessage: `Monday returned no board for id ${parsed.boardId} on the final post-update read`,
                detailKey: 'board_id',
                detailValue: parsed.boardId,
              });
              return { data: finalProjected, response: finalReadResponse };
            },
          });

        emitMutation({
          ctx,
          data: projected,
          schema: boardUpdateCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          // Use the final-read response for meta (request_id,
          // complexity) — it's the freshest wire call and reflects
          // the success-path's last interaction with Monday.
          ...toEmit(finalResponse),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
