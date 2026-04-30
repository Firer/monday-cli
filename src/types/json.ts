/**
 * Tight typing for the Monday `JSON` scalar payload shape
 * (R-JsonValue, M5a follow-up to Codex review pass-1 on the
 * status/dropdown commit, deferred until the people translator
 * exercised the first translator with a nested array of objects
 * with mixed primitive types).
 *
 * `Readonly<Record<string, unknown>>` (the previous slot type)
 * admits `undefined` values, symbols, functions, and class
 * instances — none of which `JSON.stringify` round-trips. Mostly
 * benign in practice (the translator builds payloads from typed
 * inputs), but a future contributor who pipes through a less-
 * disciplined source could land a non-JSON value at Monday's
 * wire boundary and see a silent corruption.
 *
 * This module narrows the type toward what the JSON scalar
 * accepts — catching the common non-JSON-shaped values at
 * compile time with no runtime cost. The narrowing is
 * structural, not semantic: see "What this does NOT prevent"
 * on `JsonValue` below for the shapes TypeScript can't catch
 * (NaN/Infinity, cycles, symbol-keyed properties, BigInt).
 *
 * **Closed-type-literal caveat.** TypeScript treats closed object
 * types (interfaces / type literals) as not implicitly satisfying
 * open index signatures, even when their values are all
 * structurally compatible. A typed payload like
 * `{personsAndTeams: readonly {id: number; kind: 'person'}[]}` is
 * structurally a JsonObject but doesn't assign without a cast at
 * the boundary. The cast site comments call this out so a future
 * refactor doesn't waste time trying to remove the cast.
 */

/**
 * The full `JSON` scalar value type. Models the JSON grammar
 * RFC 8259 prescribes — string / number / boolean / null /
 * arrays / objects — minus `undefined` (`JSON.stringify({x:
 * undefined})` drops the key, which is silent payload
 * corruption — the type system catches it instead).
 *
 * **What this does NOT prevent.** TypeScript's `number` type
 * includes `NaN` and `±Infinity`, both of which `JSON.stringify`
 * silently maps to `null`. JsonValue can't exclude them
 * structurally; callers that build payloads from arithmetic
 * results should validate at the boundary. Codex pass-1 nit on
 * the R-JsonValue refactor; documented here so a future
 * contributor doesn't assume "JsonValue = JSON.stringify-safe"
 * unconditionally.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | JsonObject;

/**
 * The JSON-object branch of `JsonValue` — used for rich payload
 * shapes the translator builds (status / dropdown / date /
 * people). Values must themselves be `JsonValue`s; keys are
 * always strings. Index signature is open (callers pass
 * type-narrowed shapes through `as JsonObject` casts at the
 * boundary).
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
