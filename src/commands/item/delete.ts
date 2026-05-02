/**
 * `monday item delete <iid> --yes [--dry-run]` — delete an item
 * (`cli-design.md` §4.3 line 533, `v0.2-plan.md` §3 M10).
 *
 * Sibling of `monday item archive` — same argv shape, same
 * confirmation contract, same projection, one knob different:
 * `idempotent: false`.
 *
 * **Confirmation gate** (cli-design §3.1 #7). `--yes` is mandatory
 * for the live path; without `--yes` (and without `--dry-run`) the
 * command fails fast with `confirmation_required` carrying
 * `details.item_id`. Same shape as `monday item archive`.
 *
 * **`--dry-run` shape.** Reads the source item via
 * `ITEM_FIELDS_FRAGMENT` projection, then emits the §6.4 dry-run
 * envelope with `operation: "delete_item"`, `item_id`, and
 * `item: <projected snapshot>` so the agent verifies the ID before
 * re-running with `--yes`. `meta.source: "live"` — same as
 * archive's dry-run.
 *
 * **Live path.** Single round-trip via `delete_item(item_id: ID!)`.
 * Monday returns the deleted `Item`, so no pre-mutation read fires.
 * A null result surfaces as `not_found` (matches archive's null-
 * handling so the error shape stays identical across both verbs).
 *
 * **Why `idempotent: false`** (despite Monday's `delete_*` being
 * idempotent past the first call per cli-design §9.1). The CLI
 * marks delete non-idempotent because re-running with the same
 * `<iid>` after an interim `monday item create` would delete the
 * *new* item — agents can't safely retry without verifying the ID
 * still names the same record. Re-deleting an already-deleted item
 * surfaces `not_found`, which agents key off the stable code per
 * §6.5.
 *
 * **No `restore`** (cli-design §5.4). Monday's delete is
 * recoverable for 30 days through the trash, but exposes no
 * `unrestore` mutation; recreating is lossy (new ID, no updates /
 * assets / automation history). The CLI deliberately doesn't ship
 * a misleading "restore" — `monday item recreate-from-archive`
 * is a future-deferred verb with explicit data-loss naming.
 *
 * **Not_found semantics.** A missing item or one the token can't
 * read surfaces as `not_found` with `details.item_id`. Mirrors
 * `monday item archive` and `monday item get` — same code, same
 * details key, same agent-recovery story.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { ConfirmationRequiredError } from '../../utils/errors.js';
import { ITEM_FIELDS_FRAGMENT } from '../../api/item-helpers.js';
import { projectMutationItem } from '../../api/item-mutation-result.js';
import { readSourceItemForDryRun } from '../../api/item-source-read.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';

// The live mutation returns an `Item` shape — same fragment as
// `item get`. The dry-run source-item read goes through
// `readSourceItemForDryRun` (R27) so the query string + null-handling
// stay one-source-of-truth across the M10 lifecycle verbs.
const DELETE_ITEM_MUTATION = `
  mutation ItemDelete($itemId: ID!) {
    delete_item(item_id: $itemId) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

interface DeleteItemResponse {
  readonly delete_item: unknown;
}

export const itemDeleteOutputSchema = projectedItemSchema;
export type ItemDeleteOutput = ProjectedItem;

const inputSchema = z.object({ itemId: ItemIdSchema }).strict();

export const itemDeleteCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemDeleteOutput
> = {
  name: 'item.delete',
  summary: 'Delete an item (--yes required)',
  examples: [
    'monday item delete 12345 --yes',
    'monday item delete 12345 --dry-run',
    'monday item delete 12345 --yes --json',
  ],
  // Re-deleting an already-deleted item surfaces `not_found`. The CLI
  // marks `idempotent: false` because re-running with the same `<iid>`
  // after an interim `monday item create` would delete the new item —
  // see the module header for the full rationale.
  idempotent: false,
  inputSchema,
  outputSchema: itemDeleteOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('delete <itemId>')
      .description(itemDeleteCommand.summary)
      // `--yes` and `--dry-run` are global flags (`src/cli/program.ts`)
      // — same single-source-of-truth pattern archive uses.
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemDeleteCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown) => {
        const parsed = parseArgv(itemDeleteCommand.inputSchema, { itemId });

        // Confirmation gate fires BEFORE `resolveClient()` — same
        // ordering archive uses. Codex M10 round-1 P2: a missing
        // `--yes` MUST surface as `confirmation_required` per
        // cli-design §3.1 #7's unconditional contract, never masked
        // by `config_error` when no token is configured. The gate-
        // error envelope's `meta.source` stays at the runner's
        // `'none'` default because no wire call fires (cli-design
        // §6.1). See archive.ts for the full rationale.
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        if (!globalFlags.dryRun && !globalFlags.yes) {
          throw new ConfirmationRequiredError(
            `monday item delete ${parsed.itemId} would delete the ` +
              `item. Re-run with --yes to confirm, or --dry-run to ` +
              `preview.`,
            {
              details: {
                item_id: parsed.itemId,
                hint:
                  'delete is destructive — Monday retains deleted ' +
                  'items in the trash for 30 days but exposes no ' +
                  'restore mutation; agents needing reversal must ' +
                  'recreate from a prior snapshot (cli-design §5.4).',
              },
            },
          );
        }

        // Gate cleared — resolve the client now. Both dry-run + live
        // need `MondayClient`; a missing token here legitimately
        // surfaces as `config_error` (the user opted into the wire
        // path via `--yes` or `--dry-run`).
        const { client, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Dry-run path: read the source item so the agent can
          // verify the ID before committing. Lifted to
          // `readSourceItemForDryRun` (R27) — same query body archive
          // + duplicate share; null result → `not_found` with the
          // same shape so agents key off one error code regardless of
          // which verb they ran.
          const projected = await readSourceItemForDryRun({
            client,
            itemId: parsed.itemId,
            operationName: 'ItemDeleteRead',
          });
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'delete_item',
                item_id: parsed.itemId,
                item: projected,
              },
            ],
            // Source-item read fired — `'live'` reflects the wire
            // round-trip (same as archive's dry-run shape).
            source: 'live',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path. `delete_item` returns the deleted item directly
        // — no pre-mutation read needed; null result means the item
        // didn't exist or the token has no access (matches the dry-
        // run path's shape so agents key off the same code).
        const response = await client.raw<DeleteItemResponse>(
          DELETE_ITEM_MUTATION,
          { itemId: parsed.itemId },
          { operationName: 'ItemDelete' },
        );
        const projected = projectMutationItem({
          raw: response.data.delete_item,
          itemId: parsed.itemId,
          errorCode: 'not_found',
          errorMessage:
            `Monday returned no item from delete_item for id ${parsed.itemId}`,
        });

        emitMutation({
          ctx,
          data: projected,
          schema: itemDeleteCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
