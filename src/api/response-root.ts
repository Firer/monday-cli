/**
 * Response-root field assertion (R41 + R42 lifts, v0.2-plan §22).
 *
 * Distinguishes "key absent" (response-shape drift →
 * `internal_error`, whole-call) from "value null" (resource missing
 * / per-record idiomatic null → `not_found`, per-record). Codex M14
 * round-2 F1 + round-3 F1 pinned the contract; R41 lifted the inline
 * check that workspace add-users / workspace remove-users / board
 * add-users each shipped verbatim; R42 (post-v0.2 cleanup window)
 * extends the same helper across the ~32 single-target mutation
 * verbs that previously conflated the two cases (or left the
 * missing-key path silent — projector-only null-handling treated
 * "key absent" the same as "value null").
 *
 * **Two modes** controlled by `nullHandling` (required — keep the
 * caller explicit so a future site doesn't silently inherit the
 * wrong behaviour):
 *
 * - `'caller_handles'` (single-target verbs, R42): only check key
 *   presence. The caller's downstream projector handles null-value
 *   per-noun semantics — most M5b/M9-M12 verbs throw `not_found`
 *   from the projector for `null` (Monday's idiomatic missing-
 *   payload signal); item set throws `internal_error` for `null`
 *   per its M5b decision (an item that exists must always return a
 *   payload from `change_*`). Either way, R42's missing-key check
 *   surfaces FIRST and produces a uniform `internal_error` for
 *   schema drift, regardless of the noun's null-value choice.
 *
 * - `'throw_not_found'` (partial-success-fan-out verbs, R41): also
 *   check `data[key]` for null/undefined and throw `not_found` so
 *   `dispatchSequential` slots it into the per-record failure
 *   array (whereas `internal_error` propagates and aborts the
 *   whole call). The `notFoundTarget` field shapes the not_found
 *   message phrasing and details.
 *
 * **Used by:**
 * - `'throw_not_found'` mode: `users-fan-out-mutation.ts`
 *   (wraps board add-users / workspace add-users / workspace
 *   remove-users via `dispatchSequential`).
 * - `'caller_handles'` mode (R42 sweep): every single-target
 *   mutation verb across M5b → M17 (item set / clear / update,
 *   item create / archive / delete / duplicate / move / upsert,
 *   update create / reply / edit / delete / toggle, board create
 *   / update / archive / delete / duplicate / add-users, column-
 *   create / update / delete, group-create / update / archive /
 *   duplicate / delete). M15-M17 sites inline the check
 *   verbatim pre-R42; the lift consolidates that boilerplate
 *   onto this helper. Pre-M14 (M5b/M9-M12) sites had no inline
 *   missing-key check; R42 adds it as net-new behaviour, picking
 *   up the M14 contract distinction proactively.
 *
 * **Not used by:** `update clear-all` per-target dispatch — that
 *   site uses `assertUpdateMutationPresent` (api/update-mutation-
 *   result.ts) which has a different contract (treats null +
 *   undefined uniformly as `not_found`, pre-dating M14's
 *   distinction). Migrating it is a separate question for v0.3
 *   (the two helpers may usefully merge).
 */

import { ApiError } from '../utils/errors.js';

const SCHEMA_DRIFT_HINT =
  "this is a schema-drift error in Monday's GraphQL response; " +
  'verify the mutation declaration and update the response ' +
  "schema if Monday's contract has changed.";

