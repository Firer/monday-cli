/**
 * `monday board archive <bid> --yes [--dry-run]` — archive a board
 * (`cli-design.md` §4.3 line 685, `v0.2-plan.md` §3 M15).
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §8 decision 9: archive
 * is consistently `--yes`-gated across nouns). Mirrors `item
 * archive` shape — gate fires BEFORE `resolveClient()` so a missing
 * `--yes` always surfaces as `confirmation_required`, never masked
 * by a `config_error` from `loadConfig()`'s missing-token check.
 * R29 helper count: 6 → 7 (item archive / item delete / update
 * delete / update clear-all / workspace delete / board archive /
 * board delete next).
 *
 * **Wire shape.** Single round-trip via `archive_board(board_id:
 * ID!)`. Monday's `archive_board` returns the archived `Board`
 * directly, so no separate pre-mutation read is needed for the
 * live path. The mutation response is projected through
 * `boardProjectionSchema`.
 *
 * **Dry-run shape** per cli-design §6.4 board-archive variant:
 * `{operation: "archive_board", board_id, board: <projected source
 * snapshot>}`. The preflight `board get` read goes through
 * `loadBoardMetadata` so cache hits are observable; `meta.source:
 * 'live' | 'cache'`. The snapshot is built from BoardMetadata's
 * fields that overlap with BoardProjection (id / name /
 * description / state / board_kind / board_folder_id /
 * workspace_id / url / updated_at) — `items_count` and
 * `permissions` are omitted because BoardMetadata doesn't carry
 * them and forcing a live read for them would defeat the cache-
 * hit purpose. Agents needing the live-projection shape get it
 * from the live mutation envelope.
 *
 * **Cache-staleness caveat.** Cache-sourced snapshots may lag
 * live state up to TTL — pass `--no-cache` for a force-live
 * preview when freshness is critical (e.g. archiving after a
 * recent rename).
 *
 * **Idempotent: true.** Re-archiving an already-archived board
 * is a no-op on Monday's side (cli-design §9.1 idempotency
 * table) — agents can safely retry on transient failure.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { enforceDestructiveGate } from '../../api/destructive-gate.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { withBoardInvalidationSingleLeg } from '../../api/board-mutation-invalidation.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';
import {
  BOARD_FIELDS_FRAGMENT,
  boardProjectionSchema,
  type BoardProjection,
} from '../../api/board-projection.js';
import { projectMutationBoard } from '../../api/board-mutation-result.js';

const ARCHIVE_BOARD_MUTATION = `
  mutation BoardArchive($boardId: ID!) {
    archive_board(board_id: $boardId) {
      ${BOARD_FIELDS_FRAGMENT}
    }
  }
`;

export const boardArchiveOutputSchema = boardProjectionSchema;
export type BoardArchiveOutput = BoardProjection;

const inputSchema = z.object({ boardId: BoardIdSchema }).strict();

const responseSchema = z
  .object({
    archive_board: z.unknown(),
  })
  .loose();

export const boardArchiveCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardArchiveOutput
> = {
  name: 'board.archive',
  summary: 'Archive a board (--yes required)',
  examples: [
    'monday board archive 12345 --yes',
    'monday board archive 12345 --dry-run',
    'monday board archive 12345 --yes --json',
  ],
  // Re-archiving an already-archived board is a no-op on Monday's
  // side per cli-design §9.1; safe to retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: boardArchiveOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board');
    noun
      .command('archive <boardId>')
      .description(boardArchiveCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardArchiveCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown) => {
        const parsed = parseArgv(boardArchiveCommand.inputSchema, { boardId });
        // Gate fires BEFORE resolveClient() so a missing --yes
        // surfaces as confirmation_required, not config_error
        // (M10 round-1 P2 ordering invariant; R29 helper preserves
        // it via already-parsed globalFlags).
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        enforceDestructiveGate({
          globalFlags,
          verb: 'board archive',
          target: parsed.boardId,
          detailKey: 'board_id',
          action: 'archive the board',
          hint:
            'archive is destructive — Monday retains archived ' +
            'boards for 30 days but exposes no unarchive mutation ' +
            '(cli-design §5.4 + §8 decision 9).',
        });

        const { client, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Preflight read via loadBoardMetadata so the v0.1
          // board-metadata cache can serve fresh entries.
          // loadBoardMetadata throws ApiError(not_found) when the
          // board is absent; bubbles to the runner's catch-all
          // for the dry-run-not-found contract.
          const preflight = await loadBoardMetadata({
            client,
            boardId: parsed.boardId,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          const current = preflight.metadata;
          // Project to the full BoardProjection shape — Codex M15
          // implementation round-1 F2: cli-design pins the dry-run
          // snapshot as the §6.2 single-resource projection (which
          // includes items_count + permissions). BoardMetadata now
          // carries these fields (optional+nullable on the schema
          // so pre-M15 cache entries don't break); coerce undefined
          // → null for the snapshot so the shape is canonical
          // BoardProjection.
          const snapshot: BoardProjection = {
            id: current.id,
            name: current.name,
            description: current.description,
            state: current.state,
            board_kind: current.board_kind,
            board_folder_id: current.board_folder_id,
            workspace_id: current.workspace_id,
            url: current.url,
            // v0.9-M51: BoardMetadata already fetches hierarchy_type
            // (required+nullable), so the snapshot carries the live
            // value rather than a forced null.
            hierarchy_type: current.hierarchy_type,
            items_count: current.items_count ?? null,
            updated_at: current.updated_at,
            permissions: current.permissions ?? null,
          };
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'archive_board',
                board_id: parsed.boardId,
                board: snapshot,
              },
            ],
            source: preflight.source,
            cacheAgeSeconds: preflight.cacheAgeSeconds,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path. archive_board returns the archived Board
        // directly; no preflight read needed.
        //
        // M16 retrofit per cli-design §8 single-leg call-site
        // contract via `withBoardInvalidationSingleLeg` (R46): the
        // helper invalidates AFTER the closure returns (i.e. after
        // `data` projection completes), BEFORE emitMutation so a
        // cache-unlink failure surfaces through the runner's
        // catch-all. The closure's throws on schema drift / null
        // payload bypass invalidation. Required because archive
        // flips the cached `boardMetadataSchema.state` field from
        // 'active' to 'archived'; without invalidation a same-
        // process `board describe` would return stale state until
        // TTL eviction.
        const { data: projected, response } = await withBoardInvalidationSingleLeg({
          boardId: parsed.boardId,
          env: ctx.env,
          perform: async () => {
            const wireResponse = await client.raw<unknown>(
              ARCHIVE_BOARD_MUTATION,
              { boardId: parsed.boardId },
              { operationName: 'BoardArchive' },
            );
            const data = unwrapOrThrow(
              responseSchema.safeParse(wireResponse.data),
              {
                context: 'Monday returned a malformed BoardArchive response',
                details: { board_id: parsed.boardId },
                hint:
                  'this is a data-integrity error in Monday\'s response; ' +
                  'verify the response shape and update responseSchema if ' +
                  'Monday\'s contract has changed.',
              },
            );
            // R42 (post-v0.2 cleanup window): consolidate the inline
            // missing-key check onto `assertResponseFieldPresent`.
            // Distinguishes missing-root-key (schema-drift →
            // internal_error) from null payload (board missing →
            // not_found via projectMutationBoard). M14 round-2 /
            // round-3 distinction was landed proactively at M15;
            // R42 lifts the inline shape across all M15-M17 verbs.
            assertResponseFieldPresent({
              data,
              key: 'archive_board',
              operationLabel: 'BoardArchive',
              details: { board_id: parsed.boardId },
              nullHandling: 'caller_handles',
            });
            // R43 lift (api/board-mutation-result.ts): null-payload
            // guard + projection. Archive's null path uses
            // `not_found` (Monday's idiomatic missing-or-no-access
            // response) per M14 round-2 / round-3 missing-root vs
            // null distinction.
            const projection = projectMutationBoard({
              raw: data.archive_board,
              errorCode: 'not_found',
              errorMessage: `Monday returned no board payload from archive_board for id ${parsed.boardId}`,
              detailKey: 'board_id',
              detailValue: parsed.boardId,
            });
            return { data: projection, response: wireResponse };
          },
        });

        emitMutation({
          ctx,
          data: projected,
          schema: boardArchiveCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
