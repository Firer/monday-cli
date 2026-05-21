/**
 * `monday user team-add-members <tid> --users <id,...>
 * [--dry-run]` — add one or more users to a team (`cli-design.md`
 * §4.3 USER section + §13 v0.5 entry; `v0.5-plan.md` §3 M34).
 *
 * **Wire shape.** Single `add_users_to_team(team_id, user_ids)`
 * round-trip via {@link addUsersToTeam} against `mutation
 * AddUsersToTeam` with `operationName: 'AddUsersToTeam'`
 * (R-NEW-37 W2 audit-point). Monday returns
 * `ChangeTeamMembershipsResult { failed_users: [User!],
 * successful_users: [User!] }` — a wire-level partial-success
 * envelope. The action body wraps this into the §6.1
 * universal partial-success shape `data: { operation:
 * "add_users_to_team", team_id, results: [{ok, user_id, ...}]
 * }` at the verb boundary (D5 closure).
 *
 * **Argv shape.**
 *
 *   - `<teamId>` — positional `TeamId`. Required, brand-
 *     validated at parse boundary.
 *   - `--users <id,...>` — required, comma-separated numeric
 *     user IDs (maps to wire `user_ids: [ID!]!`). Each entry
 *     brand-validated via {@link UserIdSchema} through the
 *     lifted {@link parseBrandedListArg} helper (R-NEW-70
 *     consumer #3 post-lift).
 *
 * **Output envelope.** Per cli-design §6.1 universal partial-
 * success shape — emits one `ok: true` envelope with
 * `data: { operation: "add_users_to_team", team_id, results:
 * [{user_id, ok, user?, error?}] }`. The wire's
 * `failed_users[]` projects to `{ok: false, user_id, error:
 * {code: "membership_failed", message: <generic>}}` records;
 * the wire's `successful_users[]` projects to `{ok: true,
 * user_id, user: {id, name, email}}` records. Result order
 * mirrors the input `--users <id,...>` order (input ID echoed
 * into `user_id` for correlation; wire User object hydrated
 * into `user` slot when successful).
 *
 * **Wire-vs-CLI semantics asymmetry.** See
 * `teamMembershipResultSchema` JSDoc in `src/api/teams.ts` for
 * the canonical note + cross-link to `docs/architecture.md`'s
 * "Wire-vs-CLI semantics documentation conventions" section
 * (R-NEW-41 4th consumer trigger).
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run
 * variant. SINGLE planned operation entry `{operation:
 * 'add_users_to_team', team_id, user_ids: [...]}` with
 * `user_ids` echoing the input argv order — Monday's wire
 * is a single-shot bulk call (`add_users_to_team(team_id,
 * user_ids: [ID!]!)`), NOT a per-user fan-out like
 * `monday workspace add-users` (which dispatches sequentially
 * one wire call per user). No preflight read fires; argv-
 * derived. `meta.source: 'none'`.
 *
 * **Idempotent: yes** — Monday is no-op on a re-add (the
 * user already being in the team surfaces as `successful_
 * users[]` regardless). Same idempotency story as
 * `workspace add-users`.
 *
 * **Admin-permission-sensitive.** Non-admin callers surface
 * `forbidden` (mapped from Monday's PERMISSION_DENIED
 * extension).
 *
 * **Runtime body landed at v0.5-M34 IMPL.** Argv + `--users`
 * parse run BEFORE `resolveClient` (usage-error-before-config-
 * error precedence). Dry-run path emits the minimal planned
 * shape; live path dispatches {@link addUsersToTeam} and
 * projects `failed_users[]` / `successful_users[]` into the
 * universal §6.1 partial-success envelope via
 * {@link projectMembershipResults} (input order preserved).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { TeamIdSchema, UserIdSchema } from '../../types/ids.js';
import { parseBrandedListArg } from '../../utils/parse-brand-list.js';
import {
  addUsersToTeam,
  teamAddMembersOutputSchema,
  type TeamAddMembersOutput,
} from '../../api/teams.js';
import { projectMembershipResults } from './_team-membership.js';

const inputSchema = z
  .object({
    teamId: TeamIdSchema,
    users: z.string().min(1, '--users must not be empty'),
  })
  .strict();

export const teamAddMembersCommand: CommandModule<
  z.infer<typeof inputSchema>,
  TeamAddMembersOutput
> = {
  name: 'user.team-add-members',
  summary: 'Add users to a team (partial-success envelope)',
  examples: [
    'monday user team-add-members 12345 --users 67890',
    'monday user team-add-members 12345 --users 67890,67891',
    'monday user team-add-members 12345 --users 67890 --dry-run --json',
  ],
  // Re-adding an existing team member is a no-op on Monday's
  // wire (the user surfaces as `successful_users[]`); mark
  // idempotent so agents can retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: teamAddMembersOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'user', 'User commands');
    noun
      .command('team-add-members <teamId>')
      .description(teamAddMembersCommand.summary)
      .requiredOption(
        '--users <list>',
        'Comma-separated numeric user IDs to add (maps to wire `user_ids: [ID!]!`).',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...teamAddMembersCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Envelope is a partial-success result (`results: [{user_id, ok, ...}]`).',
          '  - Re-adding an existing member is a no-op (surfaces as `successful_users[]`).',
          '',
        ].join('\n'),
      )
      .action(async (teamIdArg: unknown, opts: unknown) => {
        const parsed = parseArgv(teamAddMembersCommand.inputSchema, {
          teamId: teamIdArg,
          ...(opts as Readonly<Record<string, unknown>>),
        });

        // Parse `--users` once at the boundary so a malformed
        // user ID surfaces `usage_error` ahead of any wire call.
        // Lifted helper at R-NEW-70 (consumer #3 post-lift).
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
                operation: 'add_users_to_team',
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

        const result = await addUsersToTeam({
          client,
          teamId: parsed.teamId,
          userIds,
        });
        const results = projectMembershipResults({
          inputUserIds: userIds,
          failedUsers: result.failedUsers,
          successfulUsers: result.successfulUsers,
          operation: 'add_users_to_team',
          teamId: parsed.teamId,
        });
        const data: TeamAddMembersOutput = {
          operation: 'add_users_to_team',
          team_id: parsed.teamId,
          results: [...results],
        };
        emitMutation({
          ctx,
          data,
          schema: teamAddMembersCommand.outputSchema,
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
