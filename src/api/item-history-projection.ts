/**
 * Per-item activity-log + comment-thread projection for the v0.3-M24
 * `monday item history <iid>` verb (`cli-design.md` §13 v0.3 entry).
 *
 * **What `monday item history` answers:** "show me every change +
 * comment on this item, chronologically, in one stream" — without
 * the agent walking `activity_logs` AND `updates` separately and
 * folding by `created_at` by hand. Two Monday surfaces feed the
 * stream:
 *
 *   1. `boards(ids:) { activity_logs(item_ids:, from:, to:,
 *      page:, limit:) }` — Monday's per-board activity log,
 *      filtered to the target item via `item_ids` AND additionally
 *      filtered WALKER-SIDE (post-fetch, before projection) to
 *      `entity = 'pulse'` (the `item_ids` arg ALONE does NOT
 *      exclude board-scoped events; empirical-probe finding
 *      2026-05-11). Page-numbered pagination (Monday's native
 *      shape; `--activity-logs-page <n>` / `--limit <n>` flags
 *      surface it).
 *   2. `items(ids:) { updates(limit:, page:) { ... replies { ...
 *      } } }` — Monday's comment thread (top-level updates +
 *      nested replies). Projected into synthesized
 *      `update_posted` + `update_replied` event-objects so the
 *      merged stream is uniform.
 *
 * The merge projector orders the unified stream by `created_at`
 * ascending; ties break by `id` for deterministic output across
 * runs.
 *
 * **Decision 2 closure** (`a1f3025`, M24-prep empirical probe pass
 * 2026-05-11; full findings at v0.3-plan §8 Decision 2 closure).
 * Three load-bearing findings from the live probe against a real
 * workspace + 19 captured `activity_logs` rows on a production
 * board:
 *
 *   - **Schema field name is `event`, NOT `kind`.** Monday's
 *     `ActivityLogType` exposes 7 fields per the introspection
 *     probe (all NON_NULL String): `account_id`, `created_at`,
 *     `data`, `entity`, `event`, `id`, `user_id`. The v0.3-plan
 *     §3 M24 description used "kind" as the synonym; the projector
 *     keeps `kind` as the CLI agent-facing discriminator (domain-
 *     neutral) but maps it 1:1 from the wire's `event` slot.
 *   - **Observed event taxonomy (production data; 19 rows on one
 *     board over 30 days; NOT exhaustive):** `create_column`
 *     (10×), `update_column_value` (4×; the dominant ITEM-SCOPED
 *     event), `create_group` (2×), `board_workspace_id_changed`
 *     (1×), `update_board_name` (1×), `update_board_nickname`
 *     (1×). The `update_column_value` payload carries `column_id`
 *     + `column_type` + `value` + `previous_value` + `textual_value`
 *     + `pulse_id` + `pulse_name`; `previous_value` is sometimes
 *     `{}` for first-set events (decode defensively as
 *     "previously-unset"). Per-`column_type` typed `before` /
 *     `after` projection lands case-by-case at M24 implementation;
 *     pre-flight pins the discriminator + raw-shape fallback.
 *   - **`entity` field discriminates item-scoped from board-scoped
 *     events.** Observed values: `pulse` (4×; item-scoped) and
 *     `board` (15×; board-scoped). The walker filters
 *     `entity = 'pulse'` to drop board-level noise (column
 *     additions, group creation, board renames) that aren't part
 *     of the item's history. **The `item_ids` filter alone is
 *     INSUFFICIENT** — passing it does NOT exclude board-scoped
 *     events from the response.
 *
 * **Eventual-consistency caveat (carry to cli-design §13 v0.3
 * entry).** Monday's `activity_logs` has an empirically-measured
 * propagation lag **>30s** on freshly-edited boards. The verb's
 * help text MUST NOT promise immediate-history for newly-modified
 * items; agents polling `monday item history` after a write should
 * wait at least 30s before expecting their write to surface.
 *
 * **Update + Reply shapes (also pinned by the probe).** `Update`
 * carries 16 fields per introspection; the projector projects only
 * the load-bearing ones: `id` (NON_NULL ID), `body` (NON_NULL
 * String), `text_body` (nullable String), `created_at` (nullable
 * `Date`), `creator_id` (nullable String), `replies` (LIST[Reply!]
 * with the list itself nullable; items non-null). `Reply` carries
 * its OWN `kind: String!` field — separate taxonomy from
 * `activity_logs.event` — and the projector surfaces it under the
 * synthesized `update_replied` event's `reply_kind` slot.
 *
 * **Runtime composition.** {@link fetchItemHistory} drives the
 * two-source walker; {@link projectActivityLogRow},
 * {@link projectUpdateRow}, and {@link projectReplyRow} are the
 * per-row projectors (the activity-log projector reads the wire
 * `data` JSON, dispatches on `event`, and applies a one-level
 * nested-JSON unwrap on `update_column_value`'s `value` /
 * `previous_value` so agents see the structured payload — e.g.
 * `{label, index}` for status, ISO string for date — rather than
 * an opaque JSON-string). The walker filters
 * `entity === ITEM_SCOPED_ENTITY` walker-side (single source of
 * truth per Decision 2 closure; projector does NOT re-filter).
 *
 * **Streaming reuse.** Per the v0.3-plan §3 M24 deliverable, the
 * verb reuses `startNdjsonStream` (R52) when `--stream` is on; the
 * trailer meta carries `{has_more, total_returned, complexity,
 * source}` per cli-design §6.3 + the symmetric page-numbered
 * per-source `activity_logs.last_page` + `updates.last_page` slots
 * (both 1-indexed; `null` when the walker exhausted that source) so
 * agents resuming a partial walk re-issue with the per-source
 * `last_page + 1`. No cursor surface at v0.3 — both sources
 * paginate page-numbered.
 */

import { z } from 'zod';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import type { MondayClient } from './client.js';
import type { Complexity, Warning } from '../utils/output/envelope.js';
import type { ItemId } from '../types/ids.js';

/**
 * Wire field name on `ActivityLogType` that discriminates
 * item-scoped (`pulse`) from board-scoped (`board`) events per the
 * Decision 2 closure entity-filter finding. The walker filters on
 * this constant before handing rows to the projector; the projector
 * itself does NOT re-filter (single source of truth at the walker
 * layer).
 */
export const ITEM_SCOPED_ENTITY = 'pulse' as const;

