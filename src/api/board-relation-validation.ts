/**
 * Validator + parser for v0.3-M19's `board_relation` and `dependency`
 * friendly translators. Each translator's input is a comma-split
 * item-ID list (`<iid1>,<iid2>`); both target columns scope the
 * relation to a specific allowed-board set (Monday's
 * `column.settings.boardIds` for `board_relation` /
 * `column.settings.dependencyBoards` for `dependency`).
 *
 * **Two surfaces.**
 *
 *   - `parseRelationItemIds(raw, columnId, context)` — pure parser.
 *     Comma-splits + trims + filters the raw `--set` value, rejects
 *     empty / over-cap / non-decimal / unsafe-integer / duplicate
 *     inputs as `usage_error` BEFORE any network call. Returns
 *     `readonly number[]` (parallel to the input order, post-dedup).
 *
 *   - `validateBoardRelationItems({ client, itemIds, allowedBoards,
 *     context, env?, noCache? })` — async validator. Batches a single
 *     `items(ids: [...])` query (one trip per `--set` call rather than
 *     one trip per item) and confirms each input item belongs to one
 *     of the column's allowed boards. Mismatches surface as
 *     `usage_error` (built by the caller from the returned
 *     `mismatches: BoardRelationMismatch[]`) so agents can correct
 *     without reading the column's settings separately.
 *
 * **Why a separate module from `column-values.ts`.** Both
 * `board_relation` and `dependency` translators consume the same
 * helpers (different settings field, identical wire shape +
 * resolution path). Keeping the parser + validator in their own
 * module mirrors the precedent set by `dates.ts` / `links.ts` /
 * `emails.ts` / `phones.ts` / `people.ts` — translator-specific
 * machinery isolated from `column-values.ts`'s dispatcher logic
 * for unit-test ergonomics. The `--set` cap (Monday's documented
 * 25-item-per-call ceiling per cli-design §5.3) lives here too;
 * over-cap inputs surface `usage_error` pre-network without
 * burning a complexity-budget call against `items(ids: ...)`.
 *
 * **Always live.** No cache leg — board membership of an item can
 * change cross-call (item moved cross-board), so the validator
 * always hits live. The translator threads
 * `{ source: 'live', cacheAgeSeconds: null }` into
 * `translatorResolution` for symmetry with the tags translator's
 * cache-aware path.
 */

import { z } from 'zod';
import type { MondayClient } from './client.js';
import { ApiError, UsageError } from '../utils/errors.js';

/** Monday's documented per-call cap for relation-column item lists. */
export const BOARD_RELATION_MAX_ITEMS = 25;

/** Decimal non-negative integer, no leading zeros allowed except for `0` itself. */
const DECIMAL_ITEM_ID_PATTERN = /^(?:0|[1-9]\d*)$/u;

export type RelationContext = 'board_relation' | 'dependency';

export interface BoardRelationValidationInputs {
  /**
   * The Monday GraphQL client. Required because the validator
   * batches a single live `items(ids: [...])` query to read each
   * input item's `board.id` and confirm membership in the column's
   * allowed-board set. No cache fallback — board membership of an
   * item can change between calls (item moved cross-board), so the
   * validator always hits live.
   */
  readonly client: MondayClient;
  readonly itemIds: readonly number[];
  readonly allowedBoards: readonly number[];
  /** The translator's column ID — surfaced into mismatch details. */
  readonly columnId: string;
  /**
   * Diagnostic context — surfaced in the throw's `details` so a
   * mismatch between `board_relation` and `dependency` consumers
   * is visible in the error envelope (per cli-design §6.5
   * single-target shape).
   */
  readonly context: RelationContext;
  readonly env?: NodeJS.ProcessEnv;
  readonly noCache?: boolean;
}

export interface BoardRelationMismatch {
  readonly itemId: number;
  /**
   * `null` when the item ID didn't appear in the `items(ids:)`
   * response at all (item deleted, item not visible to the caller's
   * token, or item never existed). A real board ID otherwise.
   */
  readonly actualBoard: number | null;
}

