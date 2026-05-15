/**
 * Team writer + reader surface for the v0.5-M34 `monday user
 * team-*` verbs (`cli-design.md` §4.3 USER section + §13 v0.5
 * entry; `v0.5-plan.md` §3 M34).
 *
 * **Wire surface (empirical probe 2026-05-15, API `2026-01`).** Six
 * Monday GraphQL operations land here — two reads against
 * `Query.teams(...)` + four writes covering the v0.5 team-CRUD
 * frame:
 *
 *   - **List variant** — `Query.teams { id name picture_url
 *     is_guest users { id name email } owners { id name email } }`.
 *     NO pagination at the wire (D6 closure — `Query.teams` has no
 *     `limit:` / `page:` / cursor; returns every team visible to
 *     the token in one shot). Account-size cap on team count is
 *     the only natural limit.
 *   - **Get variant** — `Query.teams(ids: [<tid>])` with the same
 *     selection set. Single-id wire shape — Monday returns
 *     `[Team]` (an array even for one id); the fetcher extracts
 *     index 0. Empty array → `not_found` with `details.team_id`
 *     (Monday's wire collapses "doesn't exist" + "exists but not
 *     visible to token" into the same shape, same convention as
 *     M32 doc-get D8 closure).
 *   - **Create variant** — `create_team(input:
 *     CreateTeamAttributesInput!, options: CreateTeamOptionsInput)
 *     → Team`. Two input objects: `input` is required (`name!`,
 *     `is_guest_team?`, `parent_team_id?`, `subscriber_ids?:
 *     [ID!]`); `options` is optional (`allow_empty_team?`). M34
 *     surfaces `--name`, `--users <id,...>`, `--guest-team`,
 *     `--allow-empty` flags; `--parent <ptid>` deferred per D3.
 *   - **Delete variant** — `delete_team(team_id: ID!) → Team`.
 *     Returns the deleted Team verbatim. Destructive gate per
 *     cli-design §3.1 (M34 verb requires `--yes`).
 *   - **Add-members variant** — `add_users_to_team(team_id: ID!,
 *     user_ids: [ID!]!) → ChangeTeamMembershipsResult { failed_
 *     users: [User!], successful_users: [User!] }`. Wire-level
 *     partial-success envelope; the action body wraps this into
 *     the §6.1 universal `data.results: [{ ok, user_id, ... }]`
 *     shape (D5 closure).
 *   - **Remove-members variant** — `remove_users_from_team(team_
 *     id: ID!, user_ids: [ID!]!) → ChangeTeamMembershipsResult`.
 *     Same envelope shape as add-members.
 *
 * **`Team` object — 6 fields.** Per the v0.5 kickoff probe: `id`
 * (ID!), `name` (String!), `picture_url` (String, nullable),
 * `is_guest` (Boolean, nullable), `users` ([User], nullable —
 * projected to slim `{id, name, email}` per the M19 / M32 slim-
 * User convention), `owners` ([User!]!, non-null wire-side; same
 * slim projection). **No `description` field on the wire** — D1
 * closure drops the speculative `--description` flag the v0.4
 * cli-design row pencilled. **No `update_team` mutation exists**
 * — D2 closure drops a `team-update` verb from v0.5 scope (no
 * rename / re-describe surface on the wire).
 *
 * **`CreateTeamAttributesInput` — 4 input fields.** Per the
 * round-2 probe: `name` (String!), `is_guest_team` (Boolean,
 * nullable), `parent_team_id` (ID, nullable), `subscriber_ids`
 * ([ID!], nullable — must not be empty unless
 * `allow_empty_team: true` per the description). Hierarchical
 * teams exist via `parent_team_id`; v0.5-M34 surfaces the wire
 * slot in the docstring but does NOT ship a `--parent <ptid>`
 * argv flag (D3 deferral — agent-UX hierarchical-team semantics
 * unclear; flag deferred to v0.5.x if user demand surfaces).
 *
 * **`CreateTeamOptionsInput` — 1 input field.** `allow_empty_
 * team` (Boolean, nullable). Maps to the M34 `--allow-empty`
 * argv flag.
 *
 * **`ChangeTeamMembershipsResult` — 2 fields.** Per the round-2
 * probe: `failed_users: [User!]` + `successful_users: [User!]`.
 * Wire returns the User objects (not just IDs); the M34 action
 * body projects to slim `{id, name, email}` then wraps into the
 * §6.1 partial-success envelope per D5.
 *
 * **No new ERROR_CODES at M34.** Existing codes route team-verb
 * failures: `not_found` (team-get against missing/inaccessible
 * tid), `usage_error` (argv-parse rejections — bad TeamId, empty
 * `--users`, etc.), `forbidden` / `unauthorized` (token lacks
 * team-write scope), `confirmation_required` (destructive gate
 * on team-delete missing `--yes`), `validation_failed` (Monday-
 * side rejection, e.g. duplicate team name).
 *
 * **Teams are live-only at v0.5-M34.** Per cli-design §8 cache
 * scope, teams aren't cached — the `team-list` / `team-get` paths
 * emit `meta.source: "live"` with `cache_age_seconds: null`.
 * Team membership churns frequently in organisations and the
 * stale-cache risk outweighs the cache-hit value (mirrors
 * `monday user list` cadence — no cache).
 *
 * **Runtime bodies landed at v0.5-M34 IMPL.** All six fetchers
 * issue a single `client.raw` round-trip with literal-pinned
 * operationNames (`ListTeams` / `GetTeam` / `CreateTeam` /
 * `DeleteTeam` / `AddUsersToTeam` / `RemoveUsersFromTeam`;
 * R-NEW-37 W2 audit-point — operationNames pinned at the
 * fetcher boundary, NOT caller-overridable). Read responses
 * parse via wrapping `*ResponseSchema` shapes through
 * `unwrapOrThrow`, so payload drift surfaces `internal_error`
 * with `details.issues`. `getTeam`'s empty-array case rewraps
 * to `not_found` per the M32 doc-get D8 cadence (Monday's wire
 * collapses "doesn't exist" + "not visible to token"). Wire
 * Team objects thread through {@link projectTeam} which filters
 * null entries out of `users` before the agent-facing
 * {@link teamSchema} sees the value — wire-vs-output split per
 * round-2 P2-1 + R-v0.5-NEW-4 discipline.
 *
 * **Out of M34 scope** (probe-surfaced + carried forward):
 *
 *   - `assign_team_owners` / `remove_team_owners` (owner-vs-member
 *     surface) — D4 deferral; tangential to the v0.5 "team CRUD"
 *     frame; revisit at v0.5.x candidate-selection.
 *   - `add_teams_to_board` / `delete_teams_from_board` (board
 *     subscription) — D4 deferral; tangential.
 *   - `add_teams_to_workspace` / `delete_teams_from_workspace`
 *     (workspace subscription) — D4 deferral; tangential.
 *   - `--parent <ptid>` on team-create — D3 deferral.
 *   - `monday user teams <uid>` per-user team-list — wire path
 *     exists via `User.teams`; deferred to v0.5.x.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import { assertResponseFieldPresent } from './response-root.js';
import type { MondayClient } from './client.js';
import type { Complexity } from '../utils/output/envelope.js';

/**
 * Slim projection of Monday's `User` for the `Team.users` +
 * `Team.owners` slots + the `ChangeTeamMembershipsResult.{failed_,
 * successful_}users` slots. Mirrors the M19 `account_tags` + M31
 * `Asset.uploaded_by` + M32 `Document.created_by` slim-User
 * cadence: `{id, name, email}` is the smallest agent-useful
 * projection (email is the canonical resolver token for team
 * membership ops).
 *
 * Full-User reads still route through `monday user get <uid>`.
 */
