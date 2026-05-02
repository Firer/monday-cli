/**
 * `monday item duplicate <iid> [--with-updates] [--dry-run]` —
 * duplicate an item (`cli-design.md` §4.3 line 531, `v0.2-plan.md`
 * §3 M10).
 *
 * Third sibling of M10's lifecycle cluster — joins `archive` + `delete`
 * to round out the four-verb set Monday's API exposes (`archive_item`
 * / `delete_item` / `duplicate_item`; the fourth, `move_item_to_*`,
 * lands in M11). Unlike its M10 siblings duplicate is **creative**,
 * not destructive, so it skips the `--yes` gate (cli-design §3.1 #7
 * is for destructive ops only — `monday item create` sets the
 * precedent for creative verbs without confirmation).
 *
 * **`board_id` derivation.** Monday's `duplicate_item` mutation requires
 * `board_id: ID!` (the SDK signature, verified at
 * `node_modules/@mondaydotcomorg/api/dist/esm/index.d.ts:2130`). Unlike
 * archive + delete (which only take `item_id`) the live path here is
 * **two-leg**: a `lookupItemBoard` round-trip first to derive the
 * source item's `board_id`, then the mutation. Both legs are
 * guaranteed live — no cache plays a role — so `meta.source: "live"`
 * directly without invoking `mergeSource` (the aggregator is for
 * paths that mix cache + live).
 *
 * **`--dry-run` shape.** Reads the source item via the same
 * `ITEM_FIELDS_FRAGMENT` projection archive + delete use, then emits
 * the §6.4 dry-run envelope with `operation: "duplicate_item"`,
 * `item_id`, `with_updates`, and `item: <projected source snapshot>`.
 * The dry-run is **single-leg** (no separate board-id lookup needed —
 * the source-item read carries everything we'd display, and the
 * mutation isn't fired). `meta.source: "live"` because the read
 * leg fired (mirrors archive's dry-run shape).
 *
 * **Live path.** Two round-trips: `ItemBoardLookup($ids)` →
 * `ItemDuplicate($itemId, $boardId, $withUpdates)`. Monday's
 * `duplicate_item` returns the new `Item` directly with a fresh
 * `id` (and the same `board_id`, because Monday duplicates onto the
 * source's board); a null result surfaces as `not_found` matching
 * the dry-run path's null-handling so agents key off one stable code
 * regardless of which path they took.
 *
 * **Mutation envelope** (cli-design §6.4 line 1827-1831 precedent).
 * `data` extends `projectedItemSchema` with one field —
 * `duplicated_from_id: <source-iid>`. The lineage is a meaningful
 * relationship of the new item, mirroring upsert's `created: true |
 * false` flag pattern: a per-verb `data` extension for a
 * business-signal an agent reading the envelope needs to thread into
 * subsequent operations. v0.2-plan §3 M10's binding requirement
 * ("Returns the new item's ID + the source item's ID") is satisfied
 * by `data.id` (new) + `data.duplicated_from_id` (source).
 *
 * **Idempotent: false.** Re-running with the same args creates a
 * second duplicate. Same shape `monday item create`'s idempotency
 * marker uses (cli-design §9.1 idempotency table — `duplicate_item`
 * inherits `create_item`'s "every call creates a new item" semantics,
 * which is why the table doesn't list it separately). Agents
 * needing idempotent duplicate-or-update use `monday item upsert`
 * (M12).
 *
 * **Not_found semantics.** A missing source item or one the token
 * can't read surfaces as `not_found` with `details.item_id`. Mirrors
 * archive + delete + `monday item get` — same code, same details
 * key, same agent-recovery story.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError } from '../../utils/errors.js';
import {
  ITEM_FIELDS_FRAGMENT,
  parseRawItem,
} from '../../api/item-helpers.js';
import { lookupItemBoard } from '../../api/item-board-lookup.js';
import {
  projectItem,
  projectedItemSchema,
} from '../../api/item-projection.js';

// Read query for `--dry-run` source-item snapshot; mutation for the
// live duplicate. Operation names diverge from archive + delete so
// fixture cassettes + Monday's request-log telemetry can distinguish
// the source-item read from the live duplicate (mirrors the M10
// archive + delete naming convention — `Item<Verb>Read` for the
// dry-run preview, `Item<Verb>` for the live mutation).
const ITEM_DUPLICATE_READ_QUERY = `
  query ItemDuplicateRead($ids: [ID!]!) {
    items(ids: $ids) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const DUPLICATE_ITEM_MUTATION = `
  mutation ItemDuplicate($itemId: ID!, $boardId: ID!, $withUpdates: Boolean) {
    duplicate_item(item_id: $itemId, board_id: $boardId, with_updates: $withUpdates) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

interface DuplicateItemResponse {
  readonly duplicate_item: unknown;
}

interface ItemDuplicateReadResponse {
  readonly items: readonly unknown[] | null;
}

/**
 * The mutation envelope's `data` extends `projectedItemSchema` with
 * one field — `duplicated_from_id` — pointing at the source item ID
 * the agent passed positionally. v0.2-plan §3 M10 commits the CLI to
 * "Returns the new item's ID + the source item's ID"; the new ID is
 * `data.id` (already in the projection), the source ID lands here.
 *
 * Why the extension lives in `data` rather than as a top-level
 * envelope slot: cli-design §6.4 (line 1827-1831) sets the precedent
 * with upsert's `data.created: true | false` flag — verb-specific
 * business signals extend `data`; top-level slots are reserved for
 * cross-verb shapes (`resolved_ids`, `side_effects`). `duplicated_
 * from_id` is duplicate-specific lineage, so it belongs with the
 * resource it describes. JSON-schema (`monday schema`) reflects the
 * extended shape automatically because the registry walks
 * `outputSchema`.
 */