/**
 * Default per-page slice for `activity_logs(limit: <n>, page: <n>)`.
 * Monday's `activity_logs` resolver caps the per-call slice at 10000;
 * the CLI default of 100 keeps the per-call latency below the per-
 * page budget while letting `--limit <n>` cap the aggregate. Mirrors
 * the v0.1 `DEFAULT_PAGE_SIZE` of 100.
 */
export const DEFAULT_HISTORY_PAGE_SIZE = 100;

/**
 * Hard cap on `--limit` for `activity_logs` per-call slice. Monday's
 * documented ceiling is 10000; the CLI mirrors it so the parse
 * boundary rejects over-large requests with `usage_error` rather
 * than letting Monday's server-side rejection surface as
 * `validation_failed` mid-walk.
 */
export const HARD_CAP_HISTORY_PAGE_SIZE = 10_000;

/**
 * Stage-1 GraphQL document — `activity_logs` per-page slice.
 *
 * Per the Decision 2 closure introspection finding,
 * `ActivityLogType` has 7 NON_NULL String fields. The projector
 * reads all 6 non-`account_id` slots (`account_id` carries no
 * item-history signal — every row in a single-account CLI session
 * shares it).
 *
 * **`item_ids` filter is necessary BUT NOT SUFFICIENT.** Per the
 * probe finding, board-scoped events (entity = 'board') leak
 * through even with `item_ids` set. The WALKER
 * ({@link fetchItemHistory}) filters `row.entity ===
 * ITEM_SCOPED_ENTITY` immediately after the page parses and
 * BEFORE handing rows to {@link projectActivityLogRow}. The
 * projector itself does NOT re-filter — single source of truth at
 * the walker layer per Decision 2 closure. Server-side filtering
 * would require a custom GraphQL middleware Monday doesn't expose;
 * filtering later than the walker would force row-shaping code to
 * know about the entity discriminator, which belongs to the
 * walker's "which rows are part of THIS item's history" question,
 * not the projector's "how do I shape this row's payload" question.
 *
 * Monday's `activity_logs(item_ids:, from:, to:, page:, limit:)`
 * signature accepts ISO-8601 timestamps for `from` / `to` per the
 * sibling `created_at` ISO8601DateTime scalar; nullable on both
 * sides so a partial range (`--since` only / `--until` only) maps
 * cleanly to omitting the absent slot.
 */
export const ACTIVITY_LOGS_QUERY = `
  query ItemHistoryActivityLogs(
    $bid: [ID!]!,
    $iid: [ID!]!,
    $from: ISO8601DateTime,
    $to: ISO8601DateTime,
    $page: Int!,
    $limit: Int!
  ) {
    boards(ids: $bid) {
      id
      activity_logs(
        item_ids: $iid,
        from: $from,
        to: $to,
        page: $page,
        limit: $limit
      ) {
        id
        event
        entity
        user_id
        created_at
        data
      }
    }
  }
`;

/**
 * Stage-2 GraphQL document — `items(ids:) { updates(...) }` for
 * the comment-thread source.
 *
 * Per the Decision 2 closure introspection finding, `Update` has
 * 16 fields; the projector selects only the load-bearing slots
 * (id / body / text_body / created_at / creator_id / replies +
 * the Reply sub-selection). Other fields (`likes`, `pinned_to_top`,
 * `viewers`, `assets`) are not part of the item-history surface in
 * v0.3; M24 implementation may extend the projection if a v0.4
 * follow-up surfaces them under the `update_posted` event's
 * `after` slot (envelope-additive per §6.1).
 *
 * **Update.created_at + Reply.created_at are nullable** per the
 * probe introspection (both fields are `SCALAR/Date`, nullable).
 * The projector substitutes `Update.edited_at` (NON_NULL Date) as
 * the chronological key when `created_at` is null — silent
 * projection behaviour (NOT a warning surface; the substitution is
 * deterministic + agents observing a null-`created_at` Update on
 * the wire reproduce the same merge order on a re-walk). v0.3's
 * `warnings[]` shape is `unknown_event_kind` only; adding a
 * `synthesized_created_at` warning is a v0.4 envelope-additive
 * extension if the substitution turns out to be agent-visible in
 * practice.
 *
 * Monday's `updates(limit:, page:)` signature is page-numbered;
 * the projector exposes `--updates-page <n>` so the two sources
 * paginate independently (activity_logs and updates have their own
 * page counters; merging them onto a single `--page <n>` flag would
 * conflate two different denominators).
 */
export const UPDATES_QUERY = `
  query ItemHistoryUpdates(
    $iid: [ID!]!,
    $page: Int!,
    $limit: Int!
  ) {
    items(ids: $iid) {
      id
      updates(limit: $limit, page: $page) {
        id
        body
        text_body
        created_at
        edited_at
        creator_id
        replies {
          id
          kind
          body
          text_body
          created_at
          updated_at
          creator_id
        }
      }
    }
  }
`;

/**
 * Wire-shape schema for an `ActivityLogType` row (Decision 2 closure
 * introspection finding — 7 NON_NULL String fields). `.loose()` so
 * future Monday surface extensions don't break the parse — the
 * projector reads only the fields it knows about and forward-compat
 * fields pass through to no consumer.
 */
export const rawActivityLogRowSchema = z
  .object({
    id: z.string().min(1),
    event: z.string().min(1),
    entity: z.string().min(1),
    user_id: z.string().min(1),
    created_at: z.string().min(1),
    data: z.string(),
  })
  .loose();

export type RawActivityLogRow = z.infer<typeof rawActivityLogRowSchema>;

/**
 * Wire-shape schema for one `Reply` row inside `Update.replies`.
 * Per the Decision 2 closure introspection finding, `Reply.id` +
 * `Reply.body` + `Reply.kind` are NON_NULL; `Reply.created_at` is
 * nullable Date; `Reply.creator_id` is nullable String.
 *
 * **`Reply.kind` is a separate taxonomy from
 * `activity_logs.event`.** Reply's kind discriminates comment-thread
 * reply types (e.g., a regular reply vs a system-generated reply);
 * activity_logs's event discriminates board-level change types. The
 * projector surfaces `Reply.kind` under the synthesized
 * `update_replied` event's `reply_kind` slot so agents can
 * introspect it without confusion.
 */
export const rawReplyRowSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    kind: z.string().min(1),
    text_body: z.string().nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    creator_id: z.string().nullable(),
  })
  .loose();

