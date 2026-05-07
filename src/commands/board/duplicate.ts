/**
 * `monday board duplicate <bid> [--name <n>] [--workspace <wid>]
 * [--with-updates] [--dry-run]` — duplicate a board
 * (`cli-design.md` §4.3 line 727, `v0.2-plan.md` §3 M15).
 *
 * **Wire shape.** Single round-trip via `duplicate_board(board_id,
 * duplicate_type: DuplicateBoardType!, board_name?, workspace_id?,
 * folder_id?, keep_subscribers?)`. Returns the M15-unique
 * `BoardDuplication { board, is_async }` SDK type — the only M15
 * verb whose live envelope's `data` wraps because Monday's wire
 * shape carries `is_async`. Per cli-design §6.1 (round-2 F3
 * widening) + §6.4 board-duplicate variant.
 *
 * **`--with-updates` flag mapping.** Selects between Monday's
 * three-armed `DuplicateBoardType` enum: without --with-updates
 * the wire call uses `duplicate_board_with_pulses` (items WITHOUT
 * updates); with --with-updates the wire call uses
 * `duplicate_board_with_pulses_and_updates` (items WITH updates).
 * The third arm (`duplicate_board_with_structure` — skeleton
 * without items) is deferred to a later v0.x; agents needing it
 * use M9's `dev mutate` escape hatch.
 *
 * **`is_async` semantics.** When true, Monday has queued the
 * duplication server-side and the new board may not be fully
 * populated by envelope time. Agents needing to operate on the
 * duplicated items / updates poll `boards(ids: [<new_id>]) {
 * state }` until terminal state. When false, the duplication has
 * fully landed by envelope time and immediate follow-up reads
 * are safe. (cli-design §6.4 board-duplicate live envelope.)
 *
 * **`--workspace` is optional.** Defaults to the source board's
 * workspace; only forwards when the agent provides a value.
 *
 * **`--name` is optional.** Defaults to Monday's server-side
 * "<source name> (Copy)" when omitted.
 *
 * **Dry-run shape** per cli-design §6.4 board-duplicate variant:
 * `{operation: "duplicate_board", board_id, with_updates,
 * target_workspace_id?, target_name?, board: <projected source
 * snapshot>}`. Preflight `board get` read via `loadBoardMetadata`
 * — cache hits observable; `meta.source: 'live' | 'cache'`.
 * Cache-staleness caveat: pass `--no-cache` for force-live
 * preview when freshness matters.
 *
 * **Idempotent: false.** Re-running creates a second copy. NOT
 * destructive (no --yes gate — cli-design §3.1 #7 reserves the
 * gate for destructive verbs). Same shape `monday board create`
 * uses for non-destructive idempotency.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, WorkspaceIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';
import {
  BOARD_FIELDS_FRAGMENT,
  boardProjectionSchema,
} from '../../api/board-projection.js';

const DUPLICATE_BOARD_MUTATION = `
  mutation BoardDuplicate(
    $boardId: ID!,
    $duplicateType: DuplicateBoardType!,
    $boardName: String,
    $workspaceId: ID
  ) {
    duplicate_board(
      board_id: $boardId,
      duplicate_type: $duplicateType,
      board_name: $boardName,
      workspace_id: $workspaceId
    ) {
      board {
        ${BOARD_FIELDS_FRAGMENT}
      }
      is_async
    }
  }
`;

/**
 * The mutation envelope's `data` wraps `BoardDuplication { board,
 * is_async }`. Per cli-design §6.4 board-duplicate variant + §6.1
 * universal envelope widening (round-2 F3) — single-target verbs
 * usually surface the projection directly, but `board duplicate`
 * is the M15 wrapper case because `is_async` is load-bearing for
 * agents that duplicate-then-immediately-read.
 */
export const boardDuplicateOutputSchema = z
  .object({
    board: boardProjectionSchema,
    is_async: z.boolean(),
  })
  .strict();

export type BoardDuplicateOutput = z.infer<typeof boardDuplicateOutputSchema>;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    name: z
      .string()
      .refine((s) => s.trim().length > 0, {
        message: '--name must be non-empty (whitespace-only is rejected)',
      })
      .optional(),
    workspace: WorkspaceIdSchema.optional(),
    withUpdates: z.boolean().optional().default(false),
  })
  .strict();

const responseSchema = z
  .object({
    duplicate_board: z.unknown(),
  })
  .loose();

const duplicationPayloadSchema = z
  .object({
    board: z.unknown(),
    is_async: z.boolean(),
  })
  .loose();

