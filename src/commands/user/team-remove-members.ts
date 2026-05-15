/**
 * `monday user team-remove-members <tid> --users <id,...>
 * [--dry-run]` — remove one or more users from a team
 * (`cli-design.md` §4.3 USER section + §13 v0.5 entry;
 * `v0.5-plan.md` §3 M34).
 *
 * **Wire shape.** Single `remove_users_from_team(team_id,
 * user_ids)` round-trip via {@link removeUsersFromTeam}
 * against `mutation RemoveUsersFromTeam` with `operationName:
 * 'RemoveUsersFromTeam'` (R-NEW-37 W2 audit-point). Monday
 * returns `ChangeTeamMembershipsResult { failed_users:
 * [User!], successful_users: [User!] }` — same wire-level
 * partial-success envelope as add-members. The action body
 * wraps this into the §6.1 universal partial-success shape
 * `data: { operation: "remove_users_from_team", team_id,
 * results: [{ok, user_id, ...}] }` (D5 closure).
 *
 * **Argv shape.**
 *
 *   - `<teamId>` — positional `TeamId`. Required, brand-
 *     validated at parse boundary.
 *   - `--users <id,...>` — required, comma-separated numeric
 *     user IDs (maps to wire `user_ids: [ID!]!`). Each entry
 *     brand-validated via {@link UserIdSchema} through the
 *     lifted {@link parseBrandedListArg} helper (R-NEW-70
 *     consumer #4 post-lift).
 *
 * **Output envelope.** Same shape as
 * {@link teamAddMembersCommand} but with `operation:
 * 'remove_users_from_team'` so agents that key off the
 * operation literal can dispatch the right post-mutation
 * recovery flow.
 *
 * **Wire-vs-CLI semantics asymmetry.** Same generic-
 * `membership_failed`-code asymmetry as team-add-members; see
 * `teamMembershipResultSchema` JSDoc in `src/api/teams.ts` for
 * the canonical note + cross-link to `docs/architecture.md`'s
 * "Wire-vs-CLI semantics documentation conventions" section.
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run
 * variant. Mirror M14 `workspace remove-users` cadence —
 * minimal envelope listing the planned
 * `remove_users_from_team` operation per supplied user_id (no
 * preflight read; argv-derived). `meta.source: 'none'`.
 *
 * **Idempotent: yes** — Monday is no-op on a re-remove (the
 * user already being out of the team surfaces in
 * `successful_users[]` per Monday's wire convention).
 *
 * **Admin-permission-sensitive.** Non-admin callers surface
 * `forbidden`.
 *
 * **Status: PRE-FLIGHT STUB.** Argv parsing + schema +
 * `--users` comma-split + commander wiring all ship at
 * pre-flight. The action body's wire-call dispatch + dry-run
 * emit + envelope emit land at v0.5-M34 IMPL.
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { TeamIdSchema, UserIdSchema } from '../../types/ids.js';
import { parseBrandedListArg } from '../../utils/parse-brand-list.js';
import {
  teamRemoveMembersOutputSchema,
  type TeamRemoveMembersOutput,
} from '../../api/teams.js';

const inputSchema = z
  .object({
    teamId: TeamIdSchema,
    users: z.string().min(1, '--users must not be empty'),
  })
  .strict();

export const teamRemoveMembersCommand: CommandModule<
  z.infer<typeof inputSchema>,
  TeamRemoveMembersOutput
> = {
  name: 'user.team-remove-members',
  summary: 'Remove users from a team (partial-success envelope)',
  examples: [
    'monday user team-remove-members 12345 --users 67890',
    'monday user team-remove-members 12345 --users 67890,67891',
    'monday user team-remove-members 12345 --users 67890 --dry-run --json',
  ],
  // Re-removing an already-removed user is a no-op on Monday's
  // wire; mark idempotent so agents can retry on transient
  // failure.
  idempotent: true,
  inputSchema,
  outputSchema: teamRemoveMembersOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'user', 'User commands');
    noun
      .command('team-remove-members <teamId>')
      .description(teamRemoveMembersCommand.summary)
      .requiredOption(
        '--users <list>',
        'Comma-separated numeric user IDs to remove (maps to wire `user_ids: [ID!]!`).',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...teamRemoveMembersCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Envelope is per-cli-design §6.1 partial-success (`results: [{user_id, ok, ...}]`).',
          '  - Re-removing an absent member is a no-op (surfaces as `successful_users[]`).',
          '',
        ].join('\n'),
      )
      .action(async (teamIdArg: unknown, opts: unknown) => {
        const parsed = parseArgv(teamRemoveMembersCommand.inputSchema, {
          teamId: teamIdArg,
          ...(opts as Readonly<Record<string, unknown>>),
        });

        // Parse `--users` once at the boundary so a malformed
        // user ID surfaces `usage_error` ahead of any wire call.
        // Lifted helper at R-NEW-70 (consumer #4 post-lift).
        const userIds = parseBrandedListArg(parsed.users, UserIdSchema, {
          flagName: '--users',
          entryDescription: 'numeric user ID',
          hint: 'user IDs are numeric (e.g. 67890)',
          emptyEntryHint:
            'e.g. --users 67890,67891 — no leading, trailing, or ' +
            'duplicate commas',
        });

        /* c8 ignore start */
        // Stub body — IMPL session lands the dry-run emit + live
        // wire-call dispatch + envelope emit.
        void ctx;
        void program;
        void parsed;
        void userIds;
        await Promise.resolve();
        throw new ApiError(
          'internal_error',
          'monday user team-remove-members — runtime body lands at v0.5-M34 IMPL.',
          {
            details: {
              deferred_to: 'v0.5-M34 IMPL',
              hint:
                'pre-flight ships argv parsing + schema + wire mutation ' +
                'document only; the live dispatch + dry-run emit + ' +
                'partial-success envelope emit land at the IMPL session.',
            },
          },
        );
        /* c8 ignore stop */
      });
  },
};
