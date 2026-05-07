/**
 * Live-mutation null-result projection for the M17 group lifecycle
 * cluster (`v0.2-plan.md` §22 R48 lift).
 *
 * Five M17 verbs share a near-verbatim shape: null-check the wire
 * payload, throw a typed ApiError on null carrying both
 * `details.board_id` and `details.group_id` (the group-mutation
 * wire signature is two-tuple — `create_group` carries `board_id`
 * only pre-id, but the read-side projection always pairs the two),
 * then parse through `groupProjectionSchema` to surface the §6.4
 * mutation envelope's `data: <projected snapshot>`.
 *
 * Lifted alongside the first M17 group verb commit (mirroring R45's
 * "ship the projection helper alongside the first new mutation
 * rather than as a follow-up R-class" precedent — same precedent
 * R39 originally established). The five M17 verbs land in the same
 * milestone, so adopting the helper from day one avoids five
 * parallel inline implementations of the same shape. cf. R28
 * (`projectMutationItem`), R37 (`projectMutationUpdate`), R43
 * (`projectMutationBoard`), R45 (`projectMutationColumn`); R48
 * ships the fifth per-noun helper at the firmest 5-consumer trigger
 * any projection-helper lift has had to date (R39 fired at 3, R45
 * at 3, R48 at 5).
 *
 * **Why parameterised on `errorCode` + `errorMessage`.** Like
 * R28 / R37 / R43 / R45, the M17 verbs diverge in error semantics:
 *   - `group-create` chose `internal_error` (every successful call
 *     returns a Group — a null payload means Monday glitched
 *     server-side, abnormal); the `details` carry `board_id` +
 *     `name` (no group_id yet).
 *   - `group-update`, `group-archive`, `group-duplicate`,
 *     `group-delete` chose `not_found` (Monday's idiomatic null-
 *     for-missing-or-no-access response — a typed agent-recovery
 *     story); all four carry `board_id` + `group_id`.
 * The helper owns the boilerplate (null check, `details: {board_id,
 * [idKey]: idValue}` envelope, the `unwrapOrThrow` schema parse);
 * each call site supplies its own typed error parts.
 *
 * **`GROUP_FIELDS_FRAGMENT` + `groupProjectionSchema` co-ship.**
 * Mirrors R39's `WORKSPACE_FIELDS_FRAGMENT` + `workspaceProjection
 * Schema`, R43's `BOARD_FIELDS_FRAGMENT` + `boardProjectionSchema`,
 * and R45's `COLUMN_FIELDS_FRAGMENT` + `columnProjectionSchema`
 * patterns. The schema mirrors the `groupSchema` already in
 * `src/api/board-metadata.ts` (the read-side cache projection) but
 * exists as an exported strict projection schema so M17's five
 * mutation verbs share one source of truth for the on-the-wire
 * Group shape. The field set covers the full Group metadata —
 * every Group field except `items_page`, which is the group's
 * items rather than group metadata and is out of scope for the
 * mutation envelope's `data` slot (M17 pre-flight load-bearing
 * finding).
 *
 * **What stays at the call site.** The wire-shape parse of the full
 * mutation response (`responseSchema.safeParse(response.data)`)
 * stays inline because each verb's response root key (`create_
 * group` / `update_group` / `archive_group` / `duplicate_group` /
 * `delete_group`) is per-verb. The missing-root-key check (schema-
 * drift → `internal_error` with a `hint`) stays inline too —
 * that's Codex M15 implementation round-2 F1's distinction between
 * schema-drift and null-payload, deliberately preserved at each
 * site. R42 would unify the missing-root-key check across all
 * pre-M14 mutation verbs once scheduled.
 */

import { z } from 'zod';
import { ApiError, type ErrorCode } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';

