/**
 * `monday item create` — create a new item or subitem
 * (`cli-design.md` §4.3 + §5.3 + §5.8 + §6.4 "Item-create shape",
 * `v0.2-plan.md` §3 M9).
 *
 * Two argv shapes the dispatch picks between:
 *
 *   1. **Top-level** — `--board <bid> --name <n>` mandatory; optional
 *      `--group`, `--position before|after --relative-to <iid>`,
 *      `--set`, `--set-raw`. Calls `create_item`. Resolves columns
 *      against `--board`'s metadata.
 *
 *   2. **Subitem** — `--parent <iid> --name <n>` mandatory; `--set` /
 *      `--set-raw` optional. `--board`, `--group`, and
 *      `--position` / `--relative-to` are **rejected** here — subitems
 *      live on Monday's auto-generated subitems board (not in groups,
 *      not relative to arbitrary items, not on a caller-named board).
 *      Calls `create_subitem`. Resolves columns against the
 *      subitems-board's metadata (derived from the parent's
 *      `subtasks` column's `settings_str.boardIds[0]`). Multi-level
 *      boards (`hierarchy_type: "multi_level"`) are rejected with
 *      `usage_error` — multi-level subitem support is deferred to
 *      v0.3 because the column-resolution path here assumes the
 *      classic auto-generated-subitems-board model.
 *
 * **Single round-trip** (cli-design §5.8 — hard exit gate). Every
 * translated `--set` / `--set-raw` value bundles into one
 * `create_item.column_values` (or `create_subitem.column_values`)
 * parameter via `bundleColumnValues`; the CLI does **not** fall back
 * to `create_item` + `change_multiple_column_values` on partial
 * failure. Monday's server-side rejection of any value fails the
 * whole mutation, and no item is created — agents retry with the
 * value fixed.
 *
 * **`--position` / `--relative-to` cross-validation.** Both flags
 * are required together (one without the other → `usage_error`).
 * `--relative-to` must reference an item on the same board (mirrors
 * the M5b wrong-board check).
 *
 * **Mutation envelope** (cli-design §6.4 + §5.3 step 2). `data: {id,
 * name, board_id, group_id, parent_id?}` with the top-level
 * `resolved_ids` echo (token → resolved column ID) for every `--set`
 * / `--set-raw` token the agent supplied. `parent_id` is present
 * only on the subitem path.
 *
 * **Idempotent: false.** Re-running with the same args creates a
 * second item. Agents needing idempotent create-or-update use
 * `monday item upsert` (M12).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, MondayCliError, UsageError } from '../../utils/errors.js';
import type { ResolverWarning } from '../../api/columns.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';
import {
  bundleColumnValues,
  type TranslatedColumnValue,
} from '../../api/column-values.js';
import {
  parseSetRawExpression,
  type ParsedSetRawExpression,
} from '../../api/raw-write.js';
import { splitSetExpression } from '../../api/set-expression.js';
import { buildResolutionContexts } from '../../api/resolution-context.js';
import {
  lookupItemBoard,
  lookupItemBoardWithHierarchy,
} from '../../api/item-board-lookup.js';
import {
  mergeSource,
  mergeSourceWithPreflight,
  mergeCacheAge,
} from '../../api/source-aggregator.js';
import { resolveAndTranslate } from '../../api/resolution-pass.js';
import { foldAndRemap } from '../../api/resolver-error-fold.js';
import { planCreate, type CreateMode } from '../../api/dry-run.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import type { Warning } from '../../utils/output/envelope.js';

// ============================================================
// GraphQL mutations. The parent lookup + relative-to lookup queries
// live in api/item-board-lookup.ts (R23 lift).
// ============================================================

const CREATE_ITEM_MUTATION = `
  mutation ItemCreateTopLevel(
    $boardId: ID!
    $itemName: String!
    $groupId: String
    $columnValues: JSON
    $createLabelsIfMissing: Boolean
    $positionRelativeMethod: PositionRelative
    $relativeTo: ID
  ) {
    create_item(
      board_id: $boardId
      item_name: $itemName
      group_id: $groupId
      column_values: $columnValues
      create_labels_if_missing: $createLabelsIfMissing
      position_relative_method: $positionRelativeMethod
      relative_to: $relativeTo
    ) {
      id
      name
      board { id }
      group { id }
    }
  }
`;

const CREATE_SUBITEM_MUTATION = `
  mutation ItemCreateSubitem(
    $parentItemId: ID!
    $itemName: String!
    $columnValues: JSON
    $createLabelsIfMissing: Boolean
  ) {
    create_subitem(
      parent_item_id: $parentItemId
      item_name: $itemName
      column_values: $columnValues
      create_labels_if_missing: $createLabelsIfMissing
    ) {
      id
      name
      board { id }
      group { id }
      parent_item { id }
    }
  }
`;

// ============================================================
// Wire response zod schemas (parse-boundary discipline, R18).
// ============================================================

// Per cli-design §6.4: data shape carries id, name, board_id,
// group_id (nullable when Monday returns no group — defensive,
// shouldn't happen in practice), parent_id (subitems only). The
// projector below maps Monday's nested response into this flat shape.
const itemCreateOutputSchema = z.object({
  id: ItemIdSchema,
  name: z.string(),
  board_id: BoardIdSchema,
  group_id: z.string().nullable(),
  parent_id: ItemIdSchema.optional(),
});
export type ItemCreateOutput = z.infer<typeof itemCreateOutputSchema>;

const createItemResponseSchema = z
  .object({
    id: ItemIdSchema,
    name: z.string(),
    board: z.object({ id: BoardIdSchema }).nullable(),
    group: z.object({ id: z.string() }).nullable(),
  })
  .loose();

const createSubitemResponseSchema = createItemResponseSchema.extend({
  parent_item: z.object({ id: ItemIdSchema }).nullable(),
});

interface CreateItemResponse {
  readonly create_item: unknown;
}
interface CreateSubitemResponse {
  readonly create_subitem: unknown;
}

// ============================================================
// Input zod schema + dispatch.
// ============================================================

const positionEnum = z.enum(['before', 'after']);

const inputSchema = z
  .object({
    name: z.string().refine((s) => s.trim().length > 0, {
      message: '--name must be non-empty (whitespace-only is rejected)',
    }),
    board: BoardIdSchema.optional(),
    group: z.string().min(1).optional(),
    set: z.array(z.string()).default([]),
    setRaw: z.array(z.string()).default([]),
    parent: ItemIdSchema.optional(),
    position: positionEnum.optional(),
    relativeTo: ItemIdSchema.optional(),
    createLabelsIfMissing: z.boolean().optional(),
  })
  .strict();

type ParsedInput = z.infer<typeof inputSchema>;

type DispatchShape =
  | {
      readonly kind: 'item';
      readonly boardId: string;
      readonly groupId: string | undefined;
      readonly position:
        | { readonly method: 'before' | 'after'; readonly relativeTo: string }
        | undefined;
    }
  | {
      readonly kind: 'subitem';
      readonly parentItemId: string;
    };

/**
 * Validates the cross-flag mutex / required-together rules per
 * cli-design §4.3 line 519-528 and the §6.4 subitem variant. Throws
 * `usage_error` with structured details so an agent can correct
 * either flag without re-reading help text.
 */