export type RawReplyRow = z.infer<typeof rawReplyRowSchema>;

/**
 * Wire-shape schema for one `Update` row. `created_at` is nullable
 * per the probe introspection (Date scalar, optional); the
 * projector substitutes `edited_at` (NON_NULL Date) when
 * `created_at` is absent.
 */
export const rawUpdateRowSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    text_body: z.string().nullable(),
    created_at: z.string().nullable(),
    edited_at: z.string().min(1),
    creator_id: z.string().nullable(),
    replies: z.array(rawReplyRowSchema).nullable(),
  })
  .loose();

export type RawUpdateRow = z.infer<typeof rawUpdateRowSchema>;

/**
 * Common base-field shape on every projected `HistoryEvent` variant.
 *
 * - `id` — stable per-row identifier. Activity-log rows reuse the
 *   wire `ActivityLogType.id`; `update_posted` reuses
 *   `Update.id`; `update_replied` reuses `Reply.id`. Cross-source
 *   `id` clashes are not possible — Monday assigns separate ID
 *   spaces to activity_logs / updates / replies.
 * - `created_at` — ISO-8601 timestamp. The chronological merge key
 *   (see `mergeByCreatedAt`).
 * - `actor_id` — nullable to accommodate the wire variance:
 *   `ActivityLogType.user_id` is NON_NULL per the probe;
 *   `Update.creator_id` is nullable; `Reply.creator_id` is
 *   nullable. `null` means "no actor recorded" (system event,
 *   deleted user); agents distinguish via the variant `kind`.
 */
const baseEventFields = {
  id: z.string().min(1),
  created_at: z.string().min(1),
  actor_id: z.string().nullable(),
};

/**
 * **`update_column_value`** — the dominant ITEM-SCOPED activity-log
 * event per the Decision 2 closure observed-events list (4× of 19
 * rows; the only item-scoped kind in the sample). Carries the
 * column-edit before / after payload.
 *
 * The per-`column_type` typed `before` / `after` projection lands
 * case-by-case at M24 implementation. Pre-flight pins:
 *   - `column_id` + `column_type` from the wire `data` payload
 *     (always present per the probe).
 *   - `before` + `after` as `z.unknown()` slots carrying the raw
 *     parsed `previous_value` / `value` JSON. M24 impl swaps in
 *     per-`column_type` typed unions (status: `{label, index}`;
 *     date: ISO string; etc.).
 *   - `textual_value` — Monday's human-readable rendering of the
 *     new value (always present per the probe; nullable for
 *     defensive forward-compat with future column types Monday
 *     may not provide a textual rendering for).
 *   - `pulse_id` + `pulse_name` — item identity for cross-board
 *     consumers; nullable for subitem variants where the parent
 *     identification carries the load.
 */
export const updateColumnValueEventSchema = z
  .object({
    ...baseEventFields,
    kind: z.literal('update_column_value'),
    column_id: z.string().min(1),
    column_type: z.string().min(1),
    before: z.unknown(),
    after: z.unknown(),
    textual_value: z.string().nullable(),
    pulse_id: z.string().nullable(),
    pulse_name: z.string().nullable(),
  })
  .strict();

/**
 * Board-scoped activity-log variants. The walker filters
 * `entity = 'pulse'` BEFORE handing rows to the projector, so these
 * variants are not surfaced on the projected stream in normal
 * operation. Pre-flight retains them as parser-roundtrip targets
 * so a future M24 implementation regression that bypasses the
 * entity filter falls back to the typed variant rather than to
 * `unknown` (cleaner failure mode; agents see the expected kind
 * literal rather than a fallback shape).
 *
 * Per-kind `before` / `after` typing is M24 impl work — pre-flight
 * pins each variant as `before: z.unknown(), after: z.unknown()`
 * carrying the raw parsed JSON `data` payload. Both slots are
 * `z.unknown()` (not `null` even for creation-shaped events) because
 * the observed taxonomy includes both creation events
 * (`create_column`, `create_group`) where `before` is meaningless
 * AND edit events (`update_board_name`, `update_board_nickname`,
 * `board_workspace_id_changed`) where `before` carries the prior
 * value from the wire `data.previous_value` payload. Uniform
 * `z.unknown()` lets M24 impl type each variant independently
 * without re-pinning the discriminator schema.
 */
const boardScopedEventSchema = <K extends string>(
  kindLiteral: K,
): z.ZodObject<{
  id: z.ZodString;
  created_at: z.ZodString;
  actor_id: z.ZodNullable<z.ZodString>;
  kind: z.ZodLiteral<K>;
  before: z.ZodUnknown;
  after: z.ZodUnknown;
}> =>
  z
    .object({
      ...baseEventFields,
      kind: z.literal(kindLiteral),
      before: z.unknown(),
      after: z.unknown(),
    })
    .strict();

export const createColumnEventSchema = boardScopedEventSchema('create_column');
export const createGroupEventSchema = boardScopedEventSchema('create_group');
export const updateBoardNameEventSchema =
  boardScopedEventSchema('update_board_name');
export const updateBoardNicknameEventSchema = boardScopedEventSchema(
  'update_board_nickname',
);
export const boardWorkspaceIdChangedEventSchema = boardScopedEventSchema(
  'board_workspace_id_changed',
);

/**
 * **`update_posted`** — synthesized event for a top-level comment
 * on the item. The projector maps `Update` rows from the
 * comment-thread source into this shape; activity_logs does NOT
 * surface comments as its own events, so the cross-source merge
 * is what unifies them.
 *
 * - `before: null` — comments are append-only events (no prior
 *   state).
 * - `after.body` — `Update.body` (NON_NULL String per the probe).
 * - `after.text_body` — `Update.text_body` (nullable; Monday's
 *   plain-text rendering of the rich-text body).
 * - `after.reply_count` — count of `Update.replies` after the
 *   wire-side null-coalesce (Monday returns `null` for "no
 *   replies known"; the projector folds to `0` for agent
 *   ergonomics — see `mergeByCreatedAt` semantics).
 */
