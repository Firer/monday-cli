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
 * **Single round-trip on the JSON-only path** (cli-design §5.8 —
 * hard exit gate). Every translated non-file `--set` / `--set-raw`
 * value bundles into one `create_item.column_values` (or
 * `create_subitem.column_values`) parameter via `bundleColumnValues`;
 * the CLI does **not** fall back to `create_item` +
 * `change_multiple_column_values` on partial failure. Monday's
 * server-side rejection of any value fails the whole mutation, and
 * no item is created — agents retry with the value fixed.
 *
 * **Two-leg dispatch on the create-time file `--set` carve-out
 * (v0.7-M43 D6 fold).** When any `--set <file-col>=<path>` is
 * present, the action body partitions setEntries (non-file →
 * leg-1's `column_values`; file → leg-2) and routes through
 * `runItemCreateFileDispatch`: leg-1 `create_item` (or
 * `create_subitem`) bundles the non-file column_values atomically;
 * leg-2 `add_file_to_column` attaches the file via M31's multipart
 * wire (reused verbatim through M38's `executeFileColumnSet`). The
 * pair is non-atomic by construction; leg-2 failure surfaces
 * `internal_error` with `details.reason:
 * 'create_then_file_upload_partial_failure'` + `details.cause` +
 * `details.created_item_id` echoing the orphan + a hint directing
 * agents to retry leg-2 only OR rollback via `monday item delete`
 * (cli-design §5.8 orphan-warn atomicity envelope, D1 closure). See
 * `runItemCreateFileDispatch` below for the helper signature.
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
import {
  resolveClient,
  type EmitFromNetworkResult,
} from '../../api/resolve-client.js';
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
import { splitSetExpression, type SetExpression } from '../../api/set-expression.js';
import {
  buildResolutionContexts,
  type ResolutionContexts,
} from '../../api/resolution-context.js';
import {
  lookupItemBoard,
  lookupItemBoardWithHierarchy,
} from '../../api/item-board-lookup.js';
import {
  SourceAggregator,
  mergeCacheAge,
  mergeSourceWithPreflight,
} from '../../api/source-aggregator.js';
import { resolveAndTranslate } from '../../api/resolution-pass.js';
import {
  executeFileColumnSet,
  dispatchFileLegsSequentially,
  type FileColumnSetEntry,
  type MultiFileLegEntry,
  preCheckM38FileDispatch,
  type PreCheckM38FileDispatchResult,
} from '../../api/file-column-set.js';
import type { MultipartTransport } from '../../api/multipart-transport.js';
import type { RunContext } from '../../cli/run.js';
import {
  foldAndRemap,
  mergeResolverWarningsIntoError,
} from '../../api/resolver-error-fold.js';
import { planCreate, type CreateMode } from '../../api/dry-run.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { precheckLocalFile } from '../../utils/file-source.js';
import { invalidateBoard } from '../../api/cache.js';
import type { Warning } from '../../utils/output/envelope.js';

/**
 * Dedupes resolver warnings by `code + message + details.token`.
 * v0.6-M38 IMPL round-2 P3-1 fix: M38 pre-check + downstream
 * resolveAndTranslate / planCreate can both observe the same
 * `stale_cache_refreshed` / `column_token_collision` warning;
 * dedupe ensures each surfaces exactly once. Same shape as the
 * bulk-update `dedupeWarnings` helper.
 */
const dedupeCreateWarnings = (
  warnings: readonly Warning[],
): readonly Warning[] => {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const w of warnings) {
    const tokenKey =
      typeof w.details?.token === 'string' ? w.details.token : '';
    const key = `${w.code}|${w.message}|${tokenKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
};

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

/**
 * v0.8-M46 create-time multi-file `--set` envelope `data` shape
 * (D6 closure). Two-leg-group dispatch: leg-1 `create_item` (or
 * `create_subitem`) bundling non-file `column_values`, then N
 * sequential `add_file_to_column` legs (legs 2..N+1) against
 * the new item ID. The envelope projects:
 *
 *   - `operation: 'item_create_with_files'` literal discriminator
 *     (plural distinguishes from M43's single-file
 *     `'item_create'` literal at `itemCreateOutputSchema`).
 *   - Leg-1's `ItemCreateOutput` shape (item ID + name + board_id
 *     + group_id + parent_id for subitems) inlined as `item`.
 *   - Per-leg asset projections — one per file column that landed,
 *     length N on success; length 0..N-1 on partial failure
 *     (reflecting columns landed before the failing leg).
 *   - `applied_file_columns: [<col_ids>]` echo (length 1..N on
 *     success; length 0..N-1 on partial failure).
 *
 * Atomicity-envelope shape on partial failure (D2 closure):
 * extends M43's `'create_then_file_upload_partial_failure'`
 * discriminator at `details.reason` with always-present
 * `details.applied_file_columns: []` slot (length 0..N-1
 * reflecting file columns landed after leg-1 succeeded but
 * before the failing leg). Length 0 corresponds to M43's
 * single-file failure case; length k>0 corresponds to M46
 * multi-file partial failure after k file legs succeeded.
 *
 * **Status: schema landed at v0.8-M46 pre-flight contract diff
 * (Codex R1 P2-2 fix); runtime emit shipped at v0.8-M46 IMPL.**
 * `runItemCreateFileMultiDispatch` (below) emits against this
 * schema on the create-time multi-file path.
 */
export const itemCreateWithFilesOutputSchema = z.object({
  operation: z.literal('item_create_with_files'),
  item: itemCreateOutputSchema,
  assets: z
    .array(
      z
        .object({
          column_id: z.string().min(1),
          filename: z.string().min(1),
          file_size_bytes: z.number().int().nonnegative(),
          asset: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
            })
            .loose(),
        })
        .strict(),
    )
    .min(2),
  applied_file_columns: z.array(z.string().min(1)).min(2),
});
export type ItemCreateWithFilesOutput = z.infer<
  typeof itemCreateWithFilesOutputSchema
>;

/**
 * Command-registry output union for `monday item create`. The JSON /
 * single-file create paths emit the canonical `ItemCreateOutput`
 * (v0.7-M43 deliberately kept its single-file two-leg path on the
 * canonical shape); v0.8-M46 multi-file create emits the distinct
 * `item_create_with_files` shape. Both are single-resource `data`
 * payloads, so both belong in the advertised `outputSchema` union
 * (agents discriminate on the presence of `operation` /
 * `applied_file_columns`). Mirrors `item.update`'s union admitting
 * its single-item file shapes.
 */
export const itemCreateCommandOutputSchema = z.union([
  itemCreateOutputSchema,
  itemCreateWithFilesOutputSchema,
]);
export type ItemCreateCommandOutput = z.infer<
  typeof itemCreateCommandOutputSchema
>;

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
          `board (hierarchy_type "multi_level"); multi-level subitem ` +
          `creation is deferred. Use a classic board ` +
          `(hierarchy_type null/"classic"). v0.3 M28 Decision 11 closure: ` +
          `Monday's sub_items_board carries no subtasks column at API ` +
          `2026-01, so depth-2 subitems have no data-model home — v0.8 ` +
          `picks the feature up if Monday surfaces the capability.`,
        {
          details: {
            parent_item_id: dispatch.parentItemId,
            parent_board_id: parent.boardId,
            hierarchy_type: parent.hierarchyType,
            deferred_to: 'v0.8',
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
  ItemCreateCommandOutput
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
  outputSchema: itemCreateCommandOutputSchema,
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
        const { client, globalFlags, apiVersion, multipart, toEmit } =
          resolveClient(ctx, program.opts());

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

        const { dateResolution, peopleResolution, tagResolution, relationResolution } =
          buildResolutionContexts({ client, ctx, globalFlags });

        // v0.6-M38 / v0.7-M43 D6 closure — create-time file-set
        // dispatch routes through the column-resolution boundary's
        // pre-check. Pre-checks setEntries against the resolved
        // create-mode board (subitems board for subitem create;
        // --board for top-level), then returns one of:
        //   - `kind: 'json'` — no file column in `--set` (existing
        //     bundled-create path runs below).
        //   - `kind: 'file_create'` — clean single-file `--set`
        //     entry; branches into the v0.7-M43 two-leg dispatch
        //     helper {@link runItemCreateFileDispatch} (carve-out
        //     fold from v0.6-M38's permanent rejection).
        //   - `kind: 'file_create_multi'` — clean multi-file
        //     `--set` entries with distinct file columns; branches
        //     into the v0.8-M46 two-leg-group dispatch helper
        //     `runItemCreateFileMultiDispatch` (D2 carve-out fold
        //     from v0.6-M38's universal multi-file rejection;
        //     runtime body shipped at v0.8-M46 IMPL).
        //   - Throws `usage_error` with
        //     `details.reason: 'duplicate_resolved_file_columns'` when
        //     2+ file `--set` entries resolve to the same column ID
        //     (mirrors JSON path's cross-token duplicate-resolved-ID
        //     contract; M46 R1 P2-1 fix). The
        //     `'mixed_file_and_value_sets'` rule is SUPPRESSED on
        //     `'item_create'` callShape per the v0.7-M43 D6 mixed-
        //     rule asymmetry — `create_item` natively bundles
        //     non-file `column_values` atomically into leg-1.
        // `--set-raw <file-col>=<json>` stays at
        // `translateRawColumnValue`'s D3 permanent rejection (the
        // pre-check inspects setEntries only).
        let m38Source: 'live' | 'cache' | 'mixed' | undefined;
        let m38CacheAge: number | null = null;
        let m38Warnings: readonly ResolverWarning[] = [];
        let m38FileCreate:
          | Extract<PreCheckM38FileDispatchResult, { kind: 'file_create' }>
          | undefined;
        let m38FileCreateMulti:
          | Extract<
              PreCheckM38FileDispatchResult,
              { kind: 'file_create_multi' }
            >
          | undefined;
        if (setEntries.length > 0) {
          const m38 = await preCheckM38FileDispatch({
            client,
            boardId: resolveBoardId,
            setEntries,
            setRawCount: rawEntries.length,
            hasName: true,
            callShape: 'item_create',
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          m38Source = m38.source;
          m38CacheAge = m38.cacheAgeSeconds;
          m38Warnings = m38.warnings;
          if (m38.kind === 'file_create') {
            m38FileCreate = m38;
          }
          if (m38.kind === 'file_create_multi') {
            // v0.8-M46 D2 carve-out fold. Hold the file_create_multi
            // slot for the two-leg-group multi-file dispatch helper
            // below (runtime body shipped at v0.8-M46 IMPL).
            m38FileCreateMulti = m38;
          }
        }

        // v0.6-M38 → v0.7-M43 D6 fold — branch into the two-leg
        // dispatch helper. {@link runItemCreateFileDispatch} runs
        // the upfront `precheckLocalFile` + partitions setEntries
        // (non-file → leg-1 `column_values`, file → leg-2
        // `add_file_to_column`) + dispatches leg-1 `create_item`
        // / `create_subitem` then leg-2 `add_file_to_column` under
        // the §5.8 orphan-warn atomicity envelope (D1 closure).
        // Reaching this branch means argv parse + shape validation
        // + duplicate-token check + create-mode resolution + M38
        // pre-check all succeeded.
        if (m38FileCreate !== undefined) {
          await runItemCreateFileDispatch({
            parsed,
            client,
            multipart,
            ctx,
            programOpts: program.opts(),
            apiVersion,
            createMode,
            resolveBoardId,
            setEntries,
            rawEntries,
            m38: m38FileCreate,
            preflightSource: createModeResult.preflightSource,
            preflightCacheAgeSeconds:
              createModeResult.preflightCacheAgeSeconds,
            metaSource: m38Source,
            metaCacheAgeSeconds: m38CacheAge,
            preflightWarnings: m38Warnings,
            dateResolution,
            peopleResolution,
            tagResolution,
            relationResolution,
            isDryRun: globalFlags.dryRun,
            noCache: globalFlags.noCache,
            retries: globalFlags.retry,
            toEmit,
          });
          return;
        }

        // v0.8-M46 D2 carve-out fold — create-time multi-file
        // dispatch path. argv parse + create-mode resolution + M38
        // pre-check (which returned `kind: 'file_create_multi'`
        // here) have already run as live contract; the two-leg-
        // group multi-file body runs leg-1 `create_item` then N
        // sequential `add_file_to_column` legs (runtime body
        // shipped at v0.8-M46 IMPL).
        if (m38FileCreateMulti !== undefined) {
          await runItemCreateFileMultiDispatch({
            parsed,
            client,
            multipart,
            ctx,
            programOpts: program.opts(),
            apiVersion,
            createMode,
            resolveBoardId,
            setEntries,
            rawEntries,
            m38: m38FileCreateMulti,
            preflightSource: createModeResult.preflightSource,
            preflightCacheAgeSeconds:
              createModeResult.preflightCacheAgeSeconds,
            metaSource: m38Source,
            metaCacheAgeSeconds: m38CacheAge,
            preflightWarnings: m38Warnings,
            dateResolution,
            peopleResolution,
            tagResolution,
            relationResolution,
            isDryRun: globalFlags.dryRun,
            noCache: globalFlags.noCache,
            retries: globalFlags.retry,
            toEmit,
          });
          return;
        }

        if (globalFlags.dryRun) {
          let result;
          try {
            result = await planCreate({
              client,
              mode: createMode,
              name: parsed.name,
              setEntries,
              ...(rawEntries.length === 0 ? {} : { rawEntries }),
              dateResolution,
              peopleResolution,
              tagResolution,
              relationResolution,
              env: ctx.env,
              noCache: globalFlags.noCache,
            });
          } catch (err) {
            // Round-3 P3-1 fix: fold M38 pre-check warnings into
            // the failure envelope's `details.resolver_warnings`.
            if (err instanceof MondayCliError && m38Warnings.length > 0) {
              throw mergeResolverWarningsIntoError(err, m38Warnings);
            }
            throw err;
          }
          // Dry-run envelope source folds four legs (Codex M9 P2 #1
          // + v0.6-M38 IMPL round-1 P3-1-equivalent fix):
          // pre-planner network calls (parent lookup + parent-board
          // metadata + --relative-to verification) + the M38
          // pre-check's column-resolution leg + planCreate's
          // column-resolution legs. `meta.source: "none"` is only
          // accurate when ZERO wire calls fired.
          const dryRunSource = mergeSourceWithPreflight(
            mergeSourceWithPreflight(result.source, m38Source),
            createModeResult.preflightSource,
          );
          const dryRunCacheAge = mergeCacheAge(
            mergeCacheAge(m38CacheAge, result.cacheAgeSeconds),
            createModeResult.preflightCacheAgeSeconds,
          );
          // Round-2 P3-1 fix: thread M38 pre-check warnings into
          // the dry-run envelope. Pre-check's `stale_cache_refreshed`
          // / `column_token_collision` survive even though
          // downstream `planCreate`'s resolveAndTranslate cache-hits
          // suppress re-emission. Dedupe inline by code+message+
          // token (small N).
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges:
              result.plannedChanges as unknown as readonly Readonly<
                Record<string, unknown>
              >[],
            source: dryRunSource,
            cacheAgeSeconds: dryRunCacheAge,
            warnings: dedupeCreateWarnings([...m38Warnings, ...result.warnings]),
            apiVersion,
          });
          return;
        }

        // Live create path (JSON-only). Three-pass resolution +
        // translation through the shared helper (R20 lift), then
        // bundle into one column_values map and fire the single-
        // round-trip mutation per cli-design §5.8. Reaching this
        // block means the v0.7-M43 `file_create` dispatch helper
        // did NOT apply (no file `--set` entries present) — the
        // helper returned above; this remaining path is JSON-only
        // single-round-trip.
        let resolutionResult;
        try {
          resolutionResult = await resolveAndTranslate({
            client,
            boardId: resolveBoardId,
            setEntries,
            rawEntries,
            dateResolution,
            peopleResolution,
            tagResolution,
            relationResolution,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
        } catch (err) {
          // Round-3 P3-1 fix: fold M38 pre-check warnings into the
          // live failure envelope's `details.resolver_warnings`.
          if (err instanceof MondayCliError && m38Warnings.length > 0) {
            throw mergeResolverWarningsIntoError(err, m38Warnings);
          }
          throw err;
        }
        // Round-2 P3-1 fix: include M38 pre-check warnings.
        // Deduped by code+message+token via the same shape as
        // bulk-update's `dedupeWarnings` helper.
        const collectedWarnings: ResolverWarning[] = dedupeCreateWarnings([
          ...m38Warnings,
          ...resolutionResult.warnings,
        ]) as ResolverWarning[];
        const resolvedIds = resolutionResult.resolvedIds;
        // Live envelope source aggregates four legs (Codex M9 P2 #1):
        // pre-planner network calls (parent lookup + parent metadata
        // + relative-to verification) → column resolution legs →
        // mutation (always live). Dry-run path stays on the
        // standalone `mergeSourceWithPreflight` helper because the
        // planner there can claim 'none' (no wire call); the class
        // shape only handles `EnvelopeSource = 'live'|'cache'|'mixed'`.
        const sourceAgg = new SourceAggregator();
        // v0.6-M38 IMPL round-1 P3-1-equivalent fix: thread the M38
        // pre-check's source/cacheAge into source aggregation so the
        // live envelope's `meta.source` reflects the pre-check wire
        // leg (a `live` BoardMetadata fetch when cache cold).
        if (m38Source !== undefined) {
          sourceAgg.record(m38Source, m38CacheAge);
        }
        if (resolutionResult.source !== undefined) {
          sourceAgg.record(
            resolutionResult.source,
            resolutionResult.cacheAgeSeconds,
          );
        }
        if (createModeResult.preflightSource !== undefined) {
          sourceAgg.record(
            createModeResult.preflightSource,
            createModeResult.preflightCacheAgeSeconds,
          );
        }
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
              resolutionSource: resolutionResult.source ?? 'live',
            });
          }
          throw err;
        }

        const warnings: readonly Warning[] = collectedWarnings;
        // Mutation leg fires live; record it so the aggregate
        // collapses cache-served resolution / preflight legs to
        // `mixed`. Live path never sees a 'none' source (the
        // mutation always fires) so the class's `EnvelopeSource`
        // shape suffices.
        sourceAgg.record('live', null);
        emitMutation({
          ctx,
          data: mutationResult.projected,
          schema: itemCreateCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(mutationResult.response),
          ...sourceAgg.result(),
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
  // R42: distinguish missing-root-key (schema-drift → internal_error
  // with schema-drift hint) from null payload (server-side glitch →
  // internal_error with no-payload message below). Pre-R42 conflated
  // both as internal_error / no-payload; post-R42 the schema-drift
  // case carries a more accurate diagnostic.
  assertResponseFieldPresent({
    data: response.data,
    key: 'create_item',
    operationLabel: 'ItemCreateTopLevel',
    details: { board_id: inputs.boardId, item_name: inputs.itemName },
    nullHandling: 'caller_handles',
  });
  if (response.data.create_item === null) {
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
  // R42: distinguish missing-root-key (schema-drift → internal_error
  // with schema-drift hint) from null payload (server-side glitch →
  // internal_error with no-payload message below). Pre-R42 conflated
  // both as internal_error / no-payload.
  assertResponseFieldPresent({
    data: response.data,
    key: 'create_subitem',
    operationLabel: 'ItemCreateSubitem',
    details: {
      parent_item_id: inputs.parentItemId,
      item_name: inputs.itemName,
    },
    nullHandling: 'caller_handles',
  });
  if (response.data.create_subitem === null) {
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

// ============================================================
// v0.7-M43 create-time file `--set` dispatch helper (v0.6-M38 →
// v0.7-M43 D6 fold).
//
// **Status: runtime body shipped at v0.7-M43 IMPL.** All upstream
// argv parse + shape validation + duplicate-token check + create-
// mode resolution + M38 pre-check fire BEFORE this helper per
// R-NEW-76 (parseArgv-BEFORE-c8 discipline graduated at v0.5-M34)
// and are shipped contract; the helper takes the resolved file-
// column dispatch slot from {@link preCheckM38FileDispatch} +
// the resolved create-mode + the original `setEntries` /
// `rawEntries` lists, partitions setEntries (non-file → leg-1's
// `column_values`, file → leg-2's `add_file_to_column`), and
// drives the two-leg dispatch under the §5.8 orphan-warn
// atomicity envelope.
//
// **D-list closures (v0.7-plan §3 M43 entry).**
//
//   - **D1 — Atomicity-envelope shape: orphan-warn.** Leg-2
//     failure surfaces `internal_error` with `details.reason:
//     'create_then_file_upload_partial_failure'` + `details.
//     created_item_id` echoing leg-1's freshly-created item ID
//     + `details.column_id` + `details.cause` carrying leg-2's
//     underlying error shape (M31 wire failure surface
//     inheritance: `column_archived` / `validation_failed` /
//     `not_found` / `file_too_large`) + `details.hint`
//     directing agents to `monday item set <iid> <file-col>=
//     <path>` (retry leg-2 only against the orphan) or `monday
//     item delete <iid> --yes` (rollback the orphan if the
//     agent prefers a clean retry of the whole two-leg path).
//     The pre-flight probe for cleanup-on-failure (rollback
//     viability of option (a) — automatic `delete_item`) was
//     inconclusive — phase-1 introspection confirmed
//     `delete_item(item_id: ID) → OBJECT/Item` wire shape
//     (rollback IS expressible) but phase-2 empirical
//     rollback-viability step could not run because the token
//     lacked `create_item` permission in a fresh sandbox
//     workspace/board (Monday "User unauthorized to perform
//     action" rejection); attempting against shared/existing
//     boards was blocked by the harness auto-classifier as
//     correctly modifying-shared-state. Defaulting to (b)
//     preserves the agent's recovery handle without introducing
//     a destructive `delete_item` cleanup leg whose own failure
//     mode is unaccounted for. The v0.7-M43 IMPL holds at (b);
//     a future milestone can lift to (a) if a user-authorized
//     probe sandbox surfaces concrete rollback-reliability data.
//   - **D2 — Dry-run envelope shape: two `planned_changes`.**
//     `--dry-run` emits two entries without burning either wire
//     round-trip: (1) `operation: 'create_item'` (mirroring
//     v0.2-M9's dry-run shape) carrying `name` + bundled non-
//     file `column_values` from the resolveAndTranslate leg +
//     the create-mode dispatch (top-level board / subitem
//     parent); (2) `operation: 'add_file_to_column'` (mirroring
//     M31's dry-run shape) carrying `column_id` + `file_path` +
//     `filename` + `file_size_bytes` from the local pre-check.
//     `source` aggregates the pre-planner network legs (parent
//     lookup + parent-board metadata for subitems +
//     `--relative-to` verification) + the M38 pre-check leg +
//     the planner's resolveAndTranslate leg, mirroring the
//     existing JSON-path dry-run aggregation in the action body
//     verbatim. No multipart wire round-trip fires on dry-run.
//   - **D3 — ERROR_CODES delta: zero net change.** Registry
//     stays at 29 codes. Atomicity failures route through
//     `internal_error` (existing) with `details.reason:
//     'create_then_file_upload_partial_failure'` discriminator;
//     leg-2 column resolution / validation failures route
//     through existing `column_archived` / `validation_failed`
//     / `not_found` / `file_too_large` per M31's pinned
//     surface (M43 reuses M31's `addFileToColumn` fetcher
//     verbatim through {@link executeFileColumnSet} so leg-2
//     failure shapes are inherited).
//
// **Wire surface.** Two-leg dispatch:
//   1. `create_item` (or `create_subitem` for subitem path)
//      with bundled `column_values` from translated non-file
//      `--set` / `--set-raw` entries — leg-1 returns the new
//      `item.id` which threads into leg-2's `item_id`
//      parameter.
//   2. `add_file_to_column(item_id, column_id, file)`
//      multipart via M31's `addFileToColumn` fetcher (through
//      {@link executeFileColumnSet}) — leg-2 returns the
//      `asset` record on success; on failure, surface the D1
//      orphan-warn envelope echoing leg-1's item ID.
//
// **operationName parity contract (W2 audit-point).** Three
// existing named GraphQL operations are reused verbatim — no
// new operations introduced at this milestone:
//   - leg-1 top-level: `'ItemCreateTopLevel'` (from
//     {@link executeCreateItem} above in this file).
//   - leg-1 subitem: `'ItemCreateSubitem'` (from
//     {@link executeCreateSubitem} above in this file).
//   - leg-2: `'AddFileToColumn'` (from M31's
//     `src/api/assets.ts:addFileToColumn`, threaded via M38's
//     {@link executeFileColumnSet}).
// No caller-overridable operationName slot — the helper
// selects top-level vs subitem from `inputs.createMode.kind`
// (the `CreateMode` discriminated union from
// `src/api/dry-run.ts`, resolved by `resolveCreateMode`
// upstream) and pairs that with `inputs.m38` (the file-column
// slot from `preCheckM38FileDispatch`). The runtime body
// invokes the existing helpers verbatim rather than
// re-spelling the operation names.
//
// **Reuse from existing surfaces.** Leg-1 reuses the existing
// `executeCreateItem` / `executeCreateSubitem` helpers in this
// file (no new wire op). Leg-2 reuses M38's
// {@link executeFileColumnSet} +
// {@link precheckLocalFile} / `buildBlobFromPath` from
// `src/utils/file-source.ts` (R-v0.6-NEW-1 4th-consumer site;
// 5-consumer graduation threshold not yet hit).
//
// **R-v0.7-NEW-5 inline decision.** The fail-fast error-
// decoration block (`if (err.code === 'usage_error') {
// throw UsageError(...) } else { throw ApiError(...) }` with
// stale-cache remap + per-record `applied_count` / `applied_
// to` / `failed_at_item` / `matched_count` decoration) at
// JSON-bulk `update.ts:1334-1361` + file-bulk
// `runItemUpdateBulkFileDispatch` does NOT tip to its 3rd
// consumer at v0.7-M43 IMPL: M43's leg-2 catch is structurally
// distinct (always-`internal_error` outer code with the
// remapped error embedded as a `details.cause` JSON projection,
// vs preserve-remapped-code with typed re-throw + decoration).
// The lift stays deferred at 2 consumers; v0.7-plan §22
// R-v0.7-NEW-5 carries the rationale + future-consumer
// triggers.
// ============================================================

interface RunItemCreateFileDispatchInputs {
  readonly parsed: ParsedInput;
  readonly client: MondayClient;
  readonly multipart: MultipartTransport;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
  readonly apiVersion: string;
  readonly createMode: CreateMode;
  readonly resolveBoardId: string;
  readonly setEntries: readonly SetExpression[];
  readonly rawEntries: readonly ParsedSetRawExpression[];
  readonly m38: Extract<
    PreCheckM38FileDispatchResult,
    { kind: 'file_create' }
  >;
  /**
   * Source contribution from the pre-planner network legs
   * (parent lookup + parent-board metadata + --relative-to
   * verification). Threaded into leg-1 + leg-2 envelope source
   * aggregation per D2 closure so `meta.source` reflects every
   * wire leg that fired.
   */
  readonly preflightSource: 'live' | 'cache' | 'mixed' | undefined;
  readonly preflightCacheAgeSeconds: number | null;
  /**
   * Source contribution from the M38 pre-check leg (column
   * resolution against `resolveBoardId`). Already-aggregated by
   * `preCheckM38FileDispatch`; threaded here so the helper can
   * fold it into leg-1 + leg-2 source aggregation without
   * re-resolving.
   */
  readonly metaSource: 'live' | 'cache' | 'mixed' | undefined;
  readonly metaCacheAgeSeconds: number | null;
  /**
   * Resolver warnings from the M38 pre-check leg
   * (`stale_cache_refreshed` / `column_token_collision`). Threaded
   * into the success + failure envelopes via the same dedupe
   * pattern as the existing JSON path.
   */
  readonly preflightWarnings: readonly ResolverWarning[];
  readonly dateResolution: ResolutionContexts['dateResolution'];
  readonly peopleResolution: ResolutionContexts['peopleResolution'];
  readonly tagResolution: ResolutionContexts['tagResolution'];
  readonly relationResolution: ResolutionContexts['relationResolution'];
  readonly isDryRun: boolean;
  readonly noCache: boolean;
  /**
   * Retry budget for leg-2's multipart dispatch (threaded into
   * {@link executeFileColumnSet} → M31's `addFileToColumn`
   * `withRetry(...)` thunk). Leg-1's `create_item` /
   * `create_subitem` retry is handled implicitly by the client
   * (configured via `globalFlags.retry` at `resolveClient(...)`);
   * this slot covers leg-2's multipart transport, which has its
   * own retry pump separate from the client.
   */
  readonly retries: number;
  /**
   * Envelope-meta closure from `resolveClient(...)`. Threads
   * leg-1's `complexity` + `apiVersion` slots into the success
   * envelope (mirrors `emitMutation`'s usage in the JSON path
   * above). `source` + `cacheAgeSeconds` are overridden by the
   * aggregator's result at emit time so the spread order is
   * deliberate.
   */
  readonly toEmit: <T>(response: MondayResponse<T>) => EmitFromNetworkResult;
}

/**
 * Two-leg create-time file dispatch helper. Runs:
 *
 *   1. Single upfront {@link precheckLocalFile} on the file `--set`
 *      raw value. Local-only; failure surfaces `usage_error` with
 *      `details.reason: 'file_not_readable'` / `'file_empty'`
 *      BEFORE either wire leg fires (atomicity-before-wire
 *      discipline per cli-design §5.8).
 *   2. Partitions `inputs.setEntries` by `token`: the entry whose
 *      `token === inputs.m38.token` routes to leg-2; every other
 *      entry routes to leg-1's `column_values`. `inputs.rawEntries`
 *      route to leg-1 verbatim — `--set-raw <file-col>=<json>` is
 *      rejected upstream at `translateRawColumnValue` per D3
 *      permanent rejection, so by this point no raw entry targets
 *      a file column.
 *   3. **Dry-run branch.** Invokes {@link planCreate} on the
 *      non-file entries (handles resolution + diff cell build),
 *      then appends a synthetic entry-2
 *      `operation: 'add_file_to_column'` carrying `column_id` +
 *      `file_path` (argv-derived) + `filename` + `file_size_bytes`
 *      from the upfront pre-check. Emits both entries together
 *      via `emitDryRun`; no multipart wire round-trip fires.
 *      Entry-2 omits `item_id` (the item doesn't exist yet at
 *      dry-run time).
 *   4. **Live branch.** `resolveAndTranslate` on the non-file
 *      entries yields the leg-1 `column_values`; leg-1 invokes
 *      `executeCreateItem` / `executeCreateSubitem` depending on
 *      `inputs.createMode.kind`; leg-2 builds a
 *      {@link FileColumnSetEntry} from the pre-check + leg-1's
 *      new item ID and invokes {@link executeFileColumnSet}.
 *      On full success, a single
 *      {@link invalidateBoard} fires (mirroring M38 single-item
 *      + M42 bulk file-dispatch invalidate timing — leg-2
 *      mutates the file column's asset state wire-side).
 *   5. **Leg-1 failure.** Routes through {@link foldAndRemap} to
 *      surface `column_archived` on cache-served file-column
 *      resolution against an archived column (mirrors the JSON
 *      path's F4 remap above). No orphan handle because no item
 *      was created.
 *   6. **Leg-2 failure (orphan-warn per D1).** Catches
 *      `MondayCliError`, applies {@link foldAndRemap} to surface
 *      `column_archived` etc., then wraps the remapped error in
 *      a fresh `ApiError('internal_error', ...)` carrying
 *      `details.reason: 'create_then_file_upload_partial_failure'`
 *      + `details.created_item_id` + `details.column_id` +
 *      `details.cause` (JSON projection of the remapped error) +
 *      `details.hint` (retry-leg-2-only / rollback). The board
 *      cache is NOT invalidated on leg-2 failure — leg-1's
 *      `create_item` doesn't affect cached board metadata
 *      (mirrors the JSON-only create path's no-invalidate), and
 *      leg-2 failure means no file mutation occurred wire-side.
 */
const runItemCreateFileDispatch = async (
  inputs: RunItemCreateFileDispatchInputs,
): Promise<void> => {
  // 1) Upfront local file pre-check. Atomicity-before-wire per
  //    cli-design §5.8: pre-checks fire BEFORE any wire round-trip
  //    so a bad path surfaces `usage_error` (exit 1) with
  //    `details.reason: 'file_not_readable'` / `'file_empty'`
  //    without burning either wire leg. R-v0.6-NEW-1 4th-consumer
  //    site (M31 upload + M38 single-item + M42 file-bulk + here);
  //    5-consumer graduation threshold not yet hit.
  const precheck = await precheckLocalFile(inputs.m38.rawValue);

  // 2) Partition setEntries: the file entry's `token` matches
  //    `inputs.m38.token` (the pre-check identified it); every
  //    other token goes to leg-1's column_values.
  const nonFileSetEntries = inputs.setEntries.filter(
    (e) => e.token !== inputs.m38.token,
  );

  // 3) Dry-run branch — D2 closure. Two `planned_changes` entries
  //    without burning either wire leg. planCreate handles
  //    non-file column resolution + diff cells; entry-2 is built
  //    locally from the pre-check.
  if (inputs.isDryRun) {
    let planResult;
    try {
      planResult = await planCreate({
        client: inputs.client,
        mode: inputs.createMode,
        name: inputs.parsed.name,
        setEntries: nonFileSetEntries,
        ...(inputs.rawEntries.length === 0
          ? {}
          : { rawEntries: inputs.rawEntries }),
        dateResolution: inputs.dateResolution,
        peopleResolution: inputs.peopleResolution,
        tagResolution: inputs.tagResolution,
        relationResolution: inputs.relationResolution,
        env: inputs.ctx.env,
        noCache: inputs.noCache,
      });
    } catch (err) {
      // Fold M38 pre-check warnings into the dry-run failure
      // envelope's `details.resolver_warnings`. `mergeResolverWarningsIntoError`
      // is a no-op on empty `preflightWarnings`, so no length guard
      // is needed; the JSON path's analogous catch at
      // `create.ts:944-951` keeps the guard inline for parity with
      // its older pattern, but the M43 helper collapses it (smaller
      // branch surface). Non-`MondayCliError` programmer bugs
      // re-throw unchanged.
      if (err instanceof MondayCliError) {
        throw mergeResolverWarningsIntoError(err, inputs.preflightWarnings);
      }
      throw err;
    }

    // Source aggregates four legs (planner + M38 pre-check +
    // pre-planner preflight) — mirrors the JSON-path dry-run
    // aggregation pattern at lines 959-966 above. planCreate may
    // return `source: 'none'` when its no-set short-circuit fires
    // (only relevant here if the call had ONLY the file `--set`),
    // so the standalone `mergeSourceWithPreflight` helper is used
    // rather than the SourceAggregator class (which doesn't model
    // 'none').
    const dryRunSource = mergeSourceWithPreflight(
      mergeSourceWithPreflight(planResult.source, inputs.metaSource),
      inputs.preflightSource,
    );
    const dryRunCacheAge = mergeCacheAge(
      mergeCacheAge(inputs.metaCacheAgeSeconds, planResult.cacheAgeSeconds),
      inputs.preflightCacheAgeSeconds,
    );

    // Entry-2: `add_file_to_column` planned-change. Mirrors M31's
    // dry-run shape minus `item_id` (the item doesn't exist yet).
    // `file_path` is the argv-derived raw value per cli-design §6.4;
    // resolved absolute path lives in pre-check rejections, not in
    // the success-shaped dry-run envelope.
    const fileEntry = {
      operation: 'add_file_to_column' as const,
      column_id: inputs.m38.columnId,
      file_path: inputs.m38.rawValue,
      filename: precheck.filename,
      file_size_bytes: precheck.fileSizeBytes,
    };

    const plannedChanges = [
      ...planResult.plannedChanges,
      fileEntry,
    ] as unknown as readonly Readonly<Record<string, unknown>>[];

    emitDryRun({
      ctx: inputs.ctx,
      programOpts: inputs.programOpts,
      plannedChanges,
      source: dryRunSource,
      cacheAgeSeconds: dryRunCacheAge,
      warnings: dedupeCreateWarnings([
        ...inputs.preflightWarnings,
        ...planResult.warnings,
      ]),
      apiVersion: inputs.apiVersion,
    });
    return;
  }

  // 4) Live branch — leg-1 (create_item / create_subitem) then
  //    leg-2 (add_file_to_column). resolveAndTranslate on non-file
  //    entries yields leg-1's column_values; the M38 pre-check
  //    already warmed the column-resolution cache so this leg
  //    typically hits cache (source folds to `mixed` once leg-1
  //    + leg-2 record `live`).
  let resolutionResult;
  try {
    resolutionResult = await resolveAndTranslate({
      client: inputs.client,
      boardId: inputs.resolveBoardId,
      setEntries: nonFileSetEntries,
      rawEntries: inputs.rawEntries,
      dateResolution: inputs.dateResolution,
      peopleResolution: inputs.peopleResolution,
      tagResolution: inputs.tagResolution,
      relationResolution: inputs.relationResolution,
      env: inputs.ctx.env,
      noCache: inputs.noCache,
    });
  } catch (err) {
    // Same shape as the planCreate catch above — collapse the
    // `&& length > 0` guard (no-op on empty) for a smaller branch
    // surface than the JSON path's pattern at
    // `create.ts:1010-1022`.
    if (err instanceof MondayCliError) {
      throw mergeResolverWarningsIntoError(err, inputs.preflightWarnings);
    }
    throw err;
  }

  // Combined warnings: M38 pre-check + resolveAndTranslate. Deduped
  // by code+message+token (a stale_cache_refreshed seen at pre-check
  // AND at resolveAndTranslate for the same token collapses to one
  // entry). Mirrors the JSON path's dedupeCreateWarnings usage.
  const collectedWarnings: readonly ResolverWarning[] = dedupeCreateWarnings(
    [...inputs.preflightWarnings, ...resolutionResult.warnings],
  ) as readonly ResolverWarning[];

  // Source aggregator across every wire leg that fires (or that
  // already fired upstream). Records preflight + M38 pre-check +
  // resolveAndTranslate legs; records `'live'` once at the end of
  // each successful wire mutation (mergeSource is idempotent for a
  // constant `'live'` second leg so recording leg-1 + leg-2 separately
  // is byte-equivalent to recording once).
  const sourceAgg = new SourceAggregator();
  // Defensive: the helper is entered only when the action body's
  // `preCheckM38FileDispatch` returned `kind: 'file_create'`, which
  // guarantees `metaSource` is defined (the M38 pre-check populates
  // `source` for every entry it resolves). The `undefined` arm is
  // unreachable from any callable test surface.
  /* c8 ignore next 3 */
  if (inputs.metaSource !== undefined) {
    sourceAgg.record(inputs.metaSource, inputs.metaCacheAgeSeconds);
  }
  if (resolutionResult.source !== undefined) {
    sourceAgg.record(
      resolutionResult.source,
      resolutionResult.cacheAgeSeconds,
    );
  }
  if (inputs.preflightSource !== undefined) {
    sourceAgg.record(
      inputs.preflightSource,
      inputs.preflightCacheAgeSeconds,
    );
  }

  // resolved_ids — file token + non-file tokens. Mirrors §6.4
  // mutation-envelope shape: `{ <token>: <resolved_column_id> }`
  // for every `--set` / `--set-raw` the agent supplied.
  const resolvedIds: Readonly<Record<string, string>> = {
    [inputs.m38.token]: inputs.m38.columnId,
    ...resolutionResult.resolvedIds,
  };

  // Bundle non-file translated values into leg-1's column_values
  // parameter. `null` when zero non-file entries (mirrors the JSON
  // path's "no `--set` values to bundle" treatment — Monday accepts
  // `column_values: null` distinctly from an empty map).
  const translated = resolutionResult.translated;
  const columnValues =
    translated.length === 0 ? null : bundleColumnValues(translated);

  // Leg-1: create_item or create_subitem. F4 remap on failure
  // mirrors the JSON path's catch arm (cache-served resolution +
  // Monday rejecting as `validation_failed` → check live archived
  // state). No orphan handle on leg-1 failure because no item was
  // created.
  let leg1Result;
  try {
    if (inputs.createMode.kind === 'subitem') {
      leg1Result = await executeCreateSubitem(inputs.client, {
        parentItemId: inputs.createMode.parentItemId,
        itemName: inputs.parsed.name,
        columnValues,
        createLabelsIfMissing: inputs.parsed.createLabelsIfMissing,
      });
    } else {
      leg1Result = await executeCreateItem(inputs.client, {
        boardId: inputs.createMode.boardId,
        itemName: inputs.parsed.name,
        groupId: inputs.createMode.groupId,
        position: inputs.createMode.position,
        columnValues,
        createLabelsIfMissing: inputs.parsed.createLabelsIfMissing,
      });
    }
  } catch (err) {
    if (err instanceof MondayCliError) {
      throw await foldAndRemap({
        err,
        warnings: collectedWarnings,
        client: inputs.client,
        boardId: inputs.resolveBoardId,
        columnIds: translated.map((t) => t.columnId),
        env: inputs.ctx.env,
        noCache: inputs.noCache,
        resolutionSource: resolutionResult.source ?? 'live',
      });
    }
    // Defensive: every wire fetcher in `src/api/**` raises typed
    // errors (ApiError / UsageError) which both extend MondayCliError;
    // a non-typed throw here indicates a programmer bug in the
    // wire layer, not a Monday-side failure that needs the F4 remap.
    /* c8 ignore next */
    throw err;
  }
  // Leg-1 fired live; record into the aggregator.
  sourceAgg.record('live', null);

  // Leg-2: add_file_to_column via M31's multipart fetcher. On
  // success, build the create envelope below; on `MondayCliError`,
  // surface the D1 orphan-warn envelope with the freshly-created
  // item ID as the recovery handle.
  const fileEntry: FileColumnSetEntry = {
    columnId: inputs.m38.columnId,
    columnType: 'file',
    rawValue: inputs.m38.rawValue,
    filePath: precheck.filePath,
    filename: precheck.filename,
    fileSizeBytes: precheck.fileSizeBytes,
  };

  try {
    await executeFileColumnSet({
      client: inputs.client,
      multipart: inputs.multipart,
      itemId: leg1Result.projected.id,
      entry: fileEntry,
      signal: inputs.ctx.signal,
      retries: inputs.retries,
    });
  } catch (err) {
    if (err instanceof MondayCliError) {
      // foldAndRemap surfaces `column_archived` for cache-served
      // file-column resolution against an archived column (cli-
      // design §6.5 stable-code rule; mirrors M42's file-bulk
      // fail-fast pattern). The remapped error's code/message
      // surface in `details.cause` so agents can branch on
      // leg-2's underlying outcome from the orphan-warn envelope.
      const remapped = await foldAndRemap({
        err,
        warnings: collectedWarnings,
        client: inputs.client,
        boardId: inputs.resolveBoardId,
        columnIds: [inputs.m38.columnId],
        env: inputs.ctx.env,
        noCache: inputs.noCache,
        resolutionSource: inputs.metaSource ?? 'live',
      });

      // D1 orphan-warn envelope. Always-internal-error outer
      // shape; the remapped error embeds as `details.cause` JSON
      // projection so the agent sees `{code, message, details?}`
      // for the underlying failure. Error.cause threads the
      // remapped error for stack debugging in `--debug` mode.
      const causeProjection: Record<string, unknown> = {
        code: remapped.code,
        message: remapped.message,
      };
      // Defensive: M31's wire-error rewraps (and foldAndRemap) always
      // populate `details` on the returned error in practice; the
      // undefined-arm exists only to satisfy the optional shape on
      // the `MondayCliError` type.
      /* c8 ignore next 3 */
      if (remapped.details !== undefined) {
        causeProjection.details = remapped.details;
      }

      const createdItemId = leg1Result.projected.id;
      throw new ApiError(
        'internal_error',
        `Item ${createdItemId} was created on board ${inputs.resolveBoardId} ` +
          `but the file upload to column ${inputs.m38.columnId} failed ` +
          `(${remapped.code}: ${remapped.message}). The item persists on ` +
          `Monday; retry the file upload alone with \`monday item set ` +
          `${createdItemId} <file-col>=<path>\` against the orphan, or roll ` +
          `back with \`monday item delete ${createdItemId} --yes\`.`,
        {
          cause: remapped,
          details: {
            reason: 'create_then_file_upload_partial_failure',
            created_item_id: createdItemId,
            column_id: inputs.m38.columnId,
            cause: causeProjection,
            hint:
              `the item was created (id ${createdItemId}) but the file ` +
              `upload failed. Retry leg-2 alone with \`monday item set ` +
              `${createdItemId} <file-col>=<path>\`; or rollback the ` +
              `orphan with \`monday item delete ${createdItemId} --yes\` ` +
              `and re-run the original \`monday item create\` once the ` +
              `underlying cause is fixed.`,
          },
        },
      );
    }
    // Non-CliError programmer bug — re-throw to the runner's catch-
    // all (surfaces as `internal_error` whole-call). Non-typed
    // throws indicate broken contract, not a Monday-side failure
    // that needs the orphan-warn decoration; routing them through
    // D1's `create_then_file_upload_partial_failure` discriminator
    // would falsely promise an orphan-recovery path for a programmer
    // bug.
    /* c8 ignore next */
    throw err;
  }
  // Leg-2 fired live; record into the aggregator. `'live'` + `'live'`
  // is idempotent under mergeSource so this is the second authoritative
  // wire-leg record (leg-1 already recorded).
  sourceAgg.record('live', null);

  // Both legs succeeded — single board-cache invalidate before emit
  // (mirrors M38 single-item + M42 fail-fast file-bulk invalidate
  // timing; leg-2 mutated the file column's asset state wire-side).
  // The invalidate fires BEFORE emitMutation so a cache-unlink
  // failure surfaces through the runner's catch-all rather than
  // double-emitting after the success envelope already hit stdout.
  await invalidateBoard(inputs.resolveBoardId, inputs.ctx.env);

  // Map the resolver warnings into the envelope `warnings` slot.
  const warnings: readonly Warning[] = collectedWarnings;

  // Success envelope — `data: ItemCreateOutput` from leg-1's
  // projection. `toEmit(leg1Result.response)` threads leg-1's
  // `complexity` + `apiVersion` slots; `sourceAgg.result()`
  // overrides `source` + `cacheAgeSeconds` so the aggregator's
  // result (cache + live blended across every leg) is
  // authoritative. Leg-2's complexity is intentionally NOT folded
  // — the contract pins leg-1's projection on `data`, and the
  // envelope's `meta.complexity` is the create mutation's cost
  // (multipart leg-2 has no GraphQL complexity surface).
  // The output asset from leg-2 is attached to the item server-
  // side; agents read it back via `monday item get <iid> --columns
  // <file-col>` if they need the projection (the file-column
  // dispatch's `Asset` slot is documented per item upload's
  // envelope; the v0.7-M43 success envelope keeps the canonical
  // ItemCreateOutput shape so JSON-path and file-path envelopes
  // remain byte-equivalent on `data`).
  emitMutation({
    ctx: inputs.ctx,
    data: leg1Result.projected,
    schema: itemCreateOutputSchema,
    programOpts: inputs.programOpts,
    warnings,
    ...inputs.toEmit(leg1Result.response),
    ...sourceAgg.result(),
    resolvedIds,
  });
};

// ============================================================
// v0.8-M46 create-time multi-file `--set` carve-out fold (D2
// closure from v0.6-M38). Two-leg-group dispatch — leg-1
// `create_item` then N sequential `add_file_to_column` legs via
// the shared `dispatchFileLegsSequentially` helper (R-v0.8-NEW-1
// lift).
//
// **Status: runtime body shipped at v0.8-M46 IMPL.** The v0.8-M46
// pre-flight contract diff shipped argv parse + create-mode
// resolution + M38 pre-check (returning `kind: 'file_create_multi'`)
// + routing as live contract plus a c8-ignored stub throwing
// `'m46_preflight_stub'`; IMPL swapped the stub for the two-leg-
// group runtime body below. parseArgv + create-mode resolution run
// BEFORE the wire-dispatch leg per R-NEW-76 (graduated v0.5-M34
// pre-flight; wire-dispatch-anchored at v0.7-M43 IMPL).
//
// **Execution shape (shipped at v0.8-M46 IMPL):**
//
//   1. Single upfront `precheckLocalFile` per file path — N file
//      legs × 1 pre-check each (D3 closure). Whole-call abort on
//      any pre-check failure regardless of `--continue-on-error`
//      per cli-design §5.8.
//   2. Partition setEntries — N file entries → leg-2..N+1's
//      `add_file_to_column` legs; remaining non-file entries
//      bundle into leg-1's `create_item` / `create_subitem`
//      `column_values`.
//   3. Leg-1 — `create_item` or `create_subitem` (per
//      `createMode.kind`) with bundled non-file `column_values`.
//      Same wire op as M43's single-file leg-1; reuses
//      `executeCreateItem` / `executeCreateSubitem` helpers.
//   4. Legs 2..N+1 — sequential `executeFileColumnSet` calls
//      against the new item ID, one per file column in argv
//      order (D1 closure — sequential within-item preserves
//      `applied_file_columns` echo accuracy on partial failure).
//   5. Atomicity-envelope shape (D2 closure) — extends M43's
//      orphan-warn discriminator
//      `'create_then_file_upload_partial_failure'` with always-
//      present `details.applied_file_columns: []` slot (length
//      0..N-1 reflecting file columns that landed after leg-1
//      succeeded but before the failing file leg). Length 0
//      corresponds to M43's single-file failure case (leg-2 fails
//      immediately); length k>0 corresponds to multi-file partial
//      failure after k file legs succeeded.
//   6. Envelope emit — `itemCreateWithFilesOutputSchema`
//      (defined above near `itemCreateOutputSchema`):
//      `operation: 'item_create_with_files'` literal + `item:
//      {id, name, board_id, group_id, parent_id?}` (inlines M43's
//      `ItemCreateOutput` shape — leg-1's full item projection,
//      NOT a scalar `item_id`) + `assets: [{column_id, filename,
//      file_size_bytes, asset}, ...]` (length N) +
//      `applied_file_columns: [...]` (length N on success).
//
// **D-list closures inherited from v0.8-plan §3 M46 entry; full
// rationale + watch-items live there.**
// ============================================================

interface RunItemCreateFileMultiDispatchInputs {
  readonly parsed: ParsedInput;
  readonly client: MondayClient;
  readonly multipart: MultipartTransport;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
  readonly apiVersion: string;
  readonly createMode: CreateMode;
  readonly resolveBoardId: string;
  readonly setEntries: readonly SetExpression[];
  readonly rawEntries: readonly ParsedSetRawExpression[];
  readonly m38: Extract<
    PreCheckM38FileDispatchResult,
    { kind: 'file_create_multi' }
  >;
  readonly preflightSource: 'live' | 'cache' | 'mixed' | undefined;
  readonly preflightCacheAgeSeconds: number | null;
  readonly metaSource: 'live' | 'cache' | 'mixed' | undefined;
  readonly metaCacheAgeSeconds: number | null;
  readonly preflightWarnings: readonly ResolverWarning[];
  readonly dateResolution: ResolutionContexts['dateResolution'];
  readonly peopleResolution: ResolutionContexts['peopleResolution'];
  readonly tagResolution: ResolutionContexts['tagResolution'];
  readonly relationResolution: ResolutionContexts['relationResolution'];
  readonly isDryRun: boolean;
  readonly noCache: boolean;
  readonly retries: number;
  readonly toEmit: <T>(response: MondayResponse<T>) => EmitFromNetworkResult;
}

const runItemCreateFileMultiDispatch = async (
  inputs: RunItemCreateFileMultiDispatchInputs,
): Promise<void> => {
  // 1) Upfront pre-check per file path (N pre-checks, argv order;
  //    D3). Atomicity-before-wire per cli-design §5.8 — a bad path
  //    surfaces `usage_error` BEFORE either wire leg fires.
  const legEntries: MultiFileLegEntry[] = [];
  for (const entry of inputs.m38.entries) {
    const precheck = await precheckLocalFile(entry.rawValue);
    legEntries.push({
      columnId: entry.columnId,
      rawValue: entry.rawValue,
      filePath: precheck.filePath,
      filename: precheck.filename,
      fileSizeBytes: precheck.fileSizeBytes,
    });
  }

  // 2) Partition setEntries: every file token routes to a file leg;
  //    the rest bundle into leg-1's `create_item.column_values`.
  const fileTokens = new Set(inputs.m38.entries.map((e) => e.token));
  const nonFileSetEntries = inputs.setEntries.filter(
    (e) => !fileTokens.has(e.token),
  );

  // 3) Dry-run branch — leg-1 planned-changes from planCreate +
  //    N synthetic `add_file_to_column` entries (no item_id; the
  //    item doesn't exist yet). Mirrors M43 single-file dry-run
  //    extended to N file entries.
  if (inputs.isDryRun) {
    let planResult;
    try {
      planResult = await planCreate({
        client: inputs.client,
        mode: inputs.createMode,
        name: inputs.parsed.name,
        setEntries: nonFileSetEntries,
        ...(inputs.rawEntries.length === 0
          ? {}
          : { rawEntries: inputs.rawEntries }),
        dateResolution: inputs.dateResolution,
        peopleResolution: inputs.peopleResolution,
        tagResolution: inputs.tagResolution,
        relationResolution: inputs.relationResolution,
        env: inputs.ctx.env,
        noCache: inputs.noCache,
      });
    } catch (err) {
      if (err instanceof MondayCliError) {
        throw mergeResolverWarningsIntoError(err, inputs.preflightWarnings);
      }
      throw err;
    }

    const dryRunSource = mergeSourceWithPreflight(
      mergeSourceWithPreflight(planResult.source, inputs.metaSource),
      inputs.preflightSource,
    );
    const dryRunCacheAge = mergeCacheAge(
      mergeCacheAge(inputs.metaCacheAgeSeconds, planResult.cacheAgeSeconds),
      inputs.preflightCacheAgeSeconds,
    );

    const fileEntries = legEntries.map((leg) => ({
      operation: 'add_file_to_column' as const,
      column_id: leg.columnId,
      file_path: leg.rawValue,
      filename: leg.filename,
      file_size_bytes: leg.fileSizeBytes,
    }));
    const plannedChanges = [
      ...planResult.plannedChanges,
      ...fileEntries,
    ] as unknown as readonly Readonly<Record<string, unknown>>[];

    emitDryRun({
      ctx: inputs.ctx,
      programOpts: inputs.programOpts,
      plannedChanges,
      source: dryRunSource,
      cacheAgeSeconds: dryRunCacheAge,
      warnings: dedupeCreateWarnings([
        ...inputs.preflightWarnings,
        ...planResult.warnings,
      ]),
      apiVersion: inputs.apiVersion,
    });
    return;
  }

  // 4) Live branch — leg-1 (create_item / create_subitem with bundled
  //    non-file column_values) then legs 2..N+1 (sequential
  //    `add_file_to_column`).
  let resolutionResult;
  try {
    resolutionResult = await resolveAndTranslate({
      client: inputs.client,
      boardId: inputs.resolveBoardId,
      setEntries: nonFileSetEntries,
      rawEntries: inputs.rawEntries,
      dateResolution: inputs.dateResolution,
      peopleResolution: inputs.peopleResolution,
      tagResolution: inputs.tagResolution,
      relationResolution: inputs.relationResolution,
      env: inputs.ctx.env,
      noCache: inputs.noCache,
    });
  } catch (err) {
    if (err instanceof MondayCliError) {
      throw mergeResolverWarningsIntoError(err, inputs.preflightWarnings);
    }
    throw err;
  }

  const collectedWarnings: readonly ResolverWarning[] = dedupeCreateWarnings(
    [...inputs.preflightWarnings, ...resolutionResult.warnings],
  ) as readonly ResolverWarning[];

  const sourceAgg = new SourceAggregator();
  /* c8 ignore next 3 */
  if (inputs.metaSource !== undefined) {
    sourceAgg.record(inputs.metaSource, inputs.metaCacheAgeSeconds);
  }
  if (resolutionResult.source !== undefined) {
    sourceAgg.record(resolutionResult.source, resolutionResult.cacheAgeSeconds);
  }
  if (inputs.preflightSource !== undefined) {
    sourceAgg.record(inputs.preflightSource, inputs.preflightCacheAgeSeconds);
  }

  // resolved_ids — file tokens + non-file tokens.
  const resolvedIds: Readonly<Record<string, string>> = {
    ...Object.fromEntries(inputs.m38.entries.map((e) => [e.token, e.columnId])),
    ...resolutionResult.resolvedIds,
  };

  const translated = resolutionResult.translated;
  const columnValues =
    translated.length === 0 ? null : bundleColumnValues(translated);

  // Leg-1: create_item / create_subitem. F4 remap on failure mirrors
  // M43 single-file leg-1; no orphan handle (no item created yet).
  let leg1Result;
  try {
    if (inputs.createMode.kind === 'subitem') {
      leg1Result = await executeCreateSubitem(inputs.client, {
        parentItemId: inputs.createMode.parentItemId,
        itemName: inputs.parsed.name,
        columnValues,
        createLabelsIfMissing: inputs.parsed.createLabelsIfMissing,
      });
    } else {
      leg1Result = await executeCreateItem(inputs.client, {
        boardId: inputs.createMode.boardId,
        itemName: inputs.parsed.name,
        groupId: inputs.createMode.groupId,
        position: inputs.createMode.position,
        columnValues,
        createLabelsIfMissing: inputs.parsed.createLabelsIfMissing,
      });
    }
  } catch (err) {
    if (err instanceof MondayCliError) {
      throw await foldAndRemap({
        err,
        warnings: collectedWarnings,
        client: inputs.client,
        boardId: inputs.resolveBoardId,
        columnIds: translated.map((t) => t.columnId),
        env: inputs.ctx.env,
        noCache: inputs.noCache,
        resolutionSource: resolutionResult.source ?? 'live',
      });
    }
    /* c8 ignore next */
    throw err;
  }
  sourceAgg.record('live', null);

  // Legs 2..N+1: sequential `add_file_to_column` fan-out against the
  // freshly-created item ID (R-v0.8-NEW-1 shared helper, D1 sequential
  // within-item).
  const createdItemId = leg1Result.projected.id;
  const dispatch = await dispatchFileLegsSequentially({
    client: inputs.client,
    multipart: inputs.multipart,
    itemId: createdItemId,
    entries: legEntries,
    signal: inputs.ctx.signal,
    retries: inputs.retries,
  });

  if (dispatch.failure !== undefined) {
    // Orphan-warn (D1 + D2). Extends M43's single-file discriminator
    // `'create_then_file_upload_partial_failure'` with the always-
    // present `applied_file_columns` slot (length 0..N-1 reflecting
    // file columns that landed after leg-1 succeeded but before the
    // failing file leg). foldAndRemap surfaces `column_archived` for
    // cache-served resolution against an archived column.
    if (dispatch.appliedColumns.length > 0) {
      // ≥1 file leg landed wire-side — invalidate the board cache so a
      // follow-up read doesn't serve stale asset metadata. (M43's
      // single-file leg-2 failure never lands a file, so it skips the
      // invalidate; the multi-file partial case can land legs.)
      await invalidateBoard(inputs.resolveBoardId, inputs.ctx.env);
    }
    const remapped = await foldAndRemap({
      err: dispatch.failure.cause,
      warnings: collectedWarnings,
      client: inputs.client,
      boardId: inputs.resolveBoardId,
      columnIds: [dispatch.failure.failedColumn],
      env: inputs.ctx.env,
      noCache: inputs.noCache,
      resolutionSource: inputs.metaSource ?? 'live',
    });

    const causeProjection: Record<string, unknown> = {
      code: remapped.code,
      message: remapped.message,
    };
    /* c8 ignore next 3 */
    if (remapped.details !== undefined) {
      causeProjection.details = remapped.details;
    }

    const failedColumn = dispatch.failure.failedColumn;
    throw new ApiError(
      'internal_error',
      `Item ${createdItemId} was created on board ${inputs.resolveBoardId} ` +
        `but file upload to column ${failedColumn} failed after ` +
        `${String(dispatch.appliedColumns.length)} of ` +
        `${String(legEntries.length)} file column(s) landed ` +
        `(${remapped.code}: ${remapped.message}). The item + applied file ` +
        `columns persist on Monday; retry the unfailed columns with ` +
        `\`monday item set ${createdItemId} <file-col>=<path>\`, or roll ` +
        `back with \`monday item delete ${createdItemId} --yes\`.`,
      {
        cause: remapped,
        details: {
          reason: 'create_then_file_upload_partial_failure',
          created_item_id: createdItemId,
          applied_file_columns: dispatch.appliedColumns,
          failed_file_column: failedColumn,
          column_id: failedColumn,
          cause: causeProjection,
          hint:
            `the item was created (id ${createdItemId}) and ` +
            `${String(dispatch.appliedColumns.length)} file column(s) ` +
            `landed before column ${failedColumn} failed. Retry the ` +
            `unfailed file columns alone with \`monday item set ` +
            `${createdItemId} <file-col>=<path>\`; or rollback the orphan ` +
            `with \`monday item delete ${createdItemId} --yes\` and re-run ` +
            `the original \`monday item create\` once the underlying ` +
            `cause is fixed.`,
        },
      },
    );
  }
  sourceAgg.record('live', null);

  // All N file legs succeeded — single board-cache invalidate before
  // emit (leg-2..N+1 mutated file-column asset state wire-side).
  await invalidateBoard(inputs.resolveBoardId, inputs.ctx.env);

  const data: ItemCreateWithFilesOutput = {
    operation: 'item_create_with_files',
    item: leg1Result.projected,
    assets: dispatch.assets.map((a) => ({
      column_id: a.column_id,
      filename: a.filename,
      file_size_bytes: a.file_size_bytes,
      asset: a.asset,
    })),
    applied_file_columns: [...dispatch.appliedColumns],
  };
  emitMutation({
    ctx: inputs.ctx,
    data,
    schema: itemCreateWithFilesOutputSchema,
    programOpts: inputs.programOpts,
    warnings: collectedWarnings,
    ...inputs.toEmit(leg1Result.response),
    ...sourceAgg.result(),
    resolvedIds,
  });
};
