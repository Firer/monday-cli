/**
 * Column-value writer (`cli-design.md` §5.3, `v0.1-plan.md` §3 M5a).
 *
 * The write half of the column-value abstraction: takes a resolved
 * column + a raw user-supplied string and produces the Monday wire
 * payload Monday's `change_simple_column_value` /
 * `change_column_value` / `change_multiple_column_values` mutations
 * accept.
 *
 * **Scope so far.** Five of the seven v0.1-allowlisted types
 * translate: `text` / `long_text` / `numbers` (simple-string
 * payloads, M5a skeleton) and `status` / `dropdown` (rich-object
 * payloads, this commit). `date` and `people` each carry their
 * own translation logic and arrive in follow-up sessions; until
 * then they fall through to `unsupported_column_type` like any
 * non-allowlisted type.
 *
 * **Mutation selection** (`cli-design.md` §5.3 step 5) lives in
 * `selectMutation` below — single simple → `change_simple_column_value`;
 * single rich → `change_column_value`; N (any combo) →
 * `change_multiple_column_values` (atomic on Monday's side). The
 * multi form re-wraps `long_text`'s simple bare string as
 * `{ text: <value> }` because Monday's per-column blob inside
 * `change_multiple_column_values` requires the object form for
 * `long_text` (a wire-shape divergence from
 * `change_simple_column_value`'s bare-string acceptance — pinned
 * via fixture in the unit suite, logged as a spec gap in
 * `v0.1-plan.md` §3 M5a for cli-design backfill).
 *
 * **No CLI-side label-to-index lookup.** Per `cli-design.md` §5.3
 * step 3: the CLI emits `{ "label": ... }` for label input and
 * `{ "index": N }` for numeric input on `status`; it does *not*
 * traverse `column.settings_str` to resolve labels to their stable
 * indexes. Same shape for `dropdown` — `{ "labels": [...] }` for
 * label input, `{ "ids": [...] }` for all-numeric input. Monday is
 * the validator of last resort; the translator's contract is
 * "produce the documented wire shape, let Monday reject typos as
 * `validation_failed`".
 *
 * **Monday `JSON` scalar discipline** (`cli-design.md` §5.3 step 4).
 * Every payload is a plain JS value (string for the simple form,
 * plain object for the rich form). The SDK / fetch layer is
 * responsible for stringifying at the wire boundary — this module
 * never `JSON.stringify`s. The unit tests in
 * `tests/unit/api/column-values.test.ts` pin the exact wire shape
 * per type as a fixture so M5b and v0.2's bulk surface inherit the
 * rule unchanged.
 *
 * **`--set-raw` escape hatch.** Lives at the command boundary, not
 * here — `--set-raw <col>=<json>` skips the friendly translator
 * entirely and uses `change_column_value` with the literal payload.
 * This module is only invoked for the friendly path.
 */

import { ApiError, UsageError } from '../utils/errors.js';
import {
  isWritableColumnType,
  type WritableColumnType,
} from './column-types.js';

/**
 * Discriminator on the wire payload's *shape*, not the GraphQL
 * mutation that consumes it (one mutation can accept either shape).
 *
 *   - `simple` — bare-string payload accepted by
 *     `change_simple_column_value`. Used by `text`, `long_text`,
 *     `numbers`. When bundled into `change_multiple_column_values`,
 *     `long_text` is re-wrapped to `{ text: <value> }` by
 *     `selectMutation`; the discriminator on the translated value
 *     stays `simple` because that's the column-class fact, not
 *     the per-mutation projection.
 *   - `rich`   — plain-object payload accepted by
 *     `change_column_value` and the per-column entry in
 *     `change_multiple_column_values`. Used by `status` and
 *     `dropdown` today; `date` and `people` ship in follow-up
 *     sessions but the typed slot already exists.
 */
export type ColumnValuePayload =
  | { readonly format: 'simple'; readonly value: string }
  | {
      readonly format: 'rich';
      readonly value: Readonly<Record<string, unknown>>;
    };

