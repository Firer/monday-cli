/**
 * `monday item move <iid> --to-group <gid> [--to-board <bid>]
 *  [--columns-mapping <json>] [--dry-run]` — move an item between
 * groups (same-board) or between boards (cross-board).
 *
 * The fourth and final lifecycle verb closing M11 — together with M10's
 * `archive` / `delete` / `duplicate`, completes the four-verb set
 * Monday's API exposes (`archive_item` / `delete_item` /
 * `duplicate_item` / `move_item_to_group` / `move_item_to_board`).
 *
 * **Two transports under one verb.**
 *   - `--to-group <gid>` alone → calls `move_item_to_group`.
 *     Same-board move; no column re-resolution; single round-trip live.
 *   - `--to-group <gid> --to-board <bid>` → calls `move_item_to_board`.
 *     Cross-board move; Monday requires `group_id: ID!` on the target
 *     board (cli-design §4.3 line 530's mutual-exclusion was misleading
 *     pre-M11 — the cross-board path needs the destination group too,
 *     so `--to-group` is required for both forms; the §9 precondition
 *     diff updates the line during the M11 docs sweep).
 *   - `--to-board <bid>` alone (no `--to-group`) → `usage_error`. There
 *     is no Monday-side default for the destination group.
 *
 * **`--columns-mapping <json>` (cross-board only).** A JSON object
 * mapping source column IDs to target column IDs, e.g.
 * `'{"status": "status_42", "due": "deadline"}'`. Maps directly to
 * Monday's `columns_mapping: [ColumnMappingInput!]` parameter where
 * `ColumnMappingInput = { source: ID!, target?: ID }` — strictly
 * ID-to-ID, no value translation (per the SDK 14.0.0 typing at
 * `node_modules/@mondaydotcomorg/api/dist/esm/index.d.ts:551`).
 *
 * **Strict default per §8 decision 5.** Monday's permissive default
 * silently drops column values whose source ID doesn't exist on the
 * target board. The CLI rejects unmatched columns pre-mutation with
 * `usage_error` carrying `details.unmatched: [{source_col_id,
 * source_title, source_type}]` and a `--columns-mapping` example so
 * the agent knows exactly which columns need a mapping. Empty
 * `--columns-mapping {}` is the explicit "drop everything (Monday's
 * permissive default)" opt-in.
 *
 * **Value-overrides deferred to v0.3.** v0.2-plan §3 M11 mentioned a
 * richer `{<src>: { id: <target>, value: <translation override> }}`
 * form whose `value` re-runs through M5a/M8's translator on target
 * metadata. Monday's `ColumnMappingInput` doesn't carry a value slot
 * — supporting it would require a non-atomic post-move
 * `change_multiple_column_values` mutation with partial-failure
 * envelope shapes that don't yet have a precedent. Deferred; agents
 * fire `monday item set <iid> <target>=<value>` post-move when they
 * need value overrides. Captured in v0.2-plan §15 post-mortem.
 *
 * **Leg ordering.**
 *   - **Same-board live:** single round-trip — `move_item_to_group`
 *     directly. `meta.source: "live"`.
 *   - **Same-board dry-run:** single round-trip — read source via
 *     `readSourceItemForDryRun({operationName: 'ItemMoveRead'})`.
 *     `meta.source: "live"`.
 *   - **Cross-board live:** four legs — `lookupItemBoard` (source
 *     board) + `loadBoardMetadata(source)` + `loadBoardMetadata(target)`
 *     (parallel) + the unmatched check + `move_item_to_board`.
 *     `meta.source` aggregates via `mergeSource` because the metadata
 *     loads can hit cache.
 *   - **Cross-board dry-run:** three legs — `readSourceItemForDryRun`
 *     (also surfaces the source-item snapshot for the envelope) +
 *     `lookupItemBoard` + `loadBoardMetadata(target)` + the unmatched
 *     check. No mutation fires.
 *
 * **Idempotent: false.** Same-board (`move_item_to_group`) is
 * idempotent on Monday's side per cli-design §9.1 — re-running with
 * the item already in the target group is a wire-level no-op. But
 * cross-board (`move_item_to_board`) re-running where the item is
 * already on the target board is undefined behaviour (the SDK doesn't
 * commit either way), so the verb-level marker stays `false`
 * conservatively. Mirrors `monday item create`'s "the verb's
 * idempotency is the conservative bound across all paths" rationale.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, GroupIdSchema, ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import type { parseGlobalFlags } from '../../types/global-flags.js';
import { ITEM_FIELDS_FRAGMENT } from '../../api/item-helpers.js';
import { projectMutationItem } from '../../api/item-mutation-result.js';
import { readSourceItemForDryRun } from '../../api/item-source-read.js';
import { lookupItemBoard } from '../../api/item-board-lookup.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';
import { SourceAggregator } from '../../api/source-aggregator.js';
import {
  parseColumnMappingJson,
  type ColumnMapping,
} from '../../api/column-mapping.js';
import { UsageError } from '../../utils/errors.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';

// Same-board mutation. `move_item_to_group(item_id, group_id)` returns
// the moved item directly with the (unchanged) board_id and the new
// group_id; we project through the same `ITEM_FIELDS_FRAGMENT` archive
// + delete + duplicate use so the envelope's `data` shape stays
// byte-identical to `item get`.
const MOVE_ITEM_TO_GROUP_MUTATION = `
  mutation ItemMoveToGroup($itemId: ID!, $groupId: String!) {
    move_item_to_group(item_id: $itemId, group_id: $groupId) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

// Cross-board mutation. Monday's `move_item_to_board` requires
// `group_id: ID!` (the destination group on the target board) and
// optionally accepts `columns_mapping: [ColumnMappingInput!]` where
// `ColumnMappingInput = { source: ID!, target?: ID }`. The CLI's
// `--columns-mapping <json>` parses to that shape directly.
const MOVE_ITEM_TO_BOARD_MUTATION = `
  mutation ItemMoveToBoard(
    $itemId: ID!
    $boardId: ID!
    $groupId: ID!
    $columnsMapping: [ColumnMappingInput!]
  ) {
    move_item_to_board(
      item_id: $itemId
      board_id: $boardId
      group_id: $groupId
      columns_mapping: $columnsMapping
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

interface MoveItemToGroupResponse {
  readonly move_item_to_group: unknown;
}

interface MoveItemToBoardResponse {
  readonly move_item_to_board: unknown;
}

export const itemMoveOutputSchema = projectedItemSchema;
export type ItemMoveOutput = ProjectedItem;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    toGroup: GroupIdSchema,
    // `--to-board` is optional. When set, the mutation routes to
    // `move_item_to_board` (cross-board); when absent, to
    // `move_item_to_group` (same-board).
    toBoard: BoardIdSchema.optional(),
    // Pre-parsed mapping. The argv layer parses + validates the JSON
    // string via `parseColumnMappingJson` before this schema runs;
    // the schema sees a typed `ColumnMapping` (Record<string, string>)
    // or `undefined`. Using `z.record` rather than `z.custom` so
    // `monday schema` can emit a proper JSON Schema for `--columns-
    // mapping` (z.custom can't be represented in JSON Schema).
    columnsMapping: z
      .record(z.string().min(1), z.string().min(1))
      .optional(),
  })
  .strict();

interface UnmatchedColumn {
  readonly source_col_id: string;
  readonly source_title: string;
  readonly source_type: string;
}

interface ColumnMappingPlan {
  /** The columns_mapping array fed to the wire mutation. */
  readonly columnsMapping: readonly { readonly source: string; readonly target: string }[];
  /** Echoed to the dry-run envelope's `column_mappings` slot. */
  readonly echo: readonly { readonly source: string; readonly target: string }[];
}

