/**
 * `monday dev task list [--mine] [--status not_done|done|stuck|working_on_it]
 *  [--sprint current|<sid>]` — list tasks on the configured tasks
 * board (cli-design §4.3 + §5.9; v0.3-plan §3 M26b).
 *
 * **Runtime body landed at M26b IMPL.** Loads the active profile's
 * `tasks_board`, walks `items_page`, then applies the client-side
 * filters supplied by argv:
 *
 *   - `--mine` resolves `me` via `client.whoami()` and keeps rows
 *     whose `people`-type column entries include the resolved user
 *     ID. (Matches against any people column; tasks boards may
 *     have multiple — Owner / Assignee / etc.)
 *   - `--status not_done` keeps rows whose status column label is
 *     not `Done` / `Cancelled`; `--status done` keeps `Done` /
 *     `Cancelled`; `--status stuck` keeps `Stuck`; `--status
 *     working_on_it` keeps `Working on it`.
 *   - `--sprint current` resolves the active sprint (per the same
 *     date-range derivation `dev sprint current` uses) and filters
 *     by the configured sprint→task `board_relation` column.
 *     `--sprint <sid>` accepts a numeric sprint item ID directly.
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ApiError } from '../../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { parseArgv } from '../../parse-argv.js';
import { emitSuccess } from '../../emit.js';
import { resolveClient } from '../../../api/resolve-client.js';
import {
  extractLinkedItemIds,
  findRelationColumnIdToBoard,
  hydrateDevBoardColumns,
  loadDevMapping,
  walkDevBoardItems,
} from '../../../api/dev-conventions.js';
import { resolveActiveDevProfile, requireDevBoard } from '../_shared.js';
import { resolveMeFactory } from '../../../api/item-helpers.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../../api/item-projection.js';
import type { Complexity } from '../../../utils/output/envelope.js';
import { _internals as listInternals } from '../sprint/list.js';

const TASK_STATUS_LITERALS = ['not_done', 'done', 'stuck', 'working_on_it'] as const;
export type TaskStatusFilter = (typeof TASK_STATUS_LITERALS)[number];

const sprintFilterSchema = z.union([
  z.literal('current'),
  z.string().regex(/^\d+$/u, { message: '--sprint must be `current` or a numeric sprint ID' }),
]);

const inputSchema = z
  .object({
    mine: z.boolean().optional(),
    status: z.enum(TASK_STATUS_LITERALS).optional(),
    sprint: sprintFilterSchema.optional(),
  })
  .strict();

const outputSchema = z.array(projectedItemSchema);

/**
 * Returns the projected status label of a task — first status / color
 * column with a non-empty `label` or `text` wins.
 */
const taskStatusLabel = (item: ProjectedItem): string | null => {
  for (const col of Object.values(item.columns)) {
    if (col.type !== 'status' && col.type !== 'color') continue;
    if (typeof col.label === 'string' && col.label.length > 0) return col.label;
    if (typeof col.text === 'string' && col.text.length > 0) return col.text;
  }
  return null;
};

const isDoneOrCancelled = (label: string | null): boolean => {
  if (label === null) return false;
  const lower = label.toLocaleLowerCase('und');
  return lower === 'done' || lower === 'cancelled' || lower === 'canceled';
};

const matchStatusFilter = (
  item: ProjectedItem,
  filter: TaskStatusFilter,
): boolean => {
  const label = taskStatusLabel(item);
  const lower = label === null ? null : label.toLocaleLowerCase('und');
  switch (filter) {
    case 'not_done':
      return !isDoneOrCancelled(label);
    case 'done':
      return isDoneOrCancelled(label);
    case 'stuck':
      return lower === 'stuck';
    case 'working_on_it':
      return lower === 'working on it';
  }
};

const isAssignedTo = (item: ProjectedItem, userId: string): boolean => {
  for (const col of Object.values(item.columns)) {
    if (col.type !== 'people') continue;
    if (!Array.isArray(col.people)) continue;
    for (const p of col.people) {
      if (p.id === userId) return true;
    }
  }
  return false;
};