/**
 * Shared GraphQL selection set for the M17 group projection. 6-space
 * continuation indent matches the column every consumer interpolates
 * `${GROUP_FIELDS_FRAGMENT}` at, so rendered query bytes stay stable
 * across consumers. Mirrors `BOARD_FIELDS_FRAGMENT` (R43),
 * `WORKSPACE_FIELDS_FRAGMENT` (R39), and `COLUMN_FIELDS_FRAGMENT`
 * (R45).
 *
 * Field set tracks `boardMetadataSchema.groups[*]` (the read-side
 * cache projection) so a `board describe` after a successful group
 * mutation returns the same JSON shape the mutation envelope did.
 * `items_page` is deliberately excluded — that's the group's items,
 * not group metadata, and is out of scope for the mutation
 * envelope's `data` slot.
 */
export const GROUP_FIELDS_FRAGMENT = `id
      title
      color
      position
      archived
      deleted`;

/**
 * Strict zod schema for the group projection — the exact shape
 * `GROUP_FIELDS_FRAGMENT` selects from the wire. Shared by all
 * five M17 group verbs; each verb's `CommandModule.outputSchema`
 * aliases this so the schema-export pipeline emits one canonical
 * shape.
 *
 * Mirrors `boardMetadataSchema.groups[*]` in `board-metadata.ts`
 * verbatim — same fields, same nullability — so a `board describe`
 * after a successful group mutation reads the same JSON shape the
 * mutation envelope wrote.
 */
export const groupProjectionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    color: z.string().nullable(),
    position: z.string().nullable(),
    archived: z.boolean().nullable(),
    deleted: z.boolean().nullable(),
  })
  .strict();

export type GroupProjection = z.infer<typeof groupProjectionSchema>;

/**
 * Group-mutation detail key — varies between create (`name` echo,
 * since the new group id doesn't exist pre-call) and update /
 * archive / duplicate / delete (`group_id`, since all four operate
 * on an existing group). All M17 verbs additionally echo `board_id`
 * because the group-mutation wire signature is two-tuple.
 */
export type GroupMutationDetailKey = 'group_id' | 'name';

export interface ProjectMutationGroupInputs {
  readonly raw: unknown;
  readonly errorCode: ErrorCode;
  /**
   * Full caller-formatted message for the null-payload throw —
   * e.g. `"Monday returned no group payload from delete_group for
   * board 12345 group topics"`. Per-verb phrasing is preserved
   * verbatim because agents key off the message text in error
   * logs.
   */
  readonly errorMessage: string;
  readonly boardId: string;
  /**
   * Whether the call site identifies the group by its already-
   * known id (`group_id`, used by update / archive / duplicate /
   * delete) or by the agent-supplied name (`name`, used by create
   * — no id exists pre-call). The helper keys `details.<idKey>`
   * accordingly so agents key off the right field without having
   * to switch on the verb.
   */
  readonly idKey: GroupMutationDetailKey;
  readonly idValue: string;
}

/**
 * Parses + projects a live-mutation `Group` payload, throwing the
 * supplied typed error on null/undefined. Caller owns the error
 * code + message so create's `internal_error` / "no group payload
 * from create_group for board <X> name <Y>" and update's /
 * archive's / duplicate's / delete's `not_found` / "no group
 * payload from <op> for board <X> group <Y>" all survive the lift
 * byte-for-byte.
 *
 * `details: { board_id, [idKey]: idValue }` is supplied by the
 * helper so every consumer carries the same envelope shape —
 * agents key off `details.board_id` + `details.group_id` (or
 * `details.name` on create's pre-id path) regardless of which verb
 * threw (cli-design §6.5).
 */
export const projectMutationGroup = ({
  raw,
  errorCode,
  errorMessage,
  boardId,
  idKey,
  idValue,
}: ProjectMutationGroupInputs): GroupProjection => {
  const details: Readonly<Record<string, unknown>> = {
    board_id: boardId,
    [idKey]: idValue,
  };
  if (raw === null || raw === undefined) {
    throw new ApiError(errorCode, errorMessage, { details });
  }
  const subjectPhrase =
    idKey === 'name'
      ? `board ${boardId} name ${JSON.stringify(idValue)}`
      : `board ${boardId} group ${idValue}`;
  return unwrapOrThrow(groupProjectionSchema.safeParse(raw), {
    context: `Monday returned a malformed group payload for ${subjectPhrase}`,
    details,
  });
};
