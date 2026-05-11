/**
 * Board-favorites resolver for the v0.3-M23 `monday board favorites`
 * verb + the `monday item search --favorites` cross-board scoping
 * lever (`cli-design.md` §13 v0.3 entry).
 *
 * **Empirical probe findings (2026-05-11, against `api.monday.com`,
 * API version `2026-01`) — `scripts/probe/m23-favorites*.ts` +
 * `scripts/probe/m23-hierarchy-*.ts`:**
 *
 *   - **Favorites lives at the TOP-LEVEL `Query.favorites:
 *     [GraphqlHierarchyObjectItem!]`** — NOT `User.favorites` /
 *     `Board.is_starred` / `me { favorites }`. The original M23
 *     pre-decision wording ("current user's starred boards") was
 *     directionally correct but the surface lives on the Query
 *     root, not the User type.
 *   - **Polymorphic element shape.** Each `GraphqlHierarchyObjectItem`
 *     carries `id` (hierarchy-item ID, distinct from the underlying
 *     object ID), `accountId`, `object: { id: ID, type:
 *     GraphqlMondayObject }` (enum: `Board` | `Folder` |
 *     `Dashboard` | `Workspace`), `folderId`, `position` (Float —
 *     Monday's UI sort order), `createdAt`, `updatedAt`. The
 *     hierarchy-item ID is distinct from `object.id`; the latter
 *     is the underlying Board ID when `object.type === Board`.
 *   - **2-stage GraphQL operation.** Stage 1 fetches `Query.
 *     favorites { id object { id type } position }` and filters
 *     client-side to `object.type === Board`. Stage 2 hydrates the
 *     surviving board IDs via
 *     `boards(ids: [<board-typed-ids>]) { id name workspace_id
 *     state url }` for human-readable + agent-useful slots.
 *   - **Order by `position` (Float).** The probe's `position` field
 *     is Monday's UI sidebar order (lower = higher in the list).
 *     `monday board favorites` sorts by `position` ascending for
 *     parity with what users see in Monday's UI.
 *   - **No write surface in v0.3.** The probe did NOT enumerate
 *     mutations under `Mutation` for favorite/unfavorite — the v0.3
 *     scope is READ-ONLY (`board favorites` lists; the
 *     `item search --favorites` flag consumes the list as a scoping
 *     filter). Writes (`board favorite <bid>` / `board unfavorite
 *     <bid>`) are a v0.4+ candidate.
 *
 * **Sharing with `item search --favorites`.** Both verbs share the
 * favorites-resolver. `monday board favorites` emits the full
 * 2-stage hydrate output (id + name + workspace_id + state + url);
 * `monday item search --favorites` consumes only the board IDs
 * (Stage 1 filter result) since the cross-board fan-out hydrates
 * board names inline via the same `boards(ids:)` call.
 *
 * **What's stub vs runtime at the pre-flight.** `fetchBoardFavorites`
 * ships as a `Promise.reject(internal_error)` stub under `c8 ignore
 * start/stop` — M23 implementation lands the runtime 2-stage body.
 * The schema definitions, type exports, the GraphQL document
 * constants, the pure-helper `filterFavoritesToBoardIds`, and the
 * `sortByPosition` projection ship as REAL implementations so the
 * pre-flight Codex review can verify the projection shape against
 * the empirical-probe fixtures inline.
 *
 * **Mirrors M22 `monday usage` shape.** M22's `fetchUsage` runs a
 * 2-stage projection (`platform_api.daily_limit` +
 * `platform_api.daily_analytics`); `fetchBoardFavorites` runs a
 * 2-stage filter+hydrate. The pre-flight pattern (schema + pure
 * helper as real impl, async fetcher as stub) is the same.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import type { MondayClient } from './client.js';
import type { Complexity } from '../utils/output/envelope.js';

/**
 * Monday's `GraphqlMondayObject` enum discriminator on
 * `HierarchyObjectID.type`. Empirically confirmed via
 * `scripts/probe/m23-monday-object-enum.ts` at 2026-05-11 against
 * API `2026-01`. Includes non-Board kinds because Monday's UI
 * favorites bar includes docs / dashboards / folders / workspaces;
 * the M23 `board favorites` verb FILTERS to `Board` only.
 *
 * Schema kept open-ended (`z.string()` not `z.enum`) to forward-
 * compatibly absorb future Monday enum additions; the filter step
 * matches the LITERAL `Board` string so an unrecognised kind is
 * just "not a board, skip" rather than a parse error.
 */
