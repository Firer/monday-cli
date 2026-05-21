/**
 * Mutation-path catch-arm error decoration helpers
 * (`docs/v0.8-plan.md` §3 "v0.8 refactor cluster" + §22 R-v0.7-NEW-5 /
 * R-v0.8-NEW-6; full pattern detail in `docs/v0.7-plan.md` §22
 * R-v0.7-NEW-5).
 *
 * **Status: SHIPPED at the v0.8 refactor-cluster IMPL.** Both runtime
 * bodies below replace the pre-flight c8-ignored stub throws; the 7
 * inline sites (4 `reThrowDecorated`, 3 `projectCauseForEnvelope`) now
 * delegate the lifted surface, and the focused unit suite
 * (`tests/unit/api/error-decoration.test.ts`) drives the coverage
 * ratchet (the conditional-spread arms that previously dragged
 * `item/update.ts` to ~80%). This was a pure internal lift — no probe,
 * no new ERROR_CODES, no cli-design section, no new command,
 * byte-for-byte behaviour-preserving at every site. The pre-flight
 * shape mirrored v0.6-M38 `file-column-set.ts` (stub-then-IMPL, minus
 * the wire/argv surface); R-NEW-76's parseArgv-BEFORE-c8 boundary rule
 * did NOT apply here because the helpers have no argv surface.
 *
 * **Why a dedicated cluster (not folded into a feature milestone).**
 * `reThrowDecorated` spans 4 unrelated mutation paths (item-clear-bulk
 * / JSON-bulk / M42 file-bulk / M46 file-bulk-multi) — too broad to
 * ride one feature's IMPL, and 3 of the 4 are unrelated to M47/M48's
 * feature work. The lift landed ahead of M47 specifically so the
 * fail-fast scaffold was consolidated BEFORE M47 would add a 5th touch.
 *
 * ---
 *
 * ## R-v0.7-NEW-5 — `reThrowDecorated` (fail-fast-scaffold lift)
 *
 * The post-`foldAndRemap` typed split-and-rebuild is byte-identical
 * across **4 consumers**:
 *
 *   1. item-clear-bulk     `src/commands/item/clear.ts`  (the c8-ignored arms)
 *   2. JSON-bulk           `src/commands/item/update.ts` (per-item fail-fast)
 *   3. M42 file-bulk       `src/commands/item/update.ts` (`runItemUpdateBulkFileDispatch`)
 *   4. M46 file-bulk-multi `src/commands/item/update.ts` (multi-file bulk)
 *
 * **LIFTED (the invariant):** the typed split —
 *   `if (remapped.code === 'usage_error') → new UsageError(...)`
 *   `else → new ApiError(remapped.code, ...)` — with the 5
 *   conditional-spread metadata arms (`cause` on both arms;
 *   `httpStatus` / `mondayCode` / `requestId` / `retryAfterSeconds`
 *   plus the unconditional `retryable: remapped.retryable` on the
 *   ApiError arm). These spreads were the uncovered branches that
 *   dragged `item/update.ts` to 79.42% — consolidating them into ONE
 *   helper + ONE focused unit test recovered the margin (the 4-path
 *   ratchet; `item/update.ts` branches 79.42% → 87.27%).
 *
 * **STAYS INLINE (the over-fit boundary — each site's own work):** the
 *   `foldAndRemap` call, `const existing = remapped.details ?? {}`, and
 *   the per-site decoration object built from `existing` + the
 *   site-specific slots (`applied_count` / `applied_to` /
 *   `failed_at_item` / `matched_count` shared by all 4; plus
 *   `applied_file_columns_per_item` / `failed_file_column` /
 *   `file_count` / `file_column_ids` on the M46-multi site). Each site
 *   assembles its own `details` record, then delegates the typed split.
 *
 * ## R-v0.8-NEW-6 — `projectCauseForEnvelope` (cause-projection builder)
 *
 * Adjacent, bundled (both live in mutation-path catch arms) but a
 * SEPARATE helper — NOT merged into `reThrowDecorated`. Recurs across
 * **3 orphan-warn sites**:
 *
 *   1. M43 create-time leg-2 `src/commands/item/create.ts` (`create_then_file_upload_partial_failure`)
 *   2. M46 create-time multi  `src/commands/item/create.ts` (same + `applied_file_columns`)
 *   3. M46 single-item multi  `src/commands/item/update.ts` (`multi_file_update_partial_failure`)
 *
 * **LIFTED:** ONLY the ~4-line projection builder — seed
 *   `{ code, message }` from the (already-remapped, or raw-`MondayCliError`)
 *   error, then conditionally attach `details`. (At the two create
 *   sites the `if (err.details !== undefined)` arm was c8-ignored as
 *   defensive while inlined; the builder's own unit test now drives
 *   both a details-present and a details-absent error, so this lift
 *   dropped those c8-ignore directives and genuinely covers both arms.)
 *
 * **STAYS INLINE (why this is structurally distinct from
 *   `reThrowDecorated`, not the same lift):** the surrounding
 *   orphan-warn decoration diverges per site — the outer code is ALWAYS
 *   `internal_error` (not the preserved remapped code), the
 *   `details.reason` literal differs, the decoration slots differ
 *   (`created_item_id` vs `item_id`; `applied_file_columns` present on
 *   the M46 sites), and the hint text differs. The genuinely-shared
 *   surface is JUST the projection builder. Merging the two helpers
 *   would force parameterising outer-code policy + decoration shape +
 *   cause-projection-vs-in-place-merge, collapsing each helper's value
 *   to "shared `foldAndRemap` call site" (already factored). See
 *   `docs/v0.7-plan.md` §22 R-v0.7-NEW-5 "M43 IMPL outcome" for the
 *   full distinctness argument.
 */

