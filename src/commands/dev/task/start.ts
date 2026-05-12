/**
 * `monday dev task start <iid>` — set a task's status to
 * "Working on it" on the configured tasks board (cli-design §4.3
 * + §5.9; v0.3-plan §3 M26b).
 *
 * **Runtime body landed at M26b IMPL.** Loads the active profile's
 * dev mapping, routes the status flip through the shared
 * {@link flipTaskStatus} helper (hydrates the tasks board's status
 * column, resolves the canonical "Working on it" label
 * case-insensitively, fires `change_simple_column_value` via the
 * shared {@link executeItemMutation}).
 *
 * **Convention, not API.** Pure convenience over
 * `monday item update <iid> --board <tasks_board> --set status=
 * "Working on it"`. The dev namespace's value is naming the
 * workflow concept (`task start`) over the CRUD primitive.
 *
 * Idempotent: yes — Monday's `change_simple_column_value` is
 * idempotent for equal values.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { parseArgv } from '../../parse-argv.js';
import { emitMutation } from '../../emit.js';
import { resolveClient } from '../../../api/resolve-client.js';
import { ItemIdSchema } from '../../../types/ids.js';
import {
  flipTaskStatus,
  loadDevMapping,
} from '../../../api/dev-conventions.js';
import { resolveActiveDevProfile, requireDevBoard } from '../_shared.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../../api/item-projection.js';

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
  })
  .strict();

export const devTaskStartCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ProjectedItem
> = {
  name: 'dev.task.start',
  summary: 'Set a task\'s status to "Working on it" on the configured tasks board',
  examples: [
    'monday dev task start 12345678',
    'monday dev task start 12345678 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: projectedItemSchema,
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
      .command('start <itemId>')
      .description(devTaskStartCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devTaskStartCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (itemIdArg: unknown) => {
        const parsed = parseArgv(devTaskStartCommand.inputSchema, {
          itemId: itemIdArg,
        });

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const mapping = await loadDevMapping(profile.name, profile.homeOptions);
        const tasksBoard = requireDevBoard(mapping, 'tasks_board', profile.name);

        const { client, apiVersion } = resolveClient(ctx, program.opts());

        const flip = await flipTaskStatus({
          client,
          tasksBoard,
          itemId: parsed.itemId,
          canonical: 'Working on it',
          hydrateOperation: 'DevTaskStartHydrate',
        });

        emitMutation({
          ctx,
          data: flip.projected,
          schema: devTaskStartCommand.outputSchema,
          programOpts: program.opts(),
          apiVersion,
          source: 'live',
          cacheAgeSeconds: null,
          complexity: flip.complexity,
        });
      });
  },
};
