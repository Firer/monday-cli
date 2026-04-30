/**
 * `monday item update <iid> [--name <n>] [--set <col>=<val>]...` —
 * multi-column atomic update + optional rename.
 * (`cli-design.md` §4.3 line 490, §5.3, `v0.1-plan.md` §3 M5b).
 *
 * Two argv shapes:
 *
 *   1. **Single-item** (this commit): positional `<itemId>` +
 *      repeatable `--set <col>=<val>` + optional `--name <n>`.
 *      Multi-`--set` (≥2) bundles into one
 *      `change_multiple_column_values` mutation (atomic on Monday's
 *      side per §5.3 step 5). `--name` rolls into the same multi
 *      mutation when columns are also present, otherwise fires a
 *      dedicated `change_simple_column_value(column_id: "name", ...)`.
 *
 *   2. **Bulk** (next commit): `--where <expr>` repeatable + no
 *      positional `<itemId>` — applies the same `--set` / `--name`
 *      bundle to every matching item via Monday's `items_page`
 *      walker. `confirmation_required` fires without `--yes` (and
 *      without `--dry-run`) per cli-design §10.2.
 *
 * **`--name` + `--set` atomicity.** Per cli-design §5.3 step 5, the
 * design promises atomicity for multi-column updates. Bundling the
 * name into the multi mutation keeps the same atomicity guarantee
 * for `--name + --set`. Monday's
 * `change_multiple_column_values(column_values: JSON!)` accepts
 * `name` as a special key in the map. The dry-run engine produces
 * a single `PlannedChange` whose `diff` includes both column keys
 * and a `name` key when both are passed.
 *
 * **`--name` only.** Single field → `change_simple_column_value(
 * column_id: "name", value: <n>)`. Atomic by default (single
 * mutation).
 *
 * **`--create-labels-if-missing`** (cli-design §4.3) — passes
 * through to Monday's `change_*_column_value(create_labels_if_missing:
 * true)`. Tells Monday to auto-create unknown status / dropdown
 * labels rather than rejecting with `validation_failed`. Off by
 * default; agents who want labels-on-demand pass the flag
 * explicitly.
 *
 * Idempotent: yes — `change_*` mutations are idempotent. Multi-set
 * is also idempotent (re-running with the same args produces the
 * same item state).
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
  type DateResolutionContext,
  type PeopleResolutionContext,
  type SelectedMutation,
  type TranslatedColumnValue,
} from '../../api/column-values.js';
import { userByEmail } from '../../api/resolvers.js';
import {
  foldResolverWarningsIntoError,
  maybeRemapValidationFailedToArchived,
} from '../../api/resolver-error-fold.js';
import { planChanges } from '../../api/dry-run.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import {
  ITEM_FIELDS_FRAGMENT,
  parseRawItem,
  resolveMeFactory,
} from '../../api/item-helpers.js';
import {
  projectItem,
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import type { Warning } from '../../utils/output/envelope.js';

const ITEM_BOARD_LOOKUP_QUERY = `
  query ItemBoardLookup($ids: [ID!]!) {
    items(ids: $ids) {
      id
      board { id }
    }
  }
`;

const CHANGE_SIMPLE_COLUMN_VALUE_MUTATION = `
  mutation ItemUpdateSimple(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: String!
    $createLabelsIfMissing: Boolean
  ) {
    change_simple_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
      create_labels_if_missing: $createLabelsIfMissing
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_COLUMN_VALUE_MUTATION = `
  mutation ItemUpdateRich(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: JSON!
    $createLabelsIfMissing: Boolean
  ) {
    change_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
      create_labels_if_missing: $createLabelsIfMissing
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_MULTIPLE_COLUMN_VALUES_MUTATION = `
  mutation ItemUpdateMulti(
    $itemId: ID!
    $boardId: ID!
    $columnValues: JSON!
    $createLabelsIfMissing: Boolean
  ) {
    change_multiple_column_values(
      item_id: $itemId
      board_id: $boardId
      column_values: $columnValues
      create_labels_if_missing: $createLabelsIfMissing
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
interface ChangeMultipleResponse {
  readonly change_multiple_column_values: unknown;
}

export const itemUpdateOutputSchema = projectedItemSchema;
export type ItemUpdateOutput = ProjectedItem;

/**
 * Input shape — single-item path. The bulk path will gain
 * `where: z.array(z.string())` + drop the `itemId.required` invariant
 * in a follow-up commit.
 */