/**
 * Per-item echo for the dry-run + envelope surface — pairs the input
 * item ID with the resolved home-board ID. `boardId` may be `null`
 * if the validator chose to treat a missing-from-response item as a
 * silent zero-row (today every code path that lands here surfaces a
 * mismatch instead, so this is reserved for future relaxations).
 */
export interface ValidatedRelationItem {
  readonly itemId: number;
  readonly boardId: number | null;
}

export type BoardRelationValidationResult =
  | {
      readonly ok: true;
      /**
       * Per-item validation results in input order. Each entry pairs
       * the input item ID with its resolved home-board ID. The
       * translator's relationResolution echo reads from this so dry-run
       * surfaces show the validator's per-item resolution alongside
       * the wire payload. Codex round-2 P1-3 widened the success
       * branch to carry these (the original `{ ok: true }` shape
       * dropped per-item data the dry-run echo needs).
       */
      readonly items: readonly ValidatedRelationItem[];
    }
  | {
      readonly ok: false;
      readonly mismatches: readonly BoardRelationMismatch[];
    };

const ITEMS_BY_ID_QUERY = `
  query ItemsByIdsForRelation($ids: [ID!]!) {
    items(ids: $ids) {
      id
      board {
        id
      }
    }
  }
`;

const itemEntrySchema = z
  .object({
    id: z.string().regex(DECIMAL_ITEM_ID_PATTERN, {
      message: 'item id must be a decimal non-negative integer string',
    }),
    board: z
      .object({
        id: z.string().regex(DECIMAL_ITEM_ID_PATTERN, {
          message: 'board id must be a decimal non-negative integer string',
        }),
      })
      .nullable(),
  })
  .strict();

const itemsResponseSchema = z
  .object({
    items: z.array(itemEntrySchema).nullable(),
  })
  .strict();

interface ItemsByIdsResponse {
  readonly items:
    | readonly {
        readonly id: string;
        readonly board: { readonly id: string } | null;
      }[]
    | null;
}

/**
 * Builds the per-context human noun used in `usage_error` messages
 * + error details. `board_relation` columns are described as
 * "board-relation columns"; `dependency` columns are "dependency
 * columns". Pinned via test so the agent-facing wording stays
 * stable.
 */
const contextNoun = (context: RelationContext): string =>
  context === 'board_relation' ? 'board-relation' : 'dependency';

/**
 * Parses a comma-split item-ID list per cli-design §5.3 step 3 (the
 * `board_relation` / `dependency` translator grammar). Five rejection
 * branches, all surfacing `usage_error` BEFORE any network call so
 * malformed input never burns a complexity-budget call against
 * `items(ids: ...)`:
 *
 *   1. **Empty input** — `--set <col>=""` or `--set <col>=" , , "` —
 *      rejected with a hint pointing at `monday item clear` (mirrors
 *      the dropdown / people / tags empty-input contract).
 *   2. **Over-cap input** — more than `BOARD_RELATION_MAX_ITEMS = 25`
 *      tokens — rejected pre-network so we don't burn a call
 *      against Monday's documented per-call ceiling.
 *   3. **Non-decimal token** — anything that isn't a decimal
 *      non-negative integer string. Hex (`"0x2a"`), scientific
 *      (`"1e3"`), signed (`"-1"`), and decimal (`"1.5"`) forms all
 *      reject here.
 *   4. **Unsafe-integer token** — decimal but exceeds
 *      `Number.MAX_SAFE_INTEGER` (2^53 - 1). `Number(token)` would
 *      lose precision; surfacing as `usage_error` rather than
 *      silently corrupting the wire payload.
 *   5. **Duplicate token** — two tokens reference the same item ID.
 *      Monday's `items_page` does NOT deduplicate `item_ids`, so
 *      a duplicate would either error server-side or silently
 *      double-link. Rejecting client-side keeps the contract
 *      explicit.
 *
 * Returns the parsed item IDs in input-token order (post-dedup is
 * unreachable since we reject duplicates).
 */