export const teamUserSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    email: z.string().min(1),
  })
  .strict();

export type TeamUser = z.infer<typeof teamUserSchema>;

/**
 * Wire-parse Team projection — Monday's 6-field wire shape per
 * the v0.5 kickoff probe (rounds 1 + 2; `scripts/probe/v0.5-team-
 * mutations.ts` 2026-05-15, API `2026-01`). Fetcher-internal;
 * NOT the agent-facing output schema (see {@link teamSchema}).
 *
 * Wire-side nullability per the probe:
 *
 *   - `id: ID!` — non-null
 *   - `name: String!` — non-null
 *   - `picture_url: String` — nullable
 *   - `is_guest: Boolean` — nullable (NOT `Boolean!` despite the
 *     conceptual non-null shape; pin the wire's actual nullable
 *     surface so a `null` from a non-guest-aware org doesn't
 *     fault the schema-parse)
 *   - `users: [User]` — nullable container AND nullable entries
 *     per the wire signature (the probe-formatter renders
 *     `LIST/<wrapped>[OBJECT/User]` — no inner `NON_NULL` wrap on
 *     the entries; compare to `ChangeTeamMembershipsResult.
 *     successful_users -> LIST/<wrapped>[NON_NULL/<wrapped>]<OBJECT/
 *     User>` from the round-2 probe which DOES carry the inner
 *     non-null marker). The wire schema accepts `users: null` for
 *     the container AND `[user1, null, user2]` for sparse entries
 *     so a wire-shape variant doesn't surface as `internal_error`
 *     from the response-parse boundary (Monday surfaces null
 *     entries when a team member's User record was tombstoned
 *     post-team-creation; verify at M34 IMPL cassette).
 *   - `owners: [User!]!` — non-null wire-side per the round-1
 *     probe `NON_NULL/<wrapped>[LIST/<wrapped>]` outer wrapper.
 *     The probe-formatter truncates the inner detail beyond the
 *     LIST wrapper so the inner non-null is inferred from the
 *     description (owners is conceptually a non-empty set of
 *     User objects); if M34 IMPL cassette surfaces a null entry,
 *     widen to `z.array(teamUserSchema.nullable())` here.
 */
export const teamWireSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    picture_url: z.string().nullable(),
    is_guest: z.boolean().nullable(),
    users: z.array(teamUserSchema.nullable()).nullable(),
    owners: z.array(teamUserSchema),
  })
  .strict();