const validateInputShape = (parsed: ParsedInput): DispatchShape => {
  const hasParent = parsed.parent !== undefined;
  const hasGroup = parsed.group !== undefined;
  const hasPosition = parsed.position !== undefined;
  const hasRelativeTo = parsed.relativeTo !== undefined;

  // --position and --relative-to are required together (one without
  // the other → usage_error). Catch BEFORE the parent / position
  // mutex so an agent passing `--parent --position` sees the
  // pairing-incomplete error rather than the parent-mutex one.
  if (hasPosition !== hasRelativeTo) {
    throw new UsageError(
      '--position and --relative-to are required together. ' +
        'Pass both (e.g. `--position before --relative-to 99999`) ' +
        'or neither.',
      {
        details: {
          ...(parsed.position === undefined ? {} : { position: parsed.position }),
          ...(parsed.relativeTo === undefined
            ? {}
            : { relative_to: parsed.relativeTo }),
        },
      },
    );
  }

  if (hasParent) {
    // --parent is mutex with --group, --position/--relative-to, and
    // --board. Subitems live on Monday's auto-generated subitems
    // board (not in groups, not relative to arbitrary items, not on
    // a caller-named board) — accepting any of these would silently
    // drop the value and create the subitem in the default location.
    // Failing fast keeps the mental model clean.
    if (hasGroup) {
      throw new UsageError(
        '--parent is mutually exclusive with --group. Subitems live ' +
          'on Monday\'s auto-generated subitems board, not in groups; ' +
          'drop --group or remove --parent.',
        { details: { parent: parsed.parent, group: parsed.group } },
      );
    }
    if (hasPosition) {
      throw new UsageError(
        '--parent is mutually exclusive with --position / --relative-to. ' +
          'Subitem position is parent-scoped, not relative to an arbitrary ' +
          'item; drop --position / --relative-to or remove --parent.',
        {
          details: {
            parent: parsed.parent,
            position: parsed.position,
            relative_to: parsed.relativeTo,
          },
        },
      );
    }
    if (parsed.board !== undefined) {
      throw new UsageError(
        '--parent is mutually exclusive with --board. The subitems board ' +
          'is derived server-side from the parent; passing --board would ' +
          'be ignored. Drop --board or remove --parent.',
        { details: { parent: parsed.parent, board: parsed.board } },
      );
    }
    // hasParent === true ⇒ parsed.parent !== undefined (the
    // discriminator at the top of validateInputShape). TypeScript
    // doesn't narrow across the let-check pattern, so we capture
    // a non-undefined local for the dispatch payload.
    /* c8 ignore next 3 — defensive: hasParent fires only when the
       parent slot is set; the throw is unreachable. */
    if (parsed.parent === undefined) {
      throw new UsageError('item create: parent narrowing failed');
    }
    return { kind: 'subitem', parentItemId: parsed.parent };
  }

  // Top-level path — --board is required.
  if (parsed.board === undefined) {
    throw new UsageError(
      '--board <bid> is required for top-level item create. (Pass ' +
        '--parent <iid> instead to create a subitem.)',
      { details: {} },
    );
  }

  // Pre-flight: same-token duplicate in --set entries (resolution-
  // free, fail-fast before any wire call). Cross-token duplicates
  // and same-column-after-resolution dups surface in planCreate /
  // the live three-pass resolver per cli-design §5.3 step 2.
  // Same check is mirrored in subitem path (no early return).
  // Implementation note: deferred the same-token check to a shared
  // helper after dispatch returned to keep validateInputShape
  // dispatch-only.
  // Position narrowing: hasPosition && hasRelativeTo means both are
  // defined (the `!==` undefined guards above) — capture into locals
  // so TypeScript narrows away the `| undefined` slot rather than
  // needing non-null assertions.
  const position =
    parsed.position !== undefined && parsed.relativeTo !== undefined
      ? { method: parsed.position, relativeTo: parsed.relativeTo }
      : undefined;
  return {
    kind: 'item',
    boardId: parsed.board,
    groupId: parsed.group,
    position,
  };
};

