/**
 * Column-value writer (`cli-design.md` §5.3, `v0.1-plan.md` §3 M5a).
 *
 * The write half of the column-value abstraction: takes a resolved
 * column + a raw user-supplied string and produces the Monday wire
 * payload Monday's `change_simple_column_value` /
 * `change_column_value` / `change_multiple_column_values` mutations
 * accept.
 *
 * **Scope so far.** Six of the seven v0.1-allowlisted types
 * translate: `text` / `long_text` / `numbers` (simple-string
 * payloads, M5a skeleton); `status` / `dropdown` (rich-object
 * payloads); and `date` (rich, with relative-token resolution
 * against the profile timezone). `people` carries its own
 * translation logic and arrives in a follow-up session; until
 * then it falls through to `unsupported_column_type` like any
 * non-allowlisted type.
 *
 * **Date resolution context** (cli-design §5.3 step 3 + the
 * "Relative dates and timezone" subsection). Relative tokens
 * (`today`, `+3d`, `+2h`) need a clock + a timezone; both come
 * from `TranslateColumnValueInputs.dateResolution`. Defaults to
 * the system clock + system tz when omitted — M5b's command
 * layer plumbs `MONDAY_TIMEZONE` env override through this slot.
 * Tests inject a deterministic clock for DST-boundary coverage.
 * The actual resolution machinery lives in `dates.ts`; this
 * module just delegates and packages the result alongside the
 * other column types.
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
import {
  parseDateInput,
  type DateResolution,
  type DateResolutionContext,
} from './dates.js';

export type { DateResolution, DateResolutionContext } from './dates.js';

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
  /**
   * Echo of the resolution context for relative-token date
   * inputs — populated by the `date` translator when the input
   * was a relative token (`today`, `+3d`, `+2h`) so the
   * dry-run engine can render `details.resolved_from` per
   * cli-design §6.4. `null` for explicit ISO inputs (where
   * the raw input *is* the resolved value) and for
   * non-`date` columns. cli-design §5.3 line 783-786 pins
   * the shape.
   */
  readonly resolvedFrom: DateResolution | null;
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
  /**
   * Resolution context for the `date` translator's relative
   * tokens (`today`, `+3d`, `+2h`). Ignored for non-`date`
   * columns. Defaults to system clock + system tz when omitted;
   * M5b's command layer plumbs `MONDAY_TIMEZONE` env override
   * through this slot per cli-design §5.3 line 765.
   */
  readonly dateResolution?: DateResolutionContext;
}

/**
 * Translates a single `<column>=<value>` pair into the Monday wire
 * payload. Throws `ApiError('unsupported_column_type')` for any
 * column type not in the v0.1 friendly-translator allowlist —
 * including allowlisted-but-not-yet-implemented types. The error
 * carries `column_id`, `type`, and a literal `--set-raw` example
 * so an agent that hits an unsupported type can paste a working
 * command without consulting Monday's docs.
 *
 * **Throws** `ApiError`:
 *   - `unsupported_column_type` — type not in the friendly
 *     allowlist, or in the allowlist but awaiting M5a follow-up
 *     (`date` / `people`, currently).
 *
 * **Throws** `UsageError`:
 *   - `usage_error` — for status / dropdown numeric input that
 *     exceeds `Number.MAX_SAFE_INTEGER`, or for dropdown input
 *     that contains no labels and no IDs after trim + filter.
 *     See `unsafeIntegerError` and the dropdown empty-input
 *     branch for the documented messages.
 */
export const translateColumnValue = (
  inputs: TranslateColumnValueInputs,
): TranslatedColumnValue => {
  const { column, value, dateResolution } = inputs;
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
      return rich(column.id, 'status', value, translateStatus(value, column.id));
    case 'dropdown':
      return rich(column.id, 'dropdown', value, translateDropdown(column.id, value));
    case 'date': {
      const parsed = parseDateInput(value, column.id, dateResolution);
      return {
        columnId: column.id,
        columnType: 'date',
        rawInput: value,
        payload: { format: 'rich', value: parsed.payload },
        resolvedFrom: parsed.resolvedFrom,
      };
    }
    case 'people':
      // Allowlisted but not yet implemented — surface the same
      // unsupported error shape so agents have a single contract to
      // key off until the rich-type writers land. The follow-up
      // session lifts this out of this branch.
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
  // Only the date translator populates resolvedFrom; every other
  // type emits null so the dry-run engine has one shape to read.
  resolvedFrom: null,
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
  resolvedFrom: null,
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
 *
 * **Safe-integer bound.** Numeric input larger than
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1) silently rounds via
 * `Number(raw)`; very long digit strings yield `Infinity`,
 * which `JSON.stringify` serialises as `null`. Either case
 * would corrupt the wire shape. We throw `usage_error` rather
 * than silently routing to the label path because the input
 * was unambiguously the index path (all digits, no signs / no
 * decimals) — sending `{label: "999999999999999999999"}` to
 * Monday would be a worse surprise than a local error.
 */