export interface TranslatedColumnValue {
  /** The resolved column ID — echoed in M5b's mutation envelope. */
  readonly columnId: string;
  /** The resolved column's type — narrowed to the v0.1 allowlist. */
  readonly columnType: WritableColumnType;
  /** The wire payload + format discriminator. */
  readonly payload: ColumnValuePayload;
  /** The raw input the caller passed, preserved for the dry-run diff. */
  readonly rawInput: string;
}

export interface TranslateColumnValueInputs {
  /**
   * The resolved column. Only `id` and `type` are read; the full
   * `BoardColumn` is fine but not required, so the bulk path can
   * project a slim shape.
   */
  readonly column: { readonly id: string; readonly type: string };
  /** The raw user-supplied value (post-`--set` parsing). */
  readonly value: string;
}

/**
 * Translates a single `<column>=<value>` pair into the Monday wire
 * payload. Throws `ApiError('unsupported_column_type')` for any
 * column type not in the v0.1 friendly-translator allowlist —
 * including allowlisted-but-not-yet-implemented types in this
 * skeleton. The error carries `column_id`, `type`, and a literal
 * `--set-raw` example so an agent that hits an unsupported type
 * can paste a working command without consulting Monday's docs.
 *
 * **Throws** `ApiError`:
 *   - `unsupported_column_type` — type not in the friendly
 *     allowlist, or in the allowlist but awaiting M5a implementation
 *     (status / dropdown / date / people, currently).
 */
export const translateColumnValue = (
  inputs: TranslateColumnValueInputs,
): TranslatedColumnValue => {
  const { column, value } = inputs;
  if (!isWritableColumnType(column.type)) {
    throw unsupportedColumnTypeError(column.id, column.type);
  }
  switch (column.type) {
    case 'text':
      return simple(column.id, 'text', value);
    case 'long_text':
      return simple(column.id, 'long_text', value);
    case 'numbers':
      return simple(column.id, 'numbers', value);
    case 'status':
      return rich(column.id, 'status', value, translateStatus(value));
    case 'dropdown':
      return rich(column.id, 'dropdown', value, translateDropdown(column.id, value));
    case 'date':
    case 'people':
      // Allowlisted but not yet implemented — surface the same
      // unsupported error shape so agents have a single contract to
      // key off until the rich-type writers land. Each follow-up
      // session lifts one of these out of this branch.
      throw unsupportedColumnTypeError(column.id, column.type);
  }
};

const simple = (
  columnId: string,
  columnType: 'text' | 'long_text' | 'numbers',
  rawInput: string,
): TranslatedColumnValue => ({
  columnId,
  columnType,
  payload: { format: 'simple', value: rawInput },
  rawInput,
});

const rich = (
  columnId: string,
  columnType: 'status' | 'dropdown',
  rawInput: string,
  value: Readonly<Record<string, unknown>>,
): TranslatedColumnValue => ({
  columnId,
  columnType,
  payload: { format: 'rich', value },
  rawInput,
});

/**
 * Status payload per `cli-design.md` §5.3 step 3:
 *   - Non-negative integer input → `{ index: N }` (number, not
 *     string — Monday's status indexes are integers and the
 *     `change_*_column_value` JSON scalar serialises a number as
 *     a number).
 *   - Anything else → `{ label: <verbatim> }`. No NFC / case-fold
 *     here: the resolver upstream normalised the *column* token,
 *     not the *value* — Monday matches the label against the
 *     board's settings server-side, and a label like " Done "
 *     with surrounding whitespace would be agent-side noise we
 *     should preserve so Monday's `validation_failed` points at
 *     the right input.
 *
 * Empty string emits `{ label: "" }` and is *not* treated as a
 * "clear" intent — `monday item clear` is the dedicated verb for
 * that. Pinned in tests so future contributors don't add silent
 * fall-through-to-clear behaviour.
 */
const translateStatus = (raw: string): Readonly<Record<string, unknown>> => {
  if (NON_NEGATIVE_INTEGER.test(raw)) {
    return { index: Number(raw) };
  }
  return { label: raw };
};