/**
 * Pre-flight same-token check for `--set` and `--set-raw`. Catches
 * the obvious case (`--set status=Done --set status=Doing`) without
 * needing column resolution, so a malformed multi-`--set` fails
 * before the network. The cross-token duplicate-resolved-id check
 * still runs in planCreate / the live path (per cli-design §5.3 step
 * 2 — the contract is resolution-time, but the pre-flight catches
 * the easy half cheap).
 */
const checkDuplicateTokens = (
  setEntries: readonly { readonly token: string }[],
  rawEntries: readonly { readonly token: string }[],
): void => {
  const seen = new Set<string>();
  for (const e of [...setEntries, ...rawEntries]) {
    if (seen.has(e.token)) {
      throw new UsageError(
        `Multiple --set / --set-raw entries target column token ` +
          `${JSON.stringify(e.token)}. Pass at most one per column; if two ` +
          `tokens resolve to the same column ID after NFC + case-fold ` +
          `normalisation, use the \`id:<column_id>\` prefix to disambiguate.`,
        { details: { token: e.token } },
      );
    }
    seen.add(e.token);
  }
};

// ============================================================
// Subitem-path helpers.
// ============================================================

/**
 * Looks up the parent item's board id + `hierarchy_type` so the
 * multi-level gate can fire pre-mutation. Wraps the shared
 * `lookupItemBoardWithHierarchy` helper with the parent-item label
 * + detail key.
 */
const lookupParent = async (
  client: MondayClient,
  parentItemId: string,
): Promise<{ boardId: string; hierarchyType: string | null }> => {
  const result = await lookupItemBoardWithHierarchy({
    client,
    itemId: parentItemId,
    label: 'Parent item',
    detailKey: 'parent_item_id',
  });
  return {
    boardId: result.boardId,
    hierarchyType: result.hierarchyType,
  };
};

/**
 * Derives the auto-generated subitems board ID from the parent
 * board's `subtasks` column. Monday's classic-board model exposes
 * the subitems board through the `subtasks` column's
 * `settings_str.boardIds[0]`. When the column is missing or the
 * settings are empty / malformed, the CLI surfaces `usage_error` —
 * the parent's board doesn't have a subitems lane provisioned, so
 * Monday's server-side `create_subitem` would either fail or auto-
 * provision in a way the CLI can't predict for column resolution.
 *
 * The agent's recovery path: drop `--set` / `--set-raw` (subitem
 * still creates without column resolution) or use `--set-raw` on
 * a `id:<col_id>` token (still requires resolution; the same gate
 * fires).
 */
