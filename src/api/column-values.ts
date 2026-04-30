/**
 * Column-value writer (`cli-design.md` §5.3, `v0.1-plan.md` §3 M5a).
 *
 * The write half of the column-value abstraction: takes a resolved
 * column + a raw user-supplied string and produces the Monday wire
 * payload Monday's `change_simple_column_value` /
 * `change_column_value` / `change_multiple_column_values` mutations
 * accept.
 *
 * **Skeleton scope (this commit).** Translates the three "simple"
 * v0.1 types (`text`, `long_text`, `numbers`) — all of which accept
 * a bare string. The four rich types (`status`, `dropdown`, `date`,
 * `people`) each carry their own translation logic and arrive in
 * follow-up sessions; until then they fall through to
 * `unsupported_column_type` like any non-allowlisted type. The
 * mutation-selection helper (`change_simple_*` vs `change_*` vs
 * `change_multiple_*`) lands when at least two type categories
 * exist to drive its shape.
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

import { ApiError } from '../utils/errors.js';
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
 *     `numbers`.
 *   - `rich`   — plain-object payload accepted by
 *     `change_column_value` and the per-column entry in
 *     `change_multiple_column_values`. Used by `status`, `dropdown`,
 *     `date`, `people` — none of which are implemented in this
 *     skeleton commit but the typed slot exists so M5b's mutation
 *     dispatcher can be written against the final shape.
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
    case 'dropdown':
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
