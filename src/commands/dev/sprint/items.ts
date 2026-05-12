/**
 * `monday dev sprint items <sid>` — list the task items linked to
 * a named sprint (cli-design §4.3 + §5.9; v0.3-plan §3 M26b).
 *
 * **Runtime body landed at M26b IMPL.** Loads the active profile's
 * dev mapping, hydrates the configured `tasks_board`'s columns to
 * locate the `board_relation` column that references the configured
 * `sprints_board` (`tasks_to_sprints_relation` per the M26a doctor
 * check), walks all tasks, and filters client-side by inspecting
 * the relation column's `value.linkedPulseIds` / `value.item_ids`
 * payload.
 *
 * **<sid> resolution.** Positional sprint ID is an item ID on the
 * sprints board (sprints are items, not first-class entities).
 * `ItemIdSchema` validates the shape at the argv layer; invalid IDs
 * surface `usage_error`. The sprint item is NOT hydrated by this
 * verb — only the tasks linked to it.
 *
 * **`dev_board_misconfigured` surfaces** when the tasks board has no
 * `board_relation` column linking to `sprints_board` (the
 * `tasks_to_sprints_relation` doctor check would fail). Points the
 * agent at `monday dev doctor` for diagnostics.
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
    sprintId: ItemIdSchema,
  })
  .strict();

const outputSchema = z.array(projectedItemSchema);

export const devSprintItemsCommand: CommandModule<
  z.infer<typeof inputSchema>,
  readonly ProjectedItem[]
> = {
  name: 'dev.sprint.items',
  summary: 'List task items linked to a named sprint via the board_relation column',
  examples: [
    'monday dev sprint items 12345678',
    'monday dev sprint items 12345678 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema,
  attach: (program, ctx) => {
    const dev = ensureSubcommand(
      program,
      'dev',
      'Monday Dev workflow shortcuts (cli-design §2.7 — convention, not API)',
    );
    const sprint = ensureSubcommand(
      dev,
      'sprint',
      'Sprint workflow verbs (three-level depth per cli-design §5.2 carve-out 1)',
    );
    sprint
      .command('items <sprintId>')
      .description(devSprintItemsCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devSprintItemsCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (sprintIdArg: unknown) => {
        const parsed = parseArgv(devSprintItemsCommand.inputSchema, {
          sprintId: sprintIdArg,
        });

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const mapping = await loadDevMapping(profile.name, profile.homeOptions);
        const tasksBoard = requireDevBoard(mapping, 'tasks_board', profile.name);
        const sprintsBoard = requireDevBoard(mapping, 'sprints_board', profile.name);

        const { client, apiVersion } = resolveClient(ctx, program.opts());

        // Resolve the board_relation column on tasks_board linking to
        // sprints_board. Doctor's `tasks_to_sprints_relation` check
        // validates this wiring at diagnostic time; the workflow verb
        // re-resolves at runtime since the relation column ID isn't
        // stored in the mapping.
        const { columns, complexity: hydrateComplexity } =
          await hydrateDevBoardColumns(
            client,
            tasksBoard,
            'DevSprintItemsHydrate',
          );
        const relationColumnId = findRelationColumnIdToBoard(
          columns,
          sprintsBoard,
        );
        if (relationColumnId === undefined) {
          throw new ApiError(
            'dev_board_misconfigured',
            `tasks board ${tasksBoard} has no board_relation column linking to sprints board ${sprintsBoard}`,
            {
              details: {
                board_id: tasksBoard,
                target_slot: 'sprints_board',
                target_board_id: sprintsBoard,
                reason: 'no_matching_relation',
                hint: 'run `monday dev doctor` for the `tasks_to_sprints_relation` check, then add or fix the Connect Boards column on the tasks board',
              },
            },
          );
        }

        const { items, complexity: walkComplexity } = await walkDevBoardItems({
          client,
          boardId: tasksBoard,
          operationName: 'DevSprintItemsWalk',
          now: ctx.clock,
        });

        const filtered = items.filter((task) => {
          const relCol = task.columns[relationColumnId];
          if (relCol === undefined) return false;
          const linked = extractLinkedItemIds(relCol.value);
          return linked.includes(parsed.sprintId);
        });

        emitSuccess({
          ctx,
          data: filtered,
          schema: devSprintItemsCommand.outputSchema,
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
