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
 * **Runtime body landed at v0.5-M34 IMPL.** A single wire
 * round-trip via {@link listTeams} populates the wrapped
 * record envelope; `returned_count` is the cached
 * `teams.length` for agent ergonomics.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import {
  listTeams,
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
    const noun = ensureSubcommand(program, 'user');
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
        // Argv is empty for team-list; parseArgv still fires to
        // verify "no unknown flags" at the parse boundary.
        parseArgv(teamListCommand.inputSchema, opts ?? {});

        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await listTeams({ client });
        const returnedCount = result.teams.length;
        emitSuccess({
          ctx,
          data: {
            teams: [...result.teams],
            returned_count: returnedCount,
          },
          schema: teamListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'single',
          warnings: [],
          source: result.source,
          cacheAgeSeconds: result.cacheAgeSeconds,
          complexity: result.complexity,
          apiVersion,
        });
      });
  },
};
