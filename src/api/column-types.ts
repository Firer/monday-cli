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
 * Writable column types per `cli-design.md` §5.3.3 + the v0.2 writer-
 * expansion roadmap (M8). Order is frozen — not because Sets are
 * ordered, but because tests iterate the array form and the snapshot
 * is part of the contract surface. v0.1 entries appear first (they
 * shipped first); M8 firm additions follow in roadmap order.
 *
 * Categories baked into the same allowlist:
 *   - **simple** (`text` / `long_text` / `numbers`) — translate to a
 *     bare string and use `change_simple_column_value`.
 *   - **rich (v0.1)** (`status` / `dropdown` / `date` / `people`) —
 *     translate to a JSON object and use `change_column_value` /
 *     `change_multiple_column_values`.
 *   - **rich (v0.2 firm)** (`link` / `email` / `phone`) — pipe-form
 *     `<value>|<text>` parsers in `links.ts` / `emails.ts` /
 *     `phones.ts`; same `change_column_value` wire path.
 *
 * The split lives in `column-values.ts`; here we just enumerate the
 * full allowlist. Tentative v0.2 types (`tags` / `board_relation` /
 * `dependency`) stay in `V0_2_WRITER_EXPANSION_TYPES` until their
 * fixture work clears — they ship firm via the same array's expansion
 * once translators land, or slip to v0.3 in the M8 post-mortem.
 */
export const WRITABLE_COLUMN_TYPES = [
  'text',
  'long_text',
  'numbers',
  'status',
  'dropdown',
  'date',
  'people',
  'link',
  'email',
  'phone',
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
 * Column types still pending in the v0.2 writer-expansion milestone
 * (`cli-design.md` §5.3 writer-expansion roadmap table). M8 shipped
 * `link` / `email` / `phone` firm — those moved to
 * `WRITABLE_COLUMN_TYPES` and are no longer surfaced here. The
 * remaining three are M8's tentative row; their fixture work decides
 * whether they ship firm in v0.2 (move to `WRITABLE_COLUMN_TYPES`) or
 * slip to v0.3 (move to a v0.3 deferral surfaced via the same
 * roadmap-category branch).
 *
 * Source-of-truth alongside `WRITABLE_COLUMN_TYPES` so the
 * `unsupported_column_type` error builder can give per-type-accurate
 * guidance instead of blanket-deferring every non-allowlisted type.
 */
export const V0_2_WRITER_EXPANSION_TYPES = [
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
 * Membership test for the read-only-forever row. Used by `--set-raw`
 * (M8) to reject these types post-resolution per cli-design §5.3
 * escape-hatch contract — Monday's API never makes them writable
 * regardless of payload, so accepting a raw payload would just shift
 * the failure from CLI-time to Monday-time.
 */
export const isReadOnlyForeverType = (type: string): type is ReadOnlyForeverType =>
  READ_ONLY_FOREVER_SET.has(type);

/**
 * Column types Monday writes via `add_file_to_column` (file upload
 * via multipart) rather than `change_column_value` / `change_multiple_
 * column_values` (`cli-design.md` §5.3 writer-expansion roadmap "files"
 * row + the escape-hatch contract).
 *
 * The friendly translator and `--set-raw` both go through
 * `change_column_value` / `change_multiple_column_values`, so a
 * `--set-raw` raw payload cannot reach the right wire surface for
 * these types — `--set-raw` rejects them with `unsupported_column_
 * type` carrying `deferred_to: "v0.4"` (asset upload pinned to v0.4
 * per cli-design §13).
 *
 * Currently one entry (`file`); the slot is plural because Monday may
 * surface other multipart-upload-shaped types in future API versions
 * and the contract should accommodate adding rows without touching
 * the consumer.
 */
export const FILES_SHAPED_TYPES = ['file'] as const;

export type FilesShapedType = (typeof FILES_SHAPED_TYPES)[number];

const FILES_SHAPED_SET: ReadonlySet<string> = new Set<string>(
  FILES_SHAPED_TYPES,
);

/**
 * Membership test for the files-shaped row. Used by `--set-raw` (M8)
 * to reject these types post-resolution per cli-design §5.3 escape-
 * hatch contract — the underlying mutation isn't `change_column_value`
 * so a raw payload can't reach the right wire surface.
 */
export const isFilesShapedType = (type: string): type is FilesShapedType =>
  FILES_SHAPED_SET.has(type);

/**
 * Roadmap category for an unsupported column type. The
 * `unsupported_column_type` error builder uses this to pick a
 * per-category message + details slot.
 *
 *   - `'v0_2_writer_expansion'` — tentative-row v0.2 types still
 *     pending (`tags` / `board_relation` / `dependency`). Surfaces
 *     `deferred_to: "v0.2"` and points at the writer-expansion
 *     milestone. M8 shipped `link` / `email` / `phone` firm so the
 *     branch no longer fires for those types — they resolve through
 *     the friendly translator.
 *   - `'read_only_forever'` — Monday-computed columns (mirror /
 *     formula / auto_number / creation_log / last_updated /
 *     item_id). Surfaces `read_only: true` and points at the
 *     underlying source column. `--set-raw` rejects these too —
 *     the read-only-forever check fires after column resolution
 *     but before mutation.
 *   - `'future'` — any other unsupported type (battery /
 *     item_assignees / time_tracking / rating / files / etc.).
 *     Surfaces `deferred_to: "future"` with a generic message that
 *     doesn't commit to a specific version. The friendly translator
 *     rejects; `--set-raw` accepts when the underlying mutation is
 *     `change_column_value` (files-shaped types like `file` are a
 *     v0.4 deferral and `--set-raw` rejects them too).
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