export const HIERARCHY_OBJECT_TYPE_BOARD = 'Board' as const;

/**
 * Stage-1 GraphQL document — fetches the polymorphic favorites
 * list. No args (`Query.favorites: [GraphqlHierarchyObjectItem!]`
 * empirically has zero args per the introspection probe).
 *
 * The selection set is the minimum the M23 verbs need:
 *   - `id` of the hierarchy item (NOT used downstream — Monday's
 *     surrogate identifier; logged for traceability).
 *   - `object { id type }` — the discriminator + underlying object
 *     ID. The `id` here is the Board ID when `type === Board`.
 *   - `position` — Monday's UI sort key (Float).
 *
 * Not selected: `accountId`, `folderId`, `createdAt`, `updatedAt`
 * — neither verb uses them; selecting widens the response payload
 * for marginal benefit. Future v0.4 may add `createdAt` /
 * `updatedAt` if a "favorited since" filter ships.
 */
export const FAVORITES_LIST_QUERY = `
  query BoardFavoritesStage1 {
    favorites {
      id
      object { id type }
      position
    }
  }
`;

/**
 * Stage-2 GraphQL document — hydrates the surviving board IDs from
 * Stage 1. The `boards(ids:)` surface silently omits inaccessible
 * board IDs (per `scripts/probe/m23-cross-board-search-2.ts` finding
 * #3); the favorites case is one path where silent-omission is the
 * EXPECTED behaviour (the user removed access to a board after
 * favoriting it; we don't want to crash the verb). The hydrator
 * surfaces this as the count delta on the `board_favorites_stale`
 * warning per {@link buildStaleFavoritesWarning}.
 *
 * **Codex P1-1 fix.** The query selects ONLY the leaf board fields
 * `monday board favorites` projects — `complexity` is NOT selected
 * here. Per the project's complexity-injection contract
 * (`src/api/client.ts:257-307` `MondayClient.raw`), the
 * `complexity { ... }` selection is injected at the operation root
 * ONLY when `--verbose` is on, and parsed back out via
 * `parseComplexity`. Hard-coding `complexity` here would (a) leak
 * the field into non-verbose responses (cli-design §6.1 pins
 * `meta.complexity: null` outside `--verbose`), and (b) inflate the
 * per-call cost for every favorites read. The verbose path injects
 * via MondayClient automatically.
 */
export const BOARDS_HYDRATE_QUERY = `
  query BoardFavoritesStage2($ids: [ID!]!) {
    boards(ids: $ids) {
      id
      name
      state
      workspace_id
      url
    }
  }
`;

/**
 * One favorites entry post-Stage-1 parse. The `object.type` field is
 * the polymorphic-favorites discriminator; `object.id` is the
 * underlying object's ID (Board ID when `type === Board`).
 */
export interface RawFavoriteEntry {
  readonly id: string;
  readonly object: { readonly id: string; readonly type: string };
  readonly position: number;
}

export const rawFavoriteEntrySchema = z
  .object({
    id: z.string().min(1),
    object: z
      .object({
        id: z.string().min(1),
        // Open-ended `z.string()` so a future Monday enum extension
        // (e.g., `Form`, `Workdoc`, etc.) doesn't break the parse
        // — the filter step matches the literal `Board` string
        // so unrecognised kinds are just "not a board, skip".
        type: z.string().min(1),
      })
      .strict(),
    position: z.number(),
  })
  .strict();

