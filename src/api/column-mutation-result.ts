/**
 * Live-mutation null-result projection for the M16 column lifecycle
 * cluster (`v0.2-plan.md` §22 R45 lift).
 *
 * Three M16 verbs share a near-verbatim shape: null-check the wire
 * payload, throw a typed ApiError on null carrying both
 * `details.board_id` and `details.column_id` (the column-mutation
 * wire signature is two-tuple — `create_column` carries
 * `board_id` only pre-id, but the read-side projection always pairs
 * the two), then parse through `columnProjectionSchema` to surface
 * the §6.4 mutation envelope's `data: <projected snapshot>`.
 *
 * Lifted alongside the first M16 column verb commit (mirroring R39's
 * "ship the projection helper alongside the first new mutation
 * rather than as a follow-up R-class" precedent — the three M16
 * verbs land in the same milestone, so adopting the helper from day
 * one avoids three parallel inline implementations of the same
 * shape). cf. R28 (`projectMutationItem`), R37 (`projectMutationUpdate`),
 * R43 (`projectMutationBoard`); R45 ships the fourth per-noun
 * helper at the same 3-consumer threshold.
 *
 * **Why parameterised on `errorCode` + `errorMessage`.** Like R28 /
 * R37 / R43, the M16 verbs diverge in error semantics:
 *   - `column-create` chose `internal_error` (every successful call
 *     returns a Column — a null payload means Monday glitched server-
 *     side, abnormal); the `details` carry `board_id` + `title` (no
 *     column_id yet).
 *   - `column-update` and `column-delete` chose `not_found`
 *     (Monday's idiomatic null-for-missing-or-no-access response —
 *     a typed agent-recovery story); both carry `board_id` +
 *     `column_id`.
 * The helper owns the boilerplate (null check, `details: { board_id,
 * [columnIdKey]: columnIdValue }` envelope, the `unwrapOrThrow`
 * schema parse); each call site supplies its own typed error parts.
 *
 * **`COLUMN_FIELDS_FRAGMENT` + `columnProjectionSchema` co-ship.**
 * Mirrors R39's `WORKSPACE_FIELDS_FRAGMENT` + `workspaceProjection
 * Schema` and R43's `BOARD_FIELDS_FRAGMENT` + `boardProjectionSchema`
 * pattern. The schema mirrors the `columnSchema` already in
 * `src/api/board-metadata.ts` (the read-side cache projection) but
 * exists as an exported strict projection schema so M16's three
 * mutation verbs share one source of truth for the on-the-wire
 * Column shape.
 *
 * **What stays at the call site.** The wire-shape parse of the full
 * mutation response (`responseSchema.safeParse(response.data)`) stays
 * inline because each verb's response root key (`create_column` /
 * `change_column_title` / `change_column_metadata` / `delete_column`)
 * is per-verb. The missing-root-key check (schema-drift →
 * `internal_error` with a `hint`) was Codex M15 implementation
 * round-2 F1's distinction between schema-drift and null-payload,
 * deliberately preserved at each site at M16 ship time. **R42
 * (post-v0.2 → v0.3 cleanup window — `c529445`) consolidated the
 * inline check across every column-mutation verb onto
 * `assertResponseFieldPresent`** with `nullHandling: 'caller_handles'`;
 * the helper runs immediately after each verb's
 * `unwrapOrThrow(responseSchema.safeParse(...))`, with
 * `projectMutationColumn` continuing to handle null-value per-noun.
 */

import { z } from 'zod';
import { ApiError, type ErrorCode } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';

/**
 * Shared GraphQL selection set for the M16 column projection. 6-space
 * continuation indent matches the column every consumer interpolates
 * `${COLUMN_FIELDS_FRAGMENT}` at, so rendered query bytes stay
 * stable across consumers. Mirrors `BOARD_FIELDS_FRAGMENT` (R43) and
 * `WORKSPACE_FIELDS_FRAGMENT` (R39).
 *
 * Field set tracks `boardMetadataSchema.columns[*]` (the read-side
 * cache projection) so a `board describe` after a successful column
 * mutation returns the same JSON shape the mutation envelope did.
 */