import { ApiError, UsageError, type MondayCliError } from '../utils/errors.js';

/**
 * Re-throws a `foldAndRemap`-decorated bulk/fail-fast error, rebuilding
 * it as the right typed class with its wire metadata preserved.
 *
 * The caller has already folded resolver-warnings + applied the
 * `validation_failed → column_archived` stale-cache remap, and has
 * assembled the full `details` decoration (its `...existing` spread
 * plus the per-site progress slots). This helper owns ONLY the typed
 * split: `usage_error` rebuilds as {@link UsageError}; any other code
 * rebuilds as {@link ApiError} preserving the wire metadata
 * (`httpStatus` / `mondayCode` / `requestId` / `retryAfterSeconds` /
 * `retryable`) via conditional spreads. Always throws — return type is
 * `never` so callers don't need a trailing unreachable statement.
 *
 * @param remapped the post-`foldAndRemap` error whose typed code +
 *   wire metadata drive the rebuild
 * @param details the fully-assembled decoration record (already
 *   including the `...existing` spread of `remapped.details`)
 */
export function reThrowDecorated(
  remapped: MondayCliError,
  details: Record<string, unknown>,
): never {
  // usage_error rebuilds as UsageError — the only metadata it carries
  // is the optional `cause` chain. Every other code rebuilds as
  // ApiError preserving the wire metadata via conditional spreads
  // (each `?? :` attaches a field only when the source error carried
  // it; the per-Monday-error permutations of httpStatus / mondayCode /
  // requestId / retryAfterSeconds set-or-unset aren't all exercised by
  // any single call site, which is why they lived as uncovered branches
  // before this lift folded them into one tested helper).
  if (remapped.code === 'usage_error') {
    throw new UsageError(remapped.message, {
      ...(remapped.cause === undefined ? {} : { cause: remapped.cause }),
      details,
    });
  }
  throw new ApiError(remapped.code, remapped.message, {
    ...(remapped.cause === undefined ? {} : { cause: remapped.cause }),
    ...(remapped.httpStatus === undefined ? {} : { httpStatus: remapped.httpStatus }),
    ...(remapped.mondayCode === undefined ? {} : { mondayCode: remapped.mondayCode }),
    ...(remapped.requestId === undefined ? {} : { requestId: remapped.requestId }),
    retryable: remapped.retryable,
    ...(remapped.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: remapped.retryAfterSeconds }),
    details,
  });
}

/**
 * Builds the JSON `details.cause` projection for an orphan-warn
 * envelope: a `{ code, message }` seed plus an optional `details`
 * passthrough. The surrounding always-`internal_error` wrap +
 * `details.reason` discriminator + hint text stay inline at each call
 * site (they diverge); this owns only the shared projection shape.
 *
 * @param err the (remapped, or raw) `MondayCliError` whose surface is
 *   projected into the agent-inspectable `details.cause` slot
 * @returns the projection record for embedding under `details.cause`
 */
export function projectCauseForEnvelope(
  err: MondayCliError,
): Record<string, unknown> {
  const projection: Record<string, unknown> = {
    code: err.code,
    message: err.message,
  };
  // `details` is optional on MondayCliError; attach it only when the
  // source error carried one. Both arms are driven by the helper's
  // focused unit test, so the two create-site call sites can drop the
  // c8-ignore that previously masked the details-absent arm.
  if (err.details !== undefined) {
    projection.details = err.details;
  }
  return projection;
}