export type TeamWire = z.infer<typeof teamWireSchema>;

/**
 * Agent-facing Team projection — the exported output schema
 * reused by `teamListOutputSchema` / `teamGetOutputSchema` /
 * `teamCreateOutputSchema` / `teamDeleteOutputSchema`. Mirrors
 * {@link teamWireSchema}'s field shape EXCEPT for the `users`
 * entries which are pinned non-null at this boundary.
 *
 * **Wire-vs-CLI projection.** M34 IMPL fetcher bodies parse the
 * wire response via {@link teamWireSchema}, then filter null
 * entries out of `Team.users` before constructing the
 * `outputSchema.parse(...)` call. Agents see a clean array;
 * `monday schema user.team-list` exports a non-null
 * entries shape; `emitSuccess` then enforces the output schema
 * for free at the action boundary (`outputSchema.parse(data)`
 * would reject a leaked null otherwise — defence-in-depth
 * against a missed projection-layer filter at IMPL).
 *
 * Splitting wire-parse from output-projection — the discipline
 * Codex flagged at M34 pre-flight round-2 P2-1 — keeps the
 * agent contract narrow while the wire-parse boundary stays
 * permissive enough to absorb wire-shape variations. Mirrors
 * v0.3-M22 `monday usage` cadence (loose wire schema, strict
 * output projection) at a sub-field granularity.
 */
export const teamSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    picture_url: z.string().nullable(),
    is_guest: z.boolean().nullable(),
    users: z.array(teamUserSchema).nullable(),
    owners: z.array(teamUserSchema),
  })
  .strict();

export type Team = z.infer<typeof teamSchema>;

/**
 * Output shape for `monday user team-list`. Wrapped record (NOT
 * bare array) so the envelope leaves headroom for a future
 * `meta.team_count` or per-team-state aggregate without breaking
 * the agent contract — mirrors M22 `monday usage` + M32 `doc
 * list` wrapped-record convention.
 *
 * Monday's `Query.teams` exposes no pagination slot (D6); the
 * shape pins a flat `teams: [Team]` array with no `has_more` /
 * cursor / page slot. Agents fetch the entire visible-team set
 * in one call.
 */
export const teamListOutputSchema = z
  .object({
    teams: z.array(teamSchema),
    returned_count: z.number().int().min(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.returned_count !== value.teams.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['returned_count'],
        message:
          `returned_count (${String(value.returned_count)}) must equal ` +
          `teams.length (${String(value.teams.length)})`,
      });
    }
  });

export type TeamListOutput = z.infer<typeof teamListOutputSchema>;

/**
 * Output shape for `monday user team-get <tid>`. Direct unwrap
 * of the single Team — mirrors the read-one-verb convention
 * (`monday user get <uid>` returns `data: <User>`).
 */
export const teamGetOutputSchema = teamSchema;

export type TeamGetOutput = Team;

/**
 * Output shape for `monday user team-create`. Direct unwrap of
 * the created Team — Monday returns the full `Team` object
 * post-create with `id` populated + any `subscriber_ids` already
 * hydrated into the `users` slot.
 */
export const teamCreateOutputSchema = teamSchema;

export type TeamCreateOutput = Team;

/**
 * Output shape for `monday user team-delete`. Direct unwrap of
 * the deleted Team — mirrors the M14 `workspace delete` cadence.
 * Monday returns the deleted team verbatim so agents see the
 * final state (name + member list) at the moment of deletion.
 */
export const teamDeleteOutputSchema = teamSchema;

export type TeamDeleteOutput = Team;

/**
 * Per-target result record for the `team-add-members` /
 * `team-remove-members` partial-success envelope (cli-design
 * §6.1 universal partial-success shape; D5 closure). Mirrors
 * the v0.2-M14 `workspace add-users` / M15 `board add-users`
 * shape verbatim — `user_id` is the input numeric ID (echoed
 * for correlation against the `--users <id,...>` argv slot),
 * `ok` is the per-user success bit, `error` carries an optional
 * `{code, message}` reason when the wire reported a failed-
 * user entry.
 *
 * **Wire-vs-CLI semantics asymmetry note.** Monday's
 * `ChangeTeamMembershipsResult` returns `failed_users: [User]`
 * — a list of User objects, NOT a list of `{user_id, error_
 * code, error_message}` triples. The CLI projects the wire
 * shape into the universal envelope at the action body: every
 * `successful_users[]` entry surfaces as `{ok: true, user_id,
 * user: {...}}`; every `failed_users[]` entry surfaces as
 * `{ok: false, user_id, error: {code: 'membership_failed',
 * message: <wire-supplied or generic>}}`. The wire's
 * `failed_users[]` carries the User object but NO per-user
 * reason — the CLI emits a generic `membership_failed` message
 * (verify at IMPL cassette whether Monday surfaces a reason
 * elsewhere in the response or via the `errors[]` extension).
 *
 * **Wire-vs-CLI semantics convention.** This asymmetry extends
 * `docs/architecture.md`'s "Wire-vs-CLI semantics documentation
 * conventions" section (R-NEW-41 4th consumer trigger — see
 * also v0.5-plan §22 R-v0.5-NEW-3). Per-verb docstrings at
 * `src/commands/user/team-add-members.ts` +
 * `src/commands/user/team-remove-members.ts` cross-link this
 * note + the architecture section for the canonical convention.
 */