export const COLUMN_FIELDS_FRAGMENT = `id
      title
      type
      description
      archived
      settings_str
      width`;

/**
 * Strict zod schema for the column projection — the exact shape
 * `COLUMN_FIELDS_FRAGMENT` selects from the wire. Shared by
 * M16's `column-create` / `column-update` / `column-delete`; each
 * verb's `CommandModule.outputSchema` aliases this so the schema-
 * export pipeline emits one canonical shape.
 *
 * Mirrors `boardMetadataSchema.columns[*]` in `board-metadata.ts`
 * verbatim — same fields, same nullability — so a `board describe`
 * after a successful column mutation reads the same JSON shape the
 * mutation envelope wrote.
 */
export const columnProjectionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    type: z.string().min(1),
    description: z.string().nullable(),
    archived: z.boolean().nullable(),
    settings_str: z.string().nullable(),
    width: z.number().nullable(),
  })
  .strict();

export type ColumnProjection = z.infer<typeof columnProjectionSchema>;

/**
 * Column-mutation detail key — varies between create (`title` echo,
 * since the new column id doesn't exist pre-call) and update / delete
 * (`column_id`, since both operate on an existing column). All M16
 * verbs additionally echo `board_id` because the column-mutation wire
 * signature is two-tuple.
 */
export type ColumnMutationDetailKey = 'column_id' | 'title';

export interface ProjectMutationColumnInputs {
  readonly raw: unknown;
  readonly errorCode: ErrorCode;
  /**
   * Full caller-formatted message for the null-payload throw — e.g.
   * `"Monday returned no column payload from delete_column for board
   * 12345 column status_4"`. Per-verb phrasing is preserved verbatim
   * because agents key off the message text in error logs.
   */
  readonly errorMessage: string;
  readonly boardId: string;
  /**
   * Whether the call site identifies the column by its already-known
   * id (`column_id`, used by update / delete) or by the agent-supplied
   * title (`title`, used by create — no id exists pre-call). The
   * helper keys `details.<columnIdKey>` accordingly so agents key off
   * the right field without having to switch on the verb.
   */
  readonly columnIdKey: ColumnMutationDetailKey;
  readonly columnIdValue: string;
}

/**
 * Parses + projects a live-mutation `Column` payload, throwing the
 * supplied typed error on null/undefined. Caller owns the error code
 * + message so create's `internal_error` / "no column payload from
 * create_column for board <X> title <Y>" and update's / delete's
 * `not_found` / "no column payload from <op> for board <X> column
 * <Y>" both survive the lift byte-for-byte.
 *
 * `details: { board_id, [columnIdKey]: columnIdValue }` is supplied
 * by the helper so every consumer carries the same envelope shape —
 * agents key off `details.board_id` + `details.column_id` (or
 * `details.title` on create's pre-id path) regardless of which verb
 * threw (cli-design §6.5).
 */
export const projectMutationColumn = ({
  raw,
  errorCode,
  errorMessage,
  boardId,
  columnIdKey,
  columnIdValue,
}: ProjectMutationColumnInputs): ColumnProjection => {
  const details: Readonly<Record<string, unknown>> = {
    board_id: boardId,
    [columnIdKey]: columnIdValue,
  };
  if (raw === null || raw === undefined) {
    throw new ApiError(errorCode, errorMessage, { details });
  }
  const subjectPhrase =
    columnIdKey === 'title'
      ? `board ${boardId} title ${JSON.stringify(columnIdValue)}`
      : `board ${boardId} column ${columnIdValue}`;
  return unwrapOrThrow(columnProjectionSchema.safeParse(raw), {
    context: `Monday returned a malformed column payload for ${subjectPhrase}`,
    details,
  });
};
