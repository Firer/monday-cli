/**
 * Shared item-command helpers (R9, surfaced post-M4 in
 * `v0.1-plan.md` §17; lifted as the M5b opening move).
 *
 * The five M4 item-read commands (`get` / `list` / `find` / `search`
 * / `subitems`) and M5a's dry-run engine all spell the same item
 * GraphQL projection and the same per-command scaffolding:
 *
 *  - The `column_values { id type text value column { title } }`
 *    selection appeared 10× across the five item commands plus once
 *    in `api/dry-run.ts`. A future contract change (a new column-
 *    side field landing on `cli-design.md` §6.2) would otherwise
 *    require a 12-touch sweep.
 *  - The full item-shape selection (id / name / state / url /
 *    created_at / updated_at / board { id } / group { id title } /
 *    parent_item { id } / column_values { ... }) appears in `get`,
 *    `list` (3×), `find` (3×), `search` (2×), `subitems`, and
 *    `dry-run.ts`. Same one-touch contract argument.
 *  - `resolveMeFactory`, `collectColumnHeads`, `titleMap`, and the
 *    parse-then-project closure for collection commands were each
 *    duplicated verbatim across `list.ts` and `search.ts`.
 *
 * Lifting them here gives M5b's mutation surface (`item set` / `item
 * clear` / `item update`) and any future bulk path one place to
 * import from instead of copy-pasting from `commands/item/list.ts`.
 *
 * **Contract surface.** Adding a field to `COLUMN_VALUES_FRAGMENT`
 * (or `ITEM_FIELDS_FRAGMENT`) widens what `cli-design.md` §6.2 /
 * §6.3 surface — bumps the envelope shape across every consumer in
 * lockstep, which is the point. Do not introduce per-command
 * divergence; if a single command needs more fields, extend the
 * fragment and accept the cross-consumer change.
 */
import type { ColumnHead } from '../utils/output/envelope.js';
import { UsageError } from '../utils/errors.js';
import {
  projectItem,
  rawItemSchema,
  type ProjectedItem,
  type RawItem,
} from './item-projection.js';
import type { MondayClient } from './client.js';

/**
 * The `column_values { ... }` selection Monday returns under every
 * item shape in the v0.1 read surface. Inlined as a string because
 * Monday's GraphQL surface accepts only inline expansion at the
 * points the v0.1 commands use it (no `fragment ... on Item`
 * registration is necessary).
 *
 * Indentation matches the spots every existing consumer interpolated
 * — keeping the rendered query bytes identical post-lift means
 * cassettes that hash on the query text continue to match without
 * re-recording.
 */
export const COLUMN_VALUES_FRAGMENT = `column_values {
            id
            type
            text
            value
            column { title }
          }`;

/**
 * The full item-shape selection — every scalar field the v0.1
 * `cli-design.md` §6.2 contract surfaces, plus the
 * `COLUMN_VALUES_FRAGMENT` expansion. Used by `item get` / `list` /
 * `find` / `search` / `subitems` and by the M5a dry-run engine.
 *
 * Indentation lands at the column the hand-rolled queries used so
 * cassette / query-text diffs stay clean post-lift.
 */
export const ITEM_FIELDS_FRAGMENT = `id
          name
          state
          url
          created_at
          updated_at
          board { id }
          group { id title }
          parent_item { id }
          ${COLUMN_VALUES_FRAGMENT}`;

/**
 * Builds the `meta.columns` consolidation slot per `cli-design.md`
 * §6.3 from board metadata. Same shape every collection-list
 * command emits — the per-row `title` lands in the consolidated
 * map, so per-cell title repeats drop from each row.
 *
 * Pure / synchronous; no I/O.
 */
export const collectColumnHeads = (
  metadata: {
    readonly columns: readonly { readonly id: string; readonly type: string; readonly title: string }[];
  },
): Readonly<Record<string, ColumnHead>> => {
  const out: Record<string, ColumnHead> = {};
  for (const c of metadata.columns) {
    out[c.id] = { id: c.id, type: c.type, title: c.title };
  }
  return out;
};

/**
 * Builds a title-by-id map for the `projectItem` projector — the
 * canonical fallback when `column.title` on the wire could drift
 * (M3 metadata loader's NFC + cache rules are the source of truth).
 *
 * Pure / synchronous; no I/O.
 */
export const titleMap = (
  metadata: {
    readonly columns: readonly { readonly id: string; readonly title: string }[];
  },
): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const c of metadata.columns) {
    out.set(c.id, c.title);
  }
  return out;
};

/**
 * Builds the `me`-token resolver every people-aware filter / search
 * command needs. The factory closes over the client; the returned
 * function fires `client.whoami()` on demand. Callers memo-cache the
 * resolved ID per build call to keep `--where Owner=me` cheap.
 *
 * Throws `UsageError` when the token is not associated with a
 * Monday user (guest token, etc.). Defensive — the transport layer
 * surfaces token-association failures as `unauthorized` before this
 * resolver runs.
 */
export const resolveMeFactory = (
  client: MondayClient,
): (() => Promise<string>) => {
  return async () => {
    const response = await client.whoami();
    const me = response.data.me;
    /* c8 ignore next 5 — defensive: Monday's me field is null only
       when the token is invalid / belongs to a guest, which the
       transport layer surfaces as `unauthorized` before this
       resolver runs. The guard exists for type narrowing. */
    if (me === null) {
      throw new UsageError(
        'cannot resolve `me` — token is not associated with a Monday user',
      );
    }
    return me.id;
  };
};

/**
 * Parses one raw GraphQL item-shape and projects it into the §6.2 /
 * §6.3 `ProjectedItem`. A thin wrapper around
 * `rawItemSchema.parse + projectItem` so the collection commands
 * (`list`, `search`) spell the same call once.
 *
 * `omitColumnTitles: true` is the §6.3 same-board-collection rule —
 * per-cell `title` drops out of each column entry (consolidated
 * into `meta.columns`). Single-resource paths (`item get`) skip
 * this helper because they keep titles inline (`item-projection.ts`
 * `projectItem` directly).
 *
 * Note: this helper still uses `rawItemSchema.parse`. R18 (next
 * commit) wraps every `rawItemSchema.parse` call site in the
 * `safeParse + ApiError(internal_error)` pattern per
 * `validation.md` "Never bubble raw ZodError out of a parse
 * boundary"; the wrap lands here in the R18 commit and propagates
 * through every consumer.
 */
export const projectFromRaw = (
  raw: unknown,
  titles: ReadonlyMap<string, string>,
  options: { readonly omitColumnTitles: boolean },
): ProjectedItem => {
  const parsed: RawItem = rawItemSchema.parse(raw);
  return projectItem({
    raw: parsed,
    columnTitles: titles,
    omitColumnTitles: options.omitColumnTitles,
  });
};

export type { RawItem, ProjectedItem };