export const boardDuplicateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardDuplicateOutput
> = {
  name: 'board.duplicate',
  summary: "Duplicate a board (optionally including its items' updates)",
  examples: [
    'monday board duplicate 12345',
    'monday board duplicate 12345 --name "Engineering — EU" --workspace 5',
    'monday board duplicate 12345 --with-updates',
    'monday board duplicate 12345 --dry-run --json',
  ],
  // Re-running creates a second copy. Mirrors `board create` /
  // `item duplicate` rationale.
  idempotent: false,
  inputSchema,
  outputSchema: boardDuplicateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('duplicate <boardId>')
      .description(boardDuplicateCommand.summary)
      .option('--name <n>', "new board name (defaults to '<source> (Copy)')")
      .option(
        '--workspace <wid>',
        "destination workspace ID (defaults to source's workspace)",
      )
      .option(
        '--with-updates',
        "include the source items' updates (Monday's `with_updates` enum)",
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardDuplicateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardDuplicateCommand.inputSchema, {
          boardId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const trimmedName = parsed.name?.trim();

        // No confirmation gate — duplicate is creative, not
        // destructive (cli-design §3.1 #7). resolveClient runs
        // first so a missing token surfaces as config_error before
        // any wire attempt.
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Preflight via loadBoardMetadata so the v0.1 board-
          // metadata cache can serve fresh entries. Cache-staleness
          // caveat applies — agents pass --no-cache for force-live
          // preview when freshness is critical.
          const preflight = await loadBoardMetadata({
            client,
            boardId: parsed.boardId,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          const current = preflight.metadata;
          // Snapshot uses BoardMetadata's BoardProjection-overlapping
          // subset (same shape as board-archive's dry-run snapshot).
          const snapshot = {
            id: current.id,
            name: current.name,
            description: current.description,
            state: current.state,
            board_kind: current.board_kind,
            board_folder_id: current.board_folder_id,
            workspace_id: current.workspace_id,
            url: current.url,
            updated_at: current.updated_at,
          };
          const planned: Record<string, unknown> = {
            operation: 'duplicate_board',
            board_id: parsed.boardId,
            with_updates: parsed.withUpdates,
            board: snapshot,
          };
          if (parsed.workspace !== undefined) {
            planned.target_workspace_id = parsed.workspace;
          }
          if (trimmedName !== undefined) {
            planned.target_name = trimmedName;
          }
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [planned],
            source: preflight.source,
            cacheAgeSeconds: preflight.cacheAgeSeconds,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path. Map --with-updates to the DuplicateBoardType
        // enum: false → duplicate_board_with_pulses (items only,
        // no updates); true → duplicate_board_with_pulses_and_
        // updates (items + their updates).
        const duplicateType = parsed.withUpdates
          ? 'duplicate_board_with_pulses_and_updates'
          : 'duplicate_board_with_pulses';

        const variables: Record<string, unknown> = {
          boardId: parsed.boardId,
          duplicateType,
        };
        if (trimmedName !== undefined) {
          variables.boardName = trimmedName;
        }
        if (parsed.workspace !== undefined) {
          variables.workspaceId = parsed.workspace;
        }

        const response = await client.raw<unknown>(
          DUPLICATE_BOARD_MUTATION,
          variables,
          { operationName: 'BoardDuplicate' },
        );
        const data = unwrapOrThrow(
          responseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed BoardDuplicate response',
            details: { board_id: parsed.boardId },
            hint:
              'this is a data-integrity error in Monday\'s response; ' +
              'verify the response shape and update responseSchema if ' +
              'Monday\'s contract has changed.',
          },
        );
        // Distinguish missing-root-key (schema-drift →
        // internal_error) from null payload (board missing →
        // not_found). Same M14 round-2/round-3 distinction.
        if (!('duplicate_board' in data)) {
          throw new ApiError(
            'internal_error',
            `Monday's BoardDuplicate response is missing the duplicate_board root field`,
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
        if (data.duplicate_board === null || data.duplicate_board === undefined) {
          throw new ApiError(
            'not_found',
            `Monday returned no BoardDuplication payload from duplicate_board for id ${parsed.boardId}`,
            { details: { board_id: parsed.boardId } },
          );
        }

        // BoardDuplication has two fields — `board` (the
        // duplicated board's projection) and `is_async`. Parse the
        // wrapper, then validate the inner board against
        // boardProjectionSchema.
        const wrapper = unwrapOrThrow(
          duplicationPayloadSchema.safeParse(data.duplicate_board),
          {
            context: 'Monday returned a malformed BoardDuplication payload',
            details: { board_id: parsed.boardId },
          },
        );
        if (wrapper.board === null || wrapper.board === undefined) {
          throw new ApiError(
            'internal_error',
            `Monday returned no board inside BoardDuplication for source id ${parsed.boardId}`,
            { details: { board_id: parsed.boardId } },
          );
        }
        const projectedBoard = unwrapOrThrow(
          boardProjectionSchema.safeParse(wrapper.board),
          {
            context: `Monday returned a malformed duplicated board payload for source id ${parsed.boardId}`,
            details: { board_id: parsed.boardId },
          },
        );

        emitMutation({
          ctx,
          data: { board: projectedBoard, is_async: wrapper.is_async },
          schema: boardDuplicateCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