/**
 * Computes the planned `columns_mapping` array for a cross-board move
 * and rejects any unmatched source columns that aren't covered by the
 * agent-supplied mapping (cli-design §8 decision 5 — strict default).
 *
 * "Unmatched" = source column whose ID doesn't exist on the target
 * board AND isn't covered by `--columns-mapping`. Source columns whose
 * IDs match a target column ID verbatim are auto-mapped (Monday would
 * have done this anyway — we make it explicit in `columns_mapping` so
 * the dry-run echo is comprehensive).
 *
 * Empty `--columns-mapping {}` is the explicit "drop everything"
 * opt-in: it bypasses the unmatched check entirely and passes an
 * empty mapping array to Monday, matching Monday's permissive default
 * behaviour.
 */
const planColumnMappings = ({
  sourceColumnIds,
  sourceColumnsById,
  targetColumnIds,
  mapping,
}: {
  readonly sourceColumnIds: readonly string[];
  readonly sourceColumnsById: ReadonlyMap<
    string,
    { readonly id: string; readonly title: string; readonly type: string }
  >;
  readonly targetColumnIds: ReadonlySet<string>;
  readonly mapping: ColumnMapping | undefined;
}): ColumnMappingPlan => {
  // Empty `{}` — the explicit "drop everything" opt-in. Skip the
  // unmatched check entirely; Monday's permissive default applies.
  if (mapping !== undefined && Object.keys(mapping).length === 0) {
    return { columnsMapping: [], echo: [] };
  }

  const planned: { source: string; target: string }[] = [];
  const unmatched: UnmatchedColumn[] = [];
  const invalidMappings: { source_col_id: string; target_col_id: string }[] = [];

  for (const sourceId of sourceColumnIds) {
    // Check the explicit mapping first. The mapping wins over a
    // verbatim ID match — agents can rename a same-ID column on
    // purpose by mapping it to a different target.
    const mapped = mapping?.[sourceId];
    if (mapped !== undefined) {
      // Round-2 P2 (F2): validate the mapped target exists on the
      // target board. The parser only checks JSON shape (non-empty
      // string); without this gate `--columns-mapping
      // '{"status_4":"typo"}'` would bypass the strict-default
      // unmatched check and reach Monday with a bogus target ID
      // (silently dropped server-side). We have target metadata
      // already loaded — fail loud here so the "reject before silent
      // drop" guarantee covers typo'd mapping targets too.
      if (!targetColumnIds.has(mapped)) {
        invalidMappings.push({ source_col_id: sourceId, target_col_id: mapped });
        continue;
      }
      planned.push({ source: sourceId, target: mapped });
      continue;
    }
    // Verbatim ID match: source column with the same ID exists on
    // target. This is Monday's default behaviour, but we surface it
    // explicitly in `columns_mapping` so the dry-run echo is
    // comprehensive.
    if (targetColumnIds.has(sourceId)) {
      planned.push({ source: sourceId, target: sourceId });
      continue;
    }
    // Unmatched: collect with details so the agent gets the
    // information they need to add a `--columns-mapping` entry.
    const sourceCol = sourceColumnsById.get(sourceId);
    unmatched.push({
      source_col_id: sourceId,
      source_title: sourceCol?.title ?? sourceId,
      source_type: sourceCol?.type ?? 'unknown',
    });
  }

  if (invalidMappings.length > 0) {
    throw new UsageError(
      `Cross-board move's --columns-mapping points at ${String(
        invalidMappings.length,
      )} target column(s) that don't exist on the target board.`,
      {
        details: {
          invalid_mappings: invalidMappings,
          hint:
            'verify the target column IDs against `monday board describe ' +
            '<target_bid>`; the source IDs map to target IDs that must ' +
            'already exist (move does not create columns).',
        },
      },
    );
  }

  if (unmatched.length > 0) {
    throw new UsageError(
      `Cross-board move would drop ${String(unmatched.length)} column ` +
        `value(s) because no target column matches. Pass ` +
        `--columns-mapping '{"<source_col_id>": "<target_col_id>", ...}' ` +
        `to bridge each unmatched column, or --columns-mapping '{}' to ` +
        `accept Monday's permissive default (silently drop unmatched).`,
      {
        details: {
          unmatched,
          example_mapping: Object.fromEntries(
            unmatched.map((u) => [u.source_col_id, '<target_col_id>']),
          ),
        },
      },
    );
  }

  return { columnsMapping: planned, echo: planned };
};

