/**
 * Update-mutation projection + GraphQL field-fragment, lifted from
 * five M13 mutation verbs and two M3 / M5b read-or-write call sites
 * (v0.2-plan §20 R37 + R38).
 *
 * **R37 — `projectMutationUpdate`.** Every M13 mutation verb (`update
 * reply` / `edit` / `delete` plus the four toggle verbs `like` /
 * `unlike` / `pin` / `unpin`) returns the post-mutation `Update` and
 * guards a null payload with the same shape: a typed throw carrying
 * `details.update_id` (or `parent_id` for reply, which keys errors
 * off the parent the agent passed on argv), then a strict zod parse
 * to surface the §6.4 mutation envelope's `data: <projected
 * snapshot>`. Mirrors R28's `projectMutationItem` exactly with
 * `Update` substituted for `Item`.
 *
 * Lifted from five sites — see v0.2-plan §20 R37:
 *   - `commands/update/reply.ts` (M13 — local `projectReply`,
 *     `idKey: 'parent_id'` because the argv input is the parent,
 *     not the new update).
 *   - `commands/update/edit.ts` (M13 — local `projectEdited`).
 *   - `commands/update/delete.ts` (M13 — local `projectDeleted`).
 *   - `commands/update/toggle.ts` (M13 — local `projectToggle`,
 *     consumed by four toggle verbs via per-verb `mutationName`).
 *   - `commands/update/clear-all.ts` (M13 — uses the null-check-only
 *     variant; see "Why two exports" below).
 *
 * **Why two exports.** Four of the five lift sites parse the wire
 * payload against the full `updateProjectionSchema`. Clear-all's
 * `DELETE_UPDATE_MUTATION` deliberately selects only `{ id }` (per-
 * target round-trip; no projection is emitted in `data.results[i]`),
 * so the strict schema would fail on every successful delete. The
 * lift therefore exposes two seams:
 *
 *   - `projectMutationUpdate({raw, updateId, mutationName, idKey?})`
 *     — null-check + strict parse + projection. Used by reply / edit
 *     / delete / toggle.
 *   - `assertUpdateMutationPresent({raw, updateId, mutationName,
 *     idKey?})` — null-check + typed throw, no projection. Used by
 *     clear-all's per-target dispatch.
 *
 * Both share `buildNotFoundError` so the typed throw's shape (code,
 * message format, `details.<idKey>`) is identical across all five
 * sites — agents key off `error.code` + `error.details.update_id`
 * (or `parent_id`) without caring which verb threw.
 *
 * **R38 — `UPDATE_FIELDS_FRAGMENT`.** The GraphQL selection set every
 * Update-shape mutation + the M3 `update get` read share. Mirrors
 * `ITEM_FIELDS_FRAGMENT` (M5b lift in `item-helpers.ts`); a future
 * §6.4 wire-shape addition is a one-touch fragment edit instead of
 * a six-touch sweep across `update create` / `reply` / `edit` /
 * `delete` / `toggle` / `get`. Indentation matches the 6-space
 * continuation each consumer interpolates at, so rendered query
 * bytes are unchanged post-lift.
 *
 * **What stays at the call site.** Reply's `parent_id` echo from
 * argv (`{...projected, parent_id: parentId}`) is a caller-side
 * extension — the helper returns the base `UpdateProjection` and
 * reply spreads onto it before emit. Mirrors R28's handling of
 * `item duplicate`'s `duplicated_from_id` extension. `update get`'s
 * extra `edited_at` + `replies` slots are likewise composed at the
 * call site (`${UPDATE_FIELDS_FRAGMENT}\n  edited_at\n  replies
 * {...}`); the fragment is the shared subset, callers compose extras
 * on top — same shape `item subitems` uses against
 * `ITEM_FIELDS_FRAGMENT`.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import { ItemIdSchema, UpdateIdSchema } from '../types/ids.js';

/**
 * Shared GraphQL selection set for the Update shape — every M13
 * mutation verb plus M5b's `update create` and M3's `update get`
 * select these fields. 6-space continuation indent matches the
 * column every consumer interpolates `${UPDATE_FIELDS_FRAGMENT}` at,
 * so rendered query bytes are unchanged post-lift.
 */
