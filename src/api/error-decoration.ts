/**
 * Mutation-path catch-arm error decoration helpers
 * (`docs/v0.8-plan.md` §3 "v0.8 refactor cluster" + §22 R-v0.7-NEW-5 /
 * R-v0.8-NEW-6; full pattern detail in `docs/v0.7-plan.md` §22
 * R-v0.7-NEW-5).
 *
 * **Status: PRE-FLIGHT STUB — runtime bodies + the 7 call-site rewires
 * + the focused unit tests land at the v0.8 refactor-cluster IMPL
 * session.** Both functions below are c8-ignored stub throws this
 * session; NEITHER is wired into a call site yet. The 7 inline sites
 * (4 `reThrowDecorated`, 3 `projectCauseForEnvelope`) stay byte-for-byte
 * as they are until IMPL swaps the stub for the runtime body and
 * delegates each site. This mirrors the v0.6-M38 `file-column-set.ts`
 * pre-flight-stub-then-IMPL shape, minus the wire/argv surface — this
 * is a pure internal lift (no probe, no new ERROR_CODES, no cli-design
 * section, no new command). See R-v0.7-NEW-3 for the stub-body
 * conventions (the `details.reason: '<id>_preflight_stub'` +
 * `details.milestone` discriminator pair); R-NEW-76's
 * parseArgv-BEFORE-c8 boundary rule does NOT apply here because the
 * helpers have no argv surface to ship.
 *
 * **Why a dedicated cluster (not folded into a feature milestone).**
 * `reThrowDecorated` spans 4 unrelated mutation paths (item-clear-bulk
 * / JSON-bulk / M42 file-bulk / M46 file-bulk-multi) — too broad to
 * ride one feature's IMPL, and 3 of the 4 are unrelated to M47/M48's
 * feature work. The lift is scheduled ahead of M47 specifically so the
 * fail-fast scaffold is consolidated BEFORE M47 would add a 5th touch.
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
 *   ApiError arm). These spreads are the uncovered branches that drag
 *   `item/update.ts` to 79.42% — consolidating them into ONE helper +
 *   ONE focused unit test recovers the margin (the 4-path ratchet).
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
 *   sites the `if (err.details !== undefined)` arm is currently
 *   c8-ignored as defensive; the builder's own unit test drives both a
 *   details-present and a details-absent error, so the IMPL DROPS those
 *   c8-ignore directives and genuinely covers both arms.)
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

import { ApiError, type MondayCliError } from '../utils/errors.js';

/**
 * Re-throws a `foldAndRemap`-decorated bulk/fail-fast error, rebuilding
 * it as the right typed class with its wire metadata preserved.
 *
 * The caller has already folded resolver-warnings + applied the
 * `validation_failed → column_archived` stale-cache remap, and has
 * assembled the full `details` decoration (its `...existing` spread
 * plus the per-site progress slots). This helper owns ONLY the typed
 * split: `usage_error` rebuilds as `UsageError` (imported at IMPL);
 * any other code rebuilds as {@link ApiError} preserving the wire metadata
 * (`httpStatus` / `mondayCode` / `requestId` / `retryAfterSeconds` /
 * `retryable`) via conditional spreads. Always throws — return type is
 * `never` so callers don't need a trailing unreachable statement.
 *
 * @param remapped the post-`foldAndRemap` error whose typed code +
 *   wire metadata drive the rebuild
 * @param details the fully-assembled decoration record (already
 *   including the `...existing` spread of `remapped.details`)
 */
/* c8 ignore start -- pre-flight stub: the WHOLE declaration is wrapped
   (not just the body) so this unwired function stays fully out of the
   coverage denominator INCLUDING the `functions` metric — wrapping only
   the body still counts `FN:reThrowDecorated` as FNF/FNH:0 (Codex
   pre-flight R1 P2-1). The runtime typed-split body + the 4 call-site
   delegations + the focused unit test land at the v0.8 refactor-cluster
   IMPL session (R-v0.7-NEW-3 stub-body conventions). */
export function reThrowDecorated(
  remapped: MondayCliError,
  details: Record<string, unknown>,
): never {
  throw new ApiError(
    'internal_error',
    'reThrowDecorated: pre-flight stub — the runtime typed-split body ' +
      'lands at the v0.8 refactor-cluster IMPL',
    {
      details: {
        reason: 'refactor_cluster_preflight_stub',
        milestone: 'v0.8-refactor-cluster',
        helper: 'reThrowDecorated',
        remapped_code: remapped.code,
        detail_keys: Object.keys(details),
      },
    },
  );
  /* c8 ignore stop */
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
/* c8 ignore start -- pre-flight stub: the WHOLE declaration is wrapped
   (same `functions`-metric reason as `reThrowDecorated` above; Codex
   pre-flight R1 P2-1). The runtime builder body + the 3 call-site
   delegations + the focused unit test (both details-present +
   details-absent arms) land at the v0.8 refactor-cluster IMPL session;
   unwired this session. */
export function projectCauseForEnvelope(
  err: MondayCliError,
): Record<string, unknown> {
  throw new ApiError(
    'internal_error',
    'projectCauseForEnvelope: pre-flight stub — the runtime builder ' +
      'body lands at the v0.8 refactor-cluster IMPL',
    {
      details: {
        reason: 'refactor_cluster_preflight_stub',
        milestone: 'v0.8-refactor-cluster',
        helper: 'projectCauseForEnvelope',
        err_code: err.code,
      },
    },
  );
  /* c8 ignore stop */
}
