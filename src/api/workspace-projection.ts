/**
 * Workspace projection schema + GraphQL field-fragment, lifted from
 * the four M14 mutation verbs and `workspace get` (v0.2-plan §22
 * R39).
 *
 * **R39 — `WORKSPACE_FIELDS_FRAGMENT`.** The shared GraphQL selection
 * set every with-settings workspace verb uses appeared in five query
 * strings: `workspace get` (M14), `workspace create` (M14), `workspace
 * update`'s preflight read + mutation (M14), `workspace delete` (M14).
 * Five consumers; well above the §17 R-timing trigger. Mirrors
 * `ITEM_FIELDS_FRAGMENT` (M5b lift in `item-helpers.ts`) and
 * `UPDATE_FIELDS_FRAGMENT` (R38 lift in `update-mutation-result.ts`).
 * 6-space continuation indent matches the column every consumer
 * interpolates `${WORKSPACE_FIELDS_FRAGMENT}` at, so rendered query
 * bytes are unchanged post-lift.
 *
 * **R39 — `workspaceProjectionSchema`.** The matching strict zod
 * projection schema. Pre-lift it lived at
 * `src/commands/workspace/get.ts:50` as `workspaceGetOutputSchema`,
 * and the four mutation verbs each imported it from there — the
 * file colocation was incidental rather than intentional. Lifting
 * the schema next to the fragment keeps the projection's two halves
 * (wire-shape selector + parser) in one place.
 *
 * **`workspace list` stays distinct.** Its narrower output (no
 * `settings.icon`) and parallel narrower GraphQL string serve a
 * different surface; extending it to share this fragment would
 * surface `settings.icon` on `workspace list`'s output as a
 * SemVer-minor additive change. R39's minimal scope keeps list
 * untouched.
 */

import { z } from 'zod';

/**
 * Shared GraphQL selection set for the workspace shape — every M14
 * mutation verb plus M14's `workspace get` (the with-settings path)
 * select these fields. 6-space continuation indent matches the
 * column every consumer interpolates `${WORKSPACE_FIELDS_FRAGMENT}`
 * at, so rendered query bytes are unchanged post-lift.
 */
export const WORKSPACE_FIELDS_FRAGMENT = `id
      name
      description
      kind
      state
      is_default_workspace
      created_at
      settings {
        icon {
          color
          image
        }
      }`;

const iconSchema = z
  .object({
    color: z.string().nullable(),
    image: z.string().nullable(),
  })
  .strict();

const settingsSchema = z
  .object({
    icon: iconSchema.nullable(),
  })
  .strict();

/**
 * Strict zod schema for the workspace projection — the exact shape
 * `WORKSPACE_FIELDS_FRAGMENT` selects from the wire. Shared by
 * `workspace get` / `create` / `update` / `delete`; each verb's
 * `CommandModule.outputSchema` aliases this so the schema-export
 * pipeline emits one canonical shape.
 */
export const workspaceProjectionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    kind: z.string().nullable(),
    state: z.string().nullable(),
    is_default_workspace: z.boolean().nullable(),
    created_at: z.string().nullable(),
    settings: settingsSchema.nullable(),
  })
  .strict();

export type WorkspaceProjection = z.infer<typeof workspaceProjectionSchema>;
