/**
 * `monday user team-create --name <n> [--users <id,...>]
 * [--guest-team] [--allow-empty] [--dry-run]` — create a new
 * team (`cli-design.md` §4.3 USER section + §13 v0.5 entry;
 * `v0.5-plan.md` §3 M34).
 *
 * **Wire shape.** Single `create_team(input, options)` round-
 * trip via {@link createTeam} against `mutation CreateTeam`
 * with `operationName: 'CreateTeam'` (R-NEW-37 W2 audit-point).
 * Returns the created `Team` with `id` populated post-create
 * + any `--users <id,...>` hydrated into the `users` slot.
 *
 * **Argv shape.**
 *
 *   - `--name <n>` — required (Monday's `CreateTeamAttributes
 *     Input.name` is `String!`). Empty string rejects at the
 *     parse boundary.
 *   - `--users <id,...>` — optional, comma-separated numeric
 *     user IDs (maps to wire `subscriber_ids: [ID!]`). Each
 *     entry brand-validated via {@link UserIdSchema} through
 *     the lifted {@link parseBrandedListArg} helper (R-NEW-70
 *     consumer #2 post-lift). Wire description: "Must not be
 *     empty, unless allow_empty_team is set"; the CLI
 *     surface forwards a non-empty list when supplied, OR
 *     omits the variable entirely when `--users` is absent.
 *   - `--guest-team` — optional boolean (maps to wire
 *     `is_guest_team: Boolean`). Absent → omitted (Monday's
 *     server-side default applies).
 *   - `--allow-empty` — optional boolean (maps to wire
 *     `options.allow_empty_team: Boolean`). Absent → omitted.
 *
 * **Out-of-scope flags carried forward from probe findings:**
 *
 *   - `--parent <ptid>` (wire slot exists via
 *     `CreateTeamAttributesInput.parent_team_id`) — D3
 *     deferral; agent-UX hierarchical-team semantics
 *     unclear today. Flag deferred to v0.5.x.
 *   - `--description` (no wire-side persistence; `Team`
 *     object carries no `description` field) — D1 closure;
 *     dropped from v0.4 cli-design row.
 *
 * **Output envelope.** Direct unwrap of the created Team —
 * `data: <Team>`. Mirrors M14 `workspace create` cadence.
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant.
 * Minimal envelope listing the planned `create_team` operation
 * + the resolved input fields (`name`, optional `is_guest_team`,
 * optional `subscriber_ids`, optional `allow_empty_team`). No
 * preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`. Mirrors M14 `workspace create` cadence —
 * the create-no-read pattern is uniform across non-destructive
 * write verbs (`workspace create` / `board create` / now
 * `user team-create`).
 *
 * **Idempotent: false.** Re-running `team-create --name foo`
 * creates a SECOND team with the same name (Monday allows
 * duplicate team names). Agents that need idempotency must
 * pair with a `team-list` lookup first.
 *
 * **Admin-permission-sensitive.** Non-admin tokens surface
 * `forbidden` (mapped from Monday's PERMISSION_DENIED
 * extension).
 *
 * **Status: PRE-FLIGHT STUB.** Argv parsing + schema +
 * commander wiring all ship at pre-flight (real shipped
 * surface). The action body's wire-call dispatch + envelope
 * emit land at v0.5-M34 IMPL.
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { UserIdSchema } from '../../types/ids.js';
import { parseBrandedListArg } from '../../utils/parse-brand-list.js';
import {
  teamCreateOutputSchema,
  type TeamCreateOutput,
} from '../../api/teams.js';

const inputSchema = z
  .object({
    name: z.string().min(1, '--name must not be empty'),
    /**
     * Raw comma-separated user IDs (e.g. `"67890,67891"`). Split
     * + brand-validated inside the action body via
     * {@link parseBrandedListArg} so the per-entry parse boundary
     * fires AFTER the top-level argv parse — keeps the error
     * envelope's `details.issues[].path` pointing at the
     * `--users` argv slot rather than a per-entry index.
     */
    users: z.string().min(1, '--users must not be empty').optional(),
    guestTeam: z.boolean().optional(),
    allowEmpty: z.boolean().optional(),
  })
  .strict();

export const teamCreateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  TeamCreateOutput
> = {
  name: 'user.team-create',
  summary: 'Create a new team (--name required; optional initial members + flags)',
  examples: [
    'monday user team-create --name "Backend Eng"',
    'monday user team-create --name "Backend Eng" --users 67890,67891',
    'monday user team-create --name "Empty Bootstrap" --allow-empty',
    'monday user team-create --name "Vendor Access" --guest-team --users 67890',
    'monday user team-create --name "Backend Eng" --users 67890 --dry-run --json',
  ],
  // Re-running creates a duplicate-named team — Monday's wire
  // does NOT dedupe by name. Mark non-idempotent so agents
  // don't naively retry on transient failures.
  idempotent: false,
  inputSchema,
  outputSchema: teamCreateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'user', 'User commands');
    noun
      .command('team-create')
      .description(teamCreateCommand.summary)
      .requiredOption('--name <n>', 'team name (Monday\'s `String!` — must not be empty)')
      .option(
        '--users <list>',
        'Comma-separated numeric user IDs for initial team membership (maps to wire `subscriber_ids: [ID!]`).',
      )
      .option('--guest-team', 'mark the team as a guest team (maps to wire `is_guest_team: true`)')
      .option(
        '--allow-empty',
        'allow team creation with no initial members (maps to wire `options.allow_empty_team: true`)',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...teamCreateCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Monday allows duplicate team names; this verb is non-idempotent.',
          '  - `--dry-run` emits the planned `create_team` operation + resolved input fields (no wire call fires; `meta.source: "none"`).',
          '  - `--parent <ptid>` is deferred to v0.5.x (hierarchical-team UX TBD).',
          '  - No `--description` slot — Monday\'s Team object carries no description field.',
          '',
        ].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(teamCreateCommand.inputSchema, opts);

        // Parse `--users` once at the boundary so a malformed
        // user ID surfaces `usage_error` ahead of any wire call.
        // Empty entries (trailing comma, double comma) reject
        // with a clear hint; non-numeric entries reject via the
        // UserIdSchema brand. Lifted helper at R-NEW-70 (consumer
        // #2 post-lift).
        const userIds: readonly string[] | undefined =
          parsed.users === undefined
            ? undefined
            : parseBrandedListArg(parsed.users, UserIdSchema, {
                flagName: '--users',
                entryDescription: 'numeric user ID',
                hint: 'user IDs are numeric (e.g. 67890)',
                emptyEntryHint:
                  'e.g. --users 67890,67891 — no leading, trailing, or ' +
                  'duplicate commas',
              });

        /* c8 ignore start */
        // Stub body — IMPL session lands the wire call + envelope
        // emit. Argv parsing + comma-list parsing above are
        // real-and-shipped; only the wire-call leg is deferred.
        void ctx;
        void program;
        void parsed;
        void userIds;
        await Promise.resolve();
        throw new ApiError(
          'internal_error',
          'monday user team-create — runtime body lands at v0.5-M34 IMPL.',
          {
            details: {
              deferred_to: 'v0.5-M34 IMPL',
              hint:
                'pre-flight ships argv parsing + schema + wire mutation ' +
                'document only; the live dispatch + envelope emit land ' +
                'at the IMPL session.',
            },
          },
        );
        /* c8 ignore stop */
      });
  },
};
