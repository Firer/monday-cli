/**
 * `--columns-mapping <json>` parser (M11 — `monday item move`).
 *
 * The cross-board `item move` accepts a JSON object mapping source
 * column IDs to target column IDs:
 *
 *   monday item move 12345 --to-group g --to-board 67890 \
 *     --columns-mapping '{"status_4": "status_42", "due": "deadline"}'
 *
 * Maps directly to Monday's `move_item_to_board(columns_mapping:
 * [ColumnMappingInput!])` parameter where `ColumnMappingInput =
 * { source: ID!, target?: ID }` (verifiable in the SDK at
 * `node_modules/@mondaydotcomorg/api/dist/esm/index.d.ts:551`) — the
 * cli-side `{<src>: <target>}` shape transposes one-for-one onto the
 * wire array `[{source: <src>, target: <target>}, ...]`.
 *
 * **What lives here.** Argv-time JSON parse + zod validation of the
 * shape (object whose keys + values are non-empty strings).
 * `usage_error` on any parse failure so agents see exit 1 with a
 * useful detail decoration, not exit 2 `internal_error` from a bare
 * ZodError.
 *
 * **What lives at the call site (`commands/item/move.ts`).** The
 * unmatched-column check (whether each source ID exists on target,
 * either via verbatim match or via the mapping). That's per-board
 * metadata work — the parse boundary doesn't see metadata.
 *
 * **Value-overrides deferred to v0.3.** v0.2-plan §3 M11 mentioned
 * accepting a richer `{<src>: { id: <target>, value: <override> }}`
 * form whose `value` would re-run through M5a/M8's translator on
 * target metadata. Monday's `ColumnMappingInput` doesn't carry a
 * value slot, so the only way to ship value-overrides would be a
 * non-atomic post-move `change_multiple_column_values` mutation —
 * which adds partial-failure semantics with no precedent. Deferred;
 * agents fire `monday item set <iid> <target>=<value>` post-move
 * when they need value overrides. The simple form is enough for
 * the M11 surface. v0.2-plan §15 captures the SDK-shape discovery.
 *
 * The argv layer in `commands/item/move.ts` calls
 * `parseColumnMappingJson(rawString)` before the command's zod
 * `inputSchema` runs; the schema then sees a typed `ColumnMapping`
 * (not a JSON-blob string), keeping the schema narrow.
 */

import { z } from 'zod';
import { UsageError } from '../utils/errors.js';

/**
 * The validated mapping shape. Keys are source column IDs (slugs),
 * values are target column IDs (slugs). Empty `{}` is valid — the
 * explicit "drop everything (Monday's permissive default)" opt-in
 * per cli-design §8 decision 5.
 */
export type ColumnMapping = Readonly<Record<string, string>>;

const columnMappingSchema = z.record(
  z.string().min(1, { message: 'expected a non-empty source column ID' }),
  z.string().min(1, { message: 'expected a non-empty target column ID' }),
);

const summariseIssues = (
  err: z.ZodError,
): readonly { readonly path: string; readonly message: string }[] =>
  err.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join('.'),
    message: issue.message,
  }));

/**
 * Parses + validates the raw `--columns-mapping <json>` argv value.
 * Throws `UsageError` (exit 1) on any failure so agents see a useful
 * decoration on the envelope rather than the runner's generic
 * `internal_error`.
 *
 * Failure modes (all `usage_error`):
 *   - Argv didn't supply a string (commander quirk, defensive).
 *   - Empty string.
 *   - Malformed JSON.
 *   - JSON root isn't an object (`null`, array, primitive).
 *   - Any value isn't a non-empty string (e.g. `{src: 42}`,
 *     `{src: {id: "tgt"}}` — the latter is the v0.2-plan rich form
 *     deferred to v0.3; we reject loudly so agents reading the error
 *     know to omit the `value` slot for now).
 */
export const parseColumnMappingJson = (raw: unknown): ColumnMapping => {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new UsageError(
      '--columns-mapping requires a non-empty JSON object literal',
      {
        details: {
          hint:
            "example: --columns-mapping '{\"status_4\": \"status_42\"}'; " +
            "use '{}' to accept Monday's permissive default (drop unmatched).",
        },
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `--columns-mapping value isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
        details: {
          hint:
            "example: --columns-mapping '{\"status_4\": \"status_42\"}' " +
            '(quote the JSON in your shell to escape spaces and braces).',
        },
      },
    );
  }

  // JSON.parse returns `unknown`; the zod schema rejects any non-
  // object root (arrays + primitives). z.record's "expected object"
  // path/code combination tells the agent the root shape was wrong.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(
      '--columns-mapping must be a JSON object (e.g. {"status_4": "status_42"})',
      {
        details: {
          received_kind: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
          hint:
            "use {} to accept Monday's permissive default (drop unmatched columns silently); " +
            'rich {id, value?} forms for cross-board value-overrides are deferred to v0.3.',
        },
      },
    );
  }

  const result = columnMappingSchema.safeParse(parsed);
  if (!result.success) {
    throw new UsageError(
      `--columns-mapping shape rejected: ${summariseIssues(result.error)
        .map((i) => (i.path.length > 0 ? `${i.path}: ${i.message}` : i.message))
        .join('; ')}`,
      {
        cause: result.error,
        details: {
          issues: summariseIssues(result.error),
          hint:
            'expected {"<source_col_id>": "<target_col_id>", ...}; ' +
            'rich {id, value?} forms for value-overrides are deferred to v0.3 — fire ' +
            '`monday item set <iid> <target>=<value>` post-move when you need them.',
        },
      },
    );
  }

  return result.data;
};
