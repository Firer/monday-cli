/**
 * `monday dev task block <iid> --reason <r>` — set a task's
 * status to "Stuck" + post the blocking reason as a comment on
 * the configured tasks board (cli-design §4.3 + §5.9; v0.3-plan
 * §3 M26b).
 *
 * **Runtime body landed at M26b IMPL.** Routes the status flip
 * through the shared {@link flipTaskStatus} helper, then fires a
 * `create_update` mutation with the supplied `--reason <r>` body.
 * The side-effect lands in the {@link MutationEnvelope} top-level
 * `side_effects[]` slot (M26 round-1 P1-2 closure).
 *
 * **`--reason` is required.** Unlike `task done`'s optional
 * `--message`, blocking ALWAYS posts a comment — the audit trail is
 * the load-bearing value of `task block` over a bare status flip.
 *
 * **Idempotency caveat.** The status flip is idempotent; the
 * `update create` post is NOT — re-runs post additional comments.
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
    reason: z.string().min(1),
  })
  .strict();

const CREATE_UPDATE_MUTATION = `
  mutation DevTaskBlockCreateUpdate($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) {
      id
    }
  }
`;

interface CreateUpdateResponseShape {
  readonly create_update: { readonly id: string } | null;
}

export const devTaskBlockCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ProjectedItem
> = {
  name: 'dev.task.block',
  summary:
    'Set a task\'s status to "Stuck" + post the blocking reason as a comment on the configured tasks board',
  examples: [
    'monday dev task block 12345678 --reason "Waiting on legal review"',
    'monday dev task block 12345678 --reason "API rate limit until tomorrow" --json',
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
      .command('block <itemId>')
      .description(devTaskBlockCommand.summary)
      .requiredOption(
        '--reason <r>',
        'Blocking reason posted as a comment on the task. Required — the audit trail is the load-bearing value of `task block` over a bare status flip.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devTaskBlockCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (itemIdArg: unknown, opts: { reason: string }) => {
        const parsed = parseArgv(devTaskBlockCommand.inputSchema, {
          itemId: itemIdArg,
          reason: opts.reason,
        });

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const mapping = await loadDevMapping(profile.name, profile.homeOptions);
        const tasksBoard = requireDevBoard(mapping, 'tasks_board', profile.name);

        const { client, apiVersion } = resolveClient(ctx, program.opts());

        const flip = await flipTaskStatus({
          client,
          tasksBoard,
          itemId: parsed.itemId,
          canonical: 'Stuck',
          hydrateOperation: 'DevTaskBlockHydrate',
        });

        const response = await client.raw<CreateUpdateResponseShape>(
          CREATE_UPDATE_MUTATION,
          { itemId: parsed.itemId, body: parsed.reason },
          { operationName: 'DevTaskBlockCreateUpdate' },
        );
        const update = response.data.create_update;
        if (update === null) {
          throw new ApiError(
            'internal_error',
            `Monday returned no update payload from create_update for item ${parsed.itemId}`,
            { details: { item_id: parsed.itemId } },
          );
        }

        emitMutation({
          ctx,
          data: flip.projected,
          schema: devTaskBlockCommand.outputSchema,
          programOpts: program.opts(),
          apiVersion,
          source: 'live',
          cacheAgeSeconds: null,
          complexity: flip.complexity,
          sideEffects: [
            {
              kind: 'update_created',
              update_id: update.id,
              item_id: parsed.itemId,
              body: parsed.reason,
            },
          ],
        });
      });
  },
};
