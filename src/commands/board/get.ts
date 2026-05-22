/**
 * `monday board get <bid>` — single board by ID (`cli-design.md` §6.2).
 *
 * Single-resource shape; columns and groups are NOT inlined here —
 * `board describe` is the heavier read for that. Keeps `board get`
 * cheap for agents who just need name / state / kind.
 *
 * **Projection-helper migration (M15).** The output schema + GraphQL
 * field set live in `api/board-projection.ts` from M15 onwards, shared
 * with the M15 board lifecycle cluster (`board create` / `update` /
 * `archive` / `duplicate`). Pre-M15 the schema was inlined here;
 * lifting it kept rendered wire bytes byte-identical (6-space
 * continuation indent matches the existing column) and lets the
 * mutation cluster reuse the same projection. Mirrors the R39
 * workspace-projection lift.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { runByIdLookup } from '../run-by-id-lookup.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import {
  BOARD_FIELDS_FRAGMENT,
  boardProjectionSchema,
  type BoardProjection,
} from '../../api/board-projection.js';

// Exported so the RUN_LIVE_TESTS schema-drift smoke test can run the
// exact production document (the shared BOARD_FIELDS_FRAGMENT) against
// the live API — the `hierarchy_type` selection (v0.9-M51) is a
// raw-GraphQL SDK-drift field, the `is_leaf` regression class. See
// tests/e2e/live-schema-drift.test.ts.
export const BOARD_GET_QUERY = `
  query BoardGet($ids: [ID!]) {
    boards(ids: $ids) {
      ${BOARD_FIELDS_FRAGMENT}
    }
  }
`;

export const boardGetOutputSchema = boardProjectionSchema;

export type BoardGetOutput = BoardProjection;

const inputSchema = z.object({ boardId: BoardIdSchema }).strict();

export const boardGetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardGetOutput
> = {
  name: 'board.get',
  summary: 'Show one board by ID (lightweight; use board describe for columns)',
  examples: [
    'monday board get 12345',
    'monday board get 12345 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardGetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('get <boardId>')
      .description(boardGetCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardGetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown) => {
        const parsed = parseArgv(boardGetCommand.inputSchema, { boardId });
        await runByIdLookup({
          ctx,
          programOpts: program.opts(),
          query: BOARD_GET_QUERY,
          operationName: 'BoardGet',
          collectionKey: 'boards',
          id: parsed.boardId,
          errorDetailKey: 'board_id',
          kind: 'board',
          schema: boardGetCommand.outputSchema,
        });
      });
  },
};