export const teamMembershipResultSchema = z
  .object({
    user_id: z.string().min(1),
    ok: z.boolean(),
    user: teamUserSchema.optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type TeamMembershipResult = z.infer<typeof teamMembershipResultSchema>;

/**
 * Output shape for `monday user team-add-members <tid> --users
 * <id,...>`. Universal partial-success envelope per cli-design
 * §6.1 — `operation: 'add_users_to_team'`, `team_id` echoed
 * input, `results: [{user_id, ok, ...}]` one record per input
 * user (whether resolved as `ok: true` post-wire-success or
 * `ok: false` if Monday's `failed_users[]` includes the user).
 */
export const teamAddMembersOutputSchema = z
  .object({
    operation: z.literal('add_users_to_team'),
    team_id: z.string().min(1),
    results: z.array(teamMembershipResultSchema),
  })
  .strict();

export type TeamAddMembersOutput = z.infer<typeof teamAddMembersOutputSchema>;

/**
 * Output shape for `monday user team-remove-members <tid> --users
 * <id,...>`. Same envelope shape as
 * {@link teamAddMembersOutputSchema} but with `operation:
 * 'remove_users_from_team'` so agents that key off the operation
 * literal can dispatch the right post-mutation recovery flow.
 */
export const teamRemoveMembersOutputSchema = z
  .object({
    operation: z.literal('remove_users_from_team'),
    team_id: z.string().min(1),
    results: z.array(teamMembershipResultSchema),
  })
  .strict();

export type TeamRemoveMembersOutput = z.infer<typeof teamRemoveMembersOutputSchema>;

/**
 * Shared Team selection fragment — every verb returning a `Team`
 * pins the same 6-field projection. Inlined into each operation
 * via string template to keep the GraphQL document readable +
 * the wire payload bounded. The `users { id name email }` +
 * `owners { id name email }` slim-User selections match the
 * `teamUserSchema` shape verbatim.
 */
const TEAM_FIELDS_FRAGMENT = `
  id
  name
  picture_url
  is_guest
  users { id name email }
  owners { id name email }
`;

/**
 * GraphQL query document for `Query.teams` listing variant.
 * Operation name pinned literally to `ListTeams` and matches the
 * wire `operationName` payload (R-NEW-37 W2 audit-point —
 * caller-overridable operationName slots were closed at M27 IMPL
 * round-1 P2-1; M34 maintains the safely-by-construction shape).
 *
 * No variables — Monday's `Query.teams` exposes only the `ids:`
 * filter (which the list verb omits) + no pagination slots
 * (D6 closure). The query returns every team visible to the
 * token.
 */
export const LIST_TEAMS_QUERY = `
  query ListTeams {
    teams {
      ${TEAM_FIELDS_FRAGMENT}
    }
  }
`;

/**
 * GraphQL query document for `Query.teams(ids:)` single-id read
 * variant. Operation name pinned to `GetTeam` (R-NEW-37 W2).
 *
 * Single-id wire shape — Monday returns `[Team]` (an array even
 * for one id); the fetcher extracts index 0. An empty array
 * surfaces `not_found` with `details.team_id` (Monday's wire
 * collapses "doesn't exist" + "not visible to token" into the
 * same shape per D8-equivalent — mirrors M32 doc-get).
 */
export const GET_TEAM_QUERY = `
  query GetTeam($ids: [ID!]!) {
    teams(ids: $ids) {
      ${TEAM_FIELDS_FRAGMENT}
    }
  }
`;

/**
 * GraphQL mutation document for `create_team(input, options)`.
 * Operation name pinned to `CreateTeam` (R-NEW-37 W2). The
 * `options:` arg is optional on the wire; the fetcher omits the
 * variable entirely when callers don't supply `allowEmptyTeam`
 * (rather than threading an explicit `null` which Monday treats
 * as "field present").
 */
export const CREATE_TEAM_MUTATION = `
  mutation CreateTeam(
    $input: CreateTeamAttributesInput!,
    $options: CreateTeamOptionsInput
  ) {
    create_team(input: $input, options: $options) {
      ${TEAM_FIELDS_FRAGMENT}
    }
  }
`;

/**
 * GraphQL mutation document for `delete_team(team_id)`. Operation
 * name pinned to `DeleteTeam` (R-NEW-37 W2). Returns the deleted
 * `Team` so agents see the final state at the moment of
 * deletion.
 */
export const DELETE_TEAM_MUTATION = `
  mutation DeleteTeam($teamId: ID!) {
    delete_team(team_id: $teamId) {
      ${TEAM_FIELDS_FRAGMENT}
    }
  }
`;

/**
 * GraphQL mutation document for `add_users_to_team(team_id,
 * user_ids)`. Operation name pinned to `AddUsersToTeam` (R-NEW-37
 * W2). Returns a `ChangeTeamMembershipsResult` with two User
 * lists — `failed_users` + `successful_users`. The CLI projects
 * the wire shape to the universal §6.1 partial-success envelope
 * at the action body per D5.
 */
export const ADD_USERS_TO_TEAM_MUTATION = `
  mutation AddUsersToTeam($teamId: ID!, $userIds: [ID!]!) {
    add_users_to_team(team_id: $teamId, user_ids: $userIds) {
      failed_users { id name email }
      successful_users { id name email }
    }
  }
`;

/**
 * GraphQL mutation document for `remove_users_from_team(team_id,
 * user_ids)`. Operation name pinned to `RemoveUsersFromTeam`
 * (R-NEW-37 W2). Same `ChangeTeamMembershipsResult` return shape
 * as add-members; the action body wraps into the universal
 * partial-success envelope with `operation:
 * 'remove_users_from_team'`.
 */
export const REMOVE_USERS_FROM_TEAM_MUTATION = `
  mutation RemoveUsersFromTeam($teamId: ID!, $userIds: [ID!]!) {
    remove_users_from_team(team_id: $teamId, user_ids: $userIds) {
      failed_users { id name email }
      successful_users { id name email }
    }
  }
`;

/**
 * `ChangeTeamMembershipsResult` wire shape per the v0.5 kickoff
 * round-2 probe: `failed_users: [User!]` + `successful_users:
 * [User!]`. Both lists are nullable containers on the wire (per
 * the probe's outer-wrapper introspection), but the inner
 * entries are non-null (`NON_NULL/<wrapped>` inside the `LIST/
 * <wrapped>`). The action body wraps this shape into the §6.1
 * universal partial-success envelope at the verb boundary.
 */
const changeTeamMembershipsResultSchema = z
  .object({
    failed_users: z.array(teamUserSchema),
    successful_users: z.array(teamUserSchema),
  })
  .strict();

/**
 * Wrapping response schema for the `ListTeams` operation. Monday's
 * documented wire shape is `[Team]` (an array, possibly empty) —
 * never null. The wrapper accepts `null` defensively so a wire-
 * shape regression parses cleanly and the fetcher rewraps it as
 * `internal_error` with a drift hint (rather than faulting the
 * parse with a confusing zod issue path).
 *
 * `.loose()` mirrors M27 `listWebhooksResponseSchema` + M32
 * `listDocsResponseSchema` — Monday occasionally returns side-
 * band debug keys (`extensions`, `account_id`) alongside the
 * documented data root; the loose mode lets them pass without
 * faulting the parse.
 *
 * Inner entries parse via {@link teamWireSchema} which accepts
 * sparse `users` arrays at the wire boundary; {@link projectTeam}
 * filters nulls before the agent-facing {@link teamSchema} sees
 * the value at `emitSuccess`.
 */
const listTeamsResponseSchema = z
  .object({
    teams: z.array(teamWireSchema).nullable(),
  })
  .loose();

/**
 * Wrapping response schema for the `GetTeam` operation. Same
 * shape as the list variant (Monday's wire returns `[Team]` even
 * for a single-id query). Empty-array surfaces `not_found` per
 * D8-equivalent (mirrors M32 doc-get); null root surfaces
 * `internal_error`.
 */
const getTeamResponseSchema = z
  .object({
    teams: z.array(teamWireSchema).nullable(),
  })
  .loose();

/**
 * Wrapping response schema for the `CreateTeam` mutation. The
 * `create_team` root is `z.unknown()` here so `assertResponseField
 * Present` can distinguish "key absent" (schema drift →
 * `internal_error`) from "value null" (no payload returned —
 * also `internal_error` per the workspace-create cadence; a
 * non-existent team after a successful mutation indicates a
 * Monday-side regression worth surfacing loudly). The payload
 * itself parses via {@link teamWireSchema} downstream.
 */
const createTeamResponseSchema = z
  .object({
    create_team: z.unknown(),
  })
  .loose();

/**
 * Wrapping response schema for the `DeleteTeam` mutation. Same
 * shape as `CreateTeam` but the null-value contract differs —
 * a null `delete_team` payload surfaces `not_found` (mirrors
 * M14 workspace-delete cadence — id bogus / already deleted by
 * a concurrent caller).
 */
const deleteTeamResponseSchema = z
  .object({
    delete_team: z.unknown(),
  })
  .loose();

/**
 * Wrapping response schema for the `AddUsersToTeam` mutation.
 * Returns `ChangeTeamMembershipsResult` non-null on the wire;
 * the wrapper accepts `null` defensively so a wire-shape
 * regression surfaces `internal_error` rather than faulting the
 * parse.
 */
const addUsersToTeamResponseSchema = z
  .object({
    add_users_to_team: changeTeamMembershipsResultSchema.nullable(),
  })
  .loose();

/**
 * Wrapping response schema for the `RemoveUsersFromTeam`
 * mutation. Same shape as `AddUsersToTeam`.
 */
const removeUsersFromTeamResponseSchema = z
  .object({
    remove_users_from_team: changeTeamMembershipsResultSchema.nullable(),
  })
  .loose();

/**
 * Wire-to-output projection for a single Team — filters null
 * entries out of {@link TeamWire.users} so the agent-facing
 * {@link teamSchema} sees a clean array (R-v0.5-NEW-4 wire-vs-
 * output split discipline; round-2 P2-1 closure). A wire `users:
 * null` container passes through unchanged (the output schema
 * accepts `null` for "team has no member list" — see
 * {@link teamSchema}). Owners are surfaced verbatim — Monday's
 * wire pins `[User!]!` for `owners` per the round-1 probe, so
 * there's no inner null to filter.
 */
const projectTeam = (wire: TeamWire): Team => ({
  id: wire.id,
  name: wire.name,
  picture_url: wire.picture_url,
  is_guest: wire.is_guest,
  users:
    wire.users === null
      ? null
      : wire.users.filter((u): u is TeamUser => u !== null),
  owners: wire.owners,
});

export interface ListTeamsInputs {
  readonly client: MondayClient;
}

export interface ListTeamsResult {
  readonly teams: readonly Team[];
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Fetches every team visible to the token via a single
 * `Query.teams` round-trip with `operationName: 'ListTeams'`
 * (R-NEW-37 W2). Source is always `'live'` per cli-design §8
 * cache scope; teams aren't cached at v0.5.
 *
 * A null `teams` root surfaces `internal_error` with a drift
 * hint — Monday's documented shape is `[Team]` (an array,
 * possibly empty), never null at this layer. Each wire team
 * threads through {@link projectTeam} so the agent-facing
 * {@link teamSchema} sees a clean (non-nullable-entries) `users`
 * array.
 */
export const listTeams = async (
  inputs: ListTeamsInputs,
): Promise<ListTeamsResult> => {
  const response = await inputs.client.raw<unknown>(
    LIST_TEAMS_QUERY,
    {},
    { operationName: 'ListTeams' },
  );
  const parsed = unwrapOrThrow(
    listTeamsResponseSchema.safeParse(response.data),
    {
      context: 'Monday `Query.teams(ListTeams)` response',
      hint:
        'Monday may have amended the `Team` selection — re-probe and ' +
        'amend `src/api/teams.ts` if so',
    },
  );
  if (parsed.teams === null) {
    throw new ApiError(
      'internal_error',
      'Monday returned a null `teams` payload from ListTeams',
      {
        details: {
          hint:
            'Monday\'s documented shape is `[Team]` (an array, possibly empty) — ' +
            'a null root indicates a wire change that needs re-probing',
        },
      },
    );
  }
  return {
    teams: parsed.teams.map(projectTeam),
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface GetTeamInputs {
  readonly client: MondayClient;
  readonly teamId: string;
}

export interface GetTeamResult {
  readonly team: Team;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Fetches a single team by ID via a single `Query.teams(ids:)`
 * round-trip with `operationName: 'GetTeam'` (R-NEW-37 W2).
 *
 * Empty wire response (Monday's shape for "team doesn't exist"
 * OR "team not visible to token") surfaces `not_found` with
 * `details.team_id` — same wire-shape collapse as M32 doc-get.
 * A null `teams` root surfaces `internal_error` with a drift
 * hint (distinct from the empty-array case); a multi-element
 * response surfaces `internal_error` defensively (a single-id
 * query shouldn't return more than one team).
 */
export const getTeam = async (
  inputs: GetTeamInputs,
): Promise<GetTeamResult> => {
  const response = await inputs.client.raw<unknown>(
    GET_TEAM_QUERY,
    { ids: [inputs.teamId] },
    { operationName: 'GetTeam' },
  );
  const parsed = unwrapOrThrow(
    getTeamResponseSchema.safeParse(response.data),
    {
      context: 'Monday `Query.teams(GetTeam)` response',
      details: { team_id: inputs.teamId },
      hint:
        'Monday may have amended the `Team` selection — re-probe and ' +
        'amend `src/api/teams.ts` if so',
    },
  );
  if (parsed.teams === null) {
    throw new ApiError(
      'internal_error',
      `Monday returned a null \`teams\` payload from GetTeam(${inputs.teamId})`,
      {
        details: {
          team_id: inputs.teamId,
          hint:
            'Monday\'s documented shape is `[Team]` (an array, possibly empty) — ' +
            'a null root indicates a wire change that needs re-probing',
        },
      },
    );
  }
  if (parsed.teams.length === 0) {
    throw new ApiError(
      'not_found',
      `team ${inputs.teamId} not found (does not exist or not visible to token)`,
      { details: { team_id: inputs.teamId } },
    );
  }
  if (parsed.teams.length > 1) {
    throw new ApiError(
      'internal_error',
      `Monday returned ${String(parsed.teams.length)} teams for a single-id GetTeam query`,
      {
        details: {
          team_id: inputs.teamId,
          hint: 'wire shape regression — re-probe `Query.teams(ids:)`',
        },
      },
    );
  }
  const [wireTeam] = parsed.teams;
  /* c8 ignore next 6 */
  if (wireTeam === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned a sparse teams array for GetTeam(${inputs.teamId})`,
      { details: { team_id: inputs.teamId } },
    );
  }
  return {
    team: projectTeam(wireTeam),
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface CreateTeamInputs {
  readonly client: MondayClient;
  readonly name: string;
  readonly subscriberIds?: readonly string[];
  readonly isGuestTeam?: boolean;
  readonly allowEmptyTeam?: boolean;
}

export interface CreateTeamResult {
  readonly team: Team;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Creates a new team via `create_team(input, options)` with
 * `operationName: 'CreateTeam'` (R-NEW-37 W2). Returns the
 * created `Team` with `id` populated post-create + any
 * `subscriberIds` hydrated into the `users` slot.
 *
 * The fetcher composes `input` from `name` + `subscriberIds` +
 * `isGuestTeam` and omits the `options` variable entirely when
 * `allowEmptyTeam` is unset (Monday's wire `options:` arg is
 * optional and a `null` value would be treated as "field
 * present" rather than "field omitted"). The same omit-vs-null
 * discipline applies to each nullable `input.*` slot — only
 * supplied fields land in the wire payload.
 *
 * A missing-key wire response surfaces `internal_error` via
 * `assertResponseFieldPresent` (R42 helper); a null payload
 * surfaces `internal_error` too — a successful `create_team`
 * mutation must return the created Team (a non-existent team
 * after a 200 response indicates a Monday-side regression).
 */
export const createTeam = async (
  inputs: CreateTeamInputs,
): Promise<CreateTeamResult> => {
  const input: Record<string, unknown> = { name: inputs.name };
  if (inputs.subscriberIds !== undefined) {
    input.subscriber_ids = inputs.subscriberIds;
  }
  if (inputs.isGuestTeam !== undefined) {
    input.is_guest_team = inputs.isGuestTeam;
  }
  const variables: Record<string, unknown> = { input };
  if (inputs.allowEmptyTeam !== undefined) {
    variables.options = { allow_empty_team: inputs.allowEmptyTeam };
  }
  const response = await inputs.client.raw<unknown>(
    CREATE_TEAM_MUTATION,
    variables,
    { operationName: 'CreateTeam' },
  );
  const data = unwrapOrThrow(
    createTeamResponseSchema.safeParse(response.data),
    {
      context: 'Monday returned a malformed CreateTeam response',
      details: { team_name: inputs.name },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update `createTeamResponseSchema` if ' +
        'Monday\'s contract has changed.',
    },
  );
  assertResponseFieldPresent({
    data,
    key: 'create_team',
    operationLabel: 'CreateTeam',
    details: { team_name: inputs.name },
    nullHandling: 'caller_handles',
  });
  const rawTeam = data.create_team;
  if (rawTeam === null || rawTeam === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned no team payload from create_team for name ${JSON.stringify(inputs.name)}.`,
      { details: { team_name: inputs.name } },
    );
  }
  const wireTeam = unwrapOrThrow(
    teamWireSchema.safeParse(rawTeam),
    {
      context: `Monday returned a malformed team payload for name ${JSON.stringify(inputs.name)}`,
      details: { team_name: inputs.name },
    },
  );
  return {
    team: projectTeam(wireTeam),
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface DeleteTeamInputs {
  readonly client: MondayClient;
  readonly teamId: string;
}

export interface DeleteTeamResult {
  readonly team: Team;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Deletes a team by ID via `delete_team(team_id)` with
 * `operationName: 'DeleteTeam'` (R-NEW-37 W2). Returns the
 * deleted Team verbatim.
 *
 * A null `delete_team` payload surfaces `not_found` —
 * mirrors the M14 `workspace delete` cadence (id was bogus
 * OR team already deleted by a concurrent caller). A missing
 * `delete_team` key surfaces `internal_error` per the R42
 * helper's "key absent" branch (schema drift).
 *
 * **Destructive-gate ordering.** The verb's action body MUST
 * call `enforceDestructiveGate` BEFORE this fetcher per the
 * M10 round-1 P2 invariant. A missing `--yes` surfaces as
 * `confirmation_required` from the action layer, never
 * masked by `config_error` when no token is configured.
 */
export const deleteTeam = async (
  inputs: DeleteTeamInputs,
): Promise<DeleteTeamResult> => {
  const response = await inputs.client.raw<unknown>(
    DELETE_TEAM_MUTATION,
    { teamId: inputs.teamId },
    { operationName: 'DeleteTeam' },
  );
  const data = unwrapOrThrow(
    deleteTeamResponseSchema.safeParse(response.data),
    {
      context: 'Monday returned a malformed DeleteTeam response',
      details: { team_id: inputs.teamId },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update `deleteTeamResponseSchema` if ' +
        'Monday\'s contract has changed.',
    },
  );
  assertResponseFieldPresent({
    data,
    key: 'delete_team',
    operationLabel: 'DeleteTeam',
    details: { team_id: inputs.teamId },
    nullHandling: 'caller_handles',
  });
  const rawTeam = data.delete_team;
  if (rawTeam === null || rawTeam === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no team payload from delete_team for id ${inputs.teamId}`,
      { details: { team_id: inputs.teamId } },
    );
  }
  const wireTeam = unwrapOrThrow(
    teamWireSchema.safeParse(rawTeam),
    {
      context: `Monday returned a malformed team payload for id ${inputs.teamId}`,
      details: { team_id: inputs.teamId },
    },
  );
  return {
    team: projectTeam(wireTeam),
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface AddUsersToTeamInputs {
  readonly client: MondayClient;
  readonly teamId: string;
  readonly userIds: readonly string[];
}

export interface AddUsersToTeamResult {
  readonly failedUsers: readonly TeamUser[];
  readonly successfulUsers: readonly TeamUser[];
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Adds a list of users to a team via `add_users_to_team(team_id,
 * user_ids)` with `operationName: 'AddUsersToTeam'` (R-NEW-37
 * W2). Returns Monday's `ChangeTeamMembershipsResult` split into
 * `failedUsers` + `successfulUsers` — the action body wraps
 * this into the §6.1 universal partial-success envelope at the
 * verb boundary (D5 closure).
 *
 * **Wire returns User objects, not error reasons.** Monday's
 * `failed_users[]` carries the User who failed but NO per-user
 * reason on the wire today. The CLI action body emits a generic
 * `membership_failed` error code per failed user. The IMPL
 * cassette suite covers the single-shot non-partial happy case
 * + the partial-success failed/successful split; no per-user
 * reason key surfaced on Monday's wire today (verified via
 * round-2 probe introspection of `ChangeTeamMembershipsResult`
 * — 2 fields only, no reason / error / message slot).
 *
 * A null `add_users_to_team` payload surfaces `internal_error`
 * — the wire returns the result envelope even when every
 * supplied user fails (failures go into `failed_users[]`, not
 * the root). A null root indicates a wire-shape regression.
 */
export const addUsersToTeam = async (
  inputs: AddUsersToTeamInputs,
): Promise<AddUsersToTeamResult> => {
  const response = await inputs.client.raw<unknown>(
    ADD_USERS_TO_TEAM_MUTATION,
    { teamId: inputs.teamId, userIds: inputs.userIds },
    { operationName: 'AddUsersToTeam' },
  );
  const parsed = unwrapOrThrow(
    addUsersToTeamResponseSchema.safeParse(response.data),
    {
      context: 'Monday returned a malformed AddUsersToTeam response',
      details: { team_id: inputs.teamId },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update `addUsersToTeamResponseSchema` ' +
        'if Monday\'s contract has changed.',
    },
  );
  if (parsed.add_users_to_team === null) {
    throw new ApiError(
      'internal_error',
      `Monday returned a null \`add_users_to_team\` payload for team ${inputs.teamId}`,
      {
        details: {
          team_id: inputs.teamId,
          hint:
            'Monday\'s documented shape is ChangeTeamMembershipsResult ' +
            '(non-null on the wire) — a null root indicates a wire ' +
            'change that needs re-probing',
        },
      },
    );
  }
  return {
    failedUsers: parsed.add_users_to_team.failed_users,
    successfulUsers: parsed.add_users_to_team.successful_users,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface RemoveUsersFromTeamInputs {
  readonly client: MondayClient;
  readonly teamId: string;
  readonly userIds: readonly string[];
}

export interface RemoveUsersFromTeamResult {
  readonly failedUsers: readonly TeamUser[];
  readonly successfulUsers: readonly TeamUser[];
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Removes a list of users from a team via
 * `remove_users_from_team(team_id, user_ids)` with
 * `operationName: 'RemoveUsersFromTeam'` (R-NEW-37 W2). Same
 * `ChangeTeamMembershipsResult` return shape as
 * {@link addUsersToTeam}; the action body wraps into the
 * universal partial-success envelope with `operation:
 * 'remove_users_from_team'`.
 *
 * Same null-root → `internal_error` contract as
 * {@link addUsersToTeam}.
 */
export const removeUsersFromTeam = async (
  inputs: RemoveUsersFromTeamInputs,
): Promise<RemoveUsersFromTeamResult> => {
  const response = await inputs.client.raw<unknown>(
    REMOVE_USERS_FROM_TEAM_MUTATION,
    { teamId: inputs.teamId, userIds: inputs.userIds },
    { operationName: 'RemoveUsersFromTeam' },
  );
  const parsed = unwrapOrThrow(
    removeUsersFromTeamResponseSchema.safeParse(response.data),
    {
      context: 'Monday returned a malformed RemoveUsersFromTeam response',
      details: { team_id: inputs.teamId },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update `removeUsersFromTeamResponseSchema` ' +
        'if Monday\'s contract has changed.',
    },
  );
  if (parsed.remove_users_from_team === null) {
    throw new ApiError(
      'internal_error',
      `Monday returned a null \`remove_users_from_team\` payload for team ${inputs.teamId}`,
      {
        details: {
          team_id: inputs.teamId,
          hint:
            'Monday\'s documented shape is ChangeTeamMembershipsResult ' +
            '(non-null on the wire) — a null root indicates a wire ' +
            'change that needs re-probing',
        },
      },
    );
  }
  return {
    failedUsers: parsed.remove_users_from_team.failed_users,
    successfulUsers: parsed.remove_users_from_team.successful_users,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};
