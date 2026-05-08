/**
 * Board-child lookup helper (`v0.2-plan.md` §22 R51 lift).
 *
 * Three M16/M17 dry-run preflight sites share a near-verbatim shape:
 * load `boardMetadataSchema` via `loadBoardMetadata`, find a child
 * entity by ID inside the `columns: [...]` or `groups: [...]` array,
 * and throw `not_found` with `details: { board_id, [<kind>_id]: id }`
 * if the child isn't present. Pre-lift each site was 14 lines (find
 * + undefined-guard + throw + detail-object literal); post-lift each
 * site is one helper call. Pure boilerplate consolidation — the
 * helper preserves the `Monday returned no <noun> with id <id> on
 * board <boardId>` phrasing AND the `not_found` error code AND the
 * `details` object shape byte-identical to the inline form so every
 * existing integration test stays green without modification.
 *
 * **Sites at R51 lift time (3, M17 close):**
 *   - `column-update` (M16) — finds column by id; details.column_id.
 *   - `group-update` (M17) — finds group by id; details.group_id.
 *   - `group-archive` (M17) — finds group by id; details.group_id.
 *
 * The `kind: K` parameter doubles as (a) the `metadata[kind]` array
 * lookup (`columns` / `groups`); (b) the singular noun for the
 * error-message phrasing (`column` / `group`); (c) the
 * `<kind-singular>_id` detail-key suffix (`column_id` / `group_id`).
 * Singular = plural with the trailing `s` stripped — Monday's two
 * board-child entities both spell their detail-key suffix that way
 * and the per-noun divergence (column_id vs group_id) is the only
 * shape difference between the three call sites.
 *
 * **Discriminated return type via `K extends 'columns' | 'groups'`.**
 * Each call site reads field-set-specific properties of the returned
 * child — column-update reads `current.title` + `current.description`;
 * group-update reads `current.title` + `current.color`; group-archive
 * reads all six `BoardGroup` fields for its snapshot projection. The
 * conditional return type (`K extends 'columns' ? BoardColumn :
 * BoardGroup`) preserves type-narrowing at every call site without
 * `as` casts.
 *
 * **Why not parameterised on `errorCode` / `errorMessage`** (cf. R28 /
 * R37 / R43 / R45 / R48). All three current consumers surface
 * `not_found` on missing children — the per-noun divergence is the
 * detail-key suffix, not the error code. Adding `errorCode` would
 * scope-creep into the R28-shaped configurability the trigger
 * doesn't justify (mutation projection has both `internal_error` for
 * create's pre-id null + `not_found` for everything else; finding
 * children in cached metadata is uniformly `not_found`). If a future
 * consumer needs a different code, the parameter can land then —
 * the trigger lineage shows R-class helpers grow parameters as new
 * consumers surface, not pre-emptively.
 *
 * **Future-proofing.** When v0.3 surfaces a fourth child kind (e.g.
 * board subscribers / board permissions), the helper extends
 * cleanly — `kind: K` widens to include the new collection name,
 * the conditional return type extends accordingly, and the noun
 * derivation stays mechanical (`kind.slice(0, -1)`). No call-site
 * breakage.
 */

import { ApiError } from '../utils/errors.js';
import type { BoardColumn, BoardGroup, BoardMetadata } from './board-metadata.js';

/**
 * Map from the `kind` discriminator to the returned child type. The
 * conditional return is expressed via this lookup so call sites
 * receive `BoardColumn` for `kind: 'columns'` and `BoardGroup` for
 * `kind: 'groups'` without an `as` cast.
 */
type BoardChildOf<K extends 'columns' | 'groups'> = K extends 'columns'
  ? BoardColumn
  : BoardGroup;

export interface FindBoardChildOrThrowInputs<K extends 'columns' | 'groups'> {
  readonly metadata: BoardMetadata;
  /**
   * Which `BoardMetadata` collection to search and which detail-key
   * suffix to surface on the thrown error. `'columns'` → searches
   * `metadata.columns`, error noun `column`, detail-key `column_id`.
   * `'groups'` → searches `metadata.groups`, error noun `group`,
   * detail-key `group_id`.
   */
  readonly kind: K;
  readonly id: string;
  readonly boardId: string;
}

/**
 * Finds a child entity (column or group) by ID inside a loaded
 * `BoardMetadata`; throws `ApiError('not_found', ...)` with
 * `details: { board_id, [<kind-singular>_id]: id }` if absent.
 *
 * Caller-supplied IDs that don't correspond to anything on the
 * loaded board surface as `not_found` with both `details.board_id`
 * AND `details.<kind-singular>_id` populated — agents distinguish
 * "wrong board id" (the board fetch itself returned empty;
 * surfaced upstream by `loadBoardMetadata`) from "wrong child id"
 * (this helper's path) without re-reading.
 *
 * Pure projection — never mutates `metadata`.
 */
export const findBoardChildOrThrow = <K extends 'columns' | 'groups'>(
  inputs: FindBoardChildOrThrowInputs<K>,
): BoardChildOf<K> => {
  const { metadata, kind, id, boardId } = inputs;
  const noun = kind === 'columns' ? 'column' : 'group';
  const detailKey = `${noun}_id`;
  const collection: readonly (BoardColumn | BoardGroup)[] =
    kind === 'columns' ? metadata.columns : metadata.groups;
  const found = collection.find((child) => child.id === id);
  if (found === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no ${noun} with id ${id} on board ${boardId}`,
      {
        details: {
          board_id: boardId,
          [detailKey]: id,
        },
      },
    );
  }
  return found as BoardChildOf<K>;
};
