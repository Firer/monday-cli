/**
 * Shared `me`-token detection (`cli-design.md` §5.3 step 3 line
 * 704-707).
 *
 * Three CLI surfaces resolve `me` to the connected user's ID, all
 * with the same case-insensitive matching rule:
 *
 *   1. **`--where Owner=me`** (read filter) — `src/api/filters.ts`.
 *   2. **`item search --where Owner=me`** (search filter) —
 *      `src/commands/item/search.ts`.
 *   3. **`--set Owner=me`** (write translator) — `src/api/people.ts`.
 *
 * Pre-extraction, all three sites carried a verbatim copy of the
 * same expression (`value.trim().toLowerCase() === 'me'`) — added
 * one-by-one across the people-session Codex passes as the parity
 * gap between the three was discovered. A single helper here
 * prevents the next drift outright; if v0.2 extends the grammar
 * (e.g. `i` / `@me` aliases) the change lands in one place.
 *
 * **Why a separate module.** The helper has no dependencies and
 * three structurally-distinct consumers; folding it into
 * `people.ts` would bind the read-side filter modules to the
 * write-side translator's import graph, which is the wrong
 * ordering. Keeping it standalone matches the seam every
 * resolver-shaped helper in `src/api/` already follows.
 */

/**
 * The set of tokens that resolve to the connected user. Exposed as
 * a frozen array so a future v0.2 extension (e.g. `i`, `@me`) lands
 * by adding one entry; the type-guard contract is unchanged.
 *
 * Lowercase canonical forms — callers lowercase the input via
 * `isMeToken` before checking, so adding a token in mixed case
 * here would silently drop matching for the lowercase form. Pin
 * via test (`me-token.test.ts`).
 */
export const ME_TOKENS: readonly string[] = ['me'];

/**
 * Returns `true` if the given token is one of the recognised `me`
 * aliases. Case-insensitive after trim — `me` / `ME` / `Me` /
 * `mE` / `" me "` all match. cli-design.md §5.3 step 3 line
 * 704-707 doesn't pin case-sensitivity explicitly, but the people
 * session's Codex passes settled on case-insensitive across all
 * three surfaces (logged as a v0.1-plan §3 M5a spec gap for
 * cli-design backfill).
 *
 * Returns `false` for any other input — including empty strings
 * (`""` doesn't trim to a `me` token; the empty-input branch in
 * each call site handles that path before reaching the helper).
 */
export const isMeToken = (token: string): boolean => {
  const normalised = token.trim().toLowerCase();
  return ME_TOKENS.includes(normalised);
};
