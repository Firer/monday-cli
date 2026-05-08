/**
 * `monday board group-create <bid> --name <n> [--color <c>]
 * [--dry-run]` — create a new group on a board (`cli-design.md`
 * §4.3 line 1174, `v0.2-plan.md` §3 M17).
 *
 * **Wire shape.** Single round-trip via `create_group(board_id,
 * group_name, position?, position_relative_method?, relative_to?,
 * group_color?)` per SDK 14.0.0 `MutationCreate_GroupArgs`. The CLI
 * flag `--name` maps to wire `group_name: String!`; `--color` maps
 * to wire `group_color: String?`. M17 deliberately OMITS all three
 * placement surfaces (`position` is per-changelog deprecated and
 * `top|bottom` literal semantics are wire-ambiguous; the relative-
 * position pair `position_relative_method` + `relative_to` is
 * deferred to v0.3 with `--before <gid>` / `--after <gid>` flags).
 * Agents needing placement today call the wire mutation via M9's
 * `dev mutate` escape hatch.
 *
 * **`--color` validation.** Monday's accepted colour names are
 * documented outside the SDK's typed surface and evolve over time
 * (the SDK types `group_color` as plain `String?`); v0.2 forwards
 * the agent's value verbatim and lets Monday validate server-side.
 * The CLI rejects only empty / whitespace-only `--color` at argv-
 * parse time. Mirrors M16 column-create's per-type `--settings`
 * field-set ownership rationale (over-pinning would force docs
 * revisions on every Monday palette tweak).
 *
 * **Live-envelope projection.** Returned `Maybe<Group>` is projected
 * through `groupProjectionSchema` (the M17 R48-lifted shared shape)
 * via `projectMutationGroup`. Sharing the schema keeps create /
 * update / archive / duplicate / delete envelopes byte-identical
 * for the same record.
 *
 * **Dry-run shape** per cli-design §6.4 group-create variant:
 * minimal `{operation: "create_group", board_id, name, color?}`. No
 * preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`.
 *
 * **Eager invalidation** (cli-design §8 single-leg call-site
 * contract). On success, calls `invalidateBoard(boardId)` AFTER
 * the success envelope's `data` projection completes — never
 * before the wire mutation, never between mutation and projection.
 * Skipped on the error path (a failed single-leg call didn't
 * change board state). The cache entry's stale `groups: [...]`
 * list is dropped so subsequent reads in the same process see
 * fresh state without TTL eviction.
 *
 * **Idempotent: false.** Re-running creates a second group with
 * the same name (Monday auto-generates a fresh group id per call).
 * NOT destructive (no --yes gate).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { BoardIdSchema } from '../../types/ids.js';
import { withBoardInvalidationSingleLeg } from '../../api/board-mutation-invalidation.js';
import { GROUP_COLOR_VALUES } from '../../api/group-color.js';
import {
  GROUP_FIELDS_FRAGMENT,
  groupProjectionSchema,
  projectMutationGroup,
  type GroupProjection,
} from '../../api/group-mutation-result.js';

const CREATE_GROUP_MUTATION = `
  mutation GroupCreate(
    $boardId: ID!,
    $groupName: String!,
    $groupColor: String
  ) {
    create_group(
      board_id: $boardId,
      group_name: $groupName,
      group_color: $groupColor
    ) {
      ${GROUP_FIELDS_FRAGMENT}
    }
  }
`;

export const boardGroupCreateOutputSchema = groupProjectionSchema;
export type BoardGroupCreateOutput = GroupProjection;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    name: z.string().refine((s) => s.trim().length > 0, {
      message: '--name must be non-empty (whitespace-only is rejected)',
    }),
    // Per cli-design §4.3 group-create: --color is argv-parse
    // validated against the pinned Monday-supported palette.
    // M17 implementation owns the field set (see api/group-color.ts);
    // values outside the set surface as usage_error (exit 1) before
    // any network call. Mirrors M16 column-create's per-type
    // `--settings` field-set ownership rationale.
    color: z.enum(GROUP_COLOR_VALUES).optional(),
  })
  .strict();

const responseSchema = z
  .object({
    create_group: z.unknown(),
  })
  .loose();

export const boardGroupCreateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardGroupCreateOutput
> = {
  name: 'board.group-create',
  summary: 'Create a new group on a board',
  examples: [
    'monday board group-create 12345 --name "Sprint 42"',
    'monday board group-create 12345 --name "Sprint 42" --color blue',
    'monday board group-create 12345 --name "Preview" --dry-run --json',
  ],
  // create_group is non-idempotent — re-running creates a second
  // group with the same name (Monday auto-generates a fresh group
  // id per call). Mirrors `board create` / `workspace create` /
  // `item create` / `column-create` rationale.
  idempotent: false,
  inputSchema,
  outputSchema: boardGroupCreateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('group-create <boardId>')
      .description(boardGroupCreateCommand.summary)
      .requiredOption('--name <n>', 'group name')
      .option('--color <c>', 'group color (Monday-supported palette name)')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardGroupCreateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardGroupCreateCommand.inputSchema, {
          boardId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const name = parsed.name.trim();
        // No trim on color — the enum check on inputSchema rejects
        // anything outside GROUP_COLOR_VALUES, which already covers
        // exact-match shapes.
        const color = parsed.color;

        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Per cli-design §6.4 group-create variant: minimal
          // `{operation, board_id, name, color?}`. No preflight
          // read fires — purely argv-derived; meta.source: 'none'.
          const planned: Record<string, unknown> = {
            operation: 'create_group',
            board_id: parsed.boardId,
            name,
          };
          if (color !== undefined) {
            planned.color = color;
          }
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [planned],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path. Send each optional arg only when the agent
        // provided one — passing `null` would explicitly clear /
        // reject Monday's server-side default.
        const variables: Record<string, unknown> = {
          boardId: parsed.boardId,
          groupName: name,
        };
        if (color !== undefined) {
          variables.groupColor = color;
        }

        // §8 single-leg call-site contract via `withBoardInvalidation
        // SingleLeg` (R46): the helper invalidates AFTER the closure
        // returns (i.e. after `data` projection completes). On the
        // error path the closure's throw bypasses invalidation —
        // matching the §8 "skip on error" rule. Ordered BEFORE
        // emitMutation so a cache-unlink failure surfaces through
        // the runner's catch-all rather than double-emitting after
        // a success envelope hit stdout.
        const { data: projected, response } = await withBoardInvalidationSingleLeg({
          boardId: parsed.boardId,
          env: ctx.env,
          perform: async () => {
            const wireResponse = await client.raw<unknown>(
              CREATE_GROUP_MUTATION,
              variables,
              { operationName: 'GroupCreate' },
            );
            const data = unwrapOrThrow(
              responseSchema.safeParse(wireResponse.data),
              {
                context: 'Monday returned a malformed GroupCreate response',
                details: { board_id: parsed.boardId, name },
                hint:
                  "this is a data-integrity error in Monday's response; " +
                  'verify the response shape and update responseSchema if ' +
                  "Monday's contract has changed.",
              },
            );
            // Distinguish missing-root-key (schema-drift →
            // internal_error with schema-drift hint) from null
            // payload (Monday returned no group → also internal_
            // error here since create's contract is "every
            // successful call returns a Group"). Mirrors the M16
            // column-create / M15 board-create missing-root-key vs
            // null-payload split.
            if (!('create_group' in data)) {
              throw new ApiError(
                'internal_error',
                `Monday's GroupCreate response is missing the create_group root field`,
                {
                  details: {
                    board_id: parsed.boardId,
                    name,
                    hint:
                      "this is a schema-drift error in Monday's GraphQL " +
                      'response; verify the mutation declaration and update ' +
                      "the response schema if Monday's contract has changed.",
                  },
                },
              );
            }
            // R48 lift (api/group-mutation-result.ts): null-payload
            // guard + projection. Create's null path uses `internal_
            // error` because the contract is "every successful call
            // returns a Group"; the helper carries the agent-
            // supplied `name` in `details` (paired with `board_id`)
            // because the new group id doesn't exist yet on the
            // null path.
            const projection = projectMutationGroup({
              raw: data.create_group,
              errorCode: 'internal_error',
              errorMessage: `Monday returned no group payload from create_group for board ${parsed.boardId} name ${JSON.stringify(name)}.`,
              boardId: parsed.boardId,
              idKey: 'name',
              idValue: name,
            });
            return { data: projection, response: wireResponse };
          },
        });

        emitMutation({
          ctx,
          data: projected,
          schema: boardGroupCreateCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
