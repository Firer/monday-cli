/**
 * `monday dev task done <iid> [--message <m>]` — set a task's
 * status to "Done" + optionally post a completion comment on the
 * configured tasks board (cli-design §4.3 + §5.9; v0.3-plan §3
 * M26b).
 *
 * **Runtime body landed at M26b IMPL.** Routes the status flip
 * through the shared {@link flipTaskStatus} helper, then — when
 * `--message <m>` is supplied — fires a side `create_update`
 * mutation against the same item. The side-effect is surfaced via
 * the {@link MutationEnvelope} top-level `side_effects[]` slot per
 * cli-design §6.4 (M26 round-1 P1-2 closure pins
 * `side_effects` at envelope top-level, NOT under `meta`).
 *
 * **Idempotency caveat.** The status flip is idempotent (same as
 * `task start`); the optional `--message` post-create is NOT — a
 * re-run with `--message` posts a second comment. `idempotent:
 * false` at the schema layer reflects the worst-case so agents on
 * retry loops know to omit `--message` on retries.
 */
import { z } from 'zod';
import { ApiError } from '../../../utils/errors.js';
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
    message: z.string().min(1).optional(),
  })
  .strict();

const CREATE_UPDATE_MUTATION = `
  mutation DevTaskDoneCreateUpdate($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) {
      id
    }
  }
`;

interface CreateUpdateResponseShape {
  readonly create_update: { readonly id: string } | null;
}

export const devTaskDoneCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ProjectedItem
> = {
  name: 'dev.task.done',
  summary:
    'Set a task\'s status to "Done" on the configured tasks board (optionally post a completion comment)',
  examples: [
    'monday dev task done 12345678',
    'monday dev task done 12345678 --message "Shipped in v0.3.0"',
    'monday dev task done 12345678 --json',
  ],
  idempotent: false,
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
      .command('done <itemId>')
      .description(devTaskDoneCommand.summary)
      .option(
        '--message <m>',
        'Post a completion comment alongside the status change. Re-runs with --message post additional comments — omit on retries.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devTaskDoneCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (itemIdArg: unknown, opts: { message?: string }) => {
        const parsed = parseArgv(devTaskDoneCommand.inputSchema, {
          itemId: itemIdArg,
          ...(opts.message !== undefined ? { message: opts.message } : {}),
        });

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const mapping = await loadDevMapping(profile.name, profile.homeOptions);
        const tasksBoard = requireDevBoard(mapping, 'tasks_board', profile.name);

        const { client, apiVersion } = resolveClient(ctx, program.opts());

        const flip = await flipTaskStatus({
          client,
          tasksBoard,
          itemId: parsed.itemId,
          canonical: 'Done',
          hydrateOperation: 'DevTaskDoneHydrate',
        });

        const sideEffects: Readonly<Record<string, unknown>>[] = [];
        if (parsed.message !== undefined) {
          const response = await client.raw<CreateUpdateResponseShape>(
            CREATE_UPDATE_MUTATION,
            { itemId: parsed.itemId, body: parsed.message },
            { operationName: 'DevTaskDoneCreateUpdate' },
          );
          const update = response.data.create_update;
          if (update === null) {
            throw new ApiError(
              'internal_error',
              `Monday returned no update payload from create_update for item ${parsed.itemId}`,
              { details: { item_id: parsed.itemId } },
            );
          }
          sideEffects.push({
            kind: 'update_created',
            update_id: update.id,
            item_id: parsed.itemId,
            body: parsed.message,
          });
        }

        emitMutation({
          ctx,
          data: flip.projected,
          schema: devTaskDoneCommand.outputSchema,
          programOpts: program.opts(),
          apiVersion,
          source: 'live',
          cacheAgeSeconds: null,
          complexity: flip.complexity,
          ...(sideEffects.length > 0 ? { sideEffects } : {}),
        });
      });
  },
};
