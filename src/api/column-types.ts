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
