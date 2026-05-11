/**
 * `monday board favorites` — current user's starred boards
 * (cli-design §13 v0.3 entry; v0.3-plan §3 M23).
 *
 * **v0.3-M23 pre-flight stub.** Registered for forward-compatibility
 * (agent scripts targeting `monday board favorites` are stable across
 * the M23 implementation drop) and rejects every invocation today
 * with `internal_error` carrying the M23-pending hint. The argv shape
 * (no positional, no command-specific flags — uses globals only) is
 * the final shape M23 implementation ships against; only the action
 * body changes.
 *
 * **Empirical-probe finding pinned (2026-05-11, API `2026-01`).**
 * Monday surfaces favorites at `Query.favorites:
 * [GraphqlHierarchyObjectItem!]` (top-level, NOT `User.favorites`).
 * Each element is polymorphic — carries `object: { id, type }` with
 * `type: GraphqlMondayObject` enum (Board | Folder | Dashboard |
 * Workspace). `monday board favorites` is a 2-stage GraphQL op —
 * Stage 1 fetches the polymorphic list + filters to `type=Board`,
 * Stage 2 hydrates via `boards(ids: [...])` for name + workspace_id
 * + state + url. Output sorted by Monday's UI `position` (Float) for
 * sidebar parity. See `src/api/board-favorites.ts` for the
 * load-bearing probe-finding docstring.
 *
 * **What lands at M23 implementation:**
 *   - Issue `FAVORITES_LIST_QUERY` (Stage 1) via the resolved
 *     transport; parse via `favoritesListResponseSchema`; filter via
 *     `filterFavoritesToBoards`.
 *   - Issue `BOARDS_HYDRATE_QUERY` (Stage 2) with the filtered IDs;
 *     parse via `boardsHydrateResponseSchema`; join via
 *     `joinFavoritesWithBoards`.
 *   - Surface `board_favorites_stale` warning on the Stage-1/Stage-2
 *     count delta (per `buildStaleFavoritesWarning`).
 *   - Emit success envelope per §6.1 with sorted `BoardFavoriteOutput[]`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { ApiError } from '../../utils/errors.js';
import { parseArgv } from '../parse-argv.js';
import {
  boardFavoritesOutputSchema,
  type BoardFavoritesOutput,
} from '../../api/board-favorites.js';

const inputSchema = z.object({}).strict();

export const boardFavoritesCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardFavoritesOutput
> = {
  name: 'board.favorites',
  summary:
    "List the current user's starred boards (v0.3-M23 pre-flight stub — runtime body lands at M23 implementation)",
  examples: [
    'monday board favorites',
    'monday board favorites --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardFavoritesOutputSchema,
  attach: (program) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('favorites')
      .description(boardFavoritesCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...boardFavoritesCommand.examples.map((e) => `  ${e}`),
          '',
          'NOTE: Pre-flight stub — runtime body lands at v0.3-M23',
          'implementation. The verb registers the argv shape so agent',
          'scripts targeting `monday board favorites` are stable across',
          'the drop-in.',
          '',
        ].join('\n'),
      )
      .action(async (rawOpts: unknown) => {
        parseArgv(boardFavoritesCommand.inputSchema, rawOpts);
        // Pre-flight stub — every invocation rejects. M23
        // implementation replaces this with the real 2-stage
        // favorites resolver action per cli-design §13 v0.3 entry.
        await Promise.reject(
          new ApiError(
            'internal_error',
            '`monday board favorites` is a v0.3-M23 pre-flight stub — runtime 2-stage favorites resolver lands at M23 implementation alongside `src/api/board-favorites.ts`.',
            {
              details: {
                hint: 'M23 implementation kickoff lands the Stage-1 favorites query + Stage-2 boards(ids:) hydrate via fetchBoardFavorites; output sorted by Monday-UI position for sidebar parity.',
              },
            },
          ),
        );
      });
  },
};
