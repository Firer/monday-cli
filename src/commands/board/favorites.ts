/**
 * `monday board favorites` — current user's starred boards
 * (cli-design §13 v0.3 entry; v0.3-plan §3 M23).
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
 * **Stage-1 short-circuit.** When Stage 1 returns no Board-typed
 * entries the action emits a success envelope with `data: []` and
 * skips Stage 2 — agents detect via `data.length === 0` (no
 * special warning shape).
 *
 * **Stale-favorites warning.** Stage 2 may hydrate fewer rows than
 * Stage 1 filtered (board deleted / access revoked since being
 * favorited). The Stage-1/Stage-2 count delta surfaces a
 * `board_favorites_stale` warning on `warnings[]` per §6.1.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import {
  boardFavoritesOutputSchema,
  fetchBoardFavorites,
  type BoardFavoritesOutput,
} from '../../api/board-favorites.js';

const inputSchema = z.object({}).strict();

export const boardFavoritesCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardFavoritesOutput
> = {
  name: 'board.favorites',
  summary: "List the current user's starred boards",
  examples: [
    'monday board favorites',
    'monday board favorites --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardFavoritesOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board');
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
        ].join('\n'),
      )
      .action(async (rawOpts: unknown) => {
        parseArgv(boardFavoritesCommand.inputSchema, rawOpts);
        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await fetchBoardFavorites({ client });
        emitSuccess({
          ctx,
          data: result.boards,
          schema: boardFavoritesCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          source: result.source,
          cacheAgeSeconds: result.cacheAgeSeconds,
          warnings: result.warnings,
          complexity: result.complexity,
          apiVersion,
        });
      });
  },
};