/**
 * Recursive "has content" check for a parsed wire value.
 *
 * Round-2 P1 (F1): the round-1 fix only treated `null`/`undefined` as
 * empty, missing the "rich clear" shapes Monday + the M5b clear
 * translator both produce — `{}`, `{label: null, index: null}`,
 * `{date: null, time: null}`, `{personsAndTeams: []}`, etc. (see
 * `column-values.ts` clear payloads + `item-projection.test.ts`
 * cleared-date case). A cleared status / date / people cell with
 * `value: "{}"` parses to `{}` and the round-1 filter wrongly
 * counted it as "has data", re-introducing the F1 bug for the
 * rich-clear case.
 *
 * Semantic emptiness here:
 *   - `null` / `undefined` → empty.
 *   - String → empty when zero-length. Non-empty strings carry data.
 *   - Number / boolean → always has content (`0` and `false` are
 *     legitimate values for numeric / checkbox cells).
 *   - Array → has content when ANY element has content.
 *   - Object → has content when ANY value has content (recursive).
 *
 * The recursion stops at primitive leaves; cyclic objects shouldn't
 * appear in JSON-parsed wire payloads, so no cycle guard.
 */
const valueHasContent = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number' || typeof v === 'boolean') return true;
  if (Array.isArray(v)) return v.some(valueHasContent);
  if (typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).some(valueHasContent);
  }
  /* c8 ignore next — symbol / bigint / function aren't representable
     in JSON-parsed Monday payloads; defensive. */
  return true;
};