/**
 * Dropdown payload per `cli-design.md` §5.3 step 3:
 *   - Comma-split, per-segment trimmed, empty segments dropped.
 *   - All remaining segments numeric → `{ ids: [N1, N2, ...] }`
 *     (numbers, not strings — dropdown IDs from Monday's
 *     `settings_str.labels[].id` are integers).
 *   - Any non-numeric segment → `{ labels: [s1, s2, ...] }`
 *     (strings, verbatim post-trim).
 *
 * **Disambiguation rule, pinned.** A label literally named `"1"`
 * cannot be set via `--set tags=1` — that input parses as the
 * `id` path. Agents who hit this collision use `--set-raw
 * tags='{"labels":["1"]}'` to bypass the translator. Surfaced
 * in the module header as a known limitation; documented via
 * unit test rather than runtime warning because it's a corner
 * case (Monday-generated dropdown labels are strings the user
 * typed; integer-only labels are vanishingly rare).
 *
 * **Empty-after-filter throws `usage_error`.** Inputs like
 * `--set tags=""` or `--set tags=" , "` carry no labels and no
 * IDs — there's nothing to translate. Throwing `usage_error`
 * (rather than emitting `{ labels: [] }`) keeps `--set` and
 * `monday item clear` non-overlapping: the only way to clear
 * a dropdown is the dedicated verb. Pinned via test.
 */
const translateDropdown = (
  columnId: string,
  raw: string,
): Readonly<Record<string, unknown>> => {
  const parts = raw
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (parts.length === 0) {
    throw new UsageError(
      `Dropdown column "${columnId}" needs at least one label or numeric ID. ` +
        `Got "${raw}". To clear a dropdown column, use \`monday item clear ${columnId}\` instead.`,
      {
        details: {
          column_id: columnId,
          column_type: 'dropdown',
          raw_input: raw,
          hint:
            'pass a comma-separated list of labels (e.g. --set ' +
            `${columnId}='Backend,Frontend') or numeric IDs (--set ` +
            `${columnId}=1,2); use --set-raw to bypass the friendly translator.`,
        },
      },
    );
  }
  if (parts.every((part) => NON_NEGATIVE_INTEGER.test(part))) {
    return { ids: parts.map((part) => Number(part)) };
  }
  return { labels: parts };
};

/**
 * Non-negative integer: matches `0`, `42`, `1234567` but not `-1`,
 * `0.5`, `1e3`, or `42 ` (with trailing whitespace). Used to gate
 * `status` index input and `dropdown` ID input. Negatives go to
 * the label / labels path because Monday status indexes are >= 0
 * and dropdown IDs are auto-incremented positive integers.
 */
const NON_NEGATIVE_INTEGER = /^\d+$/u;

/**
 * Builds the canonical `unsupported_column_type` error (`cli-design.md`
 * §5.3 step 4 + §6.5). The `--set-raw` example uses the literal
 * column ID so an agent can paste-and-edit. Exported for unit
 * coverage.
 */
export const unsupportedColumnTypeError = (
  columnId: string,
  type: string,
): ApiError =>
  new ApiError(
    'unsupported_column_type',
    `Column "${columnId}" has type "${type}", which is not in the v0.1 ` +
      `friendly --set translator allowlist. Use --set-raw with the ` +
      `Monday-shape JSON, or wait for v0.2 / a later M5a session for ` +
      `built-in support.`,
    {
      details: {
        column_id: columnId,
        type,
        // The hint is intentionally generic: when the CLI knows the
        // exact Monday shape for a type, we add it to the friendly
        // allowlist instead of leaving callers to copy a hint. The
        // --set-raw example below is the always-correct escape.
        hint:
          'pass the Monday-shape JSON with --set-raw; see ' +
          'https://developer.monday.com/api-reference/reference/column-types-reference ' +
          'for per-type shapes.',
        set_raw_example: `--set-raw ${columnId}='<json>'`,
      },
    },
  );