export interface AssertResponseFieldPresentInputs {
  /**
   * The response data object. Accepted as `unknown` so callers can
   * pass `response.data` (typed via per-verb wire interfaces like
   * `ChangeSimpleResponse`) without casting at every site; the
   * helper runtime-narrows to a `Record<string, unknown>` once.
   */
  readonly data: unknown;
  /** The mutation root key name (e.g. `'archive_item'`). */
  readonly key: string;
  /**
   * The operation label for `internal_error` messages — typically
   * the GraphQL operation name (PascalCase). Distinct from `key`
   * (snake_case mutation field).
   */
  readonly operationLabel: string;
  /**
   * Detail map echoed in the `internal_error` thrown when `key` is
   * absent. Caller supplies the full set — for two-target partial-
   * success-fan-out verbs that's `{[scopeKey]: scopeId, [targetKey]: targetId}`;
   * for single-target verbs it's just `{[idKey]: idValue}` (or a
   * pair like `{board_id, item_id}` for two-tuple wire signatures).
   * The schema-drift `hint` is appended automatically.
   */
  readonly details: Readonly<Record<string, unknown>>;
  /**
   * Behaviour when `data[key]` is null/undefined. See module doc
   * for the per-mode contract.
   */
  readonly nullHandling: 'caller_handles' | 'throw_not_found';
  /** Required iff `nullHandling === 'throw_not_found'`. */
  readonly notFoundTarget?: { readonly key: string; readonly id: string };
}

/**
 * Throws `ApiError('internal_error')` when `key` is absent from
 * `data` (schema drift). When `nullHandling === 'throw_not_found'`,
 * also throws `ApiError('not_found')` if `data[key]` is null /
 * undefined (per-record idiomatic missing). Returns void on success.
 *
 * Distinct error codes per the M14 round-2 F1 / round-3 F1
 * contract — `dispatchSequential` re-throws `internal_error` (whole-
 * call schema drift) but lets `not_found` land in the per-record
 * slot. Without this distinction, a per-record not_found could be
 * produced from a schema-drift response, masking the contract
 * violation; agents writing recovery loops keyed off `error.code`
 * would treat schema drift as "this resource doesn't exist" and
 * skip the failure rather than reporting it.
 */
export const assertResponseFieldPresent = (
  inputs: AssertResponseFieldPresentInputs,
): void => {
  const { data, key, operationLabel, details, nullHandling, notFoundTarget } =
    inputs;

  // Defensive narrow — the wire-schema parse upstream typically
  // guarantees object-shape, but pre-M14 sites pass `response.data`
  // directly without a wire-schema parse, so a malformed (non-
  // object) response surfaces here rather than crashing on a later
  // property access. Matched against `internal_error` since it's
  // the same class of contract violation as a missing root key.
  if (typeof data !== 'object' || data === null) {
    throw new ApiError(
      'internal_error',
      `Monday's ${operationLabel} response data is not object-shaped`,
      { details: { ...details, hint: SCHEMA_DRIFT_HINT } },
    );
  }

  const record = data as Record<string, unknown>;
  if (!(key in record)) {
    throw new ApiError(
      'internal_error',
      `Monday's ${operationLabel} response is missing the ${key} root field`,
      { details: { ...details, hint: SCHEMA_DRIFT_HINT } },
    );
  }

  if (nullHandling === 'caller_handles') return;

  const raw = record[key];
  if (raw === null || raw === undefined) {
    // 'throw_not_found' mode requires notFoundTarget to shape the
    // per-record message + details. The type system marks it
    // optional (since 'caller_handles' mode doesn't need it), but
    // logically required here — surface a defensive internal_error
    // if a future caller omits it in 'throw_not_found' mode.
    /* c8 ignore next 7 — defensive: every 'throw_not_found' caller
       supplies notFoundTarget; a future regression that omits it
       fails loudly here rather than producing a half-shaped
       not_found. */
    if (notFoundTarget === undefined) {
      throw new ApiError(
        'internal_error',
        `assertResponseFieldPresent: 'throw_not_found' mode requires notFoundTarget`,
        { details: { ...details, hint: SCHEMA_DRIFT_HINT } },
      );
    }
    const noun = notFoundTarget.key.replace(/_id$/u, '');
    throw new ApiError(
      'not_found',
      `Monday returned no payload from ${key} for ${noun} ${notFoundTarget.id}`,
      { details: { [notFoundTarget.key]: notFoundTarget.id } },
    );
  }
};
