/**
 * `monday user team-get <tid>` — read a single team by ID
 * (`cli-design.md` §4.3 USER section + §13 v0.5 entry;
 * `v0.5-plan.md` §3 M34).
 *
 * **Wire shape.** Single `Query.teams(ids: [<tid>])` round-trip
 * via {@link getTeam} against `query GetTeam` with
 * `operationName: 'GetTeam'` (R-NEW-37 W2 audit-point). Monday
 * returns `[Team]` (an array even for a single-id query); the
 * fetcher extracts index 0. Empty array → `not_found` with
 * `details.team_id` (Monday's wire surface collapses
 * "doesn't exist" + "exists but inaccessible to token" into
 * the same shape; the CLI can't distinguish them — same
 * convention as M32 doc-get D8).
 *
 * **Output envelope.** Direct unwrap of the Team — `data:
 * <Team with users + owners hydrated>`. Mirrors read-one-verb
 * convention (`monday board get <bid>` returns `data: <Board>`,
 * `monday user get <uid>` returns `data: <User>`). The Team's
 * own `id` field is the echoed input; no separate `team_id`
 * slot needed.
 *
 * **Teams are live-only at v0.5-M34** per cli-design §8 cache
 * scope. Output `meta.source: "live"`, `meta.cache_age_
 * seconds: null`.
 *
 * **Idempotent: yes** (pure read).
 *
 * **Status: PRE-FLIGHT STUB.** Argv parsing + schema + commander
 * wiring all ship at pre-flight; action body's wire-call
 * dispatch + envelope emit land at v0.5-M34 IMPL.
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { TeamIdSchema } from '../../types/ids.js';
import {
  teamGetOutputSchema,
  type TeamGetOutput,
} from '../../api/teams.js';

const inputSchema = z.object({ teamId: TeamIdSchema }).strict();

export const teamGetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  TeamGetOutput
> = {
  name: 'user.team-get',
  summary: 'Read a single team by ID (includes member + owner lists)',
  examples: [
    'monday user team-get 12345',
    'monday user team-get 12345 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: teamGetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'user', 'User commands');
    noun
      .command('team-get <teamId>')
      .description(teamGetCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...teamGetCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Output carries the full Team plus `users: [User]` (members) + `owners: [User]` (managers).',
          '  - Non-existent + inaccessible teams both surface `not_found` (Monday\'s wire collapses both cases).',
          '',
        ].join('\n'),
      )
      .action(async (teamIdArg: unknown) => {
        const parsed = parseArgv(teamGetCommand.inputSchema, {
          teamId: teamIdArg,
        });

        /* c8 ignore start */
        // Stub body — IMPL session lands the wire call + envelope
        // emit. Argv parsing above is real-and-shipped; only the
        // wire-call leg is deferred.
        void ctx;
        void program;
        void parsed;
        await Promise.resolve();
        throw new ApiError(
          'internal_error',
          'monday user team-get — runtime body lands at v0.5-M34 IMPL.',
          {
            details: {
              deferred_to: 'v0.5-M34 IMPL',
              hint:
                'pre-flight ships argv parsing + schema + wire query ' +
                'document only; the live dispatch + envelope emit land ' +
                'at the IMPL session.',
            },
          },
        );
        /* c8 ignore stop */
      });
  },
};
