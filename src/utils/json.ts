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