export const favoritesListResponseSchema = z
  .object({
    favorites: z.array(rawFavoriteEntrySchema).nullable(),
  })
  // `.loose()` so future Monday Query-root extension fields don't
  // fail this parse. Same forward-compat policy as M22's
  // `usageQueryResponseSchema`.
  .loose();

export type FavoritesListResponse = z.infer<typeof favoritesListResponseSchema>;

/**
 * One hydrated board after Stage 2. Matches Monday's `boards(ids:)`
 * selection set on the wire.
 */
export interface RawHydratedBoard {
  readonly id: string;
  readonly name: string;
  readonly state: string | null;
  readonly workspace_id: string | null;
  readonly url: string | null;
}

export const rawHydratedBoardSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    state: z.string().nullable(),
    workspace_id: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict();

export const boardsHydrateResponseSchema = z
  .object({
    boards: z.array(rawHydratedBoardSchema.nullable()).nullable(),
  })
  .loose();

export type BoardsHydrateResponse = z.infer<typeof boardsHydrateResponseSchema>;

/**
 * One row in the `monday board favorites` output. The `position`
 * slot carries Monday's UI sort key for parity — the output is
 * sorted by `position` ascending so agents see the same order
 * users see.
 */
export interface BoardFavoriteOutput {
  readonly id: string;
  readonly name: string;
  readonly state: string | null;
  readonly workspace_id: string | null;
  readonly url: string | null;
  readonly position: number;
}

export const boardFavoriteOutputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    state: z.string().nullable(),
    workspace_id: z.string().nullable(),
    url: z.string().nullable(),
    position: z.number(),
  })
  .strict();

export const boardFavoritesOutputSchema = z.array(boardFavoriteOutputSchema);
export type BoardFavoritesOutput = z.infer<typeof boardFavoritesOutputSchema>;

/**
 * Warning the resolver surfaces when Stage 1 returned N favorite
 * board entries but Stage 2 hydrated fewer (because the user lost
 * access to a board after favoriting it, or the board was deleted).
 * Not fatal — the verb still returns the boards Stage 2 hydrated.
 */
export interface StaleFavoritesWarning {
  readonly code: 'board_favorites_stale';
  readonly message: string;
  readonly details: {
    readonly favorited_count: number;
    readonly hydrated_count: number;
    readonly missing_board_ids: readonly string[];
    readonly hint: string;
  };
}