export const updatePostedEventSchema = z
  .object({
    ...baseEventFields,
    kind: z.literal('update_posted'),
    before: z.null(),
    after: z
      .object({
        body: z.string(),
        text_body: z.string().nullable(),
        reply_count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/**
 * **`update_replied`** — synthesized event for one reply within a
 * comment thread. The projector emits ONE event per `Reply` row;
 * the parent `Update.id` lands on `parent_update_id` so agents can
 * reconstruct thread context without a second round-trip.
 *
 * `reply_kind` carries `Reply.kind` (NON_NULL String per the
 * probe — a SEPARATE taxonomy from `activity_logs.event`). Pre-
 * flight pins this as `z.string()` (open enum) per the same
 * forward-compat policy as M23 favorites' `object.type` field —
 * Monday may extend Reply.kind with new variants without breaking
 * the parse.
 */
export const updateRepliedEventSchema = z
  .object({
    ...baseEventFields,
    kind: z.literal('update_replied'),
    parent_update_id: z.string().min(1),
    reply_kind: z.string().min(1),
    before: z.null(),
    after: z
      .object({
        body: z.string(),
        text_body: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

/**
 * **`unknown`** — fallback variant for an `activity_logs.event`
 * value the projector doesn't recognise. Carries the raw wire
 * `event` slot (so agents see the unrecognised string) + the raw
 * `entity` slot (so the walker filter discrepancy is visible) +
 * the raw parsed `data` JSON under `after` (so a manual M24 impl
 * extension can reproject without a second wire call). `before` is
 * `null` for uniform shape with the synthesized comment-event
 * variants (`update_posted` / `update_replied`) which also pin
 * `before: null` for their append-only-events semantics — the
 * `unknown` variant similarly has no meaningful "before" since the
 * projector by definition doesn't know how to extract the prior
 * state from the wire payload (M24 impl's typed variants are the
 * place that knowledge lives). Agents wanting to introspect the raw
 * payload read `after` (the full parsed `data` JSON) alongside
 * `event` + `entity` for routing.
 *
 * Surfaces alongside a `warnings[]` entry of code
 * `unknown_event_kind` (per {@link buildUnknownEventKindWarning})
 * so agents introspect the projector's coverage gap without parsing
 * the events list for `kind === 'unknown'` themselves.
 *
 * Per Decision 2 closure: this variant is the registry-stable
 * surface for forward-compat with Monday's expanding event
 * taxonomy. The 29-error-code registry stays AT 29 — the unknown-
 * event-kind surface is a `warnings[]` shape, NOT a new
 * `error.code` entry.
 */
export const unknownEventSchema = z
  .object({
    ...baseEventFields,
    kind: z.literal('unknown'),
    event: z.string().min(1),
    entity: z.string().min(1),
    before: z.null(),
    after: z.unknown(),
  })
  .strict();

/**
 * The projected per-event discriminated union — the contract surface
 * for `monday item history`. Agents read `kind` to route per-variant
 * handling. Adding a new variant is non-breaking (envelope-additive
 * per §6.1); renaming or removing one is the SemVer-major boundary.
 *
 * **Variant count: 9** (1 item-scoped activity-log + 5 board-scoped
 * activity-log variants kept for parser-roundtrip + 2 synthesized
 * comment-thread variants + 1 unknown fallback). The Decision 2
 * closure observed-events list capped the activity-log variants at
 * 6; the synthesized + fallback variants are the projector's own
 * contract.
 *
 * **Decision 2 ratification.** The discriminator field name `kind`
 * maps 1:1 from Monday's wire `ActivityLogType.event` field
 * (schema field-name drift); the variants enumerate the observed
 * production taxonomy + the `unknown` fallback for forward-compat.
 */
export const historyEventSchema = z.discriminatedUnion('kind', [
  updateColumnValueEventSchema,
  createColumnEventSchema,
  createGroupEventSchema,
  updateBoardNameEventSchema,
  updateBoardNicknameEventSchema,
  boardWorkspaceIdChangedEventSchema,
  updatePostedEventSchema,
  updateRepliedEventSchema,
  unknownEventSchema,
]);

export type HistoryEvent = z.infer<typeof historyEventSchema>;

/**
 * The top-level command output schema — `data` is the chronologically-
 * merged event array. Mirrors M23's `crossBoardSearchOutputSchema`
 * (a flat array of typed rows; no top-level metadata in `data`).
 */
export const historyEventOutputSchema = z.array(historyEventSchema);
export type HistoryEventOutput = z.infer<typeof historyEventOutputSchema>;

/**
 * Warning surfaced when the projector encountered an
 * `activity_logs.event` value not in the typed-variant set
 * (`event` mapped to the `kind: 'unknown'` fallback). `details`
 * carries the raw event + entity values so agents can extend the
 * projector or file a follow-up.
 *
 * **NOT an `error.code` registry entry** per Decision 2 closure —
 * §6.1 `warnings[]` shape only. The 29-stable-error-code registry
 * stays at 29.
 *
 * **Aggregation semantics.** The projector emits ONE warning per
 * unique `event` value observed in the merged stream (not per
 * occurrence) — repeated `unknown` events of the same wire kind
 * surface a single warning carrying `details.occurrence_count` so
 * the warnings array stays bounded even on degenerate inputs.
 */
export interface UnknownEventKindWarning {
  readonly code: 'unknown_event_kind';
  readonly message: string;
  readonly details: {
    readonly event: string;
    readonly entity: string;
    readonly occurrence_count: number;
    readonly hint: string;
  };
}

export const unknownEventKindWarningSchema = z
  .object({
    code: z.literal('unknown_event_kind'),
    message: z.string().min(1),
    details: z
      .object({
        event: z.string().min(1),
        entity: z.string().min(1),
        occurrence_count: z.number().int().positive(),
        hint: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * Builds an {@link UnknownEventKindWarning} from one observed
 * unknown event + its occurrence count across the merged stream.
 * **Real implementation** at pre-flight (pure helper; the warning
 * shape is the contract surface).
 *
 * The hint forward-references the projector's extensibility point
 * so agents have a concrete next step (vs a generic "unknown"
 * message that requires reading the source).
 */
export const buildUnknownEventKindWarning = (
  event: string,
  entity: string,
  occurrenceCount: number,
): UnknownEventKindWarning => ({
  code: 'unknown_event_kind',
  message: `activity_logs returned ${String(occurrenceCount)} ${
    occurrenceCount === 1 ? 'row' : 'rows'
  } with an unrecognised event kind "${event}" (entity: "${entity}"); surfaced under the \`unknown\` event variant`,
  details: {
    event,
    entity,
    occurrence_count: occurrenceCount,
    hint: 'Monday may have extended `activity_logs.event` with a new kind; extend `historyEventSchema` in `src/api/item-history-projection.ts` with a typed variant to surface the before/after payload, or consume the raw parsed payload from the `unknown` variant\'s `after` slot',
  },
});

/**
 * Merges two pre-projected event streams (activity-log + comment-
 * thread) into a single chronologically-ordered stream. **Real
 * implementation** at pre-flight (pure helper).
 *
 * Ordering rules:
 *   - Primary: `created_at` ascending (oldest first; matches
 *     Monday's UI activity log + comment thread chronological
 *     reading order).
 *   - Tie-break: `id` (lexicographic) — deterministic across runs
 *     even when two events share the exact same `created_at`
 *     timestamp (Monday's resolver issues IDs in monotonic order
 *     per source, so the tie-break preserves intra-source order).
 *
 * **Why merge here, not at the walker.** The two source walkers
 * paginate independently (activity_logs page-numbered;
 * updates page-numbered with a different denominator); merging at
 * the walker would force coupled pagination on the streaming
 * path. The projector merges the FULLY-DRAINED-PER-WALL-CLOCK-CAP
 * lists — `fetchItemHistory` walks both sources to the `--since`
 * / `--until` cap independently, then this helper merges.
 *
 * **Streaming semantics.** When `--stream` is on, the merge is
 * NOT incremental — the entire `--since`-bounded slice must be
 * resident to order it. M24 implementation's NDJSON stream emits
 * the merged array per-item after the merge completes; the
 * trailer carries the per-source pagination state for resumption.
 */
export const mergeByCreatedAt = (
  activityEvents: readonly HistoryEvent[],
  commentEvents: readonly HistoryEvent[],
): readonly HistoryEvent[] => {
  const merged: HistoryEvent[] = [...activityEvents, ...commentEvents];
  return merged.sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
};

/**
 * Inputs to {@link projectActivityLogRow}.
 */
export interface ProjectActivityLogRowInputs {
  readonly row: RawActivityLogRow;
}

/**
 * Parses a wire `data` payload defensively. Monday encodes
 * `ActivityLogType.data` as a JSON string carrying the per-event
 * payload (per Decision 2 closure introspection). On parse failure
 * the projector falls back to the raw string under
 * `{raw_data: <string>}` so the `unknown` variant's `after` slot
 * still carries diagnostic content rather than a discarded payload.
 */
const parseActivityLogDataJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw_data: raw };
  }
};

/**
 * Extracts `value` / `previous_value` from a Monday `data` payload.
 * The wire shape carries them as JSON-encoded strings inside the
 * outer parsed object (Monday's nested-JSON convention); the
 * projector unwraps one level so agents see the structured payload
 * (e.g. `{label, index}`, `{date, time}`) rather than an opaque
 * string. When the slot is already a structured value (Monday's
 * shape varies per column type and per event), pass it through.
 *
 * Per Decision 2 closure: `previous_value` is sometimes `{}` on
 * first-set events ("previously-unset"). The projector preserves
 * the empty-object shape rather than collapsing to `null` — agents
 * keying off the empty-object distinguish "first set" from
 * "no prior value tracked".
 */
const unwrapNestedJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

/**
 * Reads `column_id` / `column_type` from a parsed `data` payload.
 * Both fields are required for the `update_column_value` typed
 * variant per Decision 2 closure (the wire payload always carries
 * them for item-scoped column-edit events). Missing / non-string
 * slots fall back to empty strings — the projector then routes the
 * row through the `unknown` fallback rather than emitting a typed
 * variant with an empty discriminator.
 */
const readStringField = (
  obj: Readonly<Record<string, unknown>>,
  key: string,
): string => {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
};

const readNullableString = (
  obj: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
};

/**
 * Returns true when the parsed data is a plain object (not array,
 * not null, not primitive). Used as the structural pre-check before
 * the projector reads typed fields off the payload.
 */
const isPlainObject = (
  v: unknown,
): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Projects one wire `ActivityLogType` row into a typed
 * {@link HistoryEvent}. Parses the wire `data` JSON, dispatches
 * on `row.event`, and emits the matching typed variant. Unknown
 * event kinds fall back to the `unknown` variant carrying the raw
 * parsed `data` under `after`.
 *
 * The projector is the SINGLE per-row dispatch point; the walker
 * delegates to it after the `entity === 'pulse'` filter (single
 * source of truth at the walker layer per Decision 2 closure;
 * projector does NOT re-filter).
 *
 * Per-`column_type` typed before/after for `update_column_value`:
 * `value` and `previous_value` are passed through with one level
 * of nested-JSON unwrap (Monday encodes nested values as JSON
 * strings inside the outer `data` payload); each column type's
 * concrete payload shape (e.g. status `{label, index}`, date ISO
 * string, text raw string) flows through unchanged. Per Decision
 * 2 closure: `previous_value: {}` is preserved as "previously-
 * unset" rather than collapsed to `null` — agents distinguish
 * the empty-object shape.
 */
export const projectActivityLogRow = (
  inputs: ProjectActivityLogRowInputs,
): HistoryEvent => {
  const { row } = inputs;
  const parsedData = parseActivityLogDataJson(row.data);
  const dataObj = isPlainObject(parsedData) ? parsedData : {};

  switch (row.event) {
    case 'update_column_value': {
      const columnId = readStringField(dataObj, 'column_id');
      const columnType = readStringField(dataObj, 'column_type');
      // Missing / empty discriminator fields → fall through to
      // `unknown` rather than emit a typed variant with empty
      // strings. Defensive: the probe pinned both fields always
      // present on `update_column_value` payloads, but a future
      // Monday rename or partial-payload bug would otherwise
      // produce a malformed typed event.
      if (columnId !== '' && columnType !== '') {
        return {
          id: row.id,
          created_at: row.created_at,
          actor_id: row.user_id,
          kind: 'update_column_value',
          column_id: columnId,
          column_type: columnType,
          before: unwrapNestedJson(dataObj.previous_value),
          after: unwrapNestedJson(dataObj.value),
          textual_value: readNullableString(dataObj, 'textual_value'),
          pulse_id: readNullableString(dataObj, 'pulse_id'),
          pulse_name: readNullableString(dataObj, 'pulse_name'),
        };
      }
      break;
    }
    case 'create_column':
    case 'create_group':
    case 'update_board_name':
    case 'update_board_nickname':
    case 'board_workspace_id_changed': {
      // Board-scoped variants — the walker's entity filter
      // normally drops these, but the projector keeps the typed
      // branch so a future regression that bypasses the filter
      // fails into the typed variant rather than `unknown`.
      // Both `before` / `after` carry the raw parsed payload so
      // agents see Monday's full event payload without re-parsing.
      return {
        id: row.id,
        created_at: row.created_at,
        actor_id: row.user_id,
        kind: row.event,
        before: unwrapNestedJson(dataObj.previous_value),
        after: parsedData,
      };
    }
    default: // fall through to the unknown variant below.
  }

  return {
    id: row.id,
    created_at: row.created_at,
    actor_id: row.user_id,
    kind: 'unknown',
    event: row.event,
    entity: row.entity,
    before: null,
    after: parsedData,
  };
};

/**
 * Inputs to {@link projectUpdateRow}.
 */
export interface ProjectUpdateRowInputs {
  readonly row: RawUpdateRow;
}

/**
 * Projects one wire `Update` row into a synthesized
 * {@link HistoryEvent} of kind `update_posted` plus one
 * `update_replied` event per `row.replies` entry (via
 * {@link projectReplyRow}). Returns a flat array suitable for
 * the merger.
 *
 * `Update.created_at` is nullable per Decision 2 closure probe
 * findings; the projector substitutes `Update.edited_at`
 * (NON_NULL) as the chronological key — silent projection
 * behaviour, deterministic across re-walks.
 *
 * Replies are flat-mapped here (not at the walker) so the
 * walker stays surface-symmetric with the activity_logs source
 * (both project per-row → events). The merge projector orders
 * the combined stream.
 */
export const projectUpdateRow = (
  inputs: ProjectUpdateRowInputs,
): readonly HistoryEvent[] => {
  const { row } = inputs;
  const createdAt = row.created_at ?? row.edited_at;
  const replies = row.replies ?? [];
  const posted: HistoryEvent = {
    id: row.id,
    created_at: createdAt,
    actor_id: row.creator_id,
    kind: 'update_posted',
    before: null,
    after: {
      body: row.body,
      text_body: row.text_body,
      reply_count: replies.length,
    },
  };
  const repliedEvents = replies.map((reply) =>
    projectReplyRow({ row: reply, parentUpdateId: row.id }),
  );
  return [posted, ...repliedEvents];
};

/**
 * Inputs to {@link projectReplyRow}. The `parentUpdateId` slot
 * wires the synthesized event's `parent_update_id` so agents
 * reconstruct thread context.
 */
export interface ProjectReplyRowInputs {
  readonly row: RawReplyRow;
  readonly parentUpdateId: string;
}

/**
 * Projects one wire `Reply` row into a synthesized
 * {@link HistoryEvent} of kind `update_replied`. The parent
 * `Update.id` lands on `parent_update_id`; `Reply.kind` lands on
 * `reply_kind` (separate from `activity_logs.event` taxonomy per
 * the Decision 2 closure probe finding).
 *
 * `Reply.created_at` is nullable per the probe introspection;
 * fallback chain: `created_at` → `updated_at`. If both are null
 * the projector substitutes the empty string — Monday's contract
 * pins `Reply.id` + `Reply.body` + `Reply.kind` as NON_NULL
 * (always present); both timestamp slots being null on the same
 * Reply isn't observed in production but is defensively handled
 * (the row still lands on the stream; the merger places it after
 * other zero-timestamp events lexicographically by `id`).
 */
export const projectReplyRow = (
  inputs: ProjectReplyRowInputs,
): HistoryEvent => {
  const { row, parentUpdateId } = inputs;
  const createdAt = row.created_at ?? row.updated_at ?? '';
  return {
    id: row.id,
    created_at: createdAt,
    actor_id: row.creator_id,
    kind: 'update_replied',
    parent_update_id: parentUpdateId,
    reply_kind: row.kind,
    before: null,
    after: {
      body: row.body,
      text_body: row.text_body,
    },
  };
};

/**
 * Per-source pagination state surfaced on the
 * {@link FetchItemHistoryResult} so the NDJSON trailer carries
 * resumption hints. Two sources paginate independently; the
 * trailer's `meta` carries both denominators so an agent
 * resuming a walk knows which page to re-issue per source.
 *
 * - `activity_logs.last_page` — the last activity-log page the
 *   walker drained. `null` when the walker exhausted the source
 *   (no more pages); a number when stopped mid-walk
 *   (`--limit` or wall-clock cap fired).
 * - `updates.last_page` — same semantics for the updates source.
 */
export interface PerSourcePaginationState {
  readonly activity_logs: { readonly last_page: number | null };
  readonly updates: { readonly last_page: number | null };
}

/**
 * Inputs to {@link fetchItemHistory}. The pre-flight pins the
 * shape; M24 implementation fills in the body.
 *
 * - `client` — resolved {@link MondayClient} so the fetch inherits
 *   `--retry` + `--verbose`-complexity injection (mirrors M22's
 *   `fetchUsage` + M23's `fetchBoardFavorites` shape).
 * - `itemId` — the target item. Branded {@link ItemId} (numeric-
 *   string; parsed at the command argv boundary).
 * - `boardId` — Monday's `activity_logs` resolver lives under
 *   `boards(ids:)`, so the walker needs the item's parent board
 *   ID. M24 implementation's command-action looks this up via
 *   the existing item-board lookup helper before constructing
 *   inputs.
 * - `since` / `until` — wall-clock filters (ISO-8601). Both
 *   optional; absent → unbounded on that side. Threaded through
 *   to `activity_logs(from:, to:)`; the updates source filters
 *   client-side against `Update.created_at` (Monday's `updates`
 *   resolver doesn't expose a wall-clock filter as of API
 *   `2026-01`).
 * - `activityLogsPage` — 1-indexed page number for the
 *   `activity_logs` source. Maps to Monday's `page:` arg.
 * - `updatesPage` — 1-indexed page number for the `updates`
 *   source. Independent of `activityLogsPage`.
 * - `limit` — per-source per-call slice size (Monday's `limit:`
 *   arg on both `activity_logs` and `updates`). Default
 *   {@link DEFAULT_HISTORY_PAGE_SIZE}; hard cap
 *   {@link HARD_CAP_HISTORY_PAGE_SIZE}.
 * - `kinds` — optional projection filter; only events whose
 *   `kind` is in the set are returned. Applied AFTER projection
 *   (so unknown-event-kind warnings still surface for filtered
 *   events; the filter narrows the returned `data` array, not
 *   the merge denominator). Pre-flight pins as
 *   `readonly HistoryEvent['kind'][]`; M24 impl walks every
 *   page either way and the filter is purely projection-side.
 * - `onItem` — streaming hook per the `--stream` path. Called
 *   per merged event per the ordered output (NOT per arrival —
 *   merging requires the full slice resident; see
 *   `mergeByCreatedAt` semantics).
 */
export interface FetchItemHistoryInputs {
  readonly client: MondayClient;
  readonly itemId: ItemId;
  readonly boardId: string;
  readonly since?: string;
  readonly until?: string;
  readonly activityLogsPage?: number;
  readonly updatesPage?: number;
  readonly limit?: number;
  readonly kinds?: readonly HistoryEvent['kind'][];
  readonly onItem?: (event: HistoryEvent) => void | Promise<void>;
}

/**
 * Result of the two-source merged-history walker. Carries:
 *
 * - `events` — chronologically-merged event array (or the
 *   `--kinds`-filtered subset).
 * - `pagination` — per-source pagination state for NDJSON
 *   trailer / agent-resumption.
 * - `warnings` — `unknown_event_kind` warnings (one per unique
 *   unrecognised event observed; see
 *   {@link buildUnknownEventKindWarning}).
 * - `complexity` — last-call `meta.complexity` (under
 *   `--verbose` only); two-source merge picks the larger of
 *   the per-source values (or `null` outside `--verbose`).
 * - `source` — always `'live'` for v0.3. activity_logs + updates
 *   are pure reads with no per-call cache; the action-layer
 *   wrapping aggregates this with the item-board lookup's cache
 *   state (which may be cache-hit) via `SourceAggregator` at M24
 *   impl, mirroring the M23 cross-board-search source shape.
 */
export interface FetchItemHistoryResult {
  readonly events: readonly HistoryEvent[];
  readonly pagination: PerSourcePaginationState;
  readonly warnings: readonly UnknownEventKindWarning[];
  readonly complexity: Complexity | null;
  readonly source: 'live';
}

/**
 * Two-source GraphQL response schemas — parse boundaries for the
 * walker's per-stage `unwrapOrThrow` calls. `.loose()` lets
 * additive Monday surface fields pass through without breaking
 * the parse (same forward-compat policy as M22/M23 wire schemas).
 */
const activityLogsResponseSchema = z
  .object({
    boards: z
      .array(
        z
          .object({
            id: z.string().min(1),
            activity_logs: z.array(rawActivityLogRowSchema).nullable(),
          })
          .loose()
          .nullable(),
      )
      .nullable(),
  })
  .loose();

const updatesResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1),
            updates: z.array(rawUpdateRowSchema).nullable(),
          })
          .loose()
          .nullable(),
      )
      .nullable(),
  })
  .loose();

/**
 * Compares two ISO-8601 timestamps lexicographically. ISO-8601 in
 * `YYYY-MM-DD[THH:MM:SS[.fff][Z|±HH:MM]]` form sorts correctly
 * lexicographically WITHIN the same offset (and same precision);
 * Monday's `created_at` values are uniformly UTC `Z`-suffixed per
 * the Decision 2 probe, so lexicographic compare matches
 * wall-clock compare. Used for client-side `--since` / `--until`
 * filtering on the updates source.
 */
const inWallClockRange = (
  timestamp: string,
  since: string | undefined,
  until: string | undefined,
): boolean => {
  if (since !== undefined && timestamp < since) return false;
  if (until !== undefined && timestamp > until) return false;
  return true;
};

/**
 * Two-source merged-history walker. Issues two independent
 * GraphQL calls (activity_logs + updates), filters + projects
 * each per Decision 2 closure ratified shape, merges
 * chronologically, aggregates `unknown_event_kind` warnings,
 * applies optional `--kinds` projection filter, and streams via
 * `inputs.onItem` (per-merged-event AFTER the merge — merging
 * requires full slice resident per the `mergeByCreatedAt`
 * docstring).
 *
 * **`source: 'live'` constant.** activity_logs + updates are
 * pure reads with no per-call cache; the action layer aggregates
 * this with the item-board lookup's `'live'` source via
 * `SourceAggregator` and resolves the envelope's `meta.source`
 * from the aggregator's resolved state (mirrors M23
 * cross-board-search).
 *
 * **`complexity`** is the larger of the two stages' per-call
 * complexity values (under `--verbose` only; null outside). Two
 * independent calls → take the worst-case stage so agents see
 * the more conservative budget snapshot rather than averaging.
 *
 * **Per-source pagination state.** Each source's `last_page` is
 * the page number the walker DRAINED if the response returned a
 * full slice (`response.length === limit` → more pages likely);
 * `null` when the response returned less than `limit` rows
 * (source exhausted). Monday's page-numbered surfaces have no
 * "next" sentinel; the heuristic mirrors the v0.2 page-walker
 * shape.
 */
export const fetchItemHistory = async (
  inputs: FetchItemHistoryInputs,
): Promise<FetchItemHistoryResult> => {
  const limit = inputs.limit ?? DEFAULT_HISTORY_PAGE_SIZE;
  const activityPage = inputs.activityLogsPage ?? 1;
  const updatesPage = inputs.updatesPage ?? 1;

  // Stage 1 — activity_logs page-walk.
  const stage1 = await inputs.client.raw<unknown>(
    ACTIVITY_LOGS_QUERY,
    {
      bid: [inputs.boardId],
      iid: [inputs.itemId],
      // Monday's `from` / `to` accept null for unbounded sides; we
      // omit the key entirely when undefined to keep the wire
      // payload minimal (the `.loose()` parse on the response is
      // unaffected by which args we send).
      ...(inputs.since === undefined ? {} : { from: inputs.since }),
      ...(inputs.until === undefined ? {} : { to: inputs.until }),
      page: activityPage,
      limit,
    },
    { operationName: 'ItemHistoryActivityLogs' },
  );
  const stage1Data = unwrapOrThrow(
    activityLogsResponseSchema.safeParse(stage1.data),
    {
      context: 'Monday `boards.activity_logs` response',
      details: { item_id: inputs.itemId, board_id: inputs.boardId },
      hint: 'Monday may have amended the `boards(ids:) { activity_logs }` surface — re-probe via `scripts/probe/m24-history-kinds.ts` and amend cli-design §13 v0.3 entry if so',
    },
  );

  const rawActivityRows: RawActivityLogRow[] = [];
  const boards = stage1Data.boards ?? [];
  for (const board of boards) {
    if (board === null) continue;
    const rows = board.activity_logs ?? [];
    rawActivityRows.push(...rows);
  }
  // Walker-side entity filter (Decision 2 ratified): drop
  // board-scoped events that leak through `item_ids` per the
  // empirical-probe finding. Single source of truth at the walker;
  // projector does NOT re-filter.
  const itemScopedRows = rawActivityRows.filter(
    (r) => r.entity === ITEM_SCOPED_ENTITY,
  );
  const activityEvents: HistoryEvent[] = itemScopedRows.map((row) =>
    projectActivityLogRow({ row }),
  );

  // Aggregate unknown_event_kind warnings: one warning per unique
  // (event, entity) tuple observed; `occurrence_count` carries the
  // multiplicity so the warnings array stays bounded on degenerate
  // inputs. Keyed by `${event}\x00${entity}` to disambiguate the
  // same event name surfacing under two entity values.
  const unknownByKey = new Map<
    string,
    { event: string; entity: string; count: number }
  >();
  for (const ev of activityEvents) {
    if (ev.kind === 'unknown') {
      const key = `${ev.event}\x00${ev.entity}`;
      const entry = unknownByKey.get(key);
      if (entry === undefined) {
        unknownByKey.set(key, {
          event: ev.event,
          entity: ev.entity,
          count: 1,
        });
      } else {
        entry.count++;
      }
    }
  }

  // Stage 2 — updates page-walk (independent denominator).
  const stage2 = await inputs.client.raw<unknown>(
    UPDATES_QUERY,
    {
      iid: [inputs.itemId],
      page: updatesPage,
      limit,
    },
    { operationName: 'ItemHistoryUpdates' },
  );
  const stage2Data = unwrapOrThrow(
    updatesResponseSchema.safeParse(stage2.data),
    {
      context: 'Monday `items.updates` response',
      details: { item_id: inputs.itemId },
      hint: 'Monday may have amended the `items(ids:) { updates }` surface — re-probe via `scripts/probe/m24-history-kinds.ts` and amend cli-design §13 v0.3 entry if so',
    },
  );

  const rawUpdateRows: RawUpdateRow[] = [];
  const items = stage2Data.items ?? [];
  for (const it of items) {
    if (it === null) continue;
    const rows = it.updates ?? [];
    rawUpdateRows.push(...rows);
  }
  // Project each Update + flat-map its replies. The projector
  // returns a flat array (parent + N replies) per row; flat-map
  // here so the wall-clock filter and merger see one combined
  // list per source.
  const allUpdateEvents: HistoryEvent[] = rawUpdateRows.flatMap((row) =>
    projectUpdateRow({ row }),
  );
  // Client-side wall-clock filter. Monday's `updates` resolver
  // doesn't expose `from:` / `to:` per Decision 2 probe; filter
  // after projection so the per-row chronological key matches the
  // merger's sort.
  const updateEvents: HistoryEvent[] =
    inputs.since === undefined && inputs.until === undefined
      ? allUpdateEvents
      : allUpdateEvents.filter((ev) =>
          inWallClockRange(ev.created_at, inputs.since, inputs.until),
        );

  // Chronological merge of both fully-drained source lists.
  const merged = mergeByCreatedAt(activityEvents, updateEvents);

  // Optional `--kinds` projection filter — narrows `data` array
  // but warnings stay (per the docstring contract). Set lookup
  // keeps the filter O(N).
  const kindsSet =
    inputs.kinds === undefined ? undefined : new Set<HistoryEvent['kind']>(inputs.kinds);
  const filtered =
    kindsSet === undefined
      ? merged
      : merged.filter((ev) => kindsSet.has(ev.kind));

  // Stream hook — per-merged-event AFTER the merge (merging is
  // not incremental per the helper's docstring). Awaiting each
  // call preserves backpressure when the hook drives an NDJSON
  // stream against a slow consumer.
  if (inputs.onItem !== undefined) {
    for (const event of filtered) {
      await inputs.onItem(event);
    }
  }

  // Build warnings array — sorted deterministically by event so
  // re-walks against the same wire produce identical envelopes.
  // Entity disambiguation lives in the map key (defensive against
  // a future bypass of the walker's entity filter) but the sort
  // is primary-on-event only: the walker's `entity === 'pulse'`
  // filter means every surfaced warning carries entity='pulse'
  // in production, so a secondary entity sort would be dead code.
  const warnings: UnknownEventKindWarning[] = Array.from(unknownByKey.values())
    .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0))
    .map((entry) =>
      buildUnknownEventKindWarning(entry.event, entry.entity, entry.count),
    );

  // Per-source pagination state. Heuristic: a response of less
  // than `limit` rows means "drained" → last_page null; a full
  // slice means "potentially more" → last_page = current page.
  const activityLastPage =
    rawActivityRows.length < limit ? null : activityPage;
  const updatesLastPage = rawUpdateRows.length < limit ? null : updatesPage;

  // Complexity — worst-case (smaller) of the two stages'
  // `remaining` budget under `--verbose`; null outside. Two
  // independent calls → pick the stage that consumed the most
  // budget so agents see the more conservative remaining
  // snapshot rather than averaging.
  const complexity =
    stage1.complexity === null
      ? stage2.complexity
      : stage2.complexity === null
        ? stage1.complexity
        : stage1.complexity.remaining <= stage2.complexity.remaining
          ? stage1.complexity
          : stage2.complexity;

  return {
    events: filtered,
    pagination: {
      activity_logs: { last_page: activityLastPage },
      updates: { last_page: updatesLastPage },
    },
    warnings,
    complexity,
    source: 'live',
  };
};

/**
 * Adapter from a {@link FetchItemHistoryResult}'s `warnings`
 * array to the envelope-shaped {@link Warning} array consumed by
 * `emitSuccess`. Pre-flight pure helper — type-narrows the
 * `code` discriminator so the envelope's `warnings[]` slot
 * carries the precise shape rather than a generic `Warning`.
 */
export const toEnvelopeWarnings = (
  warnings: readonly UnknownEventKindWarning[],
): readonly Warning[] => warnings;
