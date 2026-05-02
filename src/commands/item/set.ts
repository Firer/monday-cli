/**
 * `monday item set <iid> (<col>=<val> | --set-raw <col>=<json>)` —
 * single-column write (`cli-design.md` §4.3 + §5.3 + §5.3 escape-
 * hatch, `v0.1-plan.md` §3 M5b, `v0.2-plan.md` §3 M8).
 *
 * Two argv shapes (mutually exclusive — exactly one fires per call):
 *   1. **Friendly** — positional `<col>=<val>`. Resolves the column,
 *      translates the value through `column-values.ts
 *      translateColumnValueAsync`, dispatches via `selectMutation`.
 *   2. **Raw** — `--set-raw <col>=<json>` (M8). Resolves the column,
 *      runs the read-only-forever / files-shaped reject lists from
 *      `raw-write.ts translateRawColumnValue`, dispatches via the
 *      same `selectMutation` (always `change_column_value` for
 *      single-column raw — never the simple variant per cli-design
 *      §5.3 line 898-901).
 *
 * **Two paths.** `--dry-run` orchestrates the M5a engine
 * (`api/dry-run.ts planChanges`) which reads the item state, builds
 * the §6.4 `planned_changes` shape, and emits a dry-run envelope
 * (`data: null`, `meta.dry_run: true`, `planned_changes: [{...}]`).
 * Live writes resolve the column + translate the value + select the
 * mutation + fire it directly, returning the projected item per §6.2.
 * Both shapes go through the same dry-run + live paths.
 *
 * **Board resolution** (cli-design §5.3 step 1). `--board <bid>` is
 * authoritative; without it the CLI calls `items(ids:[<iid>])` to
 * read `board.id` and continues. The implicit-lookup result feeds
 * both the live write and the dry-run engine — same answer, same
 * source-of-truth (the item's current board).
 *
 * **Resolver-warning preservation.** Both paths thread collision /
 * stale-cache-refreshed warnings into the success envelope via
 * `warnings: [...]`. On error paths that surface AFTER resolution
 * succeeded (the `column_archived` case the dry-run engine pins),
 * the warnings fold into `error.details.resolver_warnings` so a
 * stale-cache-then-archived flow doesn't lose the refresh signal.
 *
 * **Mutation kind selection** (`api/column-values.ts selectMutation`).
 * Item set is single-`<col>=<val>` only:
 *   - 1 simple type (text / long_text / numbers) →
 *     `change_simple_column_value` (bare-string `value`).
 *   - 1 rich type (status / dropdown / date / people) →
 *     `change_column_value` (JSON object `value`).
 * `change_multiple_column_values` is never selected by item set —
 * that path lights up under `monday item update` (next session).
 *
 * Idempotent: yes — Monday's `change_*` mutations are idempotent
 * (re-running with the same args produces the same item state).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, MondayCliError, UsageError } from '../../utils/errors.js';
import {
  resolveColumnWithRefresh,
  type ResolverWarning,
} from '../../api/columns.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';
import {
  selectMutation,
  translateColumnValueAsync,
  type SelectedMutation,
  type TranslatedColumnValue,
} from '../../api/column-values.js';
import {
  parseSetRawExpression,
  translateRawColumnValue,
} from '../../api/raw-write.js';
import { splitSetExpression } from '../../api/set-expression.js';
import { buildResolutionContexts } from '../../api/resolution-context.js';
import { resolveBoardId } from '../../api/item-board-lookup.js';
import {
  foldResolverWarningsIntoError,
  maybeRemapValidationFailedToArchived,
} from '../../api/resolver-error-fold.js';
import { planChanges } from '../../api/dry-run.js';
import {
  ITEM_FIELDS_FRAGMENT,
  parseRawItem,
} from '../../api/item-helpers.js';
import {
  projectItem,
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import type { Warning } from '../../utils/output/envelope.js';

const CHANGE_SIMPLE_COLUMN_VALUE_MUTATION = `
  mutation ItemSetSimple(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: String!
  ) {
    change_simple_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_COLUMN_VALUE_MUTATION = `
  mutation ItemSetRich(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: JSON!
  ) {
    change_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

interface ChangeSimpleResponse {
  readonly change_simple_column_value: unknown;
}
interface ChangeColumnResponse {
  readonly change_column_value: unknown;
}

export const itemSetOutputSchema = projectedItemSchema;
export type ItemSetOutput = ProjectedItem;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    // Positional `<col>=<val>` is optional in M8 — `--set-raw` is the
    // alternative shape per cli-design §4.3 line 492-494. Exactly one
    // of `setExpr` / `setRaw` must be present (validated below).
    setExpr: z.string().min(1).optional(),
    setRaw: z.string().min(1).optional(),
    board: BoardIdSchema.optional(),
  })
  .strict()
  .refine(
    (v) => (v.setExpr === undefined) !== (v.setRaw === undefined),
    {
      message:
        'item set requires exactly one of <col>=<val> (positional) or ' +
        '--set-raw <col>=<json>',
      path: ['setExpr'],
    },
  );

export const itemSetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemSetOutput
> = {
  name: 'item.set',
  summary: 'Write a single column value on an item',
  examples: [
    'monday item set 12345 status=Done',
    'monday item set 12345 status=Done --board 67890',
    "monday item set 12345 owner=alice@example.com --dry-run",
    'monday item set 12345 due=+1w --json',
    "monday item set 12345 --set-raw status='{\"label\":\"Done\"}'",
    "monday item set 12345 --set-raw tags='{\"tag_ids\":[1,2]}' --board 67890",
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemSetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      // Positional `[setExpr]` optional so the parser accepts the
      // `--set-raw`-only invocation per cli-design §4.3 line 492-494.
      // The zod refinement enforces "exactly one of setExpr / setRaw".
      .command('set <itemId> [setExpr]')
      .description(itemSetCommand.summary)
      .option('--board <bid>', 'board ID (skip implicit lookup)')
      .option(
        '--set-raw <expr>',
        '<col>=<json> raw write (escape hatch — bypasses friendly translator)',
      )
      // `--dry-run` is a global flag (`src/cli/program.ts`) — read
      // it via `globalFlags.dryRun` rather than redeclaring on this
      // subcommand so the flag stays single-source-of-truth across
      // every M5b mutation surface.
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemSetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, setExpr: unknown, opts: unknown) => {
        const parsed = parseArgv(itemSetCommand.inputSchema, {
          itemId,
          ...(setExpr === undefined ? {} : { setExpr }),
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        // Exactly one of setExpr / setRaw is present (zod refinement
        // enforces XOR). Discriminate to keep the downstream code
        // shape clear.
        const isRaw = parsed.setRaw !== undefined;
        const friendly =
          parsed.setExpr === undefined ? null : splitSetExpression(parsed.setExpr);
        const rawParsed =
          parsed.setRaw === undefined ? null : parseSetRawExpression(parsed.setRaw);
        // The token under either shape — used for resolved_ids echo +
        // dry-run engine input.
        const token = friendly?.token ?? rawParsed?.token;
        /* c8 ignore next 5 — defensive: zod refinement guarantees one
           of friendly / rawParsed is non-null, so token is non-undefined.
           The guard exists for `noUncheckedIndexedAccess` narrowing. */
        if (token === undefined) {
          throw new UsageError('item set: token narrowing failed');
        }

        const boardId = await resolveBoardId({
          client,
          itemId: parsed.itemId,
          explicit: parsed.board,
        });

        // Resolution contexts. `MONDAY_TIMEZONE` env override threads
        // to date.parseDateInput per cli-design §5.3 line 765;
        // `resolveMe` + `resolveEmail` cover the people branch's
        // `me` token and email-lookup paths per §5.3 line 728-734.
        const { dateResolution, peopleResolution } = buildResolutionContexts(
          { client, ctx, globalFlags },
        );

        if (globalFlags.dryRun) {
          const result = await planChanges({
            client,
            boardId,
            itemId: parsed.itemId,
            setEntries: friendly === null ? [] : [friendly],
            ...(rawParsed === null ? {} : { rawEntries: [rawParsed] }),
            dateResolution,
            peopleResolution,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            // PlannedChange is a closed-shape interface; the dry-run
            // envelope's `planned_changes` field is `unknown[]` per
            // §6.4 (extensions land additively). Widen here.
            plannedChanges: result.plannedChanges as unknown as readonly Readonly<Record<string, unknown>>[],
            source: result.source,
            cacheAgeSeconds: result.cacheAgeSeconds,
            warnings: result.warnings,
            apiVersion,
          });
          return;
        }

        // Live write path. Resolution + translation + mutation,
        // mirroring planChanges' resolver-warnings preservation but
        // without the item-state read (which the live mutation
        // doesn't need — the mutation response carries the updated
        // item).
        const resolution = await resolveColumnWithRefresh({
          client,
          boardId,
          token,
          includeArchived: true,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });
        const resolverWarnings: readonly ResolverWarning[] = resolution.warnings;

        if (resolution.match.column.archived === true) {
          throw foldResolverWarningsIntoError(
            new ApiError(
              'column_archived',
              `Column ${JSON.stringify(resolution.match.column.id)} on board ` +
                `${boardId} is archived. Monday rejects mutations against ` +
                `archived columns; un-archive the column in Monday or pick a ` +
                `different target.`,
              {
                details: {
                  column_id: resolution.match.column.id,
                  column_title: resolution.match.column.title,
                  column_type: resolution.match.column.type,
                  board_id: boardId,
                },
              },
            ),
            resolverWarnings,
          );
        }

        // Translator + mutation-selection + live mutation all share
        // the same resolver-warnings preservation rule. Any typed
        // failure (UsageError from date/dropdown/people invalid
        // input, ApiError(validation_failed) from Monday on the
        // mutation) gets the collected collision /
        // stale_cache_refreshed warnings folded into
        // details.resolver_warnings — pass-1 finding F2 widened the
        // fold from ApiError-only to MondayCliError to cover the
        // full error surface. M8: --set-raw branch uses the same
        // shape — `translateRawColumnValue` runs the read-only-
        // forever / files-shaped reject lists, then dispatch.
        let translated: TranslatedColumnValue;
        let mutationResult;
        try {
          if (isRaw) {
            /* c8 ignore next 4 — defensive: isRaw === true means
               rawParsed is non-null per the discriminator above. */
            if (rawParsed === null) {
              throw new UsageError('item set: rawParsed narrowing failed');
            }
            translated = translateRawColumnValue(
              {
                id: resolution.match.column.id,
                type: resolution.match.column.type,
              },
              rawParsed.value,
              rawParsed.rawJson,
            );
          } else {
            /* c8 ignore next 4 — defensive: isRaw === false means
               friendly is non-null per the discriminator above. */
            if (friendly === null) {
              throw new UsageError('item set: friendly narrowing failed');
            }
            translated = await translateColumnValueAsync({
              column: {
                id: resolution.match.column.id,
                type: resolution.match.column.type,
              },
              value: friendly.value,
              dateResolution,
              peopleResolution,
            });
          }
          const mutation: SelectedMutation = selectMutation([translated]);
          mutationResult = await executeMutation(client, {
            mutation,
            itemId: parsed.itemId,
            boardId,
          });
        } catch (err) {
          if (err instanceof MondayCliError) {
            throw await maybeRemapValidationFailedToArchived(
              foldResolverWarningsIntoError(err, resolverWarnings),
              {
                client,
                boardId,
                columnIds: [resolution.match.column.id],
                env: ctx.env,
                noCache: globalFlags.noCache,
                resolutionSource: resolution.source,
              },
            );
          }
          throw err;
        }

        // Resolver warnings ride into the success envelope's
        // top-level warnings so an agent reading a successful write
        // still sees that the cache was stale or that the token
        // collided with another column's title. Same shape filter
        // reads use post-R12.
        // ResolverWarning widens to envelope.Warning structurally
        // (narrower code literal, required details). Same shape
        // filters.ts and search.ts use post-R12.
        const warnings: readonly Warning[] = resolverWarnings;

        emitMutation({
          ctx,
          data: mutationResult.projected,
          schema: itemSetCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(mutationResult.response),
          // Resolution may have served from cache (and refreshed if
          // the column wasn't there); thread the resolved source +
          // age through. The mutation itself is always live, so a
          // pure-cache leg never happens here — but the resolver's
          // `mixed` outcome still surfaces as `mixed`.
          source: resolution.source === 'cache' ? 'mixed' : resolution.source,
          cacheAgeSeconds: resolution.cacheAgeSeconds,
          // cli-design §5.3 step 2: echo the resolved column ID so
          // an agent's "set then re-read" loop can use the resolved
          // ID without consulting metadata twice. Keyed by the raw
          // input token (the slot is `Record<string, string>` so
          // multi-`--set` in M5b's item update extends naturally).
          resolvedIds: { [token]: resolution.match.column.id },
        });
      });
  },
};

