/**
 * `monday dev epic items <eid>` — list the task items linked to
 * a named epic (cli-design §4.3 + §5.9; v0.3-plan §3 M26b).
 *
 * **Runtime body landed at M26b IMPL.** Same shape as
 * `dev sprint items` but operates against the `tasks_to_epics_relation`
 * board_relation column (the M26a round-2 P2-3 fix replaced the
 * epics↔releases relation with this one; epics ↔ tasks is the
 * actually-consumed wiring at v0.3).
 *
 * **<eid> resolution.** Positional epic ID is an item ID on the
 * epics board. `ItemIdSchema` validates the shape at the argv layer.
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ApiError } from '../../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { parseArgv } from '../../parse-argv.js';
import { emitSuccess } from '../../emit.js';
import { resolveClient } from '../../../api/resolve-client.js';
import { ItemIdSchema } from '../../../types/ids.js';
import {
  extractLinkedItemIds,
  findRelationColumnIdToBoard,
  hydrateDevBoardColumns,
  loadDevMapping,
  walkDevBoardItems,
} from '../../../api/dev-conventions.js';
import { resolveActiveDevProfile, requireDevBoard } from '../_shared.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../../api/item-projection.js';

const inputSchema = z
  .object({
    epicId: ItemIdSchema,
  })
  .strict();

const outputSchema = z.array(projectedItemSchema);

export const devEpicItemsCommand: CommandModule<
  z.infer<typeof inputSchema>,
  readonly ProjectedItem[]
> = {
  name: 'dev.epic.items',
  summary: 'List task items linked to a named epic via the board_relation column',
  examples: [
    'monday dev epic items 12345678',
    'monday dev epic items 12345678 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema,
  attach: (program, ctx) => {
    const dev = ensureSubcommand(
      program,
      'dev',
      'Monday Dev workflow shortcuts (sprint, epic, release, task)',
    );
    const epic = ensureSubcommand(
      dev,
      'epic',
      'Epic workflow verbs',
    );
    epic
      .command('items <epicId>')
      .description(devEpicItemsCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devEpicItemsCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (epicIdArg: unknown) => {
        const parsed = parseArgv(devEpicItemsCommand.inputSchema, {
          epicId: epicIdArg,
        });

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const mapping = await loadDevMapping(profile.name, profile.homeOptions);
        const tasksBoard = requireDevBoard(mapping, 'tasks_board', profile.name);
        const epicsBoard = requireDevBoard(mapping, 'epics_board', profile.name);

        const { client, apiVersion } = resolveClient(ctx, program.opts());

        const { columns, complexity: hydrateComplexity } =
          await hydrateDevBoardColumns(
            client,
            tasksBoard,
            'DevEpicItemsHydrate',
          );
        const relationColumnId = findRelationColumnIdToBoard(
          columns,
          epicsBoard,
        );
        if (relationColumnId === undefined) {
          throw new ApiError(
            'dev_board_misconfigured',
            `tasks board ${tasksBoard} has no board_relation column linking to epics board ${epicsBoard}`,
            {
              details: {
                board_id: tasksBoard,
                target_slot: 'epics_board',
                target_board_id: epicsBoard,
                reason: 'no_matching_relation',
                hint: 'run `monday dev doctor` for the `tasks_to_epics_relation` check, then add or fix the Connect Boards column on the tasks board',
              },
            },
          );
        }

        const { items, complexity: walkComplexity } = await walkDevBoardItems({
          client,
          boardId: tasksBoard,
          operationName: 'DevEpicItemsWalk',
          now: ctx.clock,
        });

        const filtered = items.filter((task) => {
          const relCol = task.columns[relationColumnId];
          if (relCol === undefined) return false;
          const linked = extractLinkedItemIds(relCol.value);
          return linked.includes(parsed.epicId);
        });

        emitSuccess({
          ctx,
          data: filtered,
          schema: devEpicItemsCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          apiVersion,
          source: 'live',
          cacheAgeSeconds: null,
          complexity: walkComplexity ?? hydrateComplexity,
        });
      });
  },
};
