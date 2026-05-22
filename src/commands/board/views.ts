/**
 * `monday board views <bid>` — list a board's views (v0.9-M52,
 * `cli-design.md` §4.3 + §11.2).
 *
 * Mirrors `board columns` / `board groups` — loads `BoardMetadata`
 * via `loadBoardMetadata` (cache-aware, same 5-minute TTL) and
 * projects to the `views[]` slot. The cache reuse means a follow-up
 * `board describe` / `board columns` / `board groups` / `board views`
 * to the same board pays one fetch.
 *
 * The wire's `BoardView` type is SDK 14.0.0-untyped (the `is_leaf` /
 * `hierarchy_type` raw-GraphQL drift class). All 13 wire fields
 * pass through 1:1 — no parsing of `settings_str` /
 * `view_specific_data_str`. Agents who want the parsed JSON call
 * `JSON.parse` themselves; the typed `settings` JSON scalar (a
 * separate wire field) covers the structured-data use-case for
 * `settings` specifically. `Board.views` is wire-nullable; the
 * projection normalizes `null` to `[]` via `?? []`. No
 * `--include-archived` flag — the wire has no archived-view
 * distinction.
 *
 * Idempotent: yes.
 */
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { z } from 'zod';
import {
  boardViewSchema,
  loadBoardMetadata,
} from '../../api/board-metadata.js';

export const boardViewsOutputSchema = z.array(boardViewSchema);
export type BoardViewsOutput = z.infer<typeof boardViewsOutputSchema>;

const inputSchema = z.object({ boardId: BoardIdSchema }).strict();

export const boardViewsCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardViewsOutput
> = {
  name: 'board.views',
  summary: "List a board's views",
  examples: [
    'monday board views 12345',
    'monday board views 12345 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardViewsOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('views <boardId>')
      .description(boardViewsCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardViewsCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown) => {
        const parsed = parseArgv(boardViewsCommand.inputSchema, { boardId });
        const { client, globalFlags, apiVersion } = resolveClient(
          ctx,
          program.opts(),
        );

        const result = await loadBoardMetadata({
          client,
          boardId: parsed.boardId,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });

        // `views` is wire-nullable; the schema preserves that on the
        // metadata projection, the public output normalizes to `[]`.
        const projected = result.metadata.views ?? [];

        ctx.meta.setSource(result.source);
        emitSuccess({
          ctx,
          data: boardViewsCommand.outputSchema.parse(projected),
          schema: boardViewsCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          // Single-fetch payload (Monday returns the full views list
          // in one request), so `has_more` is unconditionally false.
          hasMore: false,
          source: result.source,
          apiVersion,
          complexity: result.complexity,
          cacheAgeSeconds: result.cacheAgeSeconds,
        });
      });
  },
};