/**
 * Returns true when the projected column carries actual data — i.e.,
 * a semantically non-empty wire value (recursive check) or a non-
 * empty human-readable `text`. Empty cells (cleared rich shapes like
 * `{}`, empty arrays, all-null leaves, or empty `text`) aren't worth
 * mapping because Monday wouldn't carry a value across the move
 * anyway.
 *
 * Why both `value` and `text`. Monday returns `text` even for read-
 * only-shaped cells whose structured `value` is null/empty (e.g.
 * `creation_log` rendering "Alice 5 minutes ago"). Either signal
 * counts as "has data" for the unmatched check — agents reading the
 * strict-default error want a precise list of what would be
 * dropped, not noise from empty cells they never touched.
 */
const cellHasData = (col: { readonly value?: unknown; readonly text?: string | null }): boolean => {
  if (typeof col.text === 'string' && col.text.length > 0) return true;
  return valueHasContent(col.value);
};

/**
 * Builds the de-duplicated set of source column IDs the item has a
 * value in (i.e., the columns whose values would be lost without a
 * mapping). The projection includes every wire `column_values` entry
 * — even empty ones — so we filter here per `cellHasData`. Codex
 * round-1 P1 (F1): pre-fix the function returned `Object.keys(source.
 * columns)` and the strict-default check fired for empty unmatched
 * source columns, blocking moves on otherwise-valid boards.
 */
const collectSourceColumnIds = (
  source: ProjectedItem,
): readonly string[] => {
  const ids: string[] = [];
  for (const [id, col] of Object.entries(source.columns)) {
    if (cellHasData(col)) ids.push(id);
  }
  return ids;
};

export const itemMoveCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemMoveOutput
> = {
  name: 'item.move',
  summary:
    'Move an item to a different group (same-board) or board (cross-board)',
  examples: [
    'monday item move 12345 --to-group new_group_id',
    'monday item move 12345 --to-group topics --to-board 67890',
    'monday item move 12345 --to-group topics --to-board 67890 \\',
    "  --columns-mapping '{\"status_4\": \"status_42\"}'",
    'monday item move 12345 --to-group topics --to-board 67890 --dry-run',
  ],
  // Same-board (`move_item_to_group`) is idempotent on Monday's side
  // per cli-design §9.1 — re-running with the item already in the
  // target group is a wire-level no-op. Cross-board
  // (`move_item_to_board`) re-running where the item is already on
  // the target board is undefined SDK behaviour, so the verb-level
  // marker stays `false` conservatively. Mirrors `monday item create`
  // (the verb's idempotency is the conservative bound across all paths).
  idempotent: false,
  inputSchema,
  outputSchema: itemMoveOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('move <itemId>')
      .description(itemMoveCommand.summary)
      .requiredOption(
        '--to-group <gid>',
        'destination group on the target board (or current board for same-board moves)',
      )
      .option(
        '--to-board <bid>',
        'destination board id; without this the move stays on the current board',
      )
      .option(
        '--columns-mapping <json>',
        "JSON {'<source_col_id>': '<target_col_id>'} mapping for cross-board moves; '{}' = drop unmatched (Monday default)",
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemMoveCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, opts: unknown) => {
        // Pre-parse the `--columns-mapping` JSON string before the zod
        // schema runs so the schema sees a typed `ColumnMapping` (not
        // a raw JSON-blob string). `parseColumnMappingJson` raises
        // `usage_error` on malformed JSON, non-object roots, or
        // non-string values per the cli-design §5.3 escape-hatch
        // contract pattern.
        const rawOpts = opts as {
          readonly toGroup?: unknown;
          readonly toBoard?: unknown;
          readonly columnsMapping?: unknown;
        };
        const columnsMapping =
          rawOpts.columnsMapping === undefined
            ? undefined
            : parseColumnMappingJson(rawOpts.columnsMapping);

        const parsed = parseArgv(itemMoveCommand.inputSchema, {
          itemId,
          toGroup: rawOpts.toGroup,
          ...(rawOpts.toBoard === undefined ? {} : { toBoard: rawOpts.toBoard }),
          ...(columnsMapping === undefined ? {} : { columnsMapping }),
        });

        // Cross-board-only flag arrives without `--to-board` — usage
        // error rather than silently dropping the mapping. cli-design
        // §3.1 keeps argv mistakes loud.
        if (parsed.toBoard === undefined && parsed.columnsMapping !== undefined) {
          throw new UsageError(
            '--columns-mapping is only valid with --to-board (cross-board moves)',
            {
              details: {
                hint: 'omit --columns-mapping for same-board moves; for cross-board, add --to-board <bid>',
              },
            },
          );
        }

        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        // Branch on transport. Same-board path: `move_item_to_group`
        // (no metadata loads, no mapping check). Cross-board path:
        // `move_item_to_board` (source + target metadata loads,
        // unmatched check, mapping wire payload).
        if (parsed.toBoard === undefined) {
          await runSameBoardMove({
            ctx,
            program,
            client,
            apiVersion,
            toEmit,
            globalFlags,
            parsed,
          });
        } else {
          await runCrossBoardMove({
            ctx,
            program,
            client,
            apiVersion,
            toEmit,
            globalFlags,
            parsed,
            // Type narrowing — cross-board path requires --to-board.
            toBoard: parsed.toBoard,
          });
        }
      });
  },
};