export const parseRelationItemIds = (
  raw: string,
  columnId: string,
  context: RelationContext,
): readonly number[] => {
  const noun = contextNoun(context);
  const tokens = raw
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (tokens.length === 0) {
    throw new UsageError(
      `${
        context === 'board_relation' ? 'Board-relation' : 'Dependency'
      } column "${columnId}" needs at least one item ID. ` +
        `Got "${raw}". To clear a ${noun} column, use ` +
        `\`monday item clear <iid> ${columnId} [--board <bid>]\` instead.`,
      {
        details: {
          column_id: columnId,
          column_type: context,
          raw_input: raw,
          hint:
            'pass a comma-separated list of numeric item IDs (e.g. ' +
            `--set ${columnId}=12345,67890). To clear, use ` +
            '`monday item clear` — `--set <col>=""` is value-shaping, ' +
            'not clear-intent (cli-design §5.3 lines 2375–2386).',
        },
      },
    );
  }
  if (tokens.length > BOARD_RELATION_MAX_ITEMS) {
    throw new UsageError(
      `${
        context === 'board_relation' ? 'Board-relation' : 'Dependency'
      } column "${columnId}" got ${tokens.length.toString()} item IDs, ` +
        `which exceeds Monday's documented per-call cap of ` +
        `${BOARD_RELATION_MAX_ITEMS.toString()}. Split the write into ` +
        `multiple calls (each ≤${BOARD_RELATION_MAX_ITEMS.toString()} ` +
        `items) or use --set-raw with a smaller subset.`,
      {
        details: {
          column_id: columnId,
          column_type: context,
          raw_input: raw,
          item_count: tokens.length,
          max_items: BOARD_RELATION_MAX_ITEMS,
          hint:
            `Monday's relation-column item cap is ` +
            `${BOARD_RELATION_MAX_ITEMS.toString()} per --set call. ` +
            `Batch the input across multiple invocations.`,
        },
      },
    );
  }

  const ids: number[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!DECIMAL_ITEM_ID_PATTERN.test(token)) {
      throw new UsageError(
        `${
          context === 'board_relation' ? 'Board-relation' : 'Dependency'
        } column "${columnId}" got non-numeric token "${token}" in ` +
          `input "${raw}". Each token must be a decimal non-negative ` +
          `item ID (Monday item IDs are auto-incremented integers).`,
        {
          details: {
            column_id: columnId,
            column_type: context,
            raw_input: raw,
            token,
            hint:
              `pass numeric item IDs only (e.g. --set ${columnId}=` +
              `12345,67890). The --set-raw escape hatch accepts the ` +
              `literal Monday wire shape if neither form fits.`,
          },
        },
      );
    }
    const parsed = Number(token);
    if (!Number.isSafeInteger(parsed)) {
      throw new UsageError(
        `${
          context === 'board_relation' ? 'Board-relation' : 'Dependency'
        } column "${columnId}" got numeric token "${token}" that ` +
          `exceeds JavaScript's safe-integer range (2^53 - 1, i.e. ` +
          `9007199254740991). Number(token) would lose precision, ` +
          `corrupting the item_ids wire payload.`,
        {
          details: {
            column_id: columnId,
            column_type: context,
            raw_input: raw,
            token,
            hint:
              `Monday item IDs are within JS safe-integer range; if ` +
              `this token is correct, use --set-raw ${columnId}=` +
              `'{"item_ids":[${token}]}' with the literal Monday wire ` +
              `shape.`,
          },
        },
      );
    }
    if (seen.has(token)) {
      throw new UsageError(
        `${
          context === 'board_relation' ? 'Board-relation' : 'Dependency'
        } column "${columnId}" got duplicate item ID "${token}" in ` +
          `input "${raw}". Each --set call links a unique set of ` +
          `items; bundling two references to the same item ID would ` +
          `silently collapse to one link.`,
        {
          details: {
            column_id: columnId,
            column_type: context,
            raw_input: raw,
            token,
            hint:
              `pass each item ID at most once (e.g. --set ${columnId}=` +
              `12345,67890, not 12345,12345).`,
          },
        },
      );
    }
    seen.add(token);
    ids.push(parsed);
  }
  return ids;
};