export const UPDATE_FIELDS_FRAGMENT = `id
      body
      text_body
      creator_id
      creator { id name email }
      item_id
      created_at
      updated_at`;

const creatorSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
  })
  .strict();

/**
 * Strict zod schema for the post-mutation `Update` projection — the
 * exact shape `UPDATE_FIELDS_FRAGMENT` selects from the wire. Reply's
 * output extends this with `parent_id` at the call site.
 */
export const updateProjectionSchema = z
  .object({
    id: UpdateIdSchema,
    body: z.string(),
    text_body: z.string().nullable(),
    creator_id: z.string().nullable(),
    creator: creatorSchema.nullable(),
    item_id: ItemIdSchema.nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
  })
  .strict();

export type UpdateProjection = z.infer<typeof updateProjectionSchema>;

/** `'update_id'` for the M13 verbs; `'parent_id'` for `update reply`
 *  (the argv input is the parent, not the new update). */
export type UpdateMutationIdKey = 'update_id' | 'parent_id';

export interface UpdateMutationContext {
  readonly updateId: string;
  /** Mutation root-field name for the not_found message
   *  (`create_update` / `edit_update` / `delete_update` /
   *  `like_update` / `unlike_update` / `pin_to_top` /
   *  `unpin_from_top`). */
  readonly mutationName: string;
  /** Defaults to `'update_id'`. */
  readonly idKey?: UpdateMutationIdKey;
}

export interface ProjectMutationUpdateInputs extends UpdateMutationContext {
  readonly raw: unknown;
}

const buildNotFoundError = (
  mutationName: string,
  updateId: string,
  idKey: UpdateMutationIdKey,
): ApiError =>
  new ApiError(
    'not_found',
    `Monday returned no update from ${mutationName} for id ${updateId}`,
    { details: { [idKey]: updateId } },
  );

/**
 * Null-check-only variant for sites whose GraphQL selection is too
 * narrow to parse against `updateProjectionSchema` (currently just
 * `update clear-all`'s per-target `delete_update` round-trip, which
 * selects only `{ id }`). Throws the same typed `not_found` shape
 * the projecting helper does so agents see one error contract across
 * every M13 mutation verb.
 */
export const assertUpdateMutationPresent = (
  raw: unknown,
  ctx: UpdateMutationContext,
): void => {
  if (raw === null || raw === undefined) {
    throw buildNotFoundError(ctx.mutationName, ctx.updateId, ctx.idKey ?? 'update_id');
  }
};

/**
 * Parses + projects a post-mutation `Update` payload, throwing the
 * typed `not_found` on null/undefined and `internal_error` (via the
 * R18 parse-boundary wrap) on a malformed shape. The helper owns
 * both error envelopes; callers compose post-projection extras
 * (reply's `parent_id` echo) at the call site.
 *
 * `details: { <idKey>: updateId }` is supplied by the helper so
 * every consumer carries the same envelope shape — agents key off
 * `details.update_id` (or `details.parent_id` for reply's not_found
 * path) regardless of which mutation verb threw.
 */
export const projectMutationUpdate = (
  inputs: ProjectMutationUpdateInputs,
): UpdateProjection => {
  const idKey = inputs.idKey ?? 'update_id';
  if (inputs.raw === null || inputs.raw === undefined) {
    throw buildNotFoundError(inputs.mutationName, inputs.updateId, idKey);
  }
  return unwrapOrThrow(updateProjectionSchema.safeParse(inputs.raw), {
    context: `Monday returned a malformed update payload for id ${inputs.updateId}`,
    details: { [idKey]: inputs.updateId },
  });
};
