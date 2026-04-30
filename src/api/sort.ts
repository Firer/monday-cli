/**
 * Per-page deterministic sort (`cli-design.md` §3.1 #8, `v0.1-plan.md`
 * §3 M4).
 *
 * Lists default to "by ID, ascending" regardless of Monday's response
 * order. The seam lives here so `item list` (cursor-paginated),
 * `item search`, and `item subitems` all share a single
 * implementation — and so the M5b dry-run engine can sort its
 * `planned_changes` array against the same rule when bulk operations
 * are involved.
 *
 * **Per-page only, by design.** Cursor pagination delivers a stable
 * page-by-page walk but Monday doesn't promise the cross-page order
 * is ID-ascending. Sorting *within* a page is cheap and gives agents
 * a stable shape to assert against (snapshot tests, fixture diffs);
 * trying to sort across pages would either require collecting every
 * page in memory (defeats NDJSON streaming) or a server-side
 * `order_by` clause the agent can already pass via `--filter-json`.
 * The §5.6 caveat documents this; the helper keeps the per-page
 * scope explicit.
 *
 * **Sort key: numeric ID.** Monday's item / board / user / workspace
 * IDs are decimal strings that can exceed `Number.MAX_SAFE_INTEGER`
 * for older accounts (`cli-design.md` §6.2 — "IDs are always
 * strings"). Lex sort is wrong (`"9" > "10"` in JS string compare);
 * `Number.parseInt` is wrong for IDs past 2^53. We compare on the
 * tuple `(length, lexicographic)` — same-length decimal strings
 * sort numerically by lex compare, and shorter strings always
 * represent smaller numbers (no leading zeros on Monday IDs). That's
 * the same trick `findOne`'s `--first` selector uses (see
 * `src/api/resolvers.ts`); centralising here means a future ID-kind
 * with leading-zero conventions surfaces as one bug, not many.
 *
 * Stable sort: `Array.prototype.sort` is stable in V8 / Node ≥ 12,
 * so tied IDs keep arrival order. The helper doesn't fall back to a
 * second key.
 */

/**
 * Compares two decimal-string IDs as if they were numeric. Returns
 * a negative / zero / positive number suitable for `Array#sort`.
 * Exported for unit tests and for callers that want to thread the
 * comparator into their own collection (e.g. `findOne`'s `--first`
 * selector — see `resolvers.ts`).
 */
export const compareNumericId = (a: string, b: string): number => {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  // Same-length decimal strings → lex order matches numeric order.
  // localeCompare is overkill here (and locale-dependent); a direct
  // < / > compare is what we want.
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/**
 * Sorts a page of resources by their ID ascending. Pure — returns a
 * new array, leaves the input untouched. Caller passes the projector
 * because items / boards / etc. all expose `id` differently in
 * fixture form (`{id}` vs `{node:{id}}` for paginated edges).
 *
 * Empty input is fine: returns `[]`. Single-element input is fine:
 * returns a copy. Bypassing the sort entirely on small inputs is
 * tempting but the cost is zero on the hot path and the regression
 * surface is shorter when every shape goes through the same
 * comparator.
 */
export const sortByIdAsc = <T>(
  items: readonly T[],
  getId: (t: T) => string,
): readonly T[] => {
  return [...items].sort((a, b) => compareNumericId(getId(a), getId(b)));
};
