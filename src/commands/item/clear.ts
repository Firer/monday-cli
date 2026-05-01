/**
 * `monday item clear <iid> <col>` — single-column clear
 * (`cli-design.md` §4.3 line 489, `v0.1-plan.md` §3 M5b).
 *
 * The dedicated "clear" verb. Per cli-design §5.3 step 3 + the
 * dropdown empty-input rejection in `column-values.ts`, `--set X=`
 * does NOT mean "clear" — it means "set to the empty-string value"
 * which is type-dependent (e.g. `{label: ""}` for status). The
 * dedicated verb is the documented escape and produces the per-type
 * "clear" wire payload:
 *
 *   - `text` / `long_text` / `numbers` → simple bare empty string
 *     (`change_simple_column_value(value: "")`).
 *   - `status` / `dropdown` / `date` / `people` → empty JSON object
 *     `{}` via `change_column_value(value: JSON!)`. Monday's
 *     "clear all column values" pattern.
 *
 * Single-column-only by argv shape: `monday item clear <iid> <col>
 * [--board <bid>]`. Multi-clear / bulk is `item update`'s territory
 * (and isn't a v0.1 concern — cli-design §4.3 names a single-column
 * verb).
 *
 * **Two paths.** `--dry-run` orchestrates `api/dry-run.ts planClear`
 * (single-token shape — symmetric with planChanges' multi-token shape
 * but one token in / one PlannedChange out). Live writes resolve the
 * column + build the clear payload + select the mutation + fire.
 *
 * **Resolver-warning preservation + cache-stale archived remap.**
 * Identical pattern to `item set` (R19 lift) — translator failures
 * and live `validation_failed` after cache-sourced resolution flow
 * through `foldResolverWarningsIntoError` +
 * `maybeRemapValidationFailedToArchived`. clear has no value-side
 * translator (the payload is `""` / `{}` per type, no user-supplied
 * value to interpret), so the only typed failure path on the live
 * side is Monday's mutation-time rejection — which still benefits
 * from the F4 cache-archived remap.
 *
 * Idempotent: yes — clearing an already-empty cell is a no-op write.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, MondayCliError } from '../../utils/errors.js';
import {
  resolveColumnWithRefresh,
  type ResolverWarning,
} from '../../api/columns.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';
import {
  selectMutation,
  translateColumnClear,
  type SelectedMutation,
} from '../../api/column-values.js';
import {
  foldResolverWarningsIntoError,
  maybeRemapValidationFailedToArchived,
} from '../../api/resolver-error-fold.js';
import { planClear } from '../../api/dry-run.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
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

// Same GraphQL surface as item set (cli-design §5.3 step 5).
// Operation names diverge (`ItemClearSimple` / `ItemClearRich`) so
// fixture cassettes + Monday's request-log telemetry can distinguish
// the source verb. The mutation bodies themselves are identical
// because Monday's `change_simple_column_value` /
// `change_column_value` accept the same arguments regardless of
// which CLI verb originated the call.
const ITEM_BOARD_LOOKUP_QUERY = `
  query ItemBoardLookup($ids: [ID!]!) {
    items(ids: $ids) {
      id
      board { id }
    }
  }
`;

const CHANGE_SIMPLE_COLUMN_VALUE_MUTATION = `
  mutation ItemClearSimple(
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
  mutation ItemClearRich(
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

const boardLookupResponseSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: ItemIdSchema,
          board: z.object({ id: BoardIdSchema }).nullable(),
        }),
      )
      .nullable(),
  })
  .loose();

interface ChangeSimpleResponse {
  readonly change_simple_column_value: unknown;
}
interface ChangeColumnResponse {
  readonly change_column_value: unknown;
}

export const itemClearOutputSchema = projectedItemSchema;
export type ItemClearOutput = ProjectedItem;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    column: z.string().min(1),
    board: BoardIdSchema.optional(),
  })
  .strict();

const resolveBoardId = async (
  client: MondayClient,
  itemId: string,
  explicit: string | undefined,
): Promise<string> => {
  if (explicit !== undefined) return explicit;
  const response = await client.raw<unknown>(
    ITEM_BOARD_LOOKUP_QUERY,
    { ids: [itemId] },
    { operationName: 'ItemBoardLookup' },
  );
  const data = unwrapOrThrow(
    boardLookupResponseSchema.safeParse(response.data),
    {
      context: `Monday returned a malformed ItemBoardLookup response for id ${itemId}`,
      details: { item_id: itemId },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update boardLookupResponseSchema if ' +
        'Monday\'s contract has changed.',
    },
  );
  const first = data.items?.[0];
  if (first === undefined) {
    throw new ApiError(
      'not_found',
      `Item ${itemId} does not exist or the token has no read access.`,
      { details: { item_id: itemId } },
    );
  }
  if (first.board === null) {
    throw new ApiError(
      'not_found',
      `Item ${itemId} has no readable board; the token may not have ` +
        `permission on the item's board, or the item is in a deleted ` +
        `board.`,
      { details: { item_id: itemId } },
    );
  }
  return first.board.id;
};

export const itemClearCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemClearOutput
> = {
  name: 'item.clear',
  summary: 'Clear a column value on an item',
  examples: [
    'monday item clear 12345 status',
    'monday item clear 12345 status --board 67890',
    'monday item clear 12345 due --dry-run',
    'monday item clear 12345 owner --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemClearOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('clear <itemId> <column>')
      .description(itemClearCommand.summary)
      .option('--board <bid>', 'board ID (skip implicit lookup)')
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemClearCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, column: unknown, opts: unknown) => {
        const parsed = parseArgv(itemClearCommand.inputSchema, {
          itemId,
          column,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        const boardId = await resolveBoardId(
          client,
          parsed.itemId,
          parsed.board,
        );

        if (globalFlags.dryRun) {
          const result = await planClear({
            client,
            boardId,
            itemId: parsed.itemId,
            token: parsed.column,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: result.plannedChanges as unknown as readonly Readonly<Record<string, unknown>>[],
            source: result.source,
            cacheAgeSeconds: result.cacheAgeSeconds,
            warnings: result.warnings,
            apiVersion,
          });
          return;
        }

        // Live clear path. Resolution + clear-payload build + mutation.
        const resolution = await resolveColumnWithRefresh({
          client,
          boardId,
          token: parsed.column,
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

        let mutationResult;
        try {
          const translated = translateColumnClear({
            id: resolution.match.column.id,
            type: resolution.match.column.type,
          });
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

        const warnings: readonly Warning[] = resolverWarnings;

        emitMutation({
          ctx,
          data: mutationResult.projected,
          schema: itemClearCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(mutationResult.response),
          source: resolution.source === 'cache' ? 'mixed' : resolution.source,
          cacheAgeSeconds: resolution.cacheAgeSeconds,
          // cli-design §5.3 step 2: echo resolved column ID per
          // agent input token. Same shape `item set` uses.
          resolvedIds: { [parsed.column]: resolution.match.column.id },
        });
      });
  },
};

interface MutationExecResult {
  readonly projected: ProjectedItem;
  readonly response: MondayResponse<unknown>;
}

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
      { operationName: 'ItemClearSimple' },
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
        value: mutation.value,
      },
      { operationName: 'ItemClearRich' },
    );
    return {
      projected: projectMutationItem(response.data.change_column_value, itemId),
      response,
    };
  }
  /* c8 ignore next 9 — defensive: selectMutation only emits the
     multi kind for >1 translated values; clear is single-column by
     argv shape, so this branch is unreachable. */
  throw new ApiError(
    'internal_error',
    `item clear selected ${mutation.kind} but only the single-column ` +
      `mutations are supported here.`,
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
