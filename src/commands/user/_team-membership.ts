/**
 * Shared partial-success projection helper for the two team-
 * membership verbs (`monday user team-add-members` +
 * `monday user team-remove-members`).
 *
 * Both verbs receive a wire `ChangeTeamMembershipsResult` shape
 * (`failed_users: [User!]` + `successful_users: [User!]`) and
 * must project to the universal §6.1 partial-success envelope's
 * `results: [{user_id, ok, ...}]` shape with input order
 * preserved. The two action bodies' projection logic is
 * byte-identical modulo the `operation` literal — lifting at
 * IMPL kickoff keeps both call sites at one helper invocation +
 * pins the input-order + bucket-lookup discipline in one place.
 *
 * **Wire-vs-CLI semantics asymmetry.** Monday's `failed_users[]`
 * carries the User object but no per-user reason on the wire;
 * the projection emits a generic `membership_failed` error code.
 * See `teamMembershipResultSchema` JSDoc in `src/api/teams.ts`
 * for the canonical asymmetry note + `docs/architecture.md`
 * cross-link (R-NEW-41 4th consumer trigger).
 *
 * **Input-order discipline.** Result order mirrors the input
 * `--users <id,...>` order; for each input user_id the helper
 * looks up in the failed set first (preserving wire's explicit
 * failure flag) then the successful map. An input user_id
 * missing from BOTH buckets surfaces `internal_error` —
 * Monday's wire is expected to return every input user in one
 * bucket, and a missing user indicates a wire-shape regression
 * worth surfacing loudly rather than silently dropping a record.
 *
 * **Single-file scope.** The `_` prefix mirrors the M26b
 * `dev/_shared.ts` cadence — module-private helpers shared
 * across sibling commands but never exported beyond the
 * containing namespace.
 */
import { ApiError } from '../../utils/errors.js';
import type {
  TeamMembershipResult,
  TeamUser,
} from '../../api/teams.js';

export interface ProjectMembershipResultsInputs {
  readonly inputUserIds: readonly string[];
  readonly failedUsers: readonly TeamUser[];
  readonly successfulUsers: readonly TeamUser[];
  readonly operation: 'add_users_to_team' | 'remove_users_from_team';
  readonly teamId: string;
}

/**
 * Generic per-user failure message used when Monday's wire
 * surfaces a user in `failed_users[]` without a per-user reason
 * (the wire's `ChangeTeamMembershipsResult` carries no error /
 * reason / message slot — round-2 probe verified 2 fields only).
 * Surfacing a uniform message keeps agent recovery flows
 * predictable; agents key off `error.code === 'membership_failed'`
 * to retry or surface to the user.
 */
const FAILED_MEMBERSHIP_MESSAGE =
  'Monday rejected this user for team membership change ' +
  '(no per-user reason on the wire — see `docs/architecture.md` ' +
  'Wire-vs-CLI semantics documentation conventions).';

export const projectMembershipResults = (
  inputs: ProjectMembershipResultsInputs,
): readonly TeamMembershipResult[] => {
  const failedById = new Map<string, TeamUser>();
  for (const user of inputs.failedUsers) {
    failedById.set(user.id, user);
  }
  const successfulById = new Map<string, TeamUser>();
  for (const user of inputs.successfulUsers) {
    successfulById.set(user.id, user);
  }
  return inputs.inputUserIds.map((userId): TeamMembershipResult => {
    if (failedById.has(userId)) {
      return {
        user_id: userId,
        ok: false,
        error: {
          code: 'membership_failed',
          message: FAILED_MEMBERSHIP_MESSAGE,
        },
      };
    }
    const successful = successfulById.get(userId);
    if (successful !== undefined) {
      return {
        user_id: userId,
        ok: true,
        user: successful,
      };
    }
    throw new ApiError(
      'internal_error',
      `Monday's ${inputs.operation} response omitted user ${userId} from both failed_users and successful_users (wire-shape regression).`,
      {
        details: {
          team_id: inputs.teamId,
          user_id: userId,
          operation: inputs.operation,
          hint:
            'wire shape regression — re-probe ' +
            '`ChangeTeamMembershipsResult` to confirm bucket semantics',
        },
      },
    );
  });
};