/**
 * Validates that every input item ID belongs to one of the
 * column's allowed boards. Batches a single `items(ids: [...])`
 * query (Monday charges complexity per-call, not per-id, so
 * batching is a hard requirement, not an optimisation).
 *
 * Returns `{ ok: true, items: [...] }` when every item resolves
 * cleanly (the per-item array surfaces verbatim into the
 * translator's relationResolution echo) OR
 * `{ ok: false, mismatches: [...] }` listing every input item
 * whose `board.id` falls outside the allowed set OR whose entry
 * is missing from Monday's response (item deleted, no visibility,
 * etc.).
 *
 * **Stub-body removal note.** The pre-flight contract diff at
 * `d822982` shipped a `Promise.reject(internal_error)` stub; this
 * runtime body lands at M19 Commit 3 alongside the friendly
 * translator. The success-branch widening (`items: [...]`) is a
 * Codex round-2 P1-3 amendment to the original pre-flight contract.
 */
export const validateBoardRelationItems = async (
  inputs: BoardRelationValidationInputs,
): Promise<BoardRelationValidationResult> => {
  const { client, itemIds, allowedBoards, columnId, context } = inputs;

  // Defensive: an empty input list shouldn't reach the validator
  // (parseRelationItemIds rejects pre-call), but the helper might
  // be called from a future site that has its own input path. Treat
  // empty as a vacuous success — no items to check, none broken.
  /* c8 ignore next 3 — defensive: parseRelationItemIds rejects empty
     pre-call; reaching this branch requires bypassing the parser. */
  if (itemIds.length === 0) {
    return { ok: true, items: [] };
  }

  const allowedSet = new Set<number>(allowedBoards);

  const variables: Readonly<Record<string, unknown>> = {
    ids: itemIds.map((id) => id.toString()),
  };
  const response = await client.raw<ItemsByIdsResponse>(
    ITEMS_BY_ID_QUERY,
    variables,
    { operationName: 'ItemsByIdsForRelation' },
  );
  const parsed = itemsResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }));
    throw new ApiError(
      'internal_error',
      `Monday returned a malformed items(ids:) response while validating ` +
        `${contextNoun(context)} column "${columnId}".`,
      {
        cause: parsed.error,
        details: {
          column_id: columnId,
          column_type: context,
          issues,
          hint:
            "this is a data-integrity error in Monday's response (or a " +
            'response-shape drift); verify the response and update the ' +
            'itemsResponseSchema if Monday\'s contract has changed.',
        },
      },
    );
  }

  // Build a map from id (number) → boardId (number | null). Monday
  // returns items in unspecified order; iterate the input order to
  // preserve the per-item echo's argv-order pin.
  const byId = new Map<number, number | null>();
  for (const entry of parsed.data.items ?? []) {
    const itemNum = Number(entry.id);
    /* c8 ignore next 3 — defensive: itemEntrySchema's regex gates the
       id field at parse boundary, so Number() always returns a finite
       number here. */
    if (!Number.isSafeInteger(itemNum)) continue;
    const boardNum = entry.board === null ? null : Number(entry.board.id);
    /* c8 ignore next 3 — defensive: same regex gates board.id. */
    if (boardNum !== null && !Number.isSafeInteger(boardNum)) continue;
    byId.set(itemNum, boardNum);
  }

  const items: ValidatedRelationItem[] = [];
  const mismatches: BoardRelationMismatch[] = [];
  for (const itemId of itemIds) {
    const actualBoard = byId.get(itemId);
    if (actualBoard === undefined) {
      // Item missing from response entirely — deleted, not visible
      // to the caller's token, or never existed. Surface as mismatch
      // with `actualBoard: null` so the caller can build a single
      // typed error envelope.
      mismatches.push({ itemId, actualBoard: null });
      continue;
    }
    if (actualBoard === null || !allowedSet.has(actualBoard)) {
      mismatches.push({ itemId, actualBoard });
      continue;
    }
    items.push({ itemId, boardId: actualBoard });
  }

  if (mismatches.length > 0) {
    return { ok: false, mismatches };
  }
  return { ok: true, items };
};