const translateStatus = (
  raw: string,
  columnId: string,
): Readonly<Record<string, unknown>> => {
  if (NON_NEGATIVE_INTEGER.test(raw)) {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw unsafeIntegerError(columnId, 'status', raw);
    }
    return { index: parsed };
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
        `Got "${raw}". To clear a dropdown column, use ` +
        `\`monday item clear <iid> ${columnId} [--board <bid>]\` instead.`,
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
    const ids = parts.map((part) => {
      const parsed = Number(part);
      if (!Number.isSafeInteger(parsed)) {
        throw unsafeIntegerError(columnId, 'dropdown', part);
      }
      return parsed;
    });
    return { ids };
  }
  return { labels: parts };
};

/**
 * Builds the `usage_error` for numeric input that exceeds
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1). Shared by status (index)
 * and dropdown (id) because the failure mode is identical: the
 * input parsed as an integer-shaped number but `Number(raw)`
 * lost precision (or yielded `Infinity` for digit strings ~310+
 * chars long). Either case would land at Monday as the wrong
 * integer or as `null` after `JSON.stringify`. The error carries
 * the raw input so an agent's debug log shows exactly what they
 * sent, and a hint nudging them toward the label path or
 * `--set-raw`.
 */
const unsafeIntegerError = (
  columnId: string,
  columnType: 'status' | 'dropdown',
  raw: string,
): UsageError => {
  const titled = columnType === 'status' ? 'Status' : 'Dropdown';
  // status uses indexes ("first label is index 0"); dropdown uses
  // numeric IDs from settings_str.labels[].id. Different word in
  // the message so an agent doesn't see "smaller ID" on a status
  // column where the concept is "index", not "ID".
  const noun = columnType === 'status' ? 'indexes' : 'IDs';
  const smaller = columnType === 'status' ? 'a smaller index' : 'a smaller ID';
  // Hints interpolate the actual `columnId` so an agent can
  // paste-and-edit. Status hint uses the literal word "label"
  // because the label-vs-index split lives in cli-design.md §5.3
  // step 3; dropdown hint shows both the labels and IDs forms.
  const hint =
    columnType === 'status'
      ? `use a status label (e.g. --set ${columnId}=Done) or an index < 2^53`
      : `use dropdown labels (e.g. --set ${columnId}=Backend,Frontend) ` +
        `or IDs < 2^53`;
  return new UsageError(
    `${titled} column "${columnId}" got numeric input "${raw}" that ` +
      `exceeds JavaScript's safe-integer range (2^53 - 1, i.e. ` +
      `9007199254740991). Number(raw) would lose precision or yield ` +
      `Infinity, corrupting the wire shape. Monday's ${columnType} ` +
      `${noun} are small non-negative integers — pass a label, ` +
      `${smaller}, or --set-raw to bypass the translator entirely.`,
    {
      details: {
        column_id: columnId,
        column_type: columnType,
        raw_input: raw,
        hint,
      },
    },
  );
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
 * The wire shape `change_multiple_column_values` accepts for one
 * column inside its `column_values` map: either a bare string (for
 * the simple types Monday accepts as a string) or a plain JSON
 * object (for rich types — and for `long_text`, see below).
 */
export type MultiColumnValue =
  | string
  | Readonly<Record<string, unknown>>;

/**
 * Discriminated union over the three v0.1 mutation paths that
 * `cli-design.md` §5.3 step 5 enumerates. The variant carries
 * exactly the fields M5b's command layer threads into the GraphQL
 * SDK — no extra projection at the call site.
 *
 *   - `change_simple_column_value` — single simple type. The
 *     `value` field is the bare string Monday's
 *     `change_simple_column_value(value: String!)` mutation
 *     accepts. `text` / `long_text` / `numbers` only.
 *   - `change_column_value` — single rich type. The `value` field
 *     is the plain-object payload Monday's
 *     `change_column_value(value: JSON!)` mutation accepts —
 *     the SDK / fetch layer JSON-stringifies at the wire boundary.
 *     `status` / `dropdown` (today); `date` / `people` will join
 *     in follow-up sessions.
 *   - `change_multiple_column_values` — N (any combo). The
 *     `columnValues` map carries one entry per column; per-column
 *     value is `string | object` per `MultiColumnValue` above.
 *     **`long_text` re-wrap**: simple-form `long_text`'s bare
 *     string is wrapped to `{ text: <value> }` for this mutation
 *     because Monday's per-column blob inside the multi mutation
 *     requires the object form for `long_text` (a wire-shape
 *     divergence from `change_simple_column_value`'s bare-string
 *     acceptance — see selectMutation source comment for the spec
 *     gap).
 */
export type SelectedMutation =
  | {
      readonly kind: 'change_simple_column_value';
      readonly columnId: string;
      readonly value: string;
    }
  | {
      readonly kind: 'change_column_value';
      readonly columnId: string;
      readonly value: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'change_multiple_column_values';
      readonly columnValues: Readonly<Record<string, MultiColumnValue>>;
    };

/**
 * Picks the right Monday mutation for a list of translated column
 * values per `cli-design.md` §5.3 step 5.
 *
 * Dispatch:
 *   - 1 translated value, simple → `change_simple_column_value`
 *     (bare-string `value`).
 *   - 1 translated value, rich → `change_column_value` (object
 *     `value`).
 *   - N translated values (any combo of simple / rich) →
 *     `change_multiple_column_values`. Atomic on Monday's side —
 *     either every column update lands or none do.
 *
 * **Duplicate column IDs throw `usage_error`.** Bundling two
 * `--set status=Done --set status=Doing` would have last-write-wins
 * semantics inside `change_multiple_column_values`'s map and the
 * agent has no way to know which one won. Surfacing as a typed
 * error at the bundling boundary keeps mutations deterministic;
 * the command layer (M5b) can catch + reframe with the literal
 * `--set` flags it received.
 *
 * **Empty input throws `usage_error`.** Defensive — the command
 * layer is supposed to validate `--set` was supplied, but the
 * helper shouldn't return a malformed `change_multiple_column_values`
 * with an empty map.
 *
 * **`long_text` re-wrap, spec gap.** Monday's
 * `change_multiple_column_values(column_values: JSON!)` accepts a
 * map where each value is either a string or a per-type object.
 * For `long_text` specifically, the per-type object is `{text:
 * <value>}` — so the bare string that `change_simple_column_value`
 * accepts is *not* the right shape inside the multi mutation.
 * `text` / `numbers` stay as bare strings. This wire-shape
 * divergence isn't called out in cli-design.md §5.3 step 5; logged
 * as a spec gap in v0.1-plan.md §3 M5a for backfill. Pinned via
 * fixture in the unit suite.
 */
export const selectMutation = (
  translated: readonly TranslatedColumnValue[],
): SelectedMutation => {
  if (translated.length === 0) {
    throw new UsageError(
      'selectMutation requires at least one translated column value. ' +
        'The command layer should reject the no-`--set` case before ' +
        'reaching this helper.',
      { details: { translated_count: 0 } },
    );
  }
  if (translated.length === 1) {
    const only = translated[0];
    /* c8 ignore next 4 — defensive: length === 1 was just checked,
       so `only` cannot be undefined. The guard exists for
       `noUncheckedIndexedAccess` narrowing. */
    if (only === undefined) {
      throw new UsageError('selectMutation: unreachable indexing guard');
    }
    if (only.payload.format === 'simple') {
      return {
        kind: 'change_simple_column_value',
        columnId: only.columnId,
        value: only.payload.value,
      };
    }
    return {
      kind: 'change_column_value',
      columnId: only.columnId,
      value: only.payload.value,
    };
  }
  // Multi: project each translated value to its multi-form blob,
  // detecting duplicate column IDs along the way.
  const columnValues: Record<string, MultiColumnValue> = {};
  const seenIds = new Set<string>();
  for (const t of translated) {
    if (seenIds.has(t.columnId)) {
      throw new UsageError(
        `Multiple --set values target column "${t.columnId}". ` +
          `change_multiple_column_values is a map keyed by column ID; ` +
          `bundling two values for the same column would silently keep ` +
          `only one. Pass at most one --set per column.`,
        {
          details: {
            column_id: t.columnId,
            duplicate_count:
              translated.filter((other) => other.columnId === t.columnId).length,
          },
        },
      );
    }
    seenIds.add(t.columnId);
    columnValues[t.columnId] = projectForMulti(t);
  }
  return { kind: 'change_multiple_column_values', columnValues };
};

/**
 * Projects one translated column value into the per-column blob
 * `change_multiple_column_values` accepts. Three cases:
 *
 *   - rich payload → pass the object through unchanged.
 *   - simple payload, type `long_text` → wrap as `{ text: <value> }`.
 *     Monday's multi-mutation blob for `long_text` requires the
 *     object form (spec gap; see `selectMutation` JSDoc).
 *   - simple payload, any other type → bare string.
 */
const projectForMulti = (t: TranslatedColumnValue): MultiColumnValue => {
  if (t.payload.format === 'rich') {
    return t.payload.value;
  }
  if (t.columnType === 'long_text') {
    return { text: t.payload.value };
  }
  return t.payload.value;
};

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
