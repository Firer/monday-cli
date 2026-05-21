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
 * variant. SINGLE planned operation entry `{operation:
 * 'remove_users_from_team', team_id, user_ids: [...]}` with
 * `user_ids` echoing the input argv order — Monday's wire is
 * a single-shot bulk call (`remove_users_from_team(team_id,
 * user_ids: [ID!]!)`), NOT a per-user fan-out like
 * `monday workspace remove-users`. No preflight read fires;
 * argv-derived. `meta.source: 'none'`.
 *
 * **Idempotent: yes** — Monday is no-op on a re-remove (the
 * user already being out of the team surfaces in
 * `successful_users[]` per Monday's wire convention).
 *
 * **Admin-permission-sensitive.** Non-admin callers surface
 * `forbidden`.
 *
 * **Runtime body landed at v0.5-M34 IMPL.** Mirrors the
 * `team-add-members` cadence verbatim modulo the `operation`
 * literal — argv + `--users` parse → resolveClient → dry-run
 * or live dispatch via {@link removeUsersFromTeam} → shared
 * {@link projectMembershipResults} → `emitMutation`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { TeamIdSchema, UserIdSchema } from '../../types/ids.js';
import { parseBrandedListArg } from '../../utils/parse-brand-list.js';
import {
  removeUsersFromTeam,
  teamRemoveMembersOutputSchema,
  type TeamRemoveMembersOutput,
} from '../../api/teams.js';
import { projectMembershipResults } from './_team-membership.js';

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
          '  - Envelope is a partial-success result (`results: [{user_id, ok, ...}]`).',
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

        const { client, globalFlags, apiVersion } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Minimal dry-run shape per cli-design §6.4 — single
          // planned operation echoing what the live wire call
          // would send. No preflight read fires; `meta.source:
          // 'none'`.
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'remove_users_from_team',
                team_id: parsed.teamId,
                user_ids: [...userIds],
              },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const result = await removeUsersFromTeam({
          client,
          teamId: parsed.teamId,
          userIds,
        });
        const results = projectMembershipResults({
          inputUserIds: userIds,
          failedUsers: result.failedUsers,
          successfulUsers: result.successfulUsers,
          operation: 'remove_users_from_team',
          teamId: parsed.teamId,
        });
        const data: TeamRemoveMembersOutput = {
          operation: 'remove_users_from_team',
          team_id: parsed.teamId,
          results: [...results],
        };
        emitMutation({
          ctx,
          data,
          schema: teamRemoveMembersCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          source: result.source,
          cacheAgeSeconds: result.cacheAgeSeconds,
          complexity: result.complexity,
          apiVersion,
        });
      });
  },
};
