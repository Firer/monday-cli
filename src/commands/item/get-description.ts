/**
 * `monday item get-description <iid>` — read an item's description
 * (block-list body) (v0.11-M54-G, `cli-design.md` §4.3 + §6.2).
 *
 * Narrow companion read to `item get`. Returns Monday's
 * `ItemDescription { id, blocks: [DocumentBlock] }` shape (4 of
 * `DocumentBlock`'s 9 wire fields surfaced — see
 * `src/api/item-description.ts`). Mirrors v0.9-M52's
 * `board views <bid>` carve-out from `board describe`: the heavy/
 * nested doc-block tree stays opt-in rather than bloating every
 * universal item read (`item get` / `list` / `find` / `search` /
 * `subitems` / `history`) with description JSON payloads.
 *
 * **Why a separate verb (D1 closure, pre-flight 2026-05-23).** The
 * candidate trade-off between (a) extending `ITEM_FIELDS_FRAGMENT`
 * universally and (b) shipping a narrow verb was decided in favour
 * of (b) per the v0.9-M52-graduated "Read-side field-add" rule
 * (`.claude/rules/workflow.md`): heavy/nested fields with selective
 * agent utility → narrow verb; lightweight + universally-useful →
 * shared schema. `Item.description` is heavy (OBJECT with a
 * `LIST<DocumentBlock>` each carrying a JSON-scalar `content`
 * payload) and most items have no description. Universal projection
 * would bloat `item list`'s N-row responses without commensurate
 * agent value.
 *
 * **Wire shape & SDK drift.** Raw GraphQL via `client.raw<T>` —
 * `Item.description` is not exposed by `@mondaydotcomorg/api`
 * 14.0.0's typed surface (`ItemDescription` isn't in the generated
 * type set). Same SDK-drift class as `Board.is_leaf` /
 * `Board.hierarchy_type` / `Board.views`. The cassette `match_query:
 * /description \{/` selection-pin + `RUN_LIVE_TESTS` smoke applies
 * per the v0.9-M52-graduated guard (`.claude/rules/testing.md`).
 *
 * **`description: null` semantics.** Monday returns
 * `description: null` for items that never had a description set
 * (probed at pre-flight against a fresh classic-board item). The
 * verb normalises that wire shape to the sentinel `{id: null,
 * blocks: []}` so the single-resource envelope's `data` is always a
 * stable object (the table renderer iterates `Object.keys`, so a
 * literal `null` would crash it). Agents distinguish the cases via
 * `data.id === null` (no description set) vs `data.id !== null`
 * (description present; `data.blocks` carries the body).
 *
 * Idempotent: yes — pure read.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError } from '../../utils/errors.js';
import { isPlainObject } from '../../utils/json.js';
import {
  ITEM_DESCRIPTION_QUERY,
  itemDescriptionSchema,
  parseItemDescription,
  type ItemDescription,
} from '../../api/item-description.js';

// Output is always `ItemDescription` (never bare null). The wire-null
// case (item has no description set) is normalised to the sentinel
// `{id: null, blocks: []}` inside `parseItemDescription` so the table
// renderer + JSON consumers see a stable object shape.
export const itemGetDescriptionOutputSchema = itemDescriptionSchema;
export type ItemGetDescriptionOutput = ItemDescription;

const inputSchema = z.object({ itemId: ItemIdSchema }).strict();

export const itemGetDescriptionCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemGetDescriptionOutput
> = {
  name: 'item.get-description',
  summary: "Show one item's description (doc-block list)",
  examples: [
    'monday item get-description 12345',
    'monday item get-description 12345 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemGetDescriptionOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item');
    noun
      .command('get-description <itemId>')
      .description(itemGetDescriptionCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...itemGetDescriptionCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (itemId: unknown) => {
        const parsed = parseArgv(itemGetDescriptionCommand.inputSchema, {
          itemId,
        });
        const { client, toEmit } = resolveClient(ctx, program.opts());
        const response = await client.raw<unknown>(
          ITEM_DESCRIPTION_QUERY,
          { ids: [parsed.itemId] },
          { operationName: 'ItemGetDescription' },
        );
        const data = response.data;
        const items = isPlainObject(data) ? data.items : null;
        const first: unknown = Array.isArray(items) ? items[0] : undefined;
        if (first === undefined || first === null) {
          throw new ApiError(
            'not_found',
            `Monday returned no item for id ${parsed.itemId}`,
            { details: { item_id: parsed.itemId } },
          );
        }
        // Pluck `description` off the item row (item id is selected
        // only so the `runByIdLookup`-style not_found path can fire
        // on a missing item; we surface the description payload, not
        // the item row itself).
        //
        // Codex pre-flight R1 P2-1 (W8): guard against a malformed
        // `items[0]` (a non-object scalar like `42` or a string —
        // shape regression). Without this guard,
        // `isPlainObject(first) ? first.description : null` collapses
        // to `null`, which `parseItemDescription` then normalises to
        // the sentinel `{id: null, blocks: []}` — making a malformed
        // row indistinguishable from "no description set". Surface
        // the shape failure explicitly so agents key on
        // `internal_error` instead of silently seeing absent data.
        if (!isPlainObject(first)) {
          throw new ApiError(
            'internal_error',
            `Monday returned a malformed item row for id ${parsed.itemId}`,
            {
              details: {
                item_id: parsed.itemId,
                reason: 'malformed_item_row',
              },
            },
          );
        }
        const descriptionRaw = first.description;
        const projected = parseItemDescription(descriptionRaw, {
          item_id: parsed.itemId,
        });
        emitSuccess({
          ctx,
          data: projected,
          schema: itemGetDescriptionCommand.outputSchema,
          programOpts: program.opts(),
          ...toEmit(response),
        });
      });
  },
};
