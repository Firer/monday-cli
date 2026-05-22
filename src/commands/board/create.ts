/**
 * `monday board create --name <n> [--workspace <wid>]
 * [--kind public|private|share] [--template <bid>]
 * [--description <d>] [--dry-run]` — create a new board
 * (`cli-design.md` §4.3 line 600, `v0.2-plan.md` §3 M15).
 *
 * **Wire shape.** Single round-trip via `create_board(board_name,
 * board_kind, workspace_id?, template_id?, description?)`. Monday's
 * GraphQL signature pins `board_kind: BoardKind!` (required at the
 * wire); the CLI defaults `--kind` to `public` when omitted so
 * agents don't have to remember the wire constraint. `--workspace`
 * is optional — Monday creates the board in the user's main
 * workspace when omitted. `--template <bid>` clones from a Monday
 * template (templates are managed via Monday's UI; the
 * `BoardKind` enum has no `template` value, so the CLI doesn't
 * pre-validate template-ness ahead of the wire call — non-template
 * IDs surface a wire error re-mapped per §6.5). `--description`
 * is optional; omitting it sends no argument and Monday's server-
 * side default applies.
 *
 * **Live-envelope projection.** Returned `Board` is projected
 * through `boardProjectionSchema` (the shape `board get` already
 * pins post-M15). Sharing the schema keeps create / get / update /
 * duplicate envelopes byte-identical for the same record — a
 * downstream `monday board get <bid>` after a successful create
 * returns the same JSON shape.
 *
 * **Dry-run shape** per cli-design §6.4 board-create variant:
 * minimal `{operation: "create_board", name, workspace_id?, kind,
 * description?, template_id?}`. No preflight read fires; the dry-
 * run is purely argv-derived. `meta.source: 'none'`.
 *
 * **Idempotent: false.** Re-running creates a duplicate board with
 * the same name. Agents needing dedupe should call
 * `monday board list` first. NOT destructive (no `--yes` gate).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { BoardIdSchema, WorkspaceIdSchema } from '../../types/ids.js';
import {
  BOARD_FIELDS_FRAGMENT,
  boardProjectionSchema,
  type BoardProjection,
} from '../../api/board-projection.js';
import { projectMutationBoard } from '../../api/board-mutation-result.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';

const CREATE_BOARD_MUTATION = `
  mutation BoardCreate(
    $boardName: String!,
    $boardKind: BoardKind!,
    $workspaceId: ID,
    $templateId: ID,
    $description: String
  ) {
    create_board(
      board_name: $boardName,
      board_kind: $boardKind,
      workspace_id: $workspaceId,
      template_id: $templateId,
      description: $description
    ) {
      ${BOARD_FIELDS_FRAGMENT}
    }
  }
`;

export const boardCreateOutputSchema = boardProjectionSchema;

export type BoardCreateOutput = BoardProjection;

// Argv schema. `name` carries the same min(1)-after-trim discipline
// as `workspace create` / `item create` — Monday accepts whitespace-
// only names but they produce un-findable boards; reject at the
// boundary. Use `.refine()` not `.transform()` so the schema stays
// JSON-Schema-representable (the schema-export pipeline rejects
// transforms); trim happens inside the action body before the wire
// call.
//
// `workspace` and `template` are branded ID-shape strings; the
// argv-parse-time validation matches `BoardId` / `WorkspaceId`'s
// `/^\d+$/` regex. Per the M15 pre-flight contract (cli-design §4.3
// + Codex round-1 F1), the CLI does NOT pre-validate template-ness
// — non-template IDs surface a wire `validation_failed` mapped per
// §6.5.
const inputSchema = z
  .object({
    name: z.string().refine((s) => s.trim().length > 0, {
      message: '--name must be non-empty (whitespace-only is rejected)',
    }),
    workspace: WorkspaceIdSchema.optional(),
    kind: z.enum(['public', 'private', 'share']).default('public'),
    template: BoardIdSchema.optional(),
    description: z.string().optional(),
  })
  .strict();

const responseSchema = z
  .object({
    create_board: z.unknown(),
  })
  .loose();

export const boardCreateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardCreateOutput
> = {
  name: 'board.create',
  summary: 'Create a new board',
  examples: [
    'monday board create --name "Engineering"',
    'monday board create --name "Engineering — EU" --kind private --workspace 5 --description "EU team"',
    'monday board create --name "Roadmap" --template 99999',
    'monday board create --name "Preview" --dry-run --json',
  ],
  // create_board is non-idempotent — re-running creates a second
  // board with the same name. Mirrors `workspace create` /
  // `item create` rationale.
  idempotent: false,
  inputSchema,
  outputSchema: boardCreateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board');
    noun
      .command('create')
      .description(boardCreateCommand.summary)
      .requiredOption('--name <n>', 'board name')
      .option('--workspace <wid>', 'workspace ID (defaults to user main workspace)')
      .option('--kind <k>', 'board kind: public|private|share (default: public)')
      .option('--template <bid>', 'clone from this template board ID')
      .option('--description <d>', 'board description')
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...boardCreateCommand.examples.map((e) => `  ${e}`),
          '',
          'Creates a classic board. To create a multi-level board, duplicate',
          'an existing one: monday board duplicate <bid>.',
          '',
        ].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(boardCreateCommand.inputSchema, opts);
        const name = parsed.name.trim();
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Per cli-design §6.4 board-create variant: minimal
          // `{operation, name, workspace_id?, kind, description?,
          // template_id?}`. No preflight read fires — purely argv-
          // derived; `meta.source: 'none'`. The defaulted
          // `kind: 'public'` is surfaced explicitly so the agent
          // sees what the live mutation would send.
          const planned: Record<string, unknown> = {
            operation: 'create_board',
            name,
            kind: parsed.kind,
          };
          if (parsed.workspace !== undefined) {
            planned.workspace_id = parsed.workspace;
          }
          if (parsed.description !== undefined) {
            planned.description = parsed.description;
          }
          if (parsed.template !== undefined) {
            planned.template_id = parsed.template;
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
        // reject Monday's server-side default rather than letting
        // it apply.
        const variables: Record<string, unknown> = {
          boardName: name,
          boardKind: parsed.kind,
        };
        if (parsed.workspace !== undefined) {
          variables.workspaceId = parsed.workspace;
        }
        if (parsed.template !== undefined) {
          variables.templateId = parsed.template;
        }
        if (parsed.description !== undefined) {
          variables.description = parsed.description;
        }
        const response = await client.raw<unknown>(
          CREATE_BOARD_MUTATION,
          variables,
          { operationName: 'BoardCreate' },
        );
        const data = unwrapOrThrow(
          responseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed BoardCreate response',
            details: { board_name: name },
            hint:
              'this is a data-integrity error in Monday\'s response; ' +
              'verify the response shape and update responseSchema if ' +
              'Monday\'s contract has changed.',
          },
        );
        // R42: consolidate the inline missing-key check onto
        // `assertResponseFieldPresent`. Distinguishes missing-root-key
        // (schema-drift → internal_error) from null payload (handled
        // downstream by `projectMutationBoard`). Codex M15 round-2 F3
        // lateral propagation; R42 lifts the inline shape across all
        // M15-M17 verbs.
        assertResponseFieldPresent({
          data,
          key: 'create_board',
          operationLabel: 'BoardCreate',
          details: { board_name: name },
          nullHandling: 'caller_handles',
        });
        // R43 lift (api/board-mutation-result.ts): null-payload
        // guard + projection. Create's null path uses
        // `internal_error` because the contract is "every successful
        // call returns a Board"; the helper carries the agent-
        // supplied `board_name` in `details` because the new id
        // doesn't exist yet on the null path.
        const projected = projectMutationBoard({
          raw: data.create_board,
          errorCode: 'internal_error',
          errorMessage: `Monday returned no board payload from create_board for name ${JSON.stringify(name)}.`,
          detailKey: 'board_name',
          detailValue: name,
        });

        emitMutation({
          ctx,
          data: projected,
          schema: boardCreateCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