export const staleFavoritesWarningSchema = z
  .object({
    code: z.literal('board_favorites_stale'),
    message: z.string().min(1),
    details: z
      .object({
        favorited_count: z.number().int().nonnegative(),
        hydrated_count: z.number().int().nonnegative(),
        missing_board_ids: z.array(z.string().min(1)),
        hint: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * Filters {@link FavoritesListResponse} to the surviving Board-typed
 * entries, sorted by `position` ascending for Monday-UI parity.
 * Pure helper — **real implementation** at pre-flight (not a stub).
 */
export const filterFavoritesToBoards = (
  response: FavoritesListResponse,
): readonly RawFavoriteEntry[] => {
  const entries = response.favorites ?? [];
  const boards = entries.filter(
    (e) => e.object.type === HIERARCHY_OBJECT_TYPE_BOARD,
  );
  // Sort by position ascending; ties broken by hierarchy-item id
  // for deterministic output across runs.
  return [...boards].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id.localeCompare(b.id);
  });
};

/**
 * Builds a {@link StaleFavoritesWarning} from the Stage-1 / Stage-2
 * delta. **Real implementation** at pre-flight (pure helper).
 */
export const buildStaleFavoritesWarning = (
  favoritedIds: readonly string[],
  hydratedIds: readonly string[],
): StaleFavoritesWarning => {
  const hydratedSet = new Set(hydratedIds);
  const missing = favoritedIds.filter((id) => !hydratedSet.has(id));
  return {
    code: 'board_favorites_stale',
    message: `${String(missing.length)} of ${String(favoritedIds.length)} favorited boards were not accessible or no longer exist`,
    details: {
      favorited_count: favoritedIds.length,
      hydrated_count: hydratedIds.length,
      missing_board_ids: missing,
      hint: 'a favorited board was deleted, archived to a private workspace, or had access revoked since being favorited',
    },
  };
};

/**
 * Joins the Stage-1 filtered favorites entries (carrying `position`)
 * with the Stage-2 hydrated boards (carrying `name` / `state` /
 * `workspace_id` / `url`) into the final {@link BoardFavoriteOutput}
 * shape. Pure helper — **real implementation** at pre-flight.
 *
 * Result is sorted by `position` ascending (input order from
 * {@link filterFavoritesToBoards}); rows where Stage 2 didn't
 * hydrate (silently omitted by `boards(ids:)`) are filtered out and
 * surfaced via {@link buildStaleFavoritesWarning} at the caller.
 */
export const joinFavoritesWithBoards = (
  filteredFavorites: readonly RawFavoriteEntry[],
  hydratedBoards: readonly RawHydratedBoard[],
): readonly BoardFavoriteOutput[] => {
  const byId = new Map(hydratedBoards.map((b) => [b.id, b]));
  const out: BoardFavoriteOutput[] = [];
  for (const fav of filteredFavorites) {
    const board = byId.get(fav.object.id);
    if (board === undefined) continue; // stale; warning surfaced at the action
    out.push({
      id: board.id,
      name: board.name,
      state: board.state,
      workspace_id: board.workspace_id,
      url: board.url,
      position: fav.position,
    });
  }
  return out;
};

/**
 * Inputs to {@link fetchBoardFavorites}.
 *
 * **Codex P1-1 fix.** Takes the {@link MondayClient} (not
 * `Transport`) so the resolver inherits the project's `--retry` +
 * `--verbose`-complexity contract automatically. MondayClient owns
 * the AbortSignal end-to-end; no per-call `signal` slot needed.
 */
export interface FetchBoardFavoritesInputs {
  readonly client: MondayClient;
}

/**
 * Result of the 2-stage favorites resolver. Carries the hydrated
 * board rows + the optional warning + the per-call envelope-meta
 * fields the command-action emits.
 *
 * **Codex P1-1 fix.** `complexity` is now `Complexity | null` from
 * `src/utils/output/envelope.ts` (matches the project-wide envelope
 * shape on `meta.complexity`); the previous bespoke shape was
 * redundant with the canonical envelope type. `source` /
 * `cacheAgeSeconds` are added so the command-action emits a fully
 * correct §6.1 collection envelope. Favorites is a pure read with
 * no per-call cache; both stages always hit live, so `source` is
 * fixed at `'live'` and `cacheAgeSeconds` at `null`.
 */
export interface FetchBoardFavoritesResult {
  readonly boards: readonly BoardFavoriteOutput[];
  readonly warnings: readonly StaleFavoritesWarning[];
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Issues the 2-stage favorites resolver against `inputs.client`.
 *
 * Stage 1: `FAVORITES_LIST_QUERY` → parse via
 * `favoritesListResponseSchema` → filter via
 * {@link filterFavoritesToBoards} (kind === Board, sort by
 * `position` ascending).
 *
 * Stage 2: `BOARDS_HYDRATE_QUERY` with the filtered Stage-1 IDs →
 * parse via `boardsHydrateResponseSchema` → join via
 * {@link joinFavoritesWithBoards}.
 *
 * Stage-1/Stage-2 count delta surfaces a
 * {@link StaleFavoritesWarning} on `result.warnings`.
 *
 * **Edge case: empty favorites.** When Stage 1 returns no Board-
 * typed entries (or the favorites list is empty/null) the helper
 * short-circuits — no Stage-2 call, empty `boards` output, no
 * warnings. The verb-level envelope is success with an empty
 * `data` array; agents detect via `data.length === 0`.
 *
 * **Parse-failure handling.** A schema mismatch on either stage
 * surfaces `internal_error` with `details.issues` carrying the
 * per-field zod path — a parse failure means Monday amended the
 * surface (forward-compat additions pass through the `.loose()`
 * wrappers; this catches the type-mismatch shapes that the v0.3
 * surface doesn't tolerate).
 *
 * **Complexity / source.** The result's `complexity` is the last
 * stage's value (Stage 2 when it runs, Stage 1 otherwise) — under
 * `--verbose` MondayClient.raw injects + parses `complexity { ... }`
 * at the operation root and returns it on the `MondayResponse`.
 * `source: 'live'` + `cacheAgeSeconds: null` are constants per the
 * P1-1 contract — favorites is a pure live read.
 */
export const fetchBoardFavorites = async (
  inputs: FetchBoardFavoritesInputs,
): Promise<FetchBoardFavoritesResult> => {
  // Stage 1 — fetch the polymorphic favorites list.
  const stage1 = await inputs.client.raw<unknown>(
    FAVORITES_LIST_QUERY,
    undefined,
    { operationName: 'BoardFavoritesStage1' },
  );
  const stage1Parsed = favoritesListResponseSchema.safeParse(stage1.data);
  if (!stage1Parsed.success) {
    throw new ApiError(
      'internal_error',
      'Monday `Query.favorites` response did not match the expected shape',
      {
        cause: stage1Parsed.error,
        details: {
          issues: stage1Parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
          hint: 'Monday may have amended the `Query.favorites` surface — re-probe via `scripts/probe/m23-favorites-deep.ts` and amend cli-design §13 v0.3 entry if so',
        },
      },
    );
  }

  // Filter to Board-typed entries + sort by `position` ascending
  // for Monday-UI parity. Drops Folder / Dashboard / Workspace and
  // any future enum extension (open-ended `z.string()` on
  // `object.type` is forward-compat).
  const filtered = filterFavoritesToBoards(stage1Parsed.data);

  // Empty short-circuit — no Stage 2 if there are no Board-typed
  // favorites. Stage 1's complexity carries forward.
  if (filtered.length === 0) {
    return {
      boards: [],
      warnings: [],
      source: 'live',
      cacheAgeSeconds: null,
      complexity: stage1.complexity,
    };
  }

  // Stage 2 — hydrate the surviving board IDs.
  const filteredIds = filtered.map((e) => e.object.id);
  const stage2 = await inputs.client.raw<unknown>(
    BOARDS_HYDRATE_QUERY,
    { ids: filteredIds },
    { operationName: 'BoardFavoritesStage2' },
  );
  const stage2Parsed = boardsHydrateResponseSchema.safeParse(stage2.data);
  if (!stage2Parsed.success) {
    throw new ApiError(
      'internal_error',
      'Monday `boards(ids:)` response did not match the expected shape',
      {
        cause: stage2Parsed.error,
        details: {
          issues: stage2Parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
          hint: 'Monday may have amended the `boards(ids:)` selection — re-probe via `scripts/probe/m23-favorites-deep.ts` and amend cli-design §13 v0.3 entry if so',
        },
      },
    );
  }

  // Monday's `boards(ids:)` typically silently omits inaccessible
  // entries (per the cross-board probe finding); the schema's
  // `.nullable()` on each entry is defensive for accounts where
  // Monday returns null placeholders instead of omitting. Drop
  // nulls — the favorites case treats both shapes as "stale".
  const hydrated: RawHydratedBoard[] = (stage2Parsed.data.boards ?? []).filter(
    (b): b is RawHydratedBoard => b !== null,
  );

  const joined = joinFavoritesWithBoards(filtered, hydrated);
  const hydratedIds = hydrated.map((b) => b.id);
  const warnings: StaleFavoritesWarning[] = [];
  if (hydratedIds.length < filteredIds.length) {
    warnings.push(buildStaleFavoritesWarning(filteredIds, hydratedIds));
  }

  return {
    boards: joined,
    warnings,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: stage2.complexity,
  };
};