interface MutationExecResult {
  readonly projected: ProjectedItem;
  readonly response: MondayResponse<unknown>;
}

/**
 * Issues the live mutation Monday's `change_simple_column_value` /
 * `change_column_value` accept. Returns the projected item per §6.2
 * — Monday returns the full item shape on the mutation's payload, so
 * one round-trip lands the write + the post-write item state. The
 * raw response object is also returned so the caller can thread its
 * `complexity` field through `toEmit`.
 */
const executeMutation = async (
  client: MondayClient,
  inputs: {
    readonly mutation: SelectedMutation;
    readonly itemId: string;
    readonly boardId: string;
  },
): Promise<MutationExecResult> => {
  const { mutation, itemId, boardId } = inputs;
  if (mutation.kind === 'change_simple_column_value') {
    const response = await client.raw<ChangeSimpleResponse>(
      CHANGE_SIMPLE_COLUMN_VALUE_MUTATION,
      {
        itemId,
        boardId,
        columnId: mutation.columnId,
        value: mutation.value,
      },
      { operationName: 'ItemSetSimple' },
    );
    return {
      projected: projectMutationItem(response.data.change_simple_column_value, itemId),
      response,
    };
  }
  if (mutation.kind === 'change_column_value') {
    const response = await client.raw<ChangeColumnResponse>(
      CHANGE_COLUMN_VALUE_MUTATION,
      {
        itemId,
        boardId,
        columnId: mutation.columnId,
        // Monday's `change_column_value(value: JSON!)` accepts a
        // plain object — the SDK / fetch layer handles the wire
        // stringification at the GraphQL `JSON` scalar boundary.
        // Per cli-design §5.3 step 4: the translator emits a plain
        // JS object; the wire layer handles the JSON.stringify.
        value: mutation.value,
      },
      { operationName: 'ItemSetRich' },
    );
    return {
      projected: projectMutationItem(response.data.change_column_value, itemId),
      response,
    };
  }
  // change_multiple_column_values — reachable only when item set's
  // single-`<col>=<val>` becomes multi-`--set` in v0.1's `item update`.
  // Defensive guard: M5b's item set never selects multi.
  /* c8 ignore next 9 — defensive: selectMutation only emits this
     kind for >1 translated values; item set is single-`<col>=<val>`
     by argv shape, so this branch is unreachable. */
  throw new ApiError(
    'internal_error',
    `item set selected ${mutation.kind} but only the single-column ` +
      `mutations are supported here; bundling >1 set targets is item ` +
      `update's surface.`,
    { details: { mutation_kind: mutation.kind, item_id: itemId } },
  );
};

const projectMutationItem = (raw: unknown, itemId: string): ProjectedItem => {
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned no item payload from the mutation for id ${itemId}.`,
      { details: { item_id: itemId } },
    );
  }
  return projectItem({ raw: parseRawItem(raw, { item_id: itemId }) });
};