const deriveSubitemsBoardId = (
  parentMetadata: {
    readonly columns: readonly {
      readonly id: string;
      readonly type: string;
      readonly settings_str: string | null;
    }[];
  },
  parentItemId: string,
  parentBoardId: string,
): string => {
  const subtasksColumn = parentMetadata.columns.find(
    (c) => c.type === 'subtasks',
  );
  if (subtasksColumn === undefined) {
    throw new UsageError(
      `Parent board ${parentBoardId} has no subtasks column; the subitems ` +
        `board for column resolution can't be derived. Either remove --set ` +
        `/ --set-raw (subitem still creates without column resolution), or ` +
        `add a subitems column to the parent's board first.`,
      {
        details: {
          parent_item_id: parentItemId,
          parent_board_id: parentBoardId,
        },
      },
    );
  }
  if (subtasksColumn.settings_str === null) {
    throw new UsageError(
      `Parent board ${parentBoardId}'s subtasks column has no settings; ` +
        `the subitems board ID can't be derived. Either remove --set / ` +
        `--set-raw (subitem still creates without column resolution), or ` +
        `re-run after the parent has at least one existing subitem so ` +
        `Monday provisions the subitems board.`,
      {
        details: {
          parent_item_id: parentItemId,
          parent_board_id: parentBoardId,
          subtasks_column_id: subtasksColumn.id,
        },
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(subtasksColumn.settings_str);
  } catch {
    parsed = null;
  }
  const boardIds =
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as { boardIds?: unknown }).boardIds)
      ? ((parsed as { boardIds: unknown[] }).boardIds.filter(
          (id): id is string => typeof id === 'string',
        ) as readonly string[])
      : ([] as readonly string[]);
  const subitemsBoardId = boardIds[0];
  if (subitemsBoardId === undefined) {
    throw new UsageError(
      `Parent board ${parentBoardId}'s subtasks column has no linked ` +
        `subitems board yet; create one subitem on the parent first (which ` +
        `provisions the subitems board) and re-run, or drop --set / ` +
        `--set-raw on this call.`,
      {
        details: {
          parent_item_id: parentItemId,
          parent_board_id: parentBoardId,
          subtasks_column_id: subtasksColumn.id,
        },
      },
    );
  }
  return subitemsBoardId;
};

/**
 * Verifies a `--relative-to` item lives on the same board as the
 * top-level create's `--board <bid>`. Mirrors the M5b wrong-board
 * check (`item set` / `item update`) shape — surfaces `usage_error`
 * with `requested_board_id` + `item_board_id` in details so the
 * agent can self-correct.
 */
const verifyRelativeToOnBoard = async (
  client: MondayClient,
  relativeToId: string,
  boardId: string,
): Promise<void> => {
  const result = await lookupItemBoard({
    client,
    itemId: relativeToId,
    label: '--relative-to item',
    detailKey: 'relative_to_id',
  });
  if (result.boardId !== boardId) {
    throw new UsageError(
      `--relative-to item ${relativeToId} lives on board ${result.boardId}, ` +
        `but --board is ${boardId}. Pass a --relative-to item on the same ` +
        `board, or drop --position / --relative-to.`,
      {
        details: {
          relative_to_id: relativeToId,
          item_board_id: result.boardId,
          requested_board_id: boardId,
        },
      },
    );
  }
};

// ============================================================
// Create-mode resolver — the orchestrator's single entry point
// into "given a parsed argv + dispatch, what's the CreateMode for
// the dry-run engine and the live mutation?"
// ============================================================

interface ResolveCreateModeInputs {
  readonly client: MondayClient;
  readonly dispatch: DispatchShape;
  readonly setEntries: readonly { readonly token: string }[];
  readonly rawEntries: readonly { readonly token: string }[];
  readonly env: NodeJS.ProcessEnv;
  readonly noCache: boolean;
}

/**
 * Result of `resolveCreateMode`. Carries the dispatch-ready
 * `CreateMode` PLUS the per-leg source / cacheAge from the
 * pre-planner network calls (parent lookup, parent-board metadata
 * for subitems-board derivation, --relative-to verification). The
 * action layer folds these into the final envelope source so a
 * `meta.source: "none"` claim never lies about a parent lookup or
 * metadata fetch that already fired (Codex M9 P2 #1).
 */
interface ResolveCreateModeResult {
  readonly mode: CreateMode;
  /**
   * Source contribution from the pre-planner legs:
   *   - subitem path: parent lookup is always live; parent-board
   *     metadata leg may be cache or live (when `--set` is supplied).
   *   - top-level path: --relative-to verification is always live
   *     (when `--position` is supplied); otherwise undefined.
   *
   * `undefined` when no pre-planner network leg fired (e.g. top-level
   * with no `--position`).
   */
  readonly preflightSource: 'live' | 'cache' | 'mixed' | undefined;
  /**
   * Worst-case cache age across pre-planner legs (currently only the
   * parent-board metadata fetch can be cache-served). `null` when
   * every pre-planner leg was live or none fired.
   */
  readonly preflightCacheAgeSeconds: number | null;
}

