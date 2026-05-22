/**
 * Shared shape for the four `update`-toggle verbs (`like` / `unlike`
 * / `pin` / `unpin`). All four share the same argv shape (one
 * positional `<uid>`, no body, `--dry-run` only), the same SDK
 * mutation shape (one ID variable, returns `Update`), and the same
 * envelope (live: projected update; dry-run: `{operation, update_id}`
 * with `meta.source: 'none'`).
 *
 * Lifting on the third consumer — the four toggles are siblings; M5b's
 * R-timing rule (`v0.1-plan.md` §17) fires when three or more sites
 * land the same shape. Without the helper each verb would duplicate
 * ~150 LOC of GraphQL string + zod schema + projection + action body;
 * with it each verb is ~30 LOC of CommandModule + one
 * `attachUpdateToggle({...})` call.
 *
 * The helper accepts the SDK's per-mutation variable-name divergence
 * (`like_update`/`unlike_update` use `update_id`; `pin_to_top`/
 * `unpin_from_top` use `id`) as a parameter — see the `idVariable`
 * field below.
 */
import { z } from 'zod';
import type { Command } from 'commander';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { UpdateIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import {
  projectMutationUpdate,
  UPDATE_FIELDS_FRAGMENT,
  updateProjectionSchema,
  type UpdateProjection,
} from '../../api/update-mutation-result.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';
import type { RunContext } from '../../cli/run.js';

export const toggleOutputSchema = updateProjectionSchema;

export type ToggleOutput = UpdateProjection;

const toggleInputSchema = z.object({ updateId: UpdateIdSchema }).strict();

export type ToggleInput = z.infer<typeof toggleInputSchema>;

export interface UpdateToggleConfig {
  /** Dotted command name used in `monday schema` (e.g. `update.like`). */
  readonly name: `update.${'like' | 'unlike' | 'pin' | 'unpin'}`;
  /** Verb segment under the `update` noun (`like`, `unlike`, `pin`, `unpin`). */
  readonly verb: 'like' | 'unlike' | 'pin' | 'unpin';
  /** One-line summary used as commander's `description()`. */
  readonly summary: string;
  /** Help-text examples. */
  readonly examples: readonly string[];
  /** Monday mutation root-field name (`like_update`, `unpin_from_top`, …). */
  readonly mutation: 'like_update' | 'unlike_update' | 'pin_to_top' | 'unpin_from_top';
  /** Operation-name attribution for SDK telemetry / fixture matching. */
  readonly operationName:
    | 'UpdateLike'
    | 'UpdateUnlike'
    | 'UpdatePin'
    | 'UpdateUnpin';
  /**
   * Monday's per-mutation variable name divergence:
   * `like_update`/`unlike_update` → `update_id`; `pin_to_top`/
   * `unpin_from_top` → `id`. Captured here so the helper sends the
   * right key on the wire.
   */
  readonly idVariable: 'id' | 'update_id';
}

const buildMutationBody = (config: UpdateToggleConfig): string => `
  mutation ${config.operationName}($${config.idVariable}: ID!) {
    ${config.mutation}(${config.idVariable}: $${config.idVariable}) {
      ${UPDATE_FIELDS_FRAGMENT}
    }
  }
`;

/**
 * Builds a `CommandModule` for one of the four toggle verbs and
 * registers it on `program`.
 */
export const buildUpdateToggleCommand = (
  config: UpdateToggleConfig,
): CommandModule<ToggleInput, ToggleOutput> => ({
  name: config.name,
  summary: config.summary,
  examples: config.examples,
  // Toggle mutations are idempotent on Monday's side — re-liking an
  // already-liked update is a server-side no-op (the like is keyed
  // off the caller); same for pin / unpin / unlike.
  idempotent: true,
  inputSchema: toggleInputSchema,
  outputSchema: toggleOutputSchema,
  attach: (program: Command, ctx: RunContext) => {
    const noun = ensureSubcommand(program, 'update');
    noun
      .command(`${config.verb} <updateId>`)
      .description(config.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...config.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (updateId: unknown) => {
        const parsed = parseArgv(toggleInputSchema, { updateId });
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Minimal §6.4 update-toggle dry-run: operation + update_id,
          // no other slots. `meta.source: 'none'` because no API call
          // fires.
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: config.mutation,
                update_id: parsed.updateId,
              },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const variables: Record<string, string> = {
          [config.idVariable]: parsed.updateId,
        };
        const response = await client.raw<unknown>(
          buildMutationBody(config),
          variables,
          { operationName: config.operationName },
        );
        // R42: distinguish missing-root-key (schema-drift →
        // internal_error) from null payload (per-record → not_found
        // via projectMutationUpdate). Must run BEFORE the parse —
        // the toggle's `z.unknown()` field type would otherwise
        // normalize a missing wire key into present-undefined.
        assertResponseFieldPresent({
          data: response.data,
          key: config.mutation,
          operationLabel: config.operationName,
          details: { update_id: parsed.updateId },
          nullHandling: 'caller_handles',
        });
        const data = unwrapOrThrow(
          z
            .object({ [config.mutation]: z.unknown() })
            .loose()
            .safeParse(response.data),
          {
            context: `Monday returned a malformed ${config.operationName} response`,
            details: { update_id: parsed.updateId },
            hint:
              'this is a data-integrity error in Monday\'s response; ' +
              'verify the response shape and update the toggle helper if ' +
              'Monday\'s contract has changed.',
          },
        );
        // Lift R37 (v0.2-plan §20): null-payload + strict-parse seam
        // shared with reply / edit / delete. The per-toggle
        // `mutationName` threads through to the not_found error
        // decoration so agents see `like_update` / `unlike_update` /
        // `pin_to_top` / `unpin_from_top` in `error.message`.
        const projected = projectMutationUpdate({
          raw: data[config.mutation],
          updateId: parsed.updateId,
          mutationName: config.mutation,
        });

        emitMutation({
          ctx,
          data: projected,
          schema: toggleOutputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
});

