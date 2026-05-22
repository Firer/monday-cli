/**
 * `Item.description` projection — the doc-block tree Monday attaches
 * to each item (`cli-design.md` §6.2 item-variant carve-out).
 *
 * Wire shape (API `2026-01`, probed at v0.11-M54-G pre-flight
 * 2026-05-23 — `scripts/probe/v0.11-item-description-2026-01.report.txt`):
 *
 *   Item.description: ItemDescription
 *     id: ID
 *     blocks: [DocumentBlock]
 *
 *   DocumentBlock (9 wire fields):
 *     id              NON_NULL String   ← required
 *     type            String            ← block-kind discriminator
 *     content         JSON              ← body payload (JSON scalar)
 *     position        Float             ← ordering
 *     parent_block_id String
 *     doc_id          ID
 *     created_at      Date
 *     created_by      User
 *     updated_at      Date
 *
 * The CLI projection surfaces a narrow 4-field block — `id`, `type`,
 * `content`, `position`. The 5 metadata-side fields (parent_block_id,
 * doc_id, created_at, created_by, updated_at) are dropped for the
 * v0.11-M54-G read surface; agents who need them can call the
 * existing `doc get`-tier verbs (`doc get` returns the full doc with
 * the same `DocumentBlock` projection at M32). Future bumps may
 * widen — kept narrow now so the surface stays focused on the
 * description-body use case.
 *
 * **SDK-drift class.** `Item.description` is NOT exposed by
 * `@mondaydotcomorg/api` 14.0.0's typed surface (`ItemDescription`
 * isn't in the generated types). Raw GraphQL via `client.raw<T>` per
 * `cli-design.md` §2.8 / §2.9 — same drift class as `Board.is_leaf`
 * / `Board.hierarchy_type` / `Board.views`. The v0.9-M52-graduated
 * "Wire selection-pin for raw-GraphQL SDK-drift fields"
 * (`.claude/rules/testing.md`) two-layer guard applies:
 *
 *   1. Cassette `match_query: /description \{/` on at least one
 *      integration test (`tests/integration/commands/item-get-
 *      description.test.ts`).
 *   2. `RUN_LIVE_TESTS`-gated `toHaveProperty('description')` on the
 *      live `items` response in
 *      `tests/e2e/live-schema-drift.test.ts`.
 *
 * **Required-nullable.** `description` is wire-nullable on items
 * with no description ever set (the probe confirmed
 * `description: null` on a fresh classic-board item). Mirrors M51's
 * `hierarchy_type` precedent: pre-v0.11 cache entries lacking the
 * key auto-invalidate via strict-parse failure (the corrupt-cache →
 * live re-fetch contract).
 *
 * **`content` shape.** `DocumentBlock.content` is a JSON scalar
 * (`SCALAR/JSON`, returned as a parsed object — the raw shape varies
 * by block `type` per Monday's doc-content model). Surfaced as
 * `unknown` through `jsonScalarOrNull` (same helper as M52's
 * `BoardView.settings` / `.sort` / `.filter` — rejects `undefined`
 * so fixtures can't silently omit a wire-selected field, accepts
 * `null` / objects / arrays / primitives).
 */

import { z } from 'zod';
import { unwrapOrThrow } from '../utils/parse-boundary.js';

// JSON-scalar helper. Lifted from `board-metadata.ts` (`jsonScalarOrNull`)
// — see R-v0.9-NEW-10 (`docs/v0.9-plan.md` §22). Two consumers now
// (`BoardView.{settings,sort,filter}` + `DocumentBlock.content`); the
// formal lift to a shared `src/api/zod-helpers.ts` waits for the 3rd
// consumer per the R-class register.
const jsonScalarOrNull = z
  .unknown()
  .refine((v) => v !== undefined, { message: 'expected JSON scalar' })
  .nullable();

/**
 * Per-block projection. 4 of `DocumentBlock`'s 9 wire fields — the
 * minimum useful slice for agents fetching an item's description
 * body. `id` is wire-NON_NULL String; others are nullable per the
 * 2026-01 introspection.
 */
export const documentBlockSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().nullable(),
    content: jsonScalarOrNull,
    position: z.number().nullable(),
  })
  .strict();

export type DocumentBlock = z.infer<typeof documentBlockSchema>;

/**
 * `Item.description` projection — `{id, blocks}`.
 *
 * `id` is `z.string().nullable()` so the normalised "no description
 * set" sentinel `{id: null, blocks: []}` parses through the same
 * schema as a populated description. Per `parseItemDescription`
 * below, a wire `description: null` (the probed shape on an item
 * that never had a description) collapses to that sentinel before
 * emit — letting the single-resource envelope's `data` stay a
 * stable object shape (the table renderer iterates `Object.keys`,
 * so a literal `null` would crash it). Agents distinguish the
 * cases via `data.id === null` (no description set) vs
 * `data.id !== null` (description present; `blocks` may be empty
 * if every block was deleted).
 *
 * `blocks` is `LIST<DocumentBlock>` on the wire and surfaced
 * verbatim — empty array when absent, populated when present.
 */
export const itemDescriptionSchema = z
  .object({
    id: z.string().nullable(),
    blocks: z.array(documentBlockSchema),
  })
  .strict();

export type ItemDescription = z.infer<typeof itemDescriptionSchema>;

/**
 * Production GraphQL document for `items.description` read at API
 * `2026-01`. Exported so the `RUN_LIVE_TESTS` schema-drift smoke
 * test runs the EXACT document against the live API — same drift-
 * catcher discipline as `BOARD_METADATA_QUERY` / `BOARD_GET_QUERY`.
 *
 * `match_query: /description \{/` on cassette mocks catches a
 * CI-side selection drop (a refactor that drops the `description`
 * block from the document); the live smoke catches a Monday-side
 * removal.
 */
export const ITEM_DESCRIPTION_QUERY = `
  query ItemGetDescription($ids: [ID!]!) {
    items(ids: $ids) {
      id
      description {
        id
        blocks {
          id
          type
          content
          position
        }
      }
    }
  }
`;

/**
 * Parses one raw `Item.description` payload (the value at
 * `data.items[0].description`) and surfaces a typed
 * `ItemDescription`. A wire `description: null` (the probed shape on
 * an item that never had a description set) normalises to the
 * sentinel `{id: null, blocks: []}` — keeps the envelope's `data`
 * an iterable object so the table renderer + JSON consumers see a
 * stable shape (see schema notes above for the agent-side
 * distinction). R18 parse-boundary wrap per `validation.md`: a
 * non-sentinel shape regression surfaces with `details.issues`
 * rather than a bare ZodError losing the failing field path.
 */
export const parseItemDescription = (
  raw: unknown,
  details: Readonly<Record<string, unknown>>,
): ItemDescription => {
  if (raw === null || raw === undefined) {
    return { id: null, blocks: [] };
  }
  return unwrapOrThrow(itemDescriptionSchema.safeParse(raw), {
    context:
      'Monday returned a malformed item-description payload',
    details,
    hint:
      'this is a data-integrity error in Monday\'s response (or an ' +
      'itemDescriptionSchema drift); verify the response shape and ' +
      'update the schema if Monday\'s contract has changed.',
  });
};
