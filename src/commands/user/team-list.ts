/**
 * `monday user team-list` — list every team visible to the
 * token (`cli-design.md` §4.3 USER section + §13 v0.5 entry;
 * `v0.5-plan.md` §3 M34).
 *
 * **Wire shape.** Single `Query.teams` round-trip via
 * {@link listTeams} against `query ListTeams` with
 * `operationName: 'ListTeams'` (R-NEW-37 W2 audit-point). No
 * pagination — Monday's `Query.teams` surface has neither
 * `limit:` / `page:` nor cursor (D6 closure); returns every
 * visible team in one shot. Account-size cap on team count is
 * the only natural limit.
 *
 * **Argv shape.** No flags — `team-list` is argv-empty.
 *
 * **Output envelope.** Wrapped record `data: { teams:
 * [Team], returned_count }` mirroring M22 `monday usage` +
 * M32 `doc list` wrapped-record cadence. No `has_more` /
 * cursor slot (D6 — wire has no pagination).
 *
 * **Teams are live-only at v0.5-M34** per cli-design §8 cache
 * scope. Output `meta.source: "live"`, `meta.cache_age_
 * seconds: null`. Team membership churns frequently; the
 * stale-cache risk outweighs the cache-hit value.
 *
 * **Idempotent: yes** (pure read).
 *
 * **Status: PRE-FLIGHT STUB.** Argv parsing + schema +
 * commander wiring all ship at pre-flight (the real shipped
 * argv surface — argv is empty for team-list so the
 * `parseArgv` call still fires + verifies "no unknown flags"
 * at the parse boundary). The action body's wire-call
 * dispatch + envelope emit land at v0.5-M34 IMPL — the stub
 * throws `internal_error` post-parse so a premature
 * invocation surfaces a clear "not yet implemented" signal
 * rather than a misleading false-success envelope (M31
 * pre-flight round-1 P2-2 lesson).
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import {
  LIST_TEAMS_QUERY,
  teamListOutputSchema,
  type TeamListOutput,
} from '../../api/teams.js';

const inputSchema = z.object({}).strict();

export const teamListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  TeamListOutput
> = {
  name: 'user.team-list',
  summary: 'List every team visible to the token (no pagination on Monday\'s wire)',
  examples: [
    'monday user team-list',
    'monday user team-list --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: teamListOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'user', 'User commands');
    noun
      .command('team-list')
      .description(teamListCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...teamListCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Monday\'s `Query.teams` exposes no pagination — every visible team returns in one call.',
          '  - Each team carries `users` (members) + `owners` (managers) lists slim-projected to {id, name, email}.',
          '',
        ].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(teamListCommand.inputSchema, opts ?? {});

        /* c8 ignore start */
        // Stub body — IMPL session lands the wire call + envelope
        // emit. The pre-flight surface (argv schema + commander
        // wiring) is real-and-shipped; the throw below MUST NOT
        // be reachable from any green-tree invocation, only from
        // a deliberate stub-poke test.
        void ctx;
        void program;
        void parsed;
        void LIST_TEAMS_QUERY;
        await Promise.resolve();
        throw new ApiError(
          'internal_error',
          'monday user team-list — runtime body lands at v0.5-M34 IMPL.',
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