/**
 * Builds the `CreateMode` (dry-run engine + live path consume the
 * same shape) from the dispatch result. Three orchestration steps
 * for the subitem path:
 *
 *   1. Look up parent item → get parent's board id + `hierarchy_type`.
 *   2. Reject `multi_level` boards (M9 supports classic only).
 *   3. If `--set` / `--set-raw` is present, load parent's BoardMetadata
 *      → find `subtasks` column → derive subitems-board id from
 *      `settings_str.boardIds[0]`.
 *
 * For top-level: verifies the `--relative-to` item lives on `--board`
 * when `--position` is set (mirrors M5b's wrong-board check).
 *
 * Pure orchestrator — no side-effects beyond the network calls and
 * the cache writes inside `loadBoardMetadata`. Throws typed errors
 * (`usage_error` / `not_found`) per the cli-design §6.5 surface.
 */
const resolveCreateMode = async (
  inputs: ResolveCreateModeInputs,
): Promise<ResolveCreateModeResult> => {
  const { client, dispatch, setEntries, rawEntries, env, noCache } = inputs;
  if (dispatch.kind === 'subitem') {
    // Parent lookup is always live (no item-level cache in v0.2).
    const parent = await lookupParent(client, dispatch.parentItemId);
    if (parent.hierarchyType === 'multi_level') {
      throw new UsageError(
        `Parent item ${dispatch.parentItemId} lives on a multi-level ` +
          `board (hierarchy_type "multi_level"); subitem creation on ` +
          `multi-level boards is deferred to v0.3. Use a classic ` +
          `board (hierarchy_type null/"classic") or wait for v0.3.`,
        {
          details: {
            parent_item_id: dispatch.parentItemId,
            parent_board_id: parent.boardId,
            hierarchy_type: parent.hierarchyType,
            deferred_to: 'v0.3',
          },
        },
      );
    }
    if (setEntries.length > 0 || rawEntries.length > 0) {
      const parentMetadata = await loadBoardMetadata({
        client,
        boardId: parent.boardId,
        env,
        noCache,
      });
      const subitemsBoardId = deriveSubitemsBoardId(
        parentMetadata.metadata,
        dispatch.parentItemId,
        parent.boardId,
      );
      // Parent lookup is always live; parent metadata may be cache
      // or live. Merge the two so the final envelope reflects both
      // pre-planner legs (Codex M9 P2 #1). The 'cache' branch fires
      // when the metadata cache is pre-warmed by a prior call within
      // the TTL window — covered by item set / item update tests for
      // the broader cache plumbing; M9 inherits the tested helper
      // and pins the non-cache branch via the integration tests.
      /* c8 ignore next 2 — cache pre-warming for the parent-board
         metadata leg needs a multi-call XDG_CACHE_HOME setup that's
         covered for the same `loadBoardMetadata` helper in item set
         / item update tests; M9 inherits the helper's coverage. */
      const parentSource: 'live' | 'mixed' =
        parentMetadata.source === 'cache' ? 'mixed' : 'live';
      return {
        mode: {
          kind: 'subitem',
          parentItemId: dispatch.parentItemId,
          subitemsBoardId,
        },
        preflightSource: parentSource,
        preflightCacheAgeSeconds: parentMetadata.cacheAgeSeconds,
      };
    }
    // No --set / --set-raw → no column resolution needed. Reuse
    // parent's board id as the placeholder (subitemsBoardId is
    // unused when both arrays are empty per planCreate's no-set
    // short-circuit and the live path's resolution loop).
    // Parent lookup was live; no metadata leg fired.
    return {
      mode: {
        kind: 'subitem',
        parentItemId: dispatch.parentItemId,
        subitemsBoardId: parent.boardId,
      },
      preflightSource: 'live',
      preflightCacheAgeSeconds: null,
    };
  }
  // top-level
  if (dispatch.position !== undefined) {
    await verifyRelativeToOnBoard(
      client,
      dispatch.position.relativeTo,
      dispatch.boardId,
    );
    return {
      mode: {
        kind: 'item',
        boardId: dispatch.boardId,
        ...(dispatch.groupId === undefined ? {} : { groupId: dispatch.groupId }),
        position: dispatch.position,
      },
      // --relative-to verification is always live; no cache leg.
      preflightSource: 'live',
      preflightCacheAgeSeconds: null,
    };
  }
  return {
    mode: {
      kind: 'item',
      boardId: dispatch.boardId,
      ...(dispatch.groupId === undefined ? {} : { groupId: dispatch.groupId }),
    },
    // No pre-planner network leg.
    preflightSource: undefined,
    preflightCacheAgeSeconds: null,
  };
};