interface SameBoardMoveInputs {
  readonly ctx: Parameters<typeof emitMutation>[0]['ctx'];
  readonly program: { readonly opts: () => unknown };
  readonly client: ReturnType<typeof resolveClient>['client'];
  readonly apiVersion: string;
  readonly toEmit: ReturnType<typeof resolveClient>['toEmit'];
  readonly globalFlags: ReturnType<typeof parseGlobalFlags>;
  readonly parsed: z.infer<typeof inputSchema>;
}

const runSameBoardMove = async ({
  ctx,
  program,
  client,
  apiVersion,
  toEmit,
  globalFlags,
  parsed,
}: SameBoardMoveInputs): Promise<void> => {
  if (globalFlags.dryRun) {
    // Single-leg dry-run: read the source item via the R27 helper.
    // The §6.4 dry-run shape carries `operation: "move_item_to_group"`,
    // `item_id`, `to_group_id`, and the projected source snapshot so
    // the agent can verify the right item before re-running without
    // `--dry-run`. `meta.source: "live"` because the read fired —
    // mirrors archive/delete/duplicate dry-run shape.
    const projected = await readSourceItemForDryRun({
      client,
      itemId: parsed.itemId,
      operationName: 'ItemMoveRead',
    });
    emitDryRun({
      ctx,
      programOpts: program.opts(),
      plannedChanges: [
        {
          operation: 'move_item_to_group',
          item_id: parsed.itemId,
          to_group_id: parsed.toGroup,
          item: projected,
        },
      ],
      source: 'live',
      cacheAgeSeconds: null,
      warnings: [],
      apiVersion,
    });
    return;
  }

  // Live path: single round-trip. `move_item_to_group` returns the
  // moved item directly. Null result → `not_found` matching the
  // dry-run path's null-handling so agents key off one stable code
  // regardless of which path they took (R28 helper).
  const response = await client.raw<MoveItemToGroupResponse>(
    MOVE_ITEM_TO_GROUP_MUTATION,
    {
      itemId: parsed.itemId,
      groupId: parsed.toGroup,
    },
    { operationName: 'ItemMoveToGroup' },
  );
  const projected = projectMutationItem({
    raw: response.data.move_item_to_group,
    itemId: parsed.itemId,
    errorCode: 'not_found',
    errorMessage: `Monday returned no item from move_item_to_group for id ${parsed.itemId}`,
  });

  emitMutation({
    ctx,
    data: projected,
    schema: itemMoveCommand.outputSchema,
    programOpts: program.opts(),
    warnings: [],
    ...toEmit(response),
    source: 'live',
    cacheAgeSeconds: null,
  });
};

interface CrossBoardMoveInputs extends SameBoardMoveInputs {
  readonly toBoard: string;
}

