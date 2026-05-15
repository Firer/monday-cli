/**
 * `monday user team-delete <tid> --yes [--dry-run]` — delete
 * an existing team (`cli-design.md` §4.3 USER section + §13
 * v0.5 entry; `v0.5-plan.md` §3 M34).
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §10.2 + M10
 * round-1 P2 invariant). `--yes` is mandatory for the live
 * path; without `--yes` (and without `--dry-run`) the command
 * fails fast with `confirmation_required` (exit 1) carrying
 * `details.team_id`. The gate fires BEFORE `resolveClient()`
 * so a missing token doesn't mask `confirmation_required` as
 * `config_error` (same shape — and same gate-before-resolve
 * ordering — as M14 `workspace delete` / M10 `item delete` /
 * `update delete`).
 *
 * **Wire shape.** Single round-trip via `delete_team(team_id:
 * <tid>)` against `mutation DeleteTeam` with `operationName:
 * 'DeleteTeam'` (R-NEW-37 W2 audit-point). Monday returns the
 * deleted `Team` so the envelope's `data` is the full
 * projection — agents see the final state (name + member
 * list) at the moment of deletion. A null `delete_team`
 * payload surfaces `not_found` — same convention as M14
 * `workspace delete` ("id was bogus / already deleted by a
 * concurrent caller").
 *
 * **Admin-permission-sensitive.** Non-admin callers surface
 * `forbidden` (mapped from Monday's PERMISSION_DENIED
 * extension).
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run
 * variant: minimal `{operation: "delete_team", team_id}`. No
 * preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`. Mirrors `workspace delete` —
 * destructive-no-read pattern is uniform across `item delete`
 * / `update delete` / `workspace delete` / `team delete`.
 *
 * **Idempotent: false.** Re-running surfaces `not_found` past
 * the first call. Same rationale as `workspace delete` —
 * agents can't safely retry without verifying the id still
 * names the same record.
 *
 * **Runtime body landed at v0.5-M34 IMPL.** Destructive gate
 * fires BEFORE `resolveClient` (M10 round-1 P2 invariant);
 * dry-run path emits minimal `{operation, team_id}` (no wire
 * call); live path dispatches {@link deleteTeam} + projects via
 * `emitMutation`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { enforceDestructiveGate } from '../../api/destructive-gate.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { TeamIdSchema } from '../../types/ids.js';
import {
  deleteTeam,
  teamDeleteOutputSchema,
  type TeamDeleteOutput,
} from '../../api/teams.js';

const inputSchema = z.object({ teamId: TeamIdSchema }).strict();

export const teamDeleteCommand: CommandModule<
  z.infer<typeof inputSchema>,
  TeamDeleteOutput
> = {
  name: 'user.team-delete',
  summary: 'Delete a team — --yes required',
  examples: [
    'monday user team-delete 12345 --yes',
    'monday user team-delete 12345 --dry-run',
    'monday user team-delete 12345 --yes --json',
  ],
  // Re-deleting an already-deleted team surfaces `not_found`;
  // re-running with the same `<tid>` after an interim
  // `team-create` would target a different record (Monday
  // mints new TeamIds on create). Mark non-idempotent.
  idempotent: false,
  inputSchema,
  outputSchema: teamDeleteOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'user', 'User commands');
    noun
      .command('team-delete <teamId>')
      .description(teamDeleteCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...teamDeleteCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (teamId: unknown) => {
        const parsed = parseArgv(teamDeleteCommand.inputSchema, { teamId });

        // Gate BEFORE `resolveClient()` — M10 round-1 P2 invariant.
        // A missing `--yes` must surface as `confirmation_required`
        // per cli-design §3.1 #7's unconditional contract, never
        // masked by `config_error` when no token is configured.
        const preGateGlobalFlags = parseGlobalFlags(program.opts(), ctx.env);
        enforceDestructiveGate({
          globalFlags: preGateGlobalFlags,
          verb: 'user team-delete',
          target: parsed.teamId,
          detailKey: 'team_id',
          action: 'delete the team',
          hint:
            'delete is destructive — Monday\'s wire surface offers no ' +
            'restore mutation for teams; agents needing reversal must ' +
            'recreate via `monday user team-create` (lossy: new id, ' +
            'membership must be re-added).',
        });

        if (preGateGlobalFlags.dryRun) {
          // Minimal dry-run shape — no preflight read fires. Per
          // cli-design §6.4 mutation-dry-run variant: `operation:
          // "delete_team"`, `team_id`, nothing else. `meta.source:
          // 'none'` because no API call fires; live surfaces
          // `not_found` for missing ids on its own. Mirrors
          // workspace-delete cadence.
          const { apiVersion } = resolveClient(ctx, program.opts());
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'delete_team',
                team_id: parsed.teamId,
              },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await deleteTeam({ client, teamId: parsed.teamId });
        emitMutation({
          ctx,
          data: result.team,
          schema: teamDeleteCommand.outputSchema,
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