export const devTaskListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  readonly ProjectedItem[]
> = {
  name: 'dev.task.list',
  summary:
    'List tasks on the configured tasks board (filter by --mine, --status, --sprint)',
  examples: [
    'monday dev task list',
    'monday dev task list --mine',
    'monday dev task list --status not_done --sprint current',
    'monday dev task list --sprint 12345678 --json',
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
    const task = ensureSubcommand(
      dev,
      'task',
      'Task workflow verbs (three-level depth per cli-design §5.2 carve-out 1)',
    );
    task
      .command('list')
      .description(devTaskListCommand.summary)
      .option(
        '--mine',
        'Restrict to tasks assigned to the connected user (resolved via the `me` token).',
      )
      .option(
        '--status <status>',
        'Filter by status: not_done | done | stuck | working_on_it. `not_done` is the agent-flow default for "tasks I still need to handle".',
      )
      .option(
        '--sprint <sprintIdOrCurrent>',
        'Filter to tasks in a specific sprint. Accepts the literal `current` (resolves via `monday dev sprint current`) or a numeric sprint item ID.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devTaskListCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (rawOpts: unknown) => {
        const opts = parseArgv(devTaskListCommand.inputSchema, rawOpts);

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const mapping = await loadDevMapping(profile.name, profile.homeOptions);
        const tasksBoard = requireDevBoard(mapping, 'tasks_board', profile.name);

        const { client, apiVersion } = resolveClient(ctx, program.opts());

        // Resolve --sprint if present. `current` needs the sprints
        // board hydrated + a sprints walk; numeric form just uses the
        // ID directly.
        let sprintItemId: string | undefined;
        let relationColumnId: string | undefined;
        let aggregateComplexity: Complexity | null = null;
        if (opts.sprint !== undefined) {
          const sprintsBoard = requireDevBoard(mapping, 'sprints_board', profile.name);
          // Resolve the tasks→sprints relation column ID (hydrate
          // tasks board columns once).
          const hydrated = await hydrateDevBoardColumns(
            client,
            tasksBoard,
            'DevTaskListHydrate',
          );
          aggregateComplexity = hydrated.complexity;
          relationColumnId = findRelationColumnIdToBoard(
            hydrated.columns,
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
                  hint: 'run `monday dev doctor` for the `tasks_to_sprints_relation` check',
                },
              },
            );
          }
          if (opts.sprint === 'current') {
            // Walk the sprints board to find the active sprint.
            const sprintWalk = await walkDevBoardItems({
              client,
              boardId: sprintsBoard,
              operationName: 'DevTaskListSprintCurrent',
              now: ctx.clock,
            });
            const todayEpoch = listInternals.dayEpoch(ctx.clock().toISOString());
            /* c8 ignore next 3 */
            if (todayEpoch === null) {
              throw new Error('unreachable: ctx.clock() produced an unparseable ISO string');
            }
            const active = sprintWalk.items.find(
              (i) =>
                listInternals.classifySprint(
                  listInternals.extractDateRange(i),
                  todayEpoch,
                ) === 'active',
            );
            if (active === undefined) {
              throw new ApiError(
                'not_found',
                `no active sprint on board ${sprintsBoard} for profile \`${profile.name}\``,
                {
                  details: {
                    profile: profile.name,
                    board_id: sprintsBoard,
                    hint: 'inspect upcoming sprints with `monday dev sprint list --state future`',
                  },
                },
              );
            }
            sprintItemId = active.id;
          } else {
            sprintItemId = opts.sprint;
          }
        }

        // Resolve `me` once when --mine is set.
        let meId: string | undefined;
        if (opts.mine === true) {
          meId = await resolveMeFactory(client)();
        }

        // Walk tasks_board.
        const { items, complexity: walkComplexity } = await walkDevBoardItems({
          client,
          boardId: tasksBoard,
          operationName: 'DevTaskList',
          now: ctx.clock,
        });

        let filtered = items;
        if (opts.status !== undefined) {
          const statusFilter = opts.status;
          filtered = filtered.filter((i) => matchStatusFilter(i, statusFilter));
        }
        if (meId !== undefined) {
          const id = meId;
          filtered = filtered.filter((i) => isAssignedTo(i, id));
        }
        if (sprintItemId !== undefined && relationColumnId !== undefined) {
          const colId = relationColumnId;
          const sid = sprintItemId;
          filtered = filtered.filter((task) => {
            const relCol = task.columns[colId];
            if (relCol === undefined) return false;
            return extractLinkedItemIds(relCol.value).includes(sid);
          });
        }

        emitSuccess({
          ctx,
          data: filtered,
          schema: devTaskListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          apiVersion,
          source: 'live',
          cacheAgeSeconds: null,
          complexity: walkComplexity ?? aggregateComplexity,
        });
      });
  },
};
