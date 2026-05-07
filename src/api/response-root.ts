/**
 * Response-root field assertion (R41 lift, v0.2-plan §22).
 *
 * Distinguishes "key absent" (response-shape drift →
 * `internal_error`, whole-call) from "value null" (resource missing
 * / can't be applied → `not_found`, per-record). Codex M14 round-2
 * F1 + round-3 F1 pinned the contract; R41 lifts the inline helpers
 * that workspace add-users / workspace remove-users / board add-
 * users each ship verbatim.
 *
 * **Why distinct from `assertUpdateMutationPresent`**
 * (`api/update-mutation-result.ts`). M13's helper handles null /
 * undefined uniformly with `not_found` — pre-dating the M14
 * missing-root-key vs null-value distinction. R42 (retroactive
 * sweep across pre-M14 mutation verbs) handles unifying them; R41
 * stays scoped to the M14 + M15 partial-success-fan-out family.
 *
 * **Used by:** `commands/workspace/add-users.ts` /
 * `commands/workspace/remove-users.ts` / `commands/board/add-users.ts`.
 *
 * **Not used by:** single-target mutation verbs (board create /
 * update / archive / delete / duplicate, workspace create / update /
 * delete) — those carry their own per-verb missing-root-key checks
 * because the contract is "every successful call returns the
 * resource" rather than "value null is a per-record path"; the
 * single-target verbs never throw `not_found` from the inline check
 * (the per-verb projector does that on the unwrapped value).
 */

import { ApiError } from '../utils/errors.js';

export interface AssertResponseFieldPresentInputs {
  /** The parsed response data object (after the wire-shape parse). */
  readonly data: Readonly<Record<string, unknown>>;
  /** The mutation root key name (e.g. `'add_users_to_board'`). */
  readonly key: string;
  /** The operation label for `internal_error` messages
   * (e.g. `'BoardAddUsers'`). Distinct from `key` because the
   * GraphQL operation name is human-readable PascalCase whereas
   * `key` is the snake_case mutation field. */
  readonly operationLabel: string;
  /** The scope-id detail key (`'workspace_id'` or `'board_id'`). */
  readonly scopeKey: string;
  /** The scope-id value (the workspace or board ID). */
  readonly scopeId: string;
  /** The target-id detail key (always `'user_id'` in M14/M15
   * partial-success-fan-out verbs; future verbs may use other
   * targets — keep this parameterised for forward-compat). */
  readonly targetKey: string;
  /** The target-id value (the user ID for the current dispatch
   * iteration). */
  readonly targetId: string;
}

/**
 * Throws `ApiError('internal_error')` when `key` is absent from
 * `data`; throws `ApiError('not_found')` when present but null.
 * Returns void on success. The caller's downstream code can rely
 * on `data[key]` being a non-null value after this call.
 *
 * Distinct error codes per the M14 round-2 F1 / round-3 F1
 * contract — `dispatchSequential` re-throws `internal_error`
 * (whole-call schema drift) but lets `not_found` land in the
 * per-record slot. Without this distinction, a per-record
 * not_found could be produced from a schema-drift response,
 * masking the contract violation.
 */
export const assertResponseFieldPresent = (
  inputs: AssertResponseFieldPresentInputs,
): void => {
  const { data, key, operationLabel, scopeKey, scopeId, targetKey, targetId } =
    inputs;
  if (!(key in data)) {
    throw new ApiError(
      'internal_error',
      `Monday's ${operationLabel} response is missing the ${key} root field`,
      {
        details: {
          [scopeKey]: scopeId,
          [targetKey]: targetId,
          hint:
            'this is a schema-drift error in Monday\'s GraphQL response; ' +
            'verify the mutation declaration and update the response ' +
            'schema if Monday\'s contract has changed.',
        },
      },
    );
  }
  const raw = data[key];
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no payload from ${key} for ${targetKey.replace(/_id$/u, '')} ${targetId}`,
      { details: { [targetKey]: targetId } },
    );
  }
};
