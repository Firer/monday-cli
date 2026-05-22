/**
 * Board projection schema + GraphQL field-fragment for the M15 board
 * lifecycle cluster (`v0.2-plan.md` §3 M15, mirrors R39's
 * workspace-projection lift).
 *
 * **`BOARD_FIELDS_FRAGMENT`.** The shared GraphQL selection set
 * every M15 board-shape verb uses. `board create` / `update` /
 * `archive` / `duplicate` all return the full Board projection;
 * `update`'s preflight read uses the same fragment too. Five of
 * the M15 cluster's GraphQL strings interpolate this fragment.
 * 6-space continuation indent matches the column every consumer
 * interpolates `${BOARD_FIELDS_FRAGMENT}` at, so rendered query
 * bytes stay stable across consumers. Mirrors
 * `WORKSPACE_FIELDS_FRAGMENT` (R39 workspace-projection lift) and
 * `ITEM_FIELDS_FRAGMENT` (M5b item-helpers lift).
 *
 * **`boardProjectionSchema`.** The matching strict zod projection
 * schema. The field set matches `board/get.ts`'s
 * `boardGetOutputSchema` so a successful `board create` /
 * `update` / `duplicate` returns the exact JSON shape a follow-
 * up `board get <bid>` would return — agents see one canonical
 * Board shape across read and mutation envelopes. `board get`
 * itself migrates to this fragment + schema in this M15 commit
 * so the projection stays single-sourced from day one (the same
 * R39-pattern bundling the §22 recommendation calls out: ship
 * the projection helper alongside the first new mutation rather
 * than as a follow-up R-class).
 *
 * **Distinct from `boardMetadataSchema`.** `board describe` /
 * column-resolution paths use the heavier `boardMetadataSchema`
 * in `api/board-metadata.ts` (carries `groups: [...]` and
 * `columns: [...]`). The lifecycle cluster doesn't need those
 * arrays — `board describe` stays the documented path for
 * column / group inspection, and the cache layer in
 * board-metadata is kept untouched by M15 (the eager-
 * invalidation contract that ties post-mutation cache state to
 * the metadata cache is M16's scope).
 */

import { z } from 'zod';

/**
 * Shared GraphQL selection set for the M15 board lifecycle
 * projection. 6-space continuation indent matches the column
 * every consumer interpolates `${BOARD_FIELDS_FRAGMENT}` at, so
 * rendered query bytes are unchanged post-lift.
 */
export const BOARD_FIELDS_FRAGMENT = `id
      name
      description
      state
      board_kind
      board_folder_id
      workspace_id
      url
      hierarchy_type
      items_count
      updated_at
      permissions`;

/**
 * Strict zod schema for the board projection — the exact shape
 * `BOARD_FIELDS_FRAGMENT` selects from the wire. Shared by
 * `board get` / `create` / `update` / `archive` / `duplicate`;
 * each verb's `CommandModule.outputSchema` aliases this so the
 * schema-export pipeline emits one canonical shape.
 */
export const boardProjectionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    state: z.string().nullable(),
    board_kind: z.string().nullable(),
    board_folder_id: z.string().nullable(),
    workspace_id: z.string().nullable(),
    url: z.string().nullable(),
    // v0.9-M51: surfaced across the whole board projection (get + the
    // mutation cluster) so one read tells an agent which subitem model
    // a board uses. SDK 14.0.0 doesn't type it — selected via raw
    // GraphQL in BOARD_FIELDS_FRAGMENT. `string | null` (not an enum):
    // Monday returns `classic` / `multi_level` plus internal forms
    // (`top_level` / `parent`) the projection passes through. Matches
    // `boardMetadataSchema.hierarchy_type` (the describe path). See
    // cli-design §2.8.
    hierarchy_type: z.string().nullable(),
    items_count: z.number().int().nullable(),
    updated_at: z.string().nullable(),
    permissions: z.string().nullable(),
  })
  .strict();

export type BoardProjection = z.infer<typeof boardProjectionSchema>;
