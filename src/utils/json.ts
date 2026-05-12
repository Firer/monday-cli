/**
 * Shared JSON-shape type-guards (`docs/v0.3-plan.md` §22 R-NEW-27
 * lift, post-M24 close-docs audit).
 *
 * Before this lift, six structurally-identical `isObject` /
 * `isJsonObject` / `isPlainObject` guards existed across the
 * codebase (4 production + 2 test). The pattern accumulated
 * silently from M2 (fixtures + e2e infrastructure) through M24
 * (item-history-projection JSON parsing). M24's developer added
 * a fresh local copy rather than discovering the existing 5 — the
 * same miss + mass-migrate cadence as R-NEW-14/15/16 (error
 * utilities) and R-NEW-19 (safeParse → unwrapOrThrow).
 *
 * Consumers narrow `unknown` to `Readonly<Record<string, unknown>>`
 * before reading keyed fields off untrusted external payloads
 * (Monday wire responses, JSON-from-disk cassettes, e2e fixture
 * server bodies). `Readonly` is the more defensive choice — none
 * of the existing consumers mutate the guarded value, and any
 * downstream code that needs a mutable shape casts explicitly.
 */

/**
 * Type-guard for "value is a plain JSON object" — narrows
 * `unknown` to `Readonly<Record<string, unknown>>`. Returns
 * false for null, arrays, and primitives.
 */
export const isPlainObject = (
  v: unknown,
): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `parseJsonArg` (R-NEW-42 lift, post-M27-close drift sweep).
 *
 * Three sites in `src/commands/*` consume a JSON-encoded argv
 * string + reject malformed JSON as `usage_error`:
 *
 *   - `monday raw --vars <json>` / `--vars-file <path>`
 *     (`src/commands/raw/index.ts`)
 *   - `monday board column-create --settings <json>`
 *     (`src/commands/board/column-create.ts`)
 *   - `monday webhook create --config <json>`
 *     (`src/commands/webhook/create.ts`, M27 IMPL)
 *
 * Each site pre-lift wrapped `JSON.parse` in try/catch + threw
 * `UsageError` with a verb-specific message + `cause: err` +
 * verb-specific `details`. The shape is structurally identical;
 * the only variation is the message prefix + which detail-keys
 * land. M27 IMPL pushed the count to 3, crossing the R7/R8
 * 3-consumer threshold; this lift ships at the post-M27-close
 * drift sweep mirroring R-NEW-38's same-cadence lift at
 * `c71a96d`.
 *
 * Behavioural note: pre-lift, `webhook/create.ts` did NOT
 * interpolate the underlying `JSON.parse` error message
 * (just the static `'--config must be a valid JSON-encoded
 * string'` text). The other two sites used `errorMessage(err)`
 * to surface the SyntaxError detail. The lift normalises to
 * always interpolate — better diagnostic value, no
 * agent-facing contract change (the `error.code` stays
 * `usage_error`; only `error.message` widens).
 */

import { UsageError } from './errors.js';
import { errorMessage } from './errors.js';

export interface ParseJsonArgOptions {
  /**
   * Free-form message prefix. Lands in `error.message` as
   * `${context} (${errorMessage(err)})` on parse failure.
   * Verb-specific phrasing (e.g. `'monday raw: GraphQL
   * variables are not valid JSON'`, `'--settings: malformed
   * JSON'`, `'--config must be a valid JSON-encoded string'`).
   */
  readonly context: string;
  /**
   * Optional `details` map echoed on the surfaced `UsageError`.
   * Each call site contributes verb-specific keys (e.g.
   * `source` for `monday raw`, `column_type` + `raw` for
   * `board column-create`, `board_id` + `hint` for `webhook
   * create`). Schema is per-verb; the helper passes through
   * verbatim.
   */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Parses a JSON-encoded argv string. Returns the parsed value
 * (`unknown` — caller narrows via downstream zod / type-guard);
 * on `SyntaxError` (or any other thrown value from `JSON.parse`)
 * throws `UsageError` with the supplied context, the underlying
 * error as `cause`, and the supplied `details`.
 *
 * Use at every argv-parse-boundary that consumes user-supplied
 * JSON (`--vars`, `--settings`, `--config`, future
 * `--<field>-json` flags). Do NOT use for response-side parsing
 * (Monday wire returns) — those go through `unwrapOrThrow` +
 * a zod schema.
 */
export const parseJsonArg = (
  raw: string,
  options: ParseJsonArgOptions,
): unknown => {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `${options.context} (${errorMessage(err)})`,
      {
        cause: err,
        ...(options.details === undefined
          ? {}
          : { details: options.details }),
      },
    );
  }
};
