/**
 * v0.1 column-type allowlist + a defensive `settings_str` parser
 * (`cli-design.md` §5.3 step 3 + step 4, `v0.1-plan.md` §3 M5a).
 *
 * Two consumers share this surface:
 *   - `commands/board/describe.ts` — populates `writable: bool` and
 *     `example_set: string[] | null` on every column it surfaces, so
 *     an agent reading one `board describe` payload knows exactly
 *     which columns `--set` will accept.
 *   - `api/column-values.ts` (M5a writer) — gates the friendly
 *     translation paths and surfaces `unsupported_column_type` for
 *     anything else.
 *
 * Owning the allowlist here (not in either consumer) means the
 * "writable types contract" has one source of truth: the v0.2 author
 * who wants to add `world_clock` flips one entry and both `describe`
 * and the writer pick it up. R8 in `v0.1-plan.md` §15 / §17.
 */

/**
 * v0.1-allowlisted column types per `cli-design.md` §5.3.3. Order is
 * frozen — not because Sets are ordered, but because tests iterate
 * the array form and the snapshot is part of the contract surface.
 *
 * Three categories baked into the same allowlist:
 *   - **simple** (`text` / `long_text` / `numbers`) — translate to a
 *     bare string and use `change_simple_column_value`.
 *   - **rich** (`status` / `dropdown` / `date` / `people`) — translate
 *     to a JSON object and use `change_column_value` /
 *     `change_multiple_column_values`.
 *
 * The split lives in `column-values.ts`; here we just enumerate the
 * v0.1 allowlist itself.
 */
export const WRITABLE_COLUMN_TYPES = [
  'text',
  'long_text',
  'numbers',
  'status',
  'dropdown',
  'date',
  'people',
] as const;

export type WritableColumnType = (typeof WRITABLE_COLUMN_TYPES)[number];

const WRITABLE_TYPE_SET: ReadonlySet<string> = new Set<string>(WRITABLE_COLUMN_TYPES);

/**
 * Membership test for the v0.1 writable allowlist. Narrows the input
 * type to `WritableColumnType` so downstream switches don't need to
 * re-cast.
 */
export const isWritableColumnType = (type: string): type is WritableColumnType =>
  WRITABLE_TYPE_SET.has(type);

/**
 * Defensive parse for Monday's `settings_str` field. Monday returns
 * a JSON-encoded string for status / dropdown / etc. column settings,
 * but the value can be `null`, an empty string, or a malformed blob
 * on legacy boards. Callers want a parsed object or `null` — never a
 * thrown `SyntaxError`.
 *
 * Returns `null` when the input is missing / empty / unparseable.
 * Returns the parsed value (typed `unknown` — caller validates the
 * shape) when JSON.parse succeeds. The caller is the boundary that
 * narrows the result to a typed shape.
 */
export const parseColumnSettings = (raw: string | null): unknown => {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * Column types the v0.2 writer-expansion milestone will add to the
 * friendly translator (`cli-design.md` §5.3 writer-expansion roadmap
 * table). v0.2 also lands the `--set-raw <col>=<json>` escape hatch.
 * Source-of-truth alongside `WRITABLE_COLUMN_TYPES` so the
 * `unsupported_column_type` error builder can give per-type-accurate
 * guidance instead of blanket-deferring every non-allowlisted type.
 *
 * `tags` / `board_relation` / `dependency` are tentative on the
 * roadmap (table calls them "may slip to v0.3"); we still surface
 * them as v0.2-deferred today because the agent-facing message
 * ("v0.2's writer-expansion adds this") is right whether they ship
 * in v0.2 or get re-slotted. If they slip, the writer-expansion
 * milestone post-mortem updates this list.
 */
export const V0_2_WRITER_EXPANSION_TYPES = [
  'link',
  'email',
  'phone',
  'tags',
  'board_relation',
  'dependency',
] as const;

export type V0_2WriterExpansionType =
  (typeof V0_2_WRITER_EXPANSION_TYPES)[number];

const V0_2_WRITER_EXPANSION_SET: ReadonlySet<string> = new Set<string>(
  V0_2_WRITER_EXPANSION_TYPES,
);

/**
 * Column types Monday computes server-side and **never makes
 * writable via the API** (`cli-design.md` §5.3 writer-expansion
 * roadmap table — "read-only forever" row). cli-design says
 * explicitly:
 *
 *   > The "read-only forever" row matters for agents: trying `--set`
 *   > on a mirror/formula/etc. surfaces `unsupported_column_type`
 *   > and will *always* surface that, regardless of version. The
 *   > hint should point at the underlying source column, not at
 *   > `--set-raw`.
 *
 * The error builder branches on this set to emit `read_only: true`
 * (no `deferred_to`) and a hint that names the underlying-source
 * pattern instead of advertising a future flag.
 */
export const READ_ONLY_FOREVER_TYPES = [
  'mirror',
  'formula',
  'auto_number',
  'creation_log',
  'last_updated',
  'item_id',
] as const;

export type ReadOnlyForeverType = (typeof READ_ONLY_FOREVER_TYPES)[number];

const READ_ONLY_FOREVER_SET: ReadonlySet<string> = new Set<string>(
  READ_ONLY_FOREVER_TYPES,
);

/**
 * Roadmap category for an unsupported column type. The
 * `unsupported_column_type` error builder uses this to pick a
 * per-category message + details slot.
 *
 *   - `'v0_2_writer_expansion'` — link / email / phone / tags
 *     (tentative) / board_relation (tentative) / dependency
 *     (tentative). Surfaces `deferred_to: "v0.2"` and says the
 *     v0.2 writer-expansion milestone adds the friendly type +
 *     `--set-raw`.
 *   - `'read_only_forever'` — Monday-computed columns (mirror /
 *     formula / auto_number / creation_log / last_updated /
 *     item_id). Surfaces `read_only: true` and points at the
 *     underlying source column.
 *   - `'future'` — any other unsupported type (battery /
 *     item_assignees / time_tracking / rating / files / etc.).
 *     Surfaces `deferred_to: "future"` with a generic message.
 *
 * Codex M5b cleanup re-review #1: pre-fix `unsupportedColumnType
 * Error` blanket-deferred every non-allowlisted type to v0.2, which
 * over-promised for the read-only-forever row and the v0.3+ rows.
 */
export type ColumnRoadmapCategory =
  | 'v0_2_writer_expansion'
  | 'read_only_forever'
  | 'future';

export const getColumnRoadmapCategory = (
  type: string,
): ColumnRoadmapCategory => {
  if (V0_2_WRITER_EXPANSION_SET.has(type)) return 'v0_2_writer_expansion';
  if (READ_ONLY_FOREVER_SET.has(type)) return 'read_only_forever';
  return 'future';
};
