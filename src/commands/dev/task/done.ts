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
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { parseArgv } from '../../parse-argv.js';
import { emitMutation } from '../../emit.js';
import { resolveClient } from '../../../api/resolve-client.js';
import { ItemIdSchema } from '../../../types/ids.js';
import {
  fireDevCreateUpdate,
  flipTaskStatus,
  loadDevMapping,
} from '../../../api/dev-conventions.js';
import { resolveActiveDevProfile, requireDevBoard } from '../_shared.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../../api/item-projection.js';
import type { Complexity } from '../../../utils/output/envelope.js';

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    message: z.string().min(1).optional(),
  })
  .strict();

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
      'Monday Dev workflow shortcuts (sprint, epic, release, task)',
    );
    const task = ensureSubcommand(
      dev,
      'task',
      'Task workflow verbs',
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
        // Codex round-1 P3-1: when create_update fires, prefer the
        // response's complexity over the flip leg's so the envelope's
        // verbose meta reflects the freshest budget snapshot.
        let envelopeComplexity: Complexity | null = flip.complexity;
        if (parsed.message !== undefined) {
          const update = await fireDevCreateUpdate({
            client,
            itemId: parsed.itemId,
            body: parsed.message,
            operationName: 'DevTaskDoneCreateUpdate',
          });
          envelopeComplexity = update.complexity ?? flip.complexity;
          sideEffects.push({
            kind: 'update_created',
            update_id: update.updateId,
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
          complexity: envelopeComplexity,
          // Codex round-1 P2-1: echo the resolved status-column ID
          // per cli-design §5.3 step 2 + docs/output-shapes.md §M26.
          resolvedIds: { status: flip.columnId },
          ...(sideEffects.length > 0 ? { sideEffects } : {}),
        });
      });
  },
};
