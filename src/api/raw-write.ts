/**
 * `--set-raw <col>=<json>` escape-hatch helpers (`cli-design.md` §5.3
 * escape-hatch contract, `v0.2-plan.md` §3 M8).
 *
 * Two surfaces split across argv-parse vs. post-resolution:
 *
 *   - `parseSetRawExpression` — argv-parse-time. Splits `<col>=<json>`
 *     on the first `=`, then parses the JSON segment via `JSON.parse`
 *     and validates the result is a JsonObject (string / number /
 *     array / null at the top level rejected). Malformed JSON or
 *     non-object JSON surfaces as `usage_error` with the parse error
 *     in `details` per cli-design §5.3 line 949-960. Cheap-fail —
 *     no network call fires for an obviously-broken `<json>`.
 *
 *   - `translateRawColumnValue` — post-resolution. Takes the resolved
 *     column + the pre-parsed JsonObject and runs the two reject
 *     lists per cli-design §5.3 escape-hatch contract:
 *       * **Read-only-forever** (`mirror` / `formula` / etc.) →
 *         `unsupported_column_type` with `read_only: true`. Monday
 *         never accepts writes against these regardless of payload,
 *         so accepting a raw payload would just shift the failure
 *         from CLI-time to Monday-time with no new information.
 *       * **`files`-shaped** (`file`, anything else where Monday
 *         uses `add_file_to_column` rather than `change_column_value`)
 *         → `unsupported_column_type` with `deferred_to: "v0.4"`.
 *         The `--set-raw` payload reaches `change_column_value` /
 *         `change_multiple_column_values` only; files-shaped types
 *         can't be written through that wire surface.
 *     Otherwise builds a `TranslatedColumnValue` with `payload:
 *     { format: 'rich', value: <parsed> }` so the existing
 *     `selectMutation` dispatcher handles it uniformly.
 *
 * **Why the split.** The argv-parse-time JSON validation lets the
 * CLI fail fast on malformed input without a network round-trip; the
 * post-resolution type gate needs the resolved column's `type`,
 * which is only known after `resolveColumnWithRefresh` (the resolver
 * needs board metadata, which comes from the network or cache). The
 * caller threads parsed → resolved → translated; each step has one
 * concern.
 *
 * **No type-shape validation.** Per cli-design §5.3 line 949-960:
 * "the CLI does not validate the parsed object against any per-type
 * schema; Monday's server-side rejection surfaces as
 * `validation_failed` with Monday's message." The whole point of
 * `--set-raw` is to bypass the friendly translator's grammar; the
 * user owns wire-shape correctness. The CLI's contract here is
 * narrower: parse the JSON, gate on the column's category, build
 * a `TranslatedColumnValue`.
 *
 * **Mutual exclusion with `--set` is the caller's concern.** The
 * cli-design §5.3 contract pins resolution-time enforcement (after
 * both flags' tokens resolve to column IDs). This module doesn't see
 * `--set` translations — the command layer collects all translated
 * values and passes them to `selectMutation`, which raises
 * `usage_error` on duplicate column IDs. The escape-hatch contract
 * is upheld by reusing `selectMutation`'s existing duplicate-ID
 * check rather than introducing a separate pre-flight check here.
 */

import { ApiError, UsageError } from '../utils/errors.js';
import {
  isFilesShapedType,
  isReadOnlyForeverType,
} from './column-types.js';
import type { JsonObject } from '../types/json.js';
import type { TranslatedColumnValue } from './column-values.js';

export interface ParsedSetRawExpression {
  /** The raw column token agent typed (`status`, `id:status_4`, `External link`). */
  readonly token: string;
  /**
   * The pre-parsed JSON object the agent supplied. Validated as a
   * JsonObject at parse-time per cli-design §5.3 line 949-960 —
   * malformed JSON / non-object JSON rejected with `usage_error`
   * before the call reaches `translateRawColumnValue`.
   */
  readonly value: JsonObject;
  /** The original `<json>` string — preserved for error contexts only. */
  readonly rawJson: string;
}

/**
 * Splits `--set-raw <col>=<json>` on the FIRST `=` per cli-design
 * §5.3 step 2 (matching `--set`'s split rule). Tokens with `=` in
 * the title need shell quoting plus the explicit `id:` / `title:`
 * prefix, same as `--set`.
 *
 * Then parses the `<json>` segment via `JSON.parse` and validates
 * the result is a JsonObject (per cli-design §5.3 line 949-952:
 * "verifies it is a JSON object — malformed JSON or non-object JSON
 * (string / number / array / null at the top level) returns
 * usage_error").
 *
 * **Throws** `UsageError(usage_error)`:
 *   - empty token, missing `=`, or empty value;
 *   - `JSON.parse` throws SyntaxError;
 *   - parsed JSON is not an object (string / number / boolean /
 *     null / array at the top level).
 */