// ============================================================
// Main command export.
// ============================================================

export const itemCreateCommand: CommandModule<
  ParsedInput,
  ItemCreateOutput
> = {
  name: 'item.create',
  summary: 'Create a new item or subitem',
  examples: [
    'monday item create --board 67890 --name "Refactor login"',
    'monday item create --board 67890 --name "Refactor login" --group topics',
    'monday item create --board 67890 --name "Refactor login" --set status=Done',
    'monday item create --board 67890 --name "Refactor login" --set status=Done --set due=+1w',
    'monday item create --board 67890 --name "Refactor login" --position before --relative-to 99999',
    'monday item create --parent 12345 --name "Subtask 1"',
    'monday item create --parent 12345 --name "Subtask 1" --set status=Working',
    'monday item create --board 67890 --name "Refactor login" --dry-run --json',
  ],
  // Re-running creates a duplicate item; agents needing idempotent
  // create-or-update use `monday item upsert` (M12).
  idempotent: false,
  inputSchema,
  outputSchema: itemCreateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('create')
      .description(itemCreateCommand.summary)
      .requiredOption('--name <n>', 'item name (required, non-empty)')
      .option('--board <bid>', 'board ID (required for top-level; rejected with --parent)')
      .option('--group <gid>', 'group ID (top-level only; default = board\'s default group)')
      .option(
        '--set <expr>',
        'repeatable <col>=<val> column write (bundled into create_item.column_values)',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option(
        '--set-raw <expr>',
        'repeatable <col>=<json> raw write (escape hatch — bypasses friendly translator)',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option('--parent <iid>', 'create as subitem of this parent item ID')
      .option('--position <method>', 'item placement: "before" | "after" (requires --relative-to)')
      .option('--relative-to <iid>', 'item ID for --position; must be on the same board')
      .option(
        '--create-labels-if-missing',
        'auto-create unknown status / dropdown labels (Monday flag)',
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemCreateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(itemCreateCommand.inputSchema, {
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        const dispatch = validateInputShape(parsed);

        // Argv-parse-time failures fire BEFORE any network call —
        // splits run on pure strings, JSON parse on `--set-raw` runs
        // on pure strings. Mirrors the M8 `item update` finding (#4):
        // a malformed `--set-raw` shouldn't pay for a parent / board
        // / metadata round-trip first.
        const setEntries = parsed.set.map(splitSetExpression);
        const rawEntries: readonly ParsedSetRawExpression[] = parsed.setRaw.map(
          parseSetRawExpression,
        );
        checkDuplicateTokens(setEntries, rawEntries);

        // Resolve the create context: a single `createMode` that
        // both the dry-run engine and the live mutation consume. For
        // top-level, it's the verified `--board` plus optional
        // group / position. For subitem, it's the parent item id +
        // the derived subitems-board id (used for column resolution).
        // Building it once avoids a let-assignment pattern that
        // forced non-null assertions later.
        //
        // The result also carries `preflightSource` /
        // `preflightCacheAgeSeconds` for the parent-lookup +
        // parent-metadata + relative-to-verification legs that fire
        // before planCreate / live mutation (Codex M9 P2 #1). These
        // fold into the final envelope source so a `meta.source`
        // claim never lies about a network leg that fired.
        const createModeResult = await resolveCreateMode({
          client,
          dispatch,
          setEntries,
          rawEntries,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });
        const createMode = createModeResult.mode;
        const resolveBoardId =
          createMode.kind === 'subitem'
            ? createMode.subitemsBoardId
            : createMode.boardId;

        const { dateResolution, peopleResolution } = buildResolutionContexts(
          { client, ctx, globalFlags },
        );

        if (globalFlags.dryRun) {
          const result = await planCreate({
            client,
            mode: createMode,
            name: parsed.name,
            setEntries,
            ...(rawEntries.length === 0 ? {} : { rawEntries }),
            dateResolution,
            peopleResolution,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          // Dry-run envelope source folds three legs (Codex M9 P2 #1):
          // pre-planner network calls (parent lookup + parent-board
          // metadata + --relative-to verification) + planCreate's
          // column-resolution legs. `meta.source: "none"` is only
          // accurate when ZERO wire calls fired.
          const dryRunSource = mergeSourceWithPreflight(
            result.source,
            createModeResult.preflightSource,
          );
          const dryRunCacheAge = mergeCacheAge(
            result.cacheAgeSeconds,
            createModeResult.preflightCacheAgeSeconds,
          );
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges:
              result.plannedChanges as unknown as readonly Readonly<
                Record<string, unknown>
              >[],
            source: dryRunSource,
            cacheAgeSeconds: dryRunCacheAge,
            warnings: result.warnings,
            apiVersion,
          });
          return;
        }

        // Live create path. Three-pass resolution + translation
        // through the shared helper (R20 lift), then bundle into one
        // column_values map and fire the single-round-trip mutation
        // per cli-design §5.8.
        const resolutionResult = await resolveAndTranslate({
          client,
          boardId: resolveBoardId,
          setEntries,
          rawEntries,
          dateResolution,
          peopleResolution,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });
        const collectedWarnings: ResolverWarning[] = [
          ...resolutionResult.warnings,
        ];
        const resolvedIds = resolutionResult.resolvedIds;
        const aggregateSource: 'live' | 'cache' | 'mixed' | undefined =
          resolutionResult.source;
        const aggregateCacheAge: number | null =
          resolutionResult.cacheAgeSeconds;
        const translated: readonly TranslatedColumnValue[] =
          resolutionResult.translated;

        // Bundle into the column_values map (single-round-trip per
        // cli-design §5.8). When zero translated values, send `null`
        // so Monday's create accepts "no column values" rather than
        // an empty map (semantically distinct on Monday's wire).
        const columnValues =
          translated.length === 0 ? null : bundleColumnValues(translated);

        let mutationResult;
        try {
          if (createMode.kind === 'subitem') {
            mutationResult = await executeCreateSubitem(client, {
              parentItemId: createMode.parentItemId,
              itemName: parsed.name,
              columnValues,
              createLabelsIfMissing: parsed.createLabelsIfMissing,
            });
          } else {
            mutationResult = await executeCreateItem(client, {
              boardId: createMode.boardId,
              itemName: parsed.name,
              groupId: createMode.groupId,
              position: createMode.position,
              columnValues,
              createLabelsIfMissing: parsed.createLabelsIfMissing,
            });
          }
        } catch (err) {
          if (err instanceof MondayCliError) {
            // F4 remap: cache-sourced resolution + Monday rejecting
            // as validation_failed → check live archived state.
            // Codex M9 P1: pre-fix the create path skipped this
            // catch arm on the assumption that the explicit archived
            // gate above (`includeArchived: true` + throw) covered
            // every case. It doesn't — cache can say "active" after
            // Monday archived the column post-cache-write. Pass
            // every translated column ID (M5b finding #3) so
            // multi-`--set` cases where a later target is archived
            // still remap.
            throw await foldAndRemap({
              err,
              warnings: collectedWarnings,
              client,
              boardId: resolveBoardId,
              columnIds: translated.map((t) => t.columnId),
              env: ctx.env,
              noCache: globalFlags.noCache,
              resolutionSource: aggregateSource ?? 'live',
            });
          }
          throw err;
        }

        const warnings: readonly Warning[] = collectedWarnings;
        // Final source folds four legs (Codex M9 P2 #1): pre-planner
        // network calls (parent lookup + parent metadata + relative-
        // to) → column resolution legs → mutation (always live).
        // The live path never sees a 'none' source (the mutation leg
        // is always live), so we merge through the leg-aware helper.
        let liveSource: 'live' | 'cache' | 'mixed' | undefined =
          aggregateSource;
        if (createModeResult.preflightSource !== undefined) {
          liveSource = mergeSource(
            liveSource,
            createModeResult.preflightSource,
          );
        }
        const finalSource: 'live' | 'cache' | 'mixed' = mergeSource(
          liveSource,
          'live',
        );
        // Cache age folds preflight worst-case staleness too.
        const finalCacheAge = mergeCacheAge(
          aggregateCacheAge,
          createModeResult.preflightCacheAgeSeconds,
        );
        emitMutation({
          ctx,
          data: mutationResult.projected,
          schema: itemCreateCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(mutationResult.response),
          source: finalSource,
          cacheAgeSeconds: finalCacheAge,
          // cli-design §5.3 step 2 / §6.4: echo the resolved column
          // IDs so an agent's "create then re-read" loop can use the
          // resolved IDs without consulting metadata twice. Empty map
          // when no `--set` / `--set-raw` was passed (mirrors item
          // update with no resolved columns).
          resolvedIds,
        });
      });
  },
};

// ============================================================
// Mutation execution helpers.
// ============================================================

interface CreateItemMutationResult {
  readonly projected: ItemCreateOutput;
  readonly response: MondayResponse<unknown>;
}

interface CreateItemInputs {
  readonly boardId: string;
  readonly itemName: string;
  readonly groupId: string | undefined;
  readonly position:
    | { readonly method: 'before' | 'after'; readonly relativeTo: string }
    | undefined;
  readonly columnValues: Readonly<Record<string, unknown>> | null;
  readonly createLabelsIfMissing: boolean | undefined;
}

const executeCreateItem = async (
  client: MondayClient,
  inputs: CreateItemInputs,
): Promise<CreateItemMutationResult> => {
  const variables: Record<string, unknown> = {
    boardId: inputs.boardId,
    itemName: inputs.itemName,
    groupId: inputs.groupId ?? null,
    columnValues: inputs.columnValues,
    createLabelsIfMissing: inputs.createLabelsIfMissing ?? false,
  };
  if (inputs.position !== undefined) {
    // Monday's PositionRelative enum string values are `before_at` /
    // `after_at`; the CLI surfaces friendlier `before` / `after` per
    // cli-design §4.3, mapped here at the wire boundary.
    variables.positionRelativeMethod =
      inputs.position.method === 'before' ? 'before_at' : 'after_at';
    variables.relativeTo = inputs.position.relativeTo;
  } else {
    variables.positionRelativeMethod = null;
    variables.relativeTo = null;
  }
  const response = await client.raw<CreateItemResponse>(
    CREATE_ITEM_MUTATION,
    variables,
    { operationName: 'ItemCreateTopLevel' },
  );
  if (response.data.create_item === null || response.data.create_item === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned no item payload from create_item.`,
      { details: { board_id: inputs.boardId, item_name: inputs.itemName } },
    );
  }
  const parsed = unwrapOrThrow(
    createItemResponseSchema.safeParse(response.data.create_item),
    {
      context: 'Monday returned a malformed create_item response',
      details: { board_id: inputs.boardId },
    },
  );
  // Defensive: Monday's create_item always returns a board { id } per
  // its schema, but the response schema admits null to keep the parse
  // boundary tolerant of API drift. Fall back to the requested board
  // id (re-parsed through BoardIdSchema to satisfy the brand) so the
  // projected envelope keeps a non-null board_id even on the rare
  // null-board response path.
  return {
    projected: {
      id: parsed.id,
      name: parsed.name,
      board_id: parsed.board?.id ?? BoardIdSchema.parse(inputs.boardId),
      group_id: parsed.group?.id ?? null,
    },
    response,
  };
};

interface CreateSubitemInputs {
  readonly parentItemId: string;
  readonly itemName: string;
  readonly columnValues: Readonly<Record<string, unknown>> | null;
  readonly createLabelsIfMissing: boolean | undefined;
}

const executeCreateSubitem = async (
  client: MondayClient,
  inputs: CreateSubitemInputs,
): Promise<CreateItemMutationResult> => {
  const response = await client.raw<CreateSubitemResponse>(
    CREATE_SUBITEM_MUTATION,
    {
      parentItemId: inputs.parentItemId,
      itemName: inputs.itemName,
      columnValues: inputs.columnValues,
      createLabelsIfMissing: inputs.createLabelsIfMissing ?? false,
    },
    { operationName: 'ItemCreateSubitem' },
  );
  if (
    response.data.create_subitem === null ||
    response.data.create_subitem === undefined
  ) {
    throw new ApiError(
      'internal_error',
      `Monday returned no item payload from create_subitem.`,
      {
        details: {
          parent_item_id: inputs.parentItemId,
          item_name: inputs.itemName,
        },
      },
    );
  }
  const parsed = unwrapOrThrow(
    createSubitemResponseSchema.safeParse(response.data.create_subitem),
    {
      context: 'Monday returned a malformed create_subitem response',
      details: { parent_item_id: inputs.parentItemId },
    },
  );
  if (parsed.board === null) {
    throw new ApiError(
      'internal_error',
      `Monday returned no board for the new subitem.`,
      { details: { parent_item_id: inputs.parentItemId } },
    );
  }
  // Always populate `parent_id` from argv — the CLI knows the
  // parent ID it just sent on the wire, so omitting it when Monday
  // returns `parent_item: null` would create a documented-shape
  // drift (output-shapes.md subitem section pins parent_id as
  // present). Codex M9 P2 #3.
  return {
    projected: {
      id: parsed.id,
      name: parsed.name,
      board_id: parsed.board.id,
      group_id: parsed.group?.id ?? null,
      // Re-parse through ItemIdSchema to satisfy the brand;
      // `inputs.parentItemId` is plain `string` from the input
      // shape but this slot needs the branded type.
      parent_id: ItemIdSchema.parse(inputs.parentItemId),
    },
    response,
  };
};

