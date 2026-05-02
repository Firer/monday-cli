/**
 * `monday item archive <iid> --yes [--dry-run]` — archive an item
 * (`cli-design.md` §4.3 line 532, `v0.2-plan.md` §3 M10).
 *
 * The smaller of the two M10 destructive verbs. `archive_item` hides
 * the item from default queries; Monday retains it for a 30-day
 * recovery window but exposes no `unarchive` mutation — see
 * cli-design §5.4 for why "restore" is intentionally absent in v0.1.
 *
 * **Confirmation gate** (cli-design §3.1 #7). `--yes` is mandatory
 * for the live path; without `--yes` (and without `--dry-run`) the
 * command fails fast with `confirmation_required` carrying
 * `details.item_id` so an agent re-running with `--yes` knows which
 * item it just gated. `--dry-run` takes precedence over the gate
 * when both are absent — agents can preview without committing,
 * which mirrors §10.2's "dry-run takes precedence over --yes" rule.
 *
 * **`--dry-run` shape.** Reads the source item via the same
 * `ITEM_FIELDS_FRAGMENT` projection the live mutation uses, then
 * emits the §6.4 dry-run envelope with `operation: "archive_item"`,
 * `item_id`, and `item: <projected snapshot>` so the agent can
 * verify they targeted the right ID before re-running with `--yes`.
 * `meta.source: "live"` because the source-item read fired (mirrors
 * `monday item get`).
 *
 * **Live path.** Single round-trip — Monday's `archive_item`
 * mutation returns the archived item directly, so no separate
 * pre-mutation read is needed. The mutation response is projected
 * through `projectItem` against the v0.1 `projectedItemSchema`
 * (same shape as `item set` / `item clear` / `item update` so an
 * agent's "archive then re-read locally" loop has a stable shape).
 * `meta.source: "live"` always; cache plays no role here because
 * archive doesn't resolve columns.
 *
 * **Idempotent: true.** Re-archiving an already-archived item is a
 * no-op on Monday's side (cli-design §9.1 idempotency table) — the
 * mutation succeeds and returns the item unchanged. Agents can
 * safely retry on transient transport failures.
 *
 * **Not_found semantics.** A missing item or one the token can't
 * read surfaces as `not_found` with `details.item_id`. Mirrors
 * `runByIdLookup`'s pattern so the error shape is identical to a
 * read-side `monday item get` against the same ID — agents key off
 * the stable code per cli-design §6.5.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import {
  ApiError,
  ConfirmationRequiredError,
} from '../../utils/errors.js';
import {
  ITEM_FIELDS_FRAGMENT,
  parseRawItem,
} from '../../api/item-helpers.js';
import { readSourceItemForDryRun } from '../../api/item-source-read.js';
import {
  projectItem,
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';

// The live mutation returns an `Item` shape — same fragment as
// `item get`. The dry-run source-item read goes through
// `readSourceItemForDryRun` (R27) so the query string + null-handling
// stay one-source-of-truth across the M10 lifecycle verbs.
const ARCHIVE_ITEM_MUTATION = `
  mutation ItemArchive($itemId: ID!) {
    archive_item(item_id: $itemId) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

interface ArchiveItemResponse {
  readonly archive_item: unknown;
}

export const itemArchiveOutputSchema = projectedItemSchema;
export type ItemArchiveOutput = ProjectedItem;

const inputSchema = z.object({ itemId: ItemIdSchema }).strict();

export const itemArchiveCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemArchiveOutput
> = {
  name: 'item.archive',
  summary: 'Archive an item (--yes required)',
  examples: [
    'monday item archive 12345 --yes',
    'monday item archive 12345 --dry-run',
    'monday item archive 12345 --yes --json',
  ],
  // Re-archiving an already-archived item is a no-op on Monday's side
  // per cli-design §9.1; safe to retry on transient transport failures.
  idempotent: true,
  inputSchema,
  outputSchema: itemArchiveOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('archive <itemId>')
      .description(itemArchiveCommand.summary)
      // `--yes` and `--dry-run` are global flags (`src/cli/program.ts`)
      // — read via `globalFlags` rather than redeclaring per-command
      // so the gate stays single-source-of-truth across every
      // destructive verb.
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemArchiveCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown) => {
        const parsed = parseArgv(itemArchiveCommand.inputSchema, { itemId });

        // Confirmation gate fires BEFORE `resolveClient()` so a
        // missing `--yes` always surfaces as `confirmation_required`
        // — never masked by `config_error` from `loadConfig()`'s
        // missing-token check. Codex M10 round-1 P2: cli-design
        // §3.1 #7 makes the gate unconditional, but pre-fix the
        // ordering let `monday item archive 12345 --json` (no `--yes`,
        // no token) exit 3 with `config_error` instead of exit 1
        // with `confirmation_required`. `raw` already had this
        // pre-network ordering precedent (commands/raw/index.ts:435).
        // As a side-benefit, the gate-error envelope's `meta.source`
        // stays at the runner's `'none'` default rather than the
        // `live` `resolveClient` would have committed via
        // `ctx.meta.setSource('live')` — agents reading provenance
        // see `'none'` because no wire call fired (cli-design §6.1).
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        if (!globalFlags.dryRun && !globalFlags.yes) {
          throw new ConfirmationRequiredError(
            `monday item archive ${parsed.itemId} would archive the ` +
              `item. Re-run with --yes to confirm, or --dry-run to ` +
              `preview.`,
            {
              details: {
                item_id: parsed.itemId,
                hint:
                  'archive is destructive — Monday retains archived ' +
                  'items for 30 days but exposes no unarchive mutation ' +
                  '(cli-design §5.4).',
              },
            },
          );
        }

        // Gate cleared — now resolve the client. Both the dry-run
        // read and the live mutation need a `MondayClient`, so a
        // missing token here legitimately surfaces as `config_error`
        // (the user opted into the wire path via `--yes` or `--dry-run`).
        const { client, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Dry-run path: read the source item so the agent can
          // verify the ID before re-running with --yes. Lifted to
          // `readSourceItemForDryRun` (R27) — same query body all
          // three M10 lifecycle verbs share; null result → `not_found`
          // (mirrors the live path's null-handling so the error shape
          // matches).
          const projected = await readSourceItemForDryRun({
            client,
            itemId: parsed.itemId,
            operationName: 'ItemArchiveRead',
          });
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'archive_item',
                item_id: parsed.itemId,
                item: projected,
              },
            ],
            // Source-item read fired — `'live'` reflects the wire
            // round-trip. Mirrors `item get`'s success envelope.
            source: 'live',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path. The `archive_item` mutation returns the archived
        // item directly — no pre-mutation read needed; null result
        // means the item didn't exist or the token has no access,
        // which surfaces as `not_found` (matches the dry-run path's
        // shape so agents key off the same code regardless of which
        // path they took).
        const response = await client.raw<ArchiveItemResponse>(
          ARCHIVE_ITEM_MUTATION,
          { itemId: parsed.itemId },
          { operationName: 'ItemArchive' },
        );
        const raw = response.data.archive_item;
        if (raw === null || raw === undefined) {
          throw new ApiError(
            'not_found',
            `Monday returned no item from archive_item for id ${parsed.itemId}`,
            { details: { item_id: parsed.itemId } },
          );
        }
        const projected = projectItem({
          raw: parseRawItem(raw, { item_id: parsed.itemId }),
        });

        emitMutation({
          ctx,
          data: projected,
          schema: itemArchiveCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