export const itemDuplicateOutputSchema = projectedItemSchema.extend({
  duplicated_from_id: ItemIdSchema,
});
export type ItemDuplicateOutput = z.infer<typeof itemDuplicateOutputSchema>;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    // Commander emits `{ withUpdates: true }` when the flag is
    // present, omits the key otherwise (per cli.md "Commander's
    // runtime option shape"). The schema defaults to `false` so the
    // GraphQL variable always has a defined boolean — matches Monday's
    // optional-flag-defaults-false behaviour.
    withUpdates: z.boolean().optional().default(false),
  })
  .strict();

export const itemDuplicateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemDuplicateOutput
> = {
  name: 'item.duplicate',
  summary: 'Duplicate an item (optionally including its updates)',
  examples: [
    'monday item duplicate 12345',
    'monday item duplicate 12345 --with-updates',
    'monday item duplicate 12345 --dry-run',
    'monday item duplicate 12345 --with-updates --json',
  ],
  // Re-running with the same args creates a second duplicate. Mirrors
  // `monday item create`'s idempotency marker — Monday's
  // `duplicate_item` shares `create_item`'s "every call creates a
  // new item" semantics (cli-design §9.1: the idempotency table
  // doesn't list `duplicate_item` separately because it inherits
  // create's behaviour). Agents needing idempotent dup-or-update
  // use `monday item upsert` (M12).
  idempotent: false,
  inputSchema,
  outputSchema: itemDuplicateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('duplicate <itemId>')
      .description(itemDuplicateCommand.summary)
      .option(
        '--with-updates',
        "include the source item's updates (Monday's `with_updates` flag)",
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemDuplicateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, opts: unknown) => {
        const parsed = parseArgv(itemDuplicateCommand.inputSchema, {
          itemId,
          ...(opts as Readonly<Record<string, unknown>>),
        });

        // Unlike archive + delete, no confirmation gate fires —
        // duplicate is creative (cli-design §3.1 #7 reserves the
        // gate for destructive verbs). resolveClient runs first so
        // a missing token surfaces as config_error before any wire
        // attempt, matching `monday item create`'s ordering.
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Dry-run path: single round-trip. Read the source item so
          // the agent can verify the ID before re-running without
          // `--dry-run`. The dry-run shape carries `with_updates` so
          // the agent reading the planned change knows whether they
          // requested update copying. No board lookup needed — we
          // aren't firing the mutation.
          const readResponse =
            await client.raw<ItemDuplicateReadResponse>(
              ITEM_DUPLICATE_READ_QUERY,
              { ids: [parsed.itemId] },
              { operationName: 'ItemDuplicateRead' },
            );
          const items = readResponse.data.items;
          const first: unknown = Array.isArray(items) ? items[0] : undefined;
          if (first === undefined || first === null) {
            throw new ApiError(
              'not_found',
              `Monday returned no item for id ${parsed.itemId}`,
              { details: { item_id: parsed.itemId } },
            );
          }
          const projected = projectItem({
            raw: parseRawItem(first, { item_id: parsed.itemId }),
          });
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'duplicate_item',
                item_id: parsed.itemId,
                with_updates: parsed.withUpdates,
                item: projected,
              },
            ],
            // Source-item read fired — `'live'` reflects the wire
            // round-trip (same shape archive's + delete's dry-runs use).
            source: 'live',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path: two round-trips. duplicate_item requires a
        // `board_id: ID!` parameter (SDK signature line 2131), so we
        // look up the source item's board before firing the mutation.
        // Both legs are guaranteed live — `lookupItemBoard` doesn't
        // touch the cache and the mutation always hits the wire — so
        // `meta.source: "live"` directly without `mergeSource`
        // (the aggregator is for cache + live combinations).
        const { boardId } = await lookupItemBoard({
          client,
          itemId: parsed.itemId,
        });

        const response = await client.raw<DuplicateItemResponse>(
          DUPLICATE_ITEM_MUTATION,
          {
            itemId: parsed.itemId,
            boardId,
            withUpdates: parsed.withUpdates,
          },
          { operationName: 'ItemDuplicate' },
        );
        const raw = response.data.duplicate_item;
        if (raw === null || raw === undefined) {
          // Defence-in-depth — `lookupItemBoard` already verified the
          // source item exists, so a null `duplicate_item` here
          // implies a permission edge case (token can read but not
          // duplicate) or a transient Monday-side rejection. Surfaces
          // as `not_found` matching the dry-run path's shape so
          // agents key off one stable code regardless of which leg
          // failed.
          throw new ApiError(
            'not_found',
            `Monday returned no item from duplicate_item for id ${parsed.itemId}`,
            { details: { item_id: parsed.itemId } },
          );
        }
        const projected = projectItem({
          raw: parseRawItem(raw, { item_id: parsed.itemId }),
        });

        emitMutation({
          ctx,
          // Extend the projection with the lineage echo — see the
          // outputSchema header comment for why this lives in `data`
          // rather than at envelope top-level (cli-design §6.4 line
          // 1827-1831 precedent: upsert's `data.created`).
          data: { ...projected, duplicated_from_id: parsed.itemId },
          schema: itemDuplicateCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          // Both legs (lookup + mutation) fire live — `'live'` is
          // the only correct value here. `cacheAgeSeconds` stays null
          // because no cache leg participated.
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