const runCrossBoardMove = async ({
  ctx,
  program,
  client,
  apiVersion,
  toEmit,
  globalFlags,
  parsed,
  toBoard,
}: CrossBoardMoveInputs): Promise<void> => {
  const sourceAgg = new SourceAggregator();

  // Leg 1: source-item read. Two roles — provides the projected
  // snapshot for the dry-run envelope's `item` slot AND surfaces the
  // source item's column IDs (the keys of `columns`) for the
  // unmatched-column check. Always live (no cache for items).
  const sourceItem = await readSourceItemForDryRun({
    client,
    itemId: parsed.itemId,
    operationName: 'ItemMoveRead',
  });
  sourceAgg.record('live', null);

  // Leg 2: source-board lookup. The source item's projected
  // `board_id` is authoritative (the read just returned it), so we
  // skip a separate `lookupItemBoard` call. The fallback to
  // `lookupItemBoard` only fires if the projection is null/empty —
  // defensive against a future schema change where `board_id` is
  // omitted from the item shape.
  const sourceBoardId =
    sourceItem.board_id ??
    (await lookupItemBoard({ client, itemId: parsed.itemId })).boardId;
  if (sourceItem.board_id === null) {
    // The fallback fired — count it as a live leg.
    sourceAgg.record('live', null);
  }

  // Leg 3 + 4: source + target board metadata. Loaded in parallel
  // because they're independent — the agent waits the slower of the
  // two rather than the sum. Either may hit cache.
  const [sourceMeta, targetMeta] = await Promise.all([
    loadBoardMetadata({ client, boardId: sourceBoardId, env: ctx.env }),
    loadBoardMetadata({ client, boardId: toBoard, env: ctx.env }),
  ]);
  sourceAgg.record(sourceMeta.source, sourceMeta.cacheAgeSeconds);
  sourceAgg.record(targetMeta.source, targetMeta.cacheAgeSeconds);

  // Build the source-columns-by-id map for the unmatched-column
  // detail decoration (so unmatched columns surface with their
  // human-readable title + type, not just IDs).
  const sourceColumnsById = new Map(
    sourceMeta.metadata.columns.map((c) => [
      c.id,
      { id: c.id, title: c.title, type: c.type },
    ] as const),
  );
  const targetColumnIds = new Set(targetMeta.metadata.columns.map((c) => c.id));
  const sourceColumnIds = collectSourceColumnIds(sourceItem);

  // Plan the columns_mapping payload + raise `usage_error` on any
  // unmatched column the agent didn't bridge via `--columns-mapping`.
  // Strict default per cli-design §8 decision 5.
  const plan = planColumnMappings({
    sourceColumnIds,
    sourceColumnsById,
    targetColumnIds,
    mapping: parsed.columnsMapping,
  });

  if (globalFlags.dryRun) {
    emitDryRun({
      ctx,
      programOpts: program.opts(),
      plannedChanges: [
        {
          operation: 'move_item_to_board',
          item_id: parsed.itemId,
          to_board_id: toBoard,
          to_group_id: parsed.toGroup,
          column_mappings: plan.echo,
          item: sourceItem,
        },
      ],
      ...sourceAgg.result(),
      warnings: [],
      apiVersion,
    });
    return;
  }

  // Live path: fire the cross-board mutation. Variables match
  // Monday's `move_item_to_board(item_id, board_id, group_id,
  // columns_mapping)` shape exactly.
  const response = await client.raw<MoveItemToBoardResponse>(
    MOVE_ITEM_TO_BOARD_MUTATION,
    {
      itemId: parsed.itemId,
      boardId: toBoard,
      groupId: parsed.toGroup,
      // Round-2 P2 (F3): the live wire mapping mirrors the dry-run
      // `column_mappings` echo so agents reading the preview see
      // exactly what Monday will receive. The planner always emits
      // an array — verbatim matches surface explicitly, mappings
      // override, empty `--columns-mapping {}` collapses to `[]`
      // (the "drop everything" opt-in). Pre-fix the no-flag case
      // sent `null` and the dry-run echo diverged from the wire
      // payload, weakening the "preview shows what will happen"
      // guarantee.
      columnsMapping: plan.columnsMapping,
    },
    { operationName: 'ItemMoveToBoard' },
  );
  sourceAgg.record('live', null);

  const projected = projectMutationItem({
    raw: response.data.move_item_to_board,
    itemId: parsed.itemId,
    errorCode: 'not_found',
    errorMessage: `Monday returned no item from move_item_to_board for id ${parsed.itemId}`,
  });

  emitMutation({
    ctx,
    data: projected,
    schema: itemMoveCommand.outputSchema,
    programOpts: program.opts(),
    warnings: [],
    ...toEmit(response),
    ...sourceAgg.result(),
  });
};

// Re-export for unit tests.
export { cellHasData, collectSourceColumnIds, planColumnMappings };