export const parseSetRawExpression = (raw: string): ParsedSetRawExpression => {
  const idx = raw.indexOf('=');
  if (idx <= 0) {
    throw new UsageError(
      `--set-raw: expected <col>=<json> (got ${JSON.stringify(raw)}); ` +
        `use shell quoting and the id:/title: prefix when the column ` +
        `token contains "="`,
      { details: { input: raw } },
    );
  }
  const token = raw.slice(0, idx);
  const rawJson = raw.slice(idx + 1);
  if (rawJson.length === 0) {
    throw new UsageError(
      `--set-raw: empty <json> after "=" (got ${JSON.stringify(raw)}); ` +
        `pass a JSON object literal (e.g. --set-raw status='{"label":"Done"}')`,
      { details: { input: raw, token } },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new UsageError(
      `--set-raw: JSON parse failed for column "${token}". ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Pass a well-formed JSON object literal (e.g. --set-raw ` +
        `status='{"label":"Done"}'). Use single-quote-around-double-` +
        `quote shell quoting on POSIX shells.`,
      {
        cause: err,
        details: {
          token,
          raw_json: rawJson,
          parse_error: err instanceof Error ? err.message : String(err),
          hint:
            'JSON property names + string values use double quotes; ' +
            'wrap the whole literal in single quotes in the shell.',
        },
      },
    );
  }
  if (!isJsonObject(parsed)) {
    throw new UsageError(
      `--set-raw: expected a JSON object for column "${token}", got ` +
        `${describeJsonShape(parsed)}. Per cli-design §5.3 the escape ` +
        `hatch accepts only JSON objects — Monday's column wire shapes ` +
        `are all keyed records (e.g. {"label":"Done"}, {"date":"2026-` +
        `05-01"}, {"personsAndTeams":[...]}).`,
      {
        details: {
          token,
          raw_json: rawJson,
          parsed_shape: describeJsonShape(parsed),
          hint:
            'wrap the literal in {…} — Monday\'s column wire shapes ' +
            'are objects, never bare strings / numbers / arrays.',
        },
      },
    );
  }
  return { token, value: parsed, rawJson };
};

/**
 * Builds a `TranslatedColumnValue` for an already-resolved column +
 * a pre-parsed JsonObject payload. Runs the two reject lists per
 * cli-design §5.3 escape-hatch contract before constructing the
 * translated value:
 *
 *   - **Read-only-forever** → `unsupported_column_type` with
 *     `read_only: true`. Monday computes these server-side; no
 *     payload (raw or friendly) is ever accepted.
 *   - **`files`-shaped** → `unsupported_column_type` with
 *     `deferred_to: "v0.4"`. Monday writes via `add_file_to_column`
 *     (multipart upload), not `change_column_value`; the raw
 *     payload can't reach the right wire surface.
 *
 * Anything else (writable + tentative-slipped + future where the API
 * accepts `change_column_value`) is accepted — the user took the
 * escape hatch and owns wire-shape correctness; Monday's server-side
 * rejection surfaces as `validation_failed` with Monday's message.
 *
 * **`columnType` slot.** The translated value carries the resolved
 * column's actual type string (`column.type`) cast through the
 * `WritableColumnType` union via `as`. The cast is structural —
 * `--set-raw` accepts types outside `WRITABLE_COLUMN_TYPES`, so the
 * runtime value may be any non-rejected type string. Downstream
 * consumers (`selectMutation`, the dry-run engine) use `columnType`
 * for the `long_text` re-wrap branch only; that branch doesn't fire
 * for raw payloads (`payload.format` is always `'rich'`), so the
 * cast is safe by construction.
 */
export const translateRawColumnValue = (
  column: { readonly id: string; readonly type: string },
  value: JsonObject,
  rawJson: string,
): TranslatedColumnValue => {
  if (isReadOnlyForeverType(column.type)) {
    throw new ApiError(
      'unsupported_column_type',
      `Column "${column.id}" has type "${column.type}", which Monday ` +
        `computes server-side and does not make writable via the API. ` +
        `--set-raw cannot bypass this — Monday rejects writes against ` +
        `read-only-forever columns regardless of payload. Set the ` +
        `underlying source column instead (e.g. for a mirror column, ` +
        `write to the column the mirror reflects on the linked board).`,
      {
        details: {
          column_id: column.id,
          type: column.type,
          read_only: true,
          hint:
            'this column type is computed by Monday and is permanently ' +
            'read-only via the API. --set-raw rejects these too — ' +
            'identify the underlying source column (the column the ' +
            'mirror / formula / auto_number / etc. reflects) and write ' +
            'to that instead. See cli-design.md §5.3 escape-hatch ' +
            'contract.',
        },
      },
    );
  }
  if (isFilesShapedType(column.type)) {
    throw new ApiError(
      'unsupported_column_type',
      `Column "${column.id}" has type "${column.type}", which Monday ` +
        `writes via add_file_to_column (multipart upload) rather than ` +
        `change_column_value. --set-raw goes through change_column_value ` +
        `/ change_multiple_column_values, so a raw payload can't reach ` +
        `the right wire surface for this type. Asset upload is pinned ` +
        `to v0.4 per cli-design §13.`,
      {
        details: {
          column_id: column.id,
          type: column.type,
          deferred_to: 'v0.4',
          hint:
            'file upload uses Monday\'s add_file_to_column mutation ' +
            '(multipart). The CLI does not expose that wire path in ' +
            'v0.2; v0.4 will add a dedicated --file flag. --set-raw ' +
            'rejects this type at column-resolution time.',
        },
      },
    );
  }
  return {
    columnId: column.id,
    // Cast: --set-raw accepts types outside WRITABLE_COLUMN_TYPES; the
    // type slot tracks the resolved Monday type string for diagnostic
    // continuity with friendly translations. Downstream `long_text`
    // re-wrap (the only consumer that branches on columnType) doesn't
    // fire for raw payloads (payload.format is always 'rich'), so the
    // cast is safe by construction.
    columnType: column.type as TranslatedColumnValue['columnType'],
    rawInput: rawJson,
    payload: { format: 'rich', value },
    resolvedFrom: null,
    peopleResolution: null,
  };
};

const isJsonObject = (value: unknown): value is JsonObject => {
  if (value === null) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return true;
};

const describeJsonShape = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  // typeof null is 'object' but the null branch above handles it; the
  // remaining 'object' case is the non-array, non-null JsonObject
  // path which doesn't reach this function. The other primitive types
  // (string / number / boolean) are reported verbatim.
  return t;
};

// Re-export for the unit test surface so test files don't need to
// reach into types/json.ts for the JsonObject brand.
export type { JsonObject } from '../types/json.js';
