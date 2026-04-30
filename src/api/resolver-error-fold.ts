/**
 * Resolver-error-folding helpers (`v0.1-plan.md` §17 R19).
 *
 * Two-helper module that consolidates the resolver-warning preservation
 * pattern + the cache-sourced `validation_failed` → `column_archived`
 * remap pattern. Lifted in M5b session 2 (2026-04-30) before
 * `item clear` / `item update` could copy them.
 *
 * **Why a shared module.** Both helpers were born inside
 * `commands/item/set.ts` (M5b session 1, Codex pass-1 findings F2/F4),
 * and the dry-run engine carried an inline shape of the resolver-
 * warning fold for its own `column_archived` throw path. M5b's
 * `item clear` / `item update` would each need the same two helpers
 * verbatim — copying the ~80 LOC three more times would set the next
 * Codex pass up to flag drift between copies. R7 / R8 timing rule:
 * extract on the THIRD example, not the second; M5b session 2 lands
 * the third (item update) and the fourth (item clear) in the same
 * session, so the helper's shape absorbs both new examples in this
 * commit.
 *
 * **Scope.** Two exports, both pure functions:
 *   - `foldResolverWarningsIntoError` — folds resolver warnings into a
 *     thrown `MondayCliError`'s `details.resolver_warnings` slot. Used
 *     by every typed post-resolution failure across the M5b mutation
 *     surfaces (translator `UsageError`s, `ApiError(unsupported_column_
 *     type)` / `user_not_found`, mutation-time `validation_failed`,
 *     `column_archived` from the dry-run engine).
 *   - `maybeRemapValidationFailedToArchived` — async helper that
 *     inspects a thrown `validation_failed` after a cache-sourced
 *     resolution and, if a forced metadata refresh confirms the
 *     column is archived, remaps the error to `column_archived` so
 *     agents key off the stable code.
 *
 * **Why not inside `api/columns.ts`.** Already 533 lines and owns the
 * read-side resolver. The fold helpers are write-side concerns
 * (consumed by command actions + the dry-run engine, not by the
 * resolver itself) and `columns.ts` shouldn't import from
 * `board-metadata.ts`'s refresh path beyond what the resolver needs.
 * A separate module also gives the helpers their own unit-test surface
 * without dragging the resolver's full test fixture.
 */

import { ApiError, MondayCliError, UsageError } from '../utils/errors.js';
import type { ResolverWarning } from './columns.js';
import { refreshBoardMetadata } from './board-metadata.js';
import type { MondayClient } from './client.js';

interface ResolverDetailWarning {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * Folds resolver warnings (`column_token_collision` /
 * `stale_cache_refreshed`) into a thrown error's
 * `details.resolver_warnings` slot. Returns a NEW error of the same
 * code with merged details; the original is discarded.
 *
 * **No-op fast path.** When `resolverWarnings` is empty, the original
 * error passes through unchanged — no allocation, same identity.
 *
 * **Class preservation.** The fold reconstructs the error via the
 * concrete typed-error constructor matching `err.code` so the new
 * error stays the same class:
 *   - `usage_error` → `UsageError`
 *   - `config_error` / `cache_error` → `MondayCliError` base class
 *     (no specific class for these in v0.1, though the contract
 *     covers them so a future `ConfigError` / `CacheError` lift
 *     would just need one more branch).
 *   - everything else (the Monday-API surface) → `ApiError`.
 *
 * Pre-fix, `commands/item/set.ts` only handled `ApiError` — a
 * `UsageError` translator failure (date / dropdown / people invalid
 * input) would bypass the fold and lose the resolver context (Codex
 * pass-1 finding F2). Lifted shape covers every `MondayCliError`
 * subclass.
 */
export const foldResolverWarningsIntoError = (
  err: MondayCliError,
  resolverWarnings: readonly ResolverWarning[],
): MondayCliError => {
  if (resolverWarnings.length === 0) return err;
  const detailWarnings: readonly ResolverDetailWarning[] = resolverWarnings.map(
    (w) => ({
      code: w.code,
      message: w.message,
      details: w.details,
    }),
  );
  const merged = mergeDetails(err, detailWarnings);
  if (err.code === 'usage_error') {
    return new UsageError(err.message, merged);
  }
  if (err.code === 'config_error' || err.code === 'cache_error') {
    return new MondayCliError(err.code, err.message, merged);
  }
  return new ApiError(err.code, err.message, merged);
};

const mergeDetails = (
  err: MondayCliError,
  detailWarnings: readonly ResolverDetailWarning[],
): {
  readonly cause: unknown;
  readonly httpStatus?: number;
  readonly mondayCode?: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details: Readonly<Record<string, unknown>>;
} => ({
  cause: err.cause,
  ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }),
  ...(err.mondayCode === undefined ? {} : { mondayCode: err.mondayCode }),
  ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
  retryable: err.retryable,
  ...(err.retryAfterSeconds === undefined
    ? {}
    : { retryAfterSeconds: err.retryAfterSeconds }),
  details: {
    ...(err.details ?? {}),
    resolver_warnings: detailWarnings,
  },
});

export interface MaybeRemapValidationFailedInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly columnId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly noCache: boolean;
  /**
   * Source the original column resolution came through. The remap
   * fires only when the resolution was cache-sourced — a `live`
   * resolution already saw the live archived flag, so a
   * `validation_failed` after live resolution is genuine (label
   * typo, schema mismatch, etc.) and shouldn't be re-classified.
   */
  readonly resolutionSource: 'live' | 'cache' | 'mixed';
}

/**
 * Inspects a thrown `validation_failed` after a cache-sourced
 * resolution and remaps it to `column_archived` if a forced-fresh
 * metadata refresh confirms the column is archived.
 *
 * Codex pass-1 finding F4: the archived-column guarantee was
 * cache-stale in one direction — when cached metadata said active
 * but Monday had since archived the column, the live mutation fired
 * and surfaced as `validation_failed`, not the stable
 * `column_archived` code agents key off (cli-design §6.5). This
 * helper closes that gap.
 *
 * **Resolver warnings preserved.** When the caller has already
 * folded resolver warnings (via `foldResolverWarningsIntoError`)
 * into the original error's `details.resolver_warnings`, the
 * remapped error inherits the slot via `details: { ...existing,
 * ... }` so a stale-cache-then-archived flow doesn't drop the
 * refresh signal.
 *
 * **Identity preservation.** Returns the original error unchanged
 * when the code isn't `validation_failed`, when the resolution was
 * live-sourced, or when the post-refresh column is still active.
 * The cache write that `refreshBoardMetadata` performs is a useful
 * side-effect — agents retrying after the failure see the corrected
 * metadata.
 */
export const maybeRemapValidationFailedToArchived = async (
  err: MondayCliError,
  inputs: MaybeRemapValidationFailedInputs,
): Promise<MondayCliError> => {
  if (err.code !== 'validation_failed') return err;
  if (inputs.resolutionSource === 'live') return err;
  let refreshed;
  try {
    refreshed = await refreshBoardMetadata({
      client: inputs.client,
      boardId: inputs.boardId,
      env: inputs.env,
      noCache: inputs.noCache,
    });
  } catch {
    // Refresh failed — propagate the original validation_failed
    // unchanged rather than masking with an unrelated refresh
    // error. The agent's retry loop will hit the same path.
    return err;
  }
  const live = refreshed.metadata.columns.find(
    (c) => c.id === inputs.columnId,
  );
  if (live?.archived !== true) return err;
  // Confirmed archived. Build a column_archived error preserving
  // the original error's resolver_warnings slot.
  const existing = err.details ?? {};
  return new ApiError(
    'column_archived',
    `Column ${JSON.stringify(inputs.columnId)} on board ` +
      `${inputs.boardId} is archived (Monday rejected the mutation as ` +
      `validation_failed; a forced metadata refresh confirmed the ` +
      `archived state). Un-archive the column in Monday or pick a ` +
      `different target.`,
    {
      cause: err,
      details: {
        ...existing,
        column_id: inputs.columnId,
        column_title: live.title,
        column_type: live.type,
        board_id: inputs.boardId,
        remapped_from: 'validation_failed',
        hint:
          'cache-sourced resolution missed the archived flag; the CLI ' +
          'forced a live refresh after the mutation failed and confirmed ' +
          'the column is now archived. Resolver warnings (if any) carry ' +
          'the pre-refresh state.',
      },
    },
  );
};