const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    set: z.array(z.string()).default([]),
    name: z.string().min(1).optional(),
    board: BoardIdSchema.optional(),
    createLabelsIfMissing: z.boolean().optional(),
  })
  .strict()
  // At least one of --set or --name must be provided. An empty
  // call (`monday item update 12345`) is meaningless and would
  // produce a zero-mutation envelope that surprises agents.
  .refine(
    (v) => v.set.length > 0 || v.name !== undefined,
    {
      message: 'item update requires at least one of --set or --name',
      path: ['set'],
    },
  );

const splitSetExpression = (raw: string): { readonly token: string; readonly value: string } => {
  const idx = raw.indexOf('=');
  if (idx <= 0) {
    throw new UsageError(
      `--set: expected <col>=<val> (got ${JSON.stringify(raw)}); ` +
        `use shell quoting and the id:/title: prefix when the column ` +
        `token contains "="`,
      { details: { input: raw } },
    );
  }
  return {
    token: raw.slice(0, idx),
    value: raw.slice(idx + 1),
  };
};

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

export const itemUpdateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemUpdateOutput
> = {
  name: 'item.update',
  summary: 'Update one or more columns on an item (atomic)',
  examples: [
    'monday item update 12345 --set status=Done',
    'monday item update 12345 --set status=Done --set owner=alice@example.com',
    'monday item update 12345 --name "New title"',
    'monday item update 12345 --name "New title" --set status=Done',
    'monday item update 12345 --set tags=Backend,Frontend --create-labels-if-missing',
    'monday item update 12345 --set status=Done --dry-run --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemUpdateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('update <itemId>')
      .description(itemUpdateCommand.summary)
      .option(
        '--set <expr>',
        'repeatable <col>=<val> column write',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option('--name <n>', 'rename the item')
      .option('--board <bid>', 'board ID (skip implicit lookup)')
      .option(
        '--create-labels-if-missing',
        'auto-create unknown status / dropdown labels (Monday flag)',
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemUpdateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, opts: unknown) => {
        const parsed = parseArgv(itemUpdateCommand.inputSchema, {
          itemId,
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

        const setEntries = parsed.set.map(splitSetExpression);

        const dateResolution: DateResolutionContext = {
          now: ctx.clock,
          ...(ctx.env.MONDAY_TIMEZONE === undefined
            ? {}
            : { timezone: ctx.env.MONDAY_TIMEZONE }),
        };
        const peopleResolution: PeopleResolutionContext = {
          resolveMe: resolveMeFactory(client),
          resolveEmail: async (email) => {
            const result = await userByEmail({
              client,
              email,
              env: ctx.env,
              noCache: globalFlags.noCache,
            });
            return result.user.id;
          },
        };

        if (globalFlags.dryRun) {
          const result = await planChanges({
            client,
            boardId,
            itemId: parsed.itemId,
            setEntries,
            ...(parsed.name === undefined ? {} : { nameChange: parsed.name }),
            dateResolution,
            peopleResolution,
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

        // Live update path. Resolve every column token in one batch
        // before translating, so the agent sees one cumulative
        // resolution-error envelope rather than partial-progress
        // surprises across the array.
        const collectedWarnings: ResolverWarning[] = [];
        const translated: TranslatedColumnValue[] = [];
        const resolvedIds: Record<string, string> = {};
        for (const entry of setEntries) {
          const resolution = await resolveColumnWithRefresh({
            client,
            boardId,
            token: entry.token,
            includeArchived: true,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          collectedWarnings.push(...resolution.warnings);

          if (resolution.match.column.archived === true) {
            throw foldResolverWarningsIntoError(
              new ApiError(
                'column_archived',
                `Column ${JSON.stringify(resolution.match.column.id)} on board ` +
                  `${boardId} is archived. Monday rejects mutations against ` +
                  `archived columns; un-archive the column in Monday or pick ` +
                  `a different target.`,
                {
                  details: {
                    column_id: resolution.match.column.id,
                    column_title: resolution.match.column.title,
                    column_type: resolution.match.column.type,
                    board_id: boardId,
                  },
                },
              ),
              collectedWarnings,
            );
          }

          try {
            const t = await translateColumnValueAsync({
              column: {
                id: resolution.match.column.id,
                type: resolution.match.column.type,
              },
              value: entry.value,
              dateResolution,
              peopleResolution,
            });
            translated.push(t);
            resolvedIds[entry.token] = resolution.match.column.id;
          } catch (err) {
            if (err instanceof MondayCliError) {
              throw foldResolverWarningsIntoError(err, collectedWarnings);
            }
            throw err;
          }
        }

        // Build the final SelectedMutation. When `--name` is set,
        // a synthetic translated value (columnId: "name",
        // columnType: "text") joins the array so `selectMutation`
        // dispatches uniformly: name-only → simple; columns + name
        // (or ≥2 columns) → multi.
        const allTranslated: readonly TranslatedColumnValue[] =
          parsed.name === undefined
            ? translated
            : [
                {
                  columnId: 'name',
                  columnType: 'text',
                  rawInput: parsed.name,
                  payload: { format: 'simple', value: parsed.name },
                  resolvedFrom: null,
                  peopleResolution: null,
                },
                ...translated,
              ];

        let mutationResult;
        try {
          const mutation: SelectedMutation = selectMutation(allTranslated);
          mutationResult = await executeMutation(client, {
            mutation,
            itemId: parsed.itemId,
            boardId,
            createLabelsIfMissing: parsed.createLabelsIfMissing,
          });
        } catch (err) {
          if (err instanceof MondayCliError) {
            // F4 remap: cache-sourced resolution + Monday rejecting
            // as validation_failed → check live archived state.
            // For multi-column updates we don't know which column
            // triggered the rejection; pick the first translated
            // column as a "best effort" remap target. This is a
            // simplification: a future enhancement might iterate
            // every translated column to find the archived one.
            const first = translated[0];
            const folded = foldResolverWarningsIntoError(err, collectedWarnings);
            if (first === undefined) {
              throw folded;
            }
            // Pick a representative resolution source for the remap
            // — multi-column resolution may have mixed cache /
            // live legs; if any leg was non-live we treat the batch
            // as cache-sourced for remap purposes. mergedSource is
            // either 'cache' / 'live' / 'mixed'.
            const mergedSource = collectedWarnings.some(
              (w) => w.code === 'stale_cache_refreshed',
            )
              ? 'mixed'
              : 'live';
            throw await maybeRemapValidationFailedToArchived(folded, {
              client,
              boardId,
              columnId: first.columnId,
              env: ctx.env,
              noCache: globalFlags.noCache,
              resolutionSource: mergedSource,
            });
          }
          throw err;
        }

        const warnings: readonly Warning[] = collectedWarnings;
        emitMutation({
          ctx,
          data: mutationResult.projected,
          schema: itemUpdateCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(mutationResult.response),
          source: collectedWarnings.length > 0 ? 'mixed' : 'live',
          cacheAgeSeconds: null,
          // resolved_ids — same shape as `item set`. The synthetic
          // `name` field doesn't appear here because the slot only
          // echoes RESOLVED tokens (those that went through the
          // column resolver); `name` skipped that step.
          resolvedIds,
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
    readonly createLabelsIfMissing: boolean | undefined;
  },
): Promise<MutationExecResult> => {
  const { mutation, itemId, boardId, createLabelsIfMissing } = inputs;
  const labelsFlag = createLabelsIfMissing ?? false;
  if (mutation.kind === 'change_simple_column_value') {
    const response = await client.raw<ChangeSimpleResponse>(
      CHANGE_SIMPLE_COLUMN_VALUE_MUTATION,
      {
        itemId,
        boardId,
        columnId: mutation.columnId,
        value: mutation.value,
        createLabelsIfMissing: labelsFlag,
      },
      { operationName: 'ItemUpdateSimple' },
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
        createLabelsIfMissing: labelsFlag,
      },
      { operationName: 'ItemUpdateRich' },
    );
    return {
      projected: projectMutationItem(response.data.change_column_value, itemId),
      response,
    };
  }
  // change_multiple_column_values — multi-`--set` or `--set + --name`.
  const response = await client.raw<ChangeMultipleResponse>(
    CHANGE_MULTIPLE_COLUMN_VALUES_MUTATION,
    {
      itemId,
      boardId,
      columnValues: mutation.columnValues,
      createLabelsIfMissing: labelsFlag,
    },
    { operationName: 'ItemUpdateMulti' },
  );
  return {
    projected: projectMutationItem(response.data.change_multiple_column_values, itemId),
    response,
  };
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
