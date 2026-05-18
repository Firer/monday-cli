/**
 * Column-value writer (`cli-design.md` §5.3, `v0.1-plan.md` §3 M5a).
 *
 * The write half of the column-value abstraction: takes a resolved
 * column + a raw user-supplied string and produces the Monday wire
 * payload Monday's `change_simple_column_value` /
 * `change_column_value` / `change_multiple_column_values` mutations
 * accept.
 *
 * **Two entry points.** Most allowlisted types translate purely
 * locally — no network, no clock dependency beyond the date
 * module's injectable clock — and live behind the sync
 * `translateColumnValue`. The four async types — `people`,
 * `tags`, `board_relation`, `dependency` — hit the network during
 * resolution (email→ID lookup, tag-name→tag-id lookup against the
 * per-account directory, item-allowed-board membership check via
 * batched `items(ids: [...])`). Rather than forcing a
 * `Promise<TranslatedColumnValue>` on every call site for the
 * sync types, `translateColumnValueAsync` is the unified async
 * entry point the command layer always calls. It delegates to the
 * sync version for non-async types and dispatches to
 * `translatePeople` / `translateTags` / `translateRelation` for
 * the async ones. M5b's write surface goes through async
 * exclusively (any of those four types may appear in a `--set`
 * bundle).
 *
 * **Scope.** Thirteen allowlisted types translate (post-M19 close):
 * `text` / `long_text` / `numbers` (simple-string payloads, M5a
 * skeleton); `status` / `dropdown` (rich-object payloads); `date`
 * (rich, with relative-token resolution against the profile
 * timezone); `people` (rich, with `me`-token + email resolution via
 * the M3 `userByEmail` directory cache); the M8 firm additions
 * `link` / `email` / `phone` (pipe-form parsers in `links.ts` /
 * `emails.ts` / `phones.ts`; same `change_column_value` wire path
 * as the v0.1 rich types); and the M19 row — `tags` (rich, with
 * tag-name→tag-id resolution via the per-account directory cache
 * in `tag-directory.ts`), `board_relation` and `dependency`
 * (rich, with `{item_ids: [N1, N2]}` wire shape and per-item
 * allowed-boards validation via
 * `validateBoardRelationItems` in `board-relation-validation.ts`;
 * `board_relation` reads `column.settings.boardIds`, `dependency`
 * reads `column.settings.dependencyBoards`).
 *
 * **Date resolution context** (cli-design §5.3 step 3 + the
 * "Relative dates and timezone" subsection). Relative tokens
 * (`today`, `+3d`, `+2h`) need a clock + a timezone; both come
 * from `TranslateColumnValueInputs.dateResolution`. Defaults to
 * the system clock + system tz when omitted — M5b's command
 * layer plumbs `MONDAY_TIMEZONE` env override through this slot.
 * Tests inject a deterministic clock for DST-boundary coverage.
 * The actual resolution machinery lives in `dates.ts`; this
 * module just delegates and packages the result alongside the
 * other column types.
 *
 * **People resolution context** (cli-design §5.3 step 3 line
 * 728-734 + the `me` token rule line 704-707). Email lookups +
 * `me` resolution come through
 * `TranslateColumnValueAsyncInputs.peopleResolution`, which
 * carries `resolveMe` (mirroring `filters.ts`'s slot, so the
 * same M5b wiring resolves `me` for both filter reads and
 * `--set` writes) and `resolveEmail` (M5b wires this to
 * `resolvers.userByEmail`). Required for people columns; ignored
 * for everything else. The actual parsing machinery lives in
 * `people.ts`.
 *
 * **Mutation selection** (`cli-design.md` §5.3 step 5) lives in
 * `selectMutation` below — single simple → `change_simple_column_value`;
 * single rich → `change_column_value`; N (any combo) →
 * `change_multiple_column_values` (atomic on Monday's side). The
 * multi form re-wraps `long_text`'s simple bare string as
 * `{ text: <value> }` because Monday's per-column blob inside
 * `change_multiple_column_values` requires the object form for
 * `long_text` (a wire-shape divergence from
 * `change_simple_column_value`'s bare-string acceptance — pinned
 * via fixture in the unit suite, logged as a spec gap in
 * `v0.1-plan.md` §3 M5a for cli-design backfill).
 *
 * **No CLI-side label-to-index lookup.** Per `cli-design.md` §5.3
 * step 3: the CLI emits `{ "label": ... }` for label input and
 * `{ "index": N }` for numeric input on `status`; it does *not*
 * traverse `column.settings_str` to resolve labels to their stable
 * indexes. Same shape for `dropdown` — `{ "labels": [...] }` for
 * label input, `{ "ids": [...] }` for all-numeric input. Monday is
 * the validator of last resort; the translator's contract is
 * "produce the documented wire shape, let Monday reject typos as
 * `validation_failed`".
 *
 * **Monday `JSON` scalar discipline** (`cli-design.md` §5.3 step 4).
 * Every payload is a plain JS value (string for the simple form,
 * plain object for the rich form). The SDK / fetch layer is
 * responsible for stringifying at the wire boundary — this module
 * never `JSON.stringify`s. The unit tests in
 * `tests/unit/api/column-values.test.ts` pin the exact wire shape
 * per type as a fixture so M5b and v0.2's bulk surface inherit the
 * rule unchanged.
 *
 * **`--set-raw` escape hatch (M8).** v0.1 had no escape hatch;
 * v0.2's M8 milestone added `--set-raw <col>=<json>` (see
 * `src/api/raw-write.ts`) for column types that don't have a
 * friendly translator yet. Non-allowlisted column types still
 * surface `unsupported_column_type` keyed by roadmap category per
 * `column-types.ts getColumnRoadmapCategory`: tentative writer-
 * expansion types (`tags` / `board_relation` / `dependency`) slipped
 * to v0.3 at M18 close — they get `deferred_to: "v0.3"` plus a
 * `--set-raw` hint, read-only-forever types get
 * `read_only: true`, anything else gets `deferred_to: "future"`
 * with a `--set-raw` hint when the underlying mutation is shaped
 * like `change_column_value`. The M8 contract is "we translate the
 * ten allowlisted types and reject everything else with
 * category-accurate guidance, pointing tentative + future-shaped
 * targets at `--set-raw`."
 */

import { ApiError, UsageError } from '../utils/errors.js';
import type { JsonObject } from '../types/json.js';
import {
  isFilesShapedType,
  isReadOnlyForeverType,
  isV0_2WriterExpansionType,
  isWritableColumnType,
  parseColumnSettings,
  type WritableColumnType,
} from './column-types.js';
import {
  parseDateInput,
  type DateResolution,
  type DateResolutionContext,
} from './dates.js';
import {
  parsePeopleInput,
  type PeopleResolution,
  type PeopleResolutionContext,
} from './people.js';
import { parseLinkInput } from './links.js';
import { parseEmailInput } from './emails.js';
import { parsePhoneInput } from './phones.js';
import type { ResolveTagsResult } from './tag-directory.js';
import {
  parseRelationItemIds,
  type BoardRelationValidationResult,
  type RelationContext,
} from './board-relation-validation.js';

export type { DateResolution, DateResolutionContext } from './dates.js';
export type {
  PeoplePayload,
  PeoplePayloadEntry,
  PeopleResolution,
  PeopleResolutionContext,
  PeopleResolutionToken,
} from './people.js';
export type { LinkPayload } from './links.js';
export type { EmailPayload } from './emails.js';
export type { PhonePayload } from './phones.js';
export type {
  BoardRelationValidationResult,
  RelationContext,
  ValidatedRelationItem,
} from './board-relation-validation.js';

/**
 * Discriminator on the wire payload's *shape*, not the GraphQL
 * mutation that consumes it (one mutation can accept either shape).
 *
 *   - `simple` — bare-string payload accepted by
 *     `change_simple_column_value`. Used by `text`, `long_text`,
 *     `numbers`. When bundled into `change_multiple_column_values`,
 *     `long_text` is re-wrapped to `{ text: <value> }` by
 *     `selectMutation`; the discriminator on the translated value
 *     stays `simple` because that's the column-class fact, not
 *     the per-mutation projection.
 *   - `rich`   — plain-object payload accepted by
 *     `change_column_value` and the per-column entry in
 *     `change_multiple_column_values`. Used by `status`,
 *     `dropdown`, `date`, and `people`. The slot type is
 *     `JsonObject` (R-JsonValue refactor) so non-JSON values
 *     (`undefined`, symbols, functions) can't sneak past the
 *     type system into the wire payload.
 */
export type ColumnValuePayload =
  | { readonly format: 'simple'; readonly value: string }
  | {
      readonly format: 'rich';
      readonly value: JsonObject;
    };

/**
 * Echo of the per-tag resolution for the M19 `tags` translator —
 * one entry per input tag-name, pairing the verbatim input with the
 * resolved Monday tag ID (numeric-string form, mirroring the people
 * translator's `resolved_id` shape). Populated by the `tags`
 * translator; `null` for every other type. The dry-run engine
 * renders this as `details.resolved_from` on tag-column diff cells
 * per cli-design §5.3 design Q5.
 */
export interface TagResolution {
  readonly tokens: readonly TagResolutionToken[];
}

export interface TagResolutionToken {
  readonly input: string;
  readonly resolved_id: string;
}

/**
 * Echo of the per-item resolution for the M19 `board_relation` /
 * `dependency` translators — one entry per validated input item ID,
 * pairing the verbatim input with the home-board ID the validator
 * confirmed lies inside the column's allowed-board set. Shared by
 * both translators (the divergence is which settings field they
 * read; the echo shape is identical). Populated by the relation
 * translators; `null` for every other type.
 *
 * The dry-run engine renders this as `details.resolved_from` on
 * relation-column diff cells per cli-design §5.3 design Q5.
 */
export interface RelationResolution {
  /**
   * Discriminant: `board_relation` or `dependency`. The agent's
   * `details.resolved_from` echo carries the original column type so
   * a wrapper that triages on the resolution shape doesn't have to
   * cross-reference back to the column metadata.
   */
  readonly context: RelationContext;
  /** The allowed-boards list the validator checked against. */
  readonly allowed_boards: readonly number[];
  readonly items: readonly RelationResolutionItem[];
}

export interface RelationResolutionItem {
  /** The verbatim input item ID (decimal string form for round-trip). */
  readonly input: string;
  /** Resolved home board for the item (decimal string form). */
  readonly resolved_board_id: string;
}

/**
 * Translator-side source/cache-age provenance for the
 * `meta.source` + `meta.cache_age_seconds` aggregation pathway.
 * Populated by translators whose resolution may hit the cache
 * (`tags` reads from the per-account directory cache; `people`
 * threads `userByEmail`'s `source`/`cacheAgeSeconds` through the
 * widened `resolveEmail` callback — M19→M20 cleanup-window parity
 * fix per v0.3-plan §11; `board_relation` / `dependency` always
 * live, populating `{source: 'live', cacheAgeSeconds: null}` for
 * the symmetry). `null` for every other type — date / status /
 * dropdown / text / long_text / numbers / link / email / phone
 * don't have a per-translator cache leg today.
 *
 * The dispatcher (`resolveAndTranslate` in `resolution-pass.ts`)
 * merges each translated value's `translatorResolution` into the
 * envelope-level `meta.source` via the existing `mergeSource` /
 * `mergeCacheAge` helpers — same pathway that aggregates per-
 * column-resolution source today.
 */
export interface TranslatorResolutionInfo {
  readonly source: 'cache' | 'live' | 'mixed' | null;
  readonly cacheAgeSeconds: number | null;
}

export interface TranslatedColumnValue {
  /** The resolved column ID — echoed in M5b's mutation envelope. */
  readonly columnId: string;
  /** The resolved column's type — narrowed to `WRITABLE_COLUMN_TYPES`. */
  readonly columnType: WritableColumnType;
  /** The wire payload + format discriminator. */
  readonly payload: ColumnValuePayload;
  /** The raw input the caller passed, preserved for the dry-run diff. */
  readonly rawInput: string;
  /**
   * Echo of the resolution context for relative-token date
   * inputs — populated by the `date` translator when the input
   * was a relative token (`today`, `+3d`, `+2h`) so the
   * dry-run engine can render `details.resolved_from` per
   * cli-design §6.4. `null` for explicit ISO inputs (where
   * the raw input *is* the resolved value) and for
   * non-`date` columns. cli-design §5.3 line 783-786 pins
   * the shape.
   */
  readonly resolvedFrom: DateResolution | null;
  /**
   * Echo of the per-token resolution for the `people` translator —
   * one entry per input token, pairing the verbatim input with the
   * resolved Monday user ID. Populated by the people translator;
   * `null` for every other type. The dry-run engine renders this
   * as `details.resolved_from` on people-column diff cells.
   *
   * **Why a parallel slot rather than widening `resolvedFrom`** —
   * the date echo and people echo are structurally different
   * (`{input, timezone, now}` vs `{tokens: [{input, resolved_id},
   * ...]}`). One slot per kind keeps existing `resolvedFrom`
   * consumers untouched and lets each translator's tests assert on
   * its own shape without an `if kind === 'date'` discriminator
   * dance. v0.2 may widen — extending the union is always
   * available later. The shape itself is a v0.1-plan §3 M5a spec
   * gap for cli-design backfill (the §6.4 sample only shows the
   * date case).
   */
  readonly peopleResolution: PeopleResolution | null;
  /**
   * Echo of the per-tag resolution for the M19 `tags` translator;
   * `null` for every other type. Mutually exclusive with
   * `resolvedFrom` and `peopleResolution` (and with the future
   * `relationResolution` slot Commit 3 lands). The dry-run engine
   * renders this as `details.resolved_from` on tag-column diff
   * cells.
   */
  readonly tagResolution: TagResolution | null;
  /**
   * Echo of the per-item resolution for the M19 `board_relation` /
   * `dependency` translators; `null` for every other type. Mutually
   * exclusive with `resolvedFrom` / `peopleResolution` /
   * `tagResolution`. The dry-run engine renders this as
   * `details.resolved_from` on relation-column diff cells.
   */
  readonly relationResolution: RelationResolution | null;
  /**
   * Source + cache-age provenance for the translator's resolution
   * leg. `null` for translators that don't hit a cache leg (date /
   * status / dropdown / simple types / link / email / phone).
   * Populated by `tags` (reads the per-account tag directory),
   * `people` (M19→M20 cleanup-window — `me` token is always live;
   * each email leg threads `userByEmail`'s `{source,
   * cacheAgeSeconds}`), and the relation translators (always live,
   * for symmetry). Aggregated into envelope-level `meta.source`
   * by `resolveAndTranslate`'s post-translate merge pass.
   */
  readonly translatorResolution: TranslatorResolutionInfo | null;
}

export interface TranslateColumnValueInputs {
  /**
   * The resolved column. `id` and `type` are required; the full
   * `BoardColumn` is fine but not required, so the bulk path can
   * project a slim shape.
   *
   * **`settingsStr` (optional, M19+):** the column's raw
   * `settings_str` from Monday's metadata. Required by the
   * `board_relation` and `dependency` translators (Commits 3 / 4)
   * to derive `column.settings.boardIds` /
   * `column.settings.dependencyBoards` for allowed-board
   * validation. Other translators ignore the field. Optional on
   * the input shape so existing callers (date / people / status
   * / dropdown / simple types) don't need to thread the value
   * through pre-M19; the relation translators throw
   * `internal_error` if the field is absent at translation time.
   */
  readonly column: {
    readonly id: string;
    readonly type: string;
    readonly settingsStr?: string | null;
  };
  /** The raw user-supplied value (post-`--set` parsing). */
  readonly value: string;
  /**
   * Resolution context for the `date` translator's relative
   * tokens (`today`, `+3d`, `+2h`). Ignored for non-`date`
   * columns. Defaults to system clock + system tz when omitted;
   * M5b's command layer plumbs `MONDAY_TIMEZONE` env override
   * through this slot per cli-design §5.3 line 765.
   */
  readonly dateResolution?: DateResolutionContext;
}

/**
 * Resolution context for the M19 `tags` translator. Mirrors the
 * `peopleResolution` slot one-to-one: a single async callback the
 * command layer wires upstream so the translator stays pure (no
 * `MondayClient` / `env` reaches `column-values.ts`).
 *
 * The callback takes the raw user-supplied input (the comma-split
 * tag-name list, post-`--set` parsing) and returns the
 * `ResolveTagsResult` from `tag-directory.resolveTags` — `{ ids,
 * misses, source, cacheAgeSeconds }`. The translator threads
 * `source` + `cacheAgeSeconds` into `translatorResolution` for
 * envelope-level aggregation, and threads `ids` into the wire
 * payload + the per-tag `tagResolution` echo. Misses surface as
 * `tag_not_found` (the translator's responsibility, not the
 * callback's).
 */
export interface TagResolutionContext {
  readonly resolveTags: (input: string) => Promise<ResolveTagsResult>;
}

/**
 * Resolution context for the M19 `board_relation` / `dependency`
 * translators. A single async callback the command layer wires
 * upstream so the translator stays pure (no `MondayClient` / `env`
 * reaches `column-values.ts`).
 *
 * The callback takes the parsed item-ID list (post `parseRelationItemIds`),
 * the column's allowed-boards list (derived from `column.settings`
 * — `boardIds` for `board_relation`, `dependencyBoards` for
 * `dependency`), and the diagnostic context discriminant; it returns
 * the `BoardRelationValidationResult` from `validateBoardRelationItems`.
 *
 * The context is shared by both translators because the validator
 * shape is identical — only the settings field the translator reads
 * to populate `allowedBoards` differs. Routing through one callback
 * keeps the resolution-context builder simple (one closure over
 * `MondayClient` rather than two).
 */
export interface RelationResolutionContext {
  readonly validateItems: (inputs: {
    readonly itemIds: readonly number[];
    readonly allowedBoards: readonly number[];
    readonly columnId: string;
    readonly context: RelationContext;
  }) => Promise<BoardRelationValidationResult>;
}

/**
 * Async-entry inputs — superset of `TranslateColumnValueInputs`
 * with the people-resolution slot. Required for people columns;
 * ignored for everything else. The async entry point delegates
 * to the sync version when `column.type !== 'people'`, so the
 * `peopleResolution` slot can be omitted in callers that know
 * they're never targeting a people column.
 *
 * In M5b's command layer, the slot is always passed (the layer
 * doesn't know in advance which column types appear in a
 * multi-`--set` bundle).
 */
export interface TranslateColumnValueAsyncInputs extends TranslateColumnValueInputs {
  /**
   * Resolution context for the `people` translator's `me` token
   * + email lookups. Required for people columns; ignored for
   * non-people types. cli-design §5.3 step 3 line 728-734 +
   * line 704-707 pin the grammar.
   */
  readonly peopleResolution?: PeopleResolutionContext;
  /**
   * Resolution context for the M19 `tags` translator. Required
   * for `tags` columns; ignored for non-`tags` types. The command
   * layer wires `resolveTags` through `buildResolutionContexts`
   * (closing over the shared `MondayClient` + `env` + cache
   * controls).
   */
  readonly tagResolution?: TagResolutionContext;
  /**
   * Resolution context for the M19 `board_relation` / `dependency`
   * translators. Required when any `--set` token resolves to one of
   * those types; the translator throws `internal_error` if the slot
   * is absent. The command layer wires `validateItems` through
   * `buildResolutionContexts`.
   */
  readonly relationResolution?: RelationResolutionContext;
}

/**
 * Translates a single `<column>=<value>` pair into the Monday wire
 * payload. **Sync entry point — handles the nine types whose
 * translation is purely local computation** (`text` / `long_text` /
 * `numbers` / `status` / `dropdown` / `date` / `link` / `email` /
 * `phone`). For `people` columns, use `translateColumnValueAsync`:
 * people resolution can hit the network (email→ID lookup) and is
 * therefore async-only.
 *
 * **Throws** `ApiError`:
 *   - `unsupported_column_type` — type not in the friendly
 *     allowlist. Carries `column_id` + `type` plus per-category
 *     details: `deferred_to: "v0.3"` for the tentative writer-
 *     expansion row that slipped from v0.2 (`tags` /
 *     `board_relation` / `dependency`), `read_only: true` for
 *     read-only-forever types (mirror / formula / auto_number /
 *     creation_log / last_updated / item_id), `deferred_to:
 *     "future"` for anything else. The `--set-raw` escape hatch
 *     (M8) accepts most non-allowlisted types.
 *   - `internal_error` — sync entry was called on a `people`
 *     column. Programmer error: the write surface always uses
 *     `translateColumnValueAsync`. The check exists so a future
 *     contributor doesn't accidentally regress to a sync code
 *     path that silently mis-translates people input.
 *
 * **Throws** `UsageError`:
 *   - `usage_error` — for status / dropdown numeric input that
 *     exceeds `Number.MAX_SAFE_INTEGER`, dropdown input that
 *     contains no labels and no IDs after trim + filter, `date`
 *     input that does not match any supported form (ISO date,
 *     ISO date+time, or relative token), invalid URL / email /
 *     phone in the link / email / phone translators, or
 *     pipe-form input with empty leader/trailer in those types.
 *     See `unsafeIntegerError`, the dropdown empty-input branch,
 *     `dates.parseDateInput`, `links.parseLinkInput`,
 *     `emails.parseEmailInput`, and `phones.parsePhoneInput` for
 *     the documented messages.
 */
export const translateColumnValue = (
  inputs: TranslateColumnValueInputs,
): TranslatedColumnValue => {
  const { column, value, dateResolution } = inputs;
  if (!isWritableColumnType(column.type)) {
    throw unsupportedColumnTypeError(column.id, column.type);
  }
  switch (column.type) {
    case 'text':
      return simple(column.id, 'text', value);
    case 'long_text':
      return simple(column.id, 'long_text', value);
    case 'numbers':
      return simple(column.id, 'numbers', value);
    case 'status':
      return rich(column.id, 'status', value, translateStatus(value, column.id));
    case 'dropdown':
      return rich(column.id, 'dropdown', value, translateDropdown(column.id, value));
    case 'date': {
      const parsed = parseDateInput(value, column.id, dateResolution);
      return {
        columnId: column.id,
        columnType: 'date',
        rawInput: value,
        payload: { format: 'rich', value: parsed.payload },
        resolvedFrom: parsed.resolvedFrom,
        peopleResolution: null,
        tagResolution: null,
        relationResolution: null,
        translatorResolution: null,
      };
    }
    case 'link': {
      // LinkPayload's `{url, text}` literal type is structurally a
      // JsonObject (both fields are JsonValues) but TypeScript treats
      // closed object types as not implicitly satisfying the open
      // index signature. Same cast pattern the people translator
      // uses; see src/types/json.ts for the documented trade.
      const parsed = parseLinkInput(value, column.id);
      return {
        columnId: column.id,
        columnType: 'link',
        rawInput: value,
        payload: { format: 'rich', value: parsed as unknown as JsonObject },
        resolvedFrom: null,
        peopleResolution: null,
        tagResolution: null,
        relationResolution: null,
        translatorResolution: null,
      };
    }
    case 'email': {
      const parsed = parseEmailInput(value, column.id);
      return {
        columnId: column.id,
        columnType: 'email',
        rawInput: value,
        payload: { format: 'rich', value: parsed as unknown as JsonObject },
        resolvedFrom: null,
        peopleResolution: null,
        tagResolution: null,
        relationResolution: null,
        translatorResolution: null,
      };
    }
    case 'phone': {
      const parsed = parsePhoneInput(value, column.id);
      return {
        columnId: column.id,
        columnType: 'phone',
        rawInput: value,
        payload: { format: 'rich', value: parsed as unknown as JsonObject },
        resolvedFrom: null,
        peopleResolution: null,
        tagResolution: null,
        relationResolution: null,
        translatorResolution: null,
      };
    }
    case 'people':
      // People translation is async (email→ID lookup hits the
      // directory cache or the `users(emails:)` GraphQL endpoint).
      // Surface as `internal_error` so a future contributor who
      // accidentally routes a people column through the sync entry
      // point sees a loud programmer-error message rather than a
      // silent payload corruption. M5b's command layer always uses
      // `translateColumnValueAsync` for write paths.
      throw new ApiError(
        'internal_error',
        `translateColumnValue (sync) called on people column "${column.id}". ` +
          `People resolution is async — use translateColumnValueAsync.`,
        {
          details: {
            column_id: column.id,
            column_type: column.type,
            hint: 'use translateColumnValueAsync from src/api/column-values.ts',
          },
        },
      );
    case 'tags':
      // Tag translation is async (tag-name→tag-id resolution hits
      // the per-account directory cache or the `account.tags`
      // GraphQL endpoint). Surface as `internal_error` for the same
      // reason as `people` — a future contributor who accidentally
      // routes a tags column through the sync entry point sees a
      // loud programmer-error message rather than a silent payload
      // corruption.
      throw new ApiError(
        'internal_error',
        `translateColumnValue (sync) called on tags column "${column.id}". ` +
          `Tag resolution is async — use translateColumnValueAsync.`,
        {
          details: {
            column_id: column.id,
            column_type: column.type,
            hint: 'use translateColumnValueAsync from src/api/column-values.ts',
          },
        },
      );
    case 'board_relation':
    case 'dependency':
      // Relation translation is async (the validator hits live
      // `items(ids: [...])` against Monday). Same programmer-error
      // shape as people / tags. board_relation lands at Commit 3,
      // dependency at Commit 4 — both share the same sync guard.
      throw new ApiError(
        'internal_error',
        `translateColumnValue (sync) called on ${column.type} column "${column.id}". ` +
          `Relation validation is async — use translateColumnValueAsync.`,
        {
          details: {
            column_id: column.id,
            column_type: column.type,
            hint: 'use translateColumnValueAsync from src/api/column-values.ts',
          },
        },
      );
  }
};

/**
 * Async entry point — handles every type in `WRITABLE_COLUMN_TYPES`.
 * Delegates to `translateColumnValue` (sync) for non-people columns;
 * dispatches to `parsePeopleInput` for `people`.
 *
 * The `peopleResolution` slot is required when `column.type ===
 * 'people'`. Omitting it for a people column raises `internal_error`
 * (programmer wiring bug) — agents see this as a loud failure
 * rather than a silent fallback to the unsupported-type path.
 *
 * **Throws** every error `translateColumnValue` throws (delegated
 * unchanged for non-people types), plus:
 *   - `ApiError(user_not_found)` — bubbled from `peopleResolution.
 *     resolveEmail` for unknown emails. cli-design.md §5.3 step 3
 *     line 733 pins the contract.
 *   - `UsageError(usage_error)` — empty / numeric people input.
 *     See `parsePeopleInput` for the per-branch messages.
 *   - `ApiError(internal_error)` — `peopleResolution` was omitted
 *     for a people column.
 */
/**
 * Builds the per-type "clear" payload for `monday item clear`. The
 * dedicated verb keeps `--set <col>=<value>` and the clear path
 * non-overlapping (cli-design §5.3 step 3 explicitly notes that
 * empty-string input on `status` is `{label: ""}`, NOT a clear; the
 * translator is value-shaping, not intent-disambiguating).
 *
 * Per-type clear shapes:
 *   - `text` / `long_text` / `numbers` → simple bare empty string
 *     (`change_simple_column_value(value: "")` clears the cell).
 *   - `status` / `dropdown` / `date` / `people` → empty JSON object
 *     `{}` via `change_column_value(value: JSON!)`. Monday's
 *     official "clear all column values" pattern.
 *
 * **Throws** `unsupported_column_type` for types outside the v0.1
 * writable allowlist — same code path the value translator uses,
 * keyed by roadmap category (`deferred_to: "v0.3"` /
 * `read_only: true` / `deferred_to: "future"`). Agents see the
 * same per-category surface across `item set` / `item update` /
 * `item clear`, so a wrapper that triages on the error details
 * doesn't need a per-verb branch.
 *
 * Sync entry — `people` clear doesn't need email resolution (the
 * payload is `{}` regardless of who's currently assigned). Reused
 * by the `item clear` dry-run + live paths.
 */
export const translateColumnClear = (
  column: { readonly id: string; readonly type: string },
): TranslatedColumnValue => {
  if (!isWritableColumnType(column.type)) {
    throw unsupportedColumnTypeError(column.id, column.type);
  }
  switch (column.type) {
    case 'text':
    case 'long_text':
    case 'numbers':
      return {
        columnId: column.id,
        columnType: column.type,
        rawInput: '',
        payload: { format: 'simple', value: '' },
        resolvedFrom: null,
        peopleResolution: null,
        tagResolution: null,
        relationResolution: null,
        translatorResolution: null,
      };
    case 'status':
    case 'dropdown':
    case 'date':
    case 'people':
    case 'link':
    case 'email':
    case 'phone':
    case 'tags':
    case 'board_relation':
    case 'dependency':
      // Rich types clear to `{}` via change_column_value per
      // cli-design §5.3 "Clearing column values" table. M8 firm row
      // (link / email / phone) and M19 row (tags / board_relation /
      // dependency) extend the table verbatim — same payload, same
      // mutation, same dispatch.
      return {
        columnId: column.id,
        columnType: column.type,
        rawInput: '',
        payload: { format: 'rich', value: {} },
        resolvedFrom: null,
        peopleResolution: null,
        tagResolution: null,
        relationResolution: null,
        translatorResolution: null,
      };
  }
};

export const translateColumnValueAsync = async (
  inputs: TranslateColumnValueAsyncInputs,
): Promise<TranslatedColumnValue> => {
  if (inputs.column.type === 'people') {
    return translatePeople(inputs);
  }
  if (inputs.column.type === 'tags') {
    return translateTags(inputs);
  }
  if (inputs.column.type === 'board_relation') {
    return translateRelation(inputs, 'board_relation');
  }
  if (inputs.column.type === 'dependency') {
    return translateRelation(inputs, 'dependency');
  }
  return translateColumnValue(inputs);
};

const translatePeople = async (
  inputs: TranslateColumnValueAsyncInputs,
): Promise<TranslatedColumnValue> => {
  const { peopleResolution } = inputs;
  if (peopleResolution === undefined) {
    throw new ApiError(
      'internal_error',
      `translateColumnValueAsync requires a peopleResolution context for ` +
        `people column "${inputs.column.id}". M5b's command layer wires ` +
        `resolveMe + resolveEmail through this slot.`,
      {
        details: {
          column_id: inputs.column.id,
          column_type: 'people',
          hint:
            'pass { peopleResolution: { resolveMe, resolveEmail } } when ' +
            'calling translateColumnValueAsync.',
        },
      },
    );
  }
  const parsed = await parsePeopleInput(
    inputs.value,
    inputs.column.id,
    peopleResolution,
  );
  return {
    columnId: inputs.column.id,
    columnType: 'people',
    rawInput: inputs.value,
    // PeoplePayload is structurally a JsonObject — it has one
    // declared key (`personsAndTeams`) whose value is a readonly
    // array of plain objects with `id: number` and `kind:
    // 'person'` (both JsonValues). TypeScript treats closed
    // object types as not implicitly satisfying open index
    // signatures even when their values all line up, so the cast
    // is structural-typing-only. Runtime shape is unchanged; the
    // wire-shape fixture in the unit suite is the load-bearing
    // pin. See `src/types/json.ts` for the JsonObject definition
    // and the closed-type-literal note that documents this trade.
    payload: {
      format: 'rich',
      value: parsed.payload as unknown as JsonObject,
    },
    resolvedFrom: null,
    peopleResolution: parsed.resolution,
    tagResolution: null,
    relationResolution: null,
    // M19→M20 cleanup-window parity fix: thread the people
    // resolution's aggregated source/age into translatorResolution
    // so envelope-level meta.source reflects cache-hit email
    // lookups. Pre-fix this slot was `null` and cache hits silently
    // dropped from the aggregate (v0.3-plan §11 post-mortem).
    translatorResolution: {
      source: parsed.source,
      cacheAgeSeconds: parsed.cacheAgeSeconds,
    },
  };
};

/**
 * Async translator for the M19 `tags` column type. Resolves a
 * comma-split tag-name list against the per-account directory
 * (cache-then-live via `tagResolution.resolveTags`), surfaces the
 * wire payload `{ tag_ids: [N1, N2] }`, populates the per-tag
 * `tagResolution` echo for dry-run rendering, and threads
 * source/cache-age provenance through `translatorResolution` for
 * envelope-level aggregation.
 *
 * **Empty input rejected** — mirrors the dropdown / people empty-
 * input contract per cli-design §5.3 lines 2375–2386 (`--set
 * <col>=""` is value-shaping, not clear-intent; `monday item clear`
 * is the dedicated clear surface). Surfaces `usage_error` with
 * `details.hint` pointing at `monday item clear`.
 *
 * **Misses surface as `tag_not_found`** — single error envelope
 * with `details: { tags: misses[] }` per cli-design §6.5 +
 * Decision 1 (`4c652d5`). Multi-miss `--set tags=foo,bar,baz` where
 * two tags are absent surfaces ONE error with `tags: ["foo", "bar"]`,
 * NOT two separate errors.
 */
const translateTags = async (
  inputs: TranslateColumnValueAsyncInputs,
): Promise<TranslatedColumnValue> => {
  const { tagResolution } = inputs;
  if (tagResolution === undefined) {
    throw new ApiError(
      'internal_error',
      `translateColumnValueAsync requires a tagResolution context for tags ` +
        `column "${inputs.column.id}". M19's command layer wires resolveTags ` +
        `through this slot via buildResolutionContexts.`,
      {
        details: {
          column_id: inputs.column.id,
          column_type: 'tags',
          hint:
            'pass { tagResolution: { resolveTags } } when calling ' +
            'translateColumnValueAsync. The resolveTags callback closes ' +
            'over MondayClient + env + noCache.',
        },
      },
    );
  }
  // Empty input boundary: split + trim + filter — if nothing is left
  // after the split, the user passed `--set tags=""` or `--set
  // tags=" , "`. Reject with usage_error pointing at `monday item
  // clear` (mirror dropdown/people empty-input contract).
  const tokens = inputs.value
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (tokens.length === 0) {
    throw new UsageError(
      `Tags column "${inputs.column.id}" needs at least one tag name. ` +
        `Got "${inputs.value}". To clear a tags column, use ` +
        `\`monday item clear <iid> ${inputs.column.id} [--board <bid>]\` instead.`,
      {
        details: {
          column_id: inputs.column.id,
          column_type: 'tags',
          raw_input: inputs.value,
          hint:
            'pass a comma-separated list of tag names (e.g. --set ' +
            `${inputs.column.id}=launch,priority). To clear, use ` +
            '`monday item clear` — `--set tags=""` is value-shaping, ' +
            'not clear-intent (cli-design §5.3 lines 2375–2386).',
        },
      },
    );
  }

  const resolved = await tagResolution.resolveTags(inputs.value);
  if (resolved.misses.length > 0) {
    const missList = resolved.misses.map((m) => JSON.stringify(m)).join(', ');
    const noun = resolved.misses.length === 1 ? 'tag' : 'tags';
    throw new ApiError(
      'tag_not_found',
      `${resolved.misses.length.toString()} ${noun} not in the account directory: ${missList}`,
      {
        details: {
          tags: resolved.misses,
          hint: 'Run `monday account tags` to list available tags.',
        },
      },
    );
  }

  // Build the per-token echo. resolveTags returns ids in input-token
  // order (post-dedup); zip with the dedup'd token list to surface
  // the verbatim input alongside each resolved id.
  const dedup: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const key = token
      .normalize('NFC')
      .trim()
      .replace(/\s+/gu, ' ')
      .toLocaleLowerCase('und');
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(token);
  }
  const echoTokens: TagResolutionToken[] = dedup.map((token, i) => ({
    input: token,
    /* c8 ignore next 5 — defensive: resolveTags returns ids parallel
       to the dedup'd input order (length-matched), so `id` is always
       present at index `i`. The String() guard exists for
       noUncheckedIndexedAccess narrowing only. */
    resolved_id: String(resolved.ids[i] ?? ''),
  }));

  return {
    columnId: inputs.column.id,
    columnType: 'tags',
    rawInput: inputs.value,
    payload: {
      format: 'rich',
      value: { tag_ids: [...resolved.ids] },
    },
    resolvedFrom: null,
    peopleResolution: null,
    tagResolution: { tokens: echoTokens },
    relationResolution: null,
    translatorResolution: {
      source: resolved.source,
      cacheAgeSeconds: resolved.cacheAgeSeconds,
    },
  };
};

/**
 * Async translator for the M19 `board_relation` and `dependency`
 * column types. Both share the same wire shape
 * (`{ item_ids: [N1, N2] }`) and the same per-item allowed-boards
 * validator; the divergence is the settings field the per-translator
 * arm reads (`column.settings.boardIds` for `board_relation` /
 * `column.settings.dependencyBoards` for `dependency`).
 *
 * **Five-step resolution.**
 *
 *   1. Require `relationResolution` context (programmer-error guard
 *      mirroring `tags` / `people`).
 *   2. Require `column.settingsStr` (the field the resolver-pass
 *      threads through). Surfacing this as `internal_error` rather
 *      than `usage_error` because the resolver-pass always supplies
 *      the field; reaching this branch is a wiring bug.
 *   3. Parse `parseRelationItemIds(value, columnId, context)` for
 *      input validation — empty / over-cap / non-decimal /
 *      unsafe-integer / duplicate inputs reject pre-network.
 *   4. Derive `allowedBoards` from the parsed settings shape per
 *      `context` discriminant. Empty `allowedBoards` (no boards
 *      configured on the column) surfaces `usage_error` — the
 *      validator can't validate against an empty allowed set.
 *   5. Call `relationResolution.validateItems({ ... })`. On
 *      mismatch, surface `usage_error` with per-item details. On
 *      success, build the wire payload + per-item echo.
 *
 * **`translatorResolution`** carries `{ source: 'live',
 * cacheAgeSeconds: null }` for symmetry with the tags translator's
 * cache-aware path. The relation validator is always live (item
 * board membership can change cross-call), but threading the slot
 * keeps the post-translate aggregation pass's shape uniform.
 */
const translateRelation = async (
  inputs: TranslateColumnValueAsyncInputs,
  context: RelationContext,
): Promise<TranslatedColumnValue> => {
  const { relationResolution } = inputs;
  if (relationResolution === undefined) {
    throw new ApiError(
      'internal_error',
      `translateColumnValueAsync requires a relationResolution context for ` +
        `${context} column "${inputs.column.id}". M19's command layer wires ` +
        `validateItems through this slot via buildResolutionContexts.`,
      {
        details: {
          column_id: inputs.column.id,
          column_type: context,
          hint:
            'pass { relationResolution: { validateItems } } when calling ' +
            'translateColumnValueAsync. The validateItems callback closes ' +
            'over MondayClient.',
        },
      },
    );
  }
  if (
    inputs.column.settingsStr === undefined ||
    inputs.column.settingsStr === null
  ) {
    throw new ApiError(
      'internal_error',
      `translateColumnValueAsync requires column.settingsStr for ${context} ` +
        `column "${inputs.column.id}" — the translator reads ` +
        `${
          context === 'board_relation' ? 'boardIds' : 'dependencyBoards'
        } from settings to derive allowed boards.`,
      {
        details: {
          column_id: inputs.column.id,
          column_type: context,
          hint:
            'the resolver-pass threads settings_str through ResolvedSet; ' +
            'verify the call site passes column.settingsStr (R20 lift, ' +
            'M19 widening).',
        },
      },
    );
  }

  const itemIds = parseRelationItemIds(inputs.value, inputs.column.id, context);

  const settings = parseColumnSettings(inputs.column.settingsStr);
  const allowedBoards = deriveAllowedBoards(settings, context);
  if (allowedBoards.length === 0) {
    throw new UsageError(
      `${
        context === 'board_relation' ? 'Board-relation' : 'Dependency'
      } column "${inputs.column.id}" has no ${
        context === 'board_relation' ? 'allowed boards' : 'dependency boards'
      } configured. Configure the column's linked-board list in Monday's ` +
        `UI before linking items via --set, or use --set-raw with the ` +
        `literal Monday wire shape.`,
      {
        details: {
          column_id: inputs.column.id,
          column_type: context,
          raw_input: inputs.value,
          hint:
            `${
              context === 'board_relation' ? 'board_relation' : 'dependency'
            } columns scope item links to a configured set of boards; the ` +
            `translator can't validate item membership against an empty ` +
            `allowed set.`,
        },
      },
    );
  }

  const result = await relationResolution.validateItems({
    itemIds,
    allowedBoards,
    columnId: inputs.column.id,
    context,
  });

  if (!result.ok) {
    throw new UsageError(
      buildRelationMismatchMessage(inputs.column.id, context, result.mismatches),
      {
        details: {
          column_id: inputs.column.id,
          column_type: context,
          raw_input: inputs.value,
          allowed_boards: allowedBoards,
          mismatches: result.mismatches.map((m) => ({
            item_id: m.itemId,
            actual_board: m.actualBoard,
          })),
          hint:
            `each item must belong to one of the column's allowed boards ` +
            `[${allowedBoards.join(', ')}]. Items missing from the response ` +
            `(actual_board: null) were not visible to the caller's token, ` +
            `archived, or deleted.`,
        },
      },
    );
  }

  // Build per-item echo from the validator's items array. The
  // validator preserves input-token order (parseRelationItemIds
  // rejects duplicates so order-preservation is straightforward).
  const echoItems: RelationResolutionItem[] = result.items.map((item) => ({
    input: item.itemId.toString(),
    /* c8 ignore next 5 — defensive: validateItems only returns items
       in result.items when the per-item check passes (boardId is
       present + allowed). String() guard for noUncheckedIndexedAccess
       narrowing. */
    resolved_board_id: item.boardId === null ? '' : item.boardId.toString(),
  }));

  return {
    columnId: inputs.column.id,
    // Type-cast: at Commit 3 only `'board_relation'` is in
    // WRITABLE_COLUMN_TYPES; Commit 4 adds `'dependency'` and the
    // cast becomes structurally identity. The dispatcher only
    // routes the matching column types here, so the cast is safe.
    columnType: context as WritableColumnType,
    rawInput: inputs.value,
    payload: {
      format: 'rich',
      value: { item_ids: [...itemIds] },
    },
    resolvedFrom: null,
    peopleResolution: null,
    tagResolution: null,
    relationResolution: {
      context,
      allowed_boards: allowedBoards,
      items: echoItems,
    },
    translatorResolution: {
      source: 'live',
      cacheAgeSeconds: null,
    },
  };
};

/**
 * Derives the column's allowed-board list from its parsed
 * `settings_str`. `board_relation` reads `settings.boardIds`
 * (falling back to `[settings.boardId]` for legacy single-target
 * shape Monday occasionally returns); `dependency` reads
 * `settings.dependencyBoards` per Monday's distinct settings shape.
 *
 * Returns `readonly number[]` after filtering to safe integers — a
 * malformed settings entry surfaces as an empty list, which the
 * caller branches on via the no-allowed-boards usage_error.
 */
const deriveAllowedBoards = (
  settings: unknown,
  context: RelationContext,
): readonly number[] => {
  if (settings === null || typeof settings !== 'object') return [];
  const obj = settings as Record<string, unknown>;
  let candidates: readonly unknown[] = [];
  if (context === 'board_relation') {
    if (Array.isArray(obj.boardIds)) {
      candidates = obj.boardIds as readonly unknown[];
    } else if (obj.boardId !== undefined) {
      // Codex post-Commit-5 P1-2 fix: legacy singular `boardId` may
      // be a decimal string (Monday occasionally returns string IDs
      // in legacy boards) — route through the same parse path as the
      // array entries below rather than gating on `typeof === number`.
      // The shared filter below tolerates non-matching shapes.
      candidates = [obj.boardId];
    }
  } else if (Array.isArray(obj.dependencyBoards)) {
    candidates = obj.dependencyBoards as readonly unknown[];
  }
  const out: number[] = [];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) {
      out.push(candidate);
    } else if (
      typeof candidate === 'string' &&
      /^(?:0|[1-9]\d*)$/u.test(candidate)
    ) {
      const parsed = Number(candidate);
      if (Number.isSafeInteger(parsed)) out.push(parsed);
    }
  }
  return out;
};

/**
 * Builds the human-readable `usage_error` message for one or more
 * relation mismatches. Mirrors the per-noun wording the
 * `parseRelationItemIds` errors use ("Board-relation column…",
 * "Dependency column…") so an agent reading two consecutive errors
 * sees consistent wording.
 */
const buildRelationMismatchMessage = (
  columnId: string,
  context: RelationContext,
  mismatches: readonly { itemId: number; actualBoard: number | null }[],
): string => {
  const titled = context === 'board_relation' ? 'Board-relation' : 'Dependency';
  const noun = mismatches.length === 1 ? 'item' : 'items';
  const detail = mismatches
    .map((m) =>
      m.actualBoard === null
        ? `${m.itemId.toString()} (not visible / deleted)`
        : `${m.itemId.toString()} (board ${m.actualBoard.toString()})`,
    )
    .join(', ');
  return (
    `${titled} column "${columnId}" rejected ${mismatches.length.toString()} ` +
    `${noun} not in the column's allowed-board set: ${detail}.`
  );
};

const simple = (
  columnId: string,
  columnType: 'text' | 'long_text' | 'numbers',
  rawInput: string,
): TranslatedColumnValue => ({
  columnId,
  columnType,
  payload: { format: 'simple', value: rawInput },
  rawInput,
  // Only the date / people / tags / relation translators populate
  // resolution echoes; every other type emits null so the dry-run
  // engine has one shape to read per slot.
  resolvedFrom: null,
  peopleResolution: null,
  tagResolution: null,
  relationResolution: null,
  translatorResolution: null,
});

const rich = (
  columnId: string,
  columnType: 'status' | 'dropdown',
  rawInput: string,
  value: JsonObject,
): TranslatedColumnValue => ({
  columnId,
  columnType,
  payload: { format: 'rich', value },
  rawInput,
  resolvedFrom: null,
  peopleResolution: null,
  tagResolution: null,
  relationResolution: null,
  translatorResolution: null,
});

/**
 * Status payload per `cli-design.md` §5.3 step 3:
 *   - Non-negative integer input → `{ index: N }` (number, not
 *     string — Monday's status indexes are integers and the
 *     `change_*_column_value` JSON scalar serialises a number as
 *     a number).
 *   - Anything else → `{ label: <verbatim> }`. No NFC / case-fold
 *     here: the resolver upstream normalised the *column* token,
 *     not the *value* — Monday matches the label against the
 *     board's settings server-side, and a label like " Done "
 *     with surrounding whitespace would be agent-side noise we
 *     should preserve so Monday's `validation_failed` points at
 *     the right input.
 *
 * Empty string emits `{ label: "" }` and is *not* treated as a
 * "clear" intent — `monday item clear` is the dedicated verb for
 * that. Pinned in tests so future contributors don't add silent
 * fall-through-to-clear behaviour.
 *
 * **Safe-integer bound.** Numeric input larger than
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1) silently rounds via
 * `Number(raw)`; very long digit strings yield `Infinity`,
 * which `JSON.stringify` serialises as `null`. Either case
 * would corrupt the wire shape. We throw `usage_error` rather
 * than silently routing to the label path because the input
 * was unambiguously the index path (all digits, no signs / no
 * decimals) — sending `{label: "999999999999999999999"}` to
 * Monday would be a worse surprise than a local error.
 */
const translateStatus = (
  raw: string,
  columnId: string,
): JsonObject => {
  if (NON_NEGATIVE_INTEGER.test(raw)) {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw unsafeIntegerError(columnId, 'status', raw);
    }
    return { index: parsed };
  }
  return { label: raw };
};

/**
 * Dropdown payload per `cli-design.md` §5.3 step 3:
 *   - Comma-split, per-segment trimmed, empty segments dropped.
 *   - All remaining segments numeric → `{ ids: [N1, N2, ...] }`
 *     (numbers, not strings — dropdown IDs from Monday's
 *     `settings_str.labels[].id` are integers).
 *   - Any non-numeric segment → `{ labels: [s1, s2, ...] }`
 *     (strings, verbatim post-trim).
 *
 * **Disambiguation rule, pinned.** A label literally named `"1"`
 * cannot be set via `--set tags=1` — that input parses as the
 * `id` path. The M8 `--set-raw tags='{"labels":["1"]}'` escape
 * hatch is the workaround. Surfaced in the module header as a
 * known limitation; documented via unit test rather than runtime
 * warning because it's a corner case (Monday-generated dropdown
 * labels are strings the user typed; integer-only labels are
 * vanishingly rare).
 *
 * **Empty-after-filter throws `usage_error`.** Inputs like
 * `--set tags=""` or `--set tags=" , "` carry no labels and no
 * IDs — there's nothing to translate. Throwing `usage_error`
 * (rather than emitting `{ labels: [] }`) keeps `--set` and
 * `monday item clear` non-overlapping: the only way to clear
 * a dropdown is the dedicated verb. Pinned via test.
 */
const translateDropdown = (
  columnId: string,
  raw: string,
): JsonObject => {
  const parts = raw
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (parts.length === 0) {
    throw new UsageError(
      `Dropdown column "${columnId}" needs at least one label or numeric ID. ` +
        `Got "${raw}". To clear a dropdown column, use ` +
        `\`monday item clear <iid> ${columnId} [--board <bid>]\` instead.`,
      {
        details: {
          column_id: columnId,
          column_type: 'dropdown',
          raw_input: raw,
          hint:
            'pass a comma-separated list of labels (e.g. --set ' +
            `${columnId}='Backend,Frontend') or numeric IDs (--set ` +
            `${columnId}=1,2). The --set-raw escape hatch accepts the ` +
            `literal Monday wire shape if neither form fits.`,
        },
      },
    );
  }
  if (parts.every((part) => NON_NEGATIVE_INTEGER.test(part))) {
    const ids = parts.map((part) => {
      const parsed = Number(part);
      if (!Number.isSafeInteger(parsed)) {
        throw unsafeIntegerError(columnId, 'dropdown', part);
      }
      return parsed;
    });
    return { ids };
  }
  return { labels: parts };
};

/**
 * Builds the `usage_error` for numeric input that exceeds
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1). Shared by status (index)
 * and dropdown (id) because the failure mode is identical: the
 * input parsed as an integer-shaped number but `Number(raw)`
 * lost precision (or yielded `Infinity` for digit strings ~310+
 * chars long). Either case would land at Monday as the wrong
 * integer or as `null` after `JSON.stringify`. The error carries
 * the raw input so an agent's debug log shows exactly what they
 * sent, and a hint nudging them toward the label path. The M8
 * `--set-raw` escape hatch is the paste-ready alternative when
 * the friendly translator can't accept the input.
 */
const unsafeIntegerError = (
  columnId: string,
  columnType: 'status' | 'dropdown',
  raw: string,
): UsageError => {
  const titled = columnType === 'status' ? 'Status' : 'Dropdown';
  // status uses indexes ("first label is index 0"); dropdown uses
  // numeric IDs from settings_str.labels[].id. Different word in
  // the message so an agent doesn't see "smaller ID" on a status
  // column where the concept is "index", not "ID".
  const noun = columnType === 'status' ? 'indexes' : 'IDs';
  const smaller = columnType === 'status' ? 'a smaller index' : 'a smaller ID';
  // Hints interpolate the actual `columnId` so an agent can
  // paste-and-edit. Status hint uses the literal word "label"
  // because the label-vs-index split lives in cli-design.md §5.3
  // step 3; dropdown hint shows both the labels and IDs forms.
  const hint =
    columnType === 'status'
      ? `use a status label (e.g. --set ${columnId}=Done) or an index < 2^53`
      : `use dropdown labels (e.g. --set ${columnId}=Backend,Frontend) ` +
        `or IDs < 2^53`;
  return new UsageError(
    `${titled} column "${columnId}" got numeric input "${raw}" that ` +
      `exceeds JavaScript's safe-integer range (2^53 - 1, i.e. ` +
      `9007199254740991). Number(raw) would lose precision or yield ` +
      `Infinity, corrupting the wire shape. Monday's ${columnType} ` +
      `${noun} are small non-negative integers — pass a label or ` +
      `${smaller}, or use --set-raw <col>=<json> with the literal ` +
      `Monday wire shape.`,
    {
      details: {
        column_id: columnId,
        column_type: columnType,
        raw_input: raw,
        hint,
      },
    },
  );
};

/**
 * Non-negative integer: matches `0`, `42`, `1234567` but not `-1`,
 * `0.5`, `1e3`, or `42 ` (with trailing whitespace). Used to gate
 * `status` index input and `dropdown` ID input. Negatives go to
 * the label / labels path because Monday status indexes are >= 0
 * and dropdown IDs are auto-incremented positive integers.
 */
const NON_NEGATIVE_INTEGER = /^\d+$/u;

/**
 * The wire shape `change_multiple_column_values` accepts for one
 * column inside its `column_values` map: either a bare string (for
 * the simple types Monday accepts as a string) or a plain JSON
 * object (for rich types — and for `long_text`, see below).
 */
export type MultiColumnValue =
  | string
  | JsonObject;

/**
 * Discriminated union over the three v0.1 mutation paths that
 * `cli-design.md` §5.3 step 5 enumerates. The variant carries
 * exactly the fields M5b's command layer threads into the GraphQL
 * SDK — no extra projection at the call site.
 *
 *   - `change_simple_column_value` — single simple type. The
 *     `value` field is the bare string Monday's
 *     `change_simple_column_value(value: String!)` mutation
 *     accepts. `text` / `long_text` / `numbers` only.
 *   - `change_column_value` — single rich type. The `value` field
 *     is the plain-object payload Monday's
 *     `change_column_value(value: JSON!)` mutation accepts —
 *     the SDK / fetch layer JSON-stringifies at the wire boundary.
 *     Used by `status` / `dropdown` / `date` / `people`.
 *   - `change_multiple_column_values` — N (any combo). The
 *     `columnValues` map carries one entry per column; per-column
 *     value is `string | object` per `MultiColumnValue` above.
 *     **`long_text` re-wrap**: simple-form `long_text`'s bare
 *     string is wrapped to `{ text: <value> }` for this mutation
 *     because Monday's per-column blob inside the multi mutation
 *     requires the object form for `long_text` (a wire-shape
 *     divergence from `change_simple_column_value`'s bare-string
 *     acceptance — see selectMutation source comment for the spec
 *     gap).
 */
export type SelectedMutation =
  | {
      readonly kind: 'change_simple_column_value';
      readonly columnId: string;
      readonly value: string;
    }
  | {
      readonly kind: 'change_column_value';
      readonly columnId: string;
      readonly value: JsonObject;
    }
  | {
      readonly kind: 'change_multiple_column_values';
      readonly columnValues: Readonly<Record<string, MultiColumnValue>>;
    };

/**
 * Picks the right Monday mutation for a list of translated column
 * values per `cli-design.md` §5.3 step 5.
 *
 * Dispatch:
 *   - 1 translated value, simple → `change_simple_column_value`
 *     (bare-string `value`).
 *   - 1 translated value, rich → `change_column_value` (object
 *     `value`).
 *   - N translated values (any combo of simple / rich) →
 *     `change_multiple_column_values`. Atomic on Monday's side —
 *     either every column update lands or none do.
 *
 * **Duplicate column IDs throw `usage_error`.** Bundling two
 * `--set status=Done --set status=Doing` would have last-write-wins
 * semantics inside `change_multiple_column_values`'s map and the
 * agent has no way to know which one won. Surfacing as a typed
 * error at the bundling boundary keeps mutations deterministic;
 * the command layer (M5b) can catch + reframe with the literal
 * `--set` flags it received.
 *
 * **Empty input throws `usage_error`.** Defensive — the command
 * layer is supposed to validate `--set` was supplied, but the
 * helper shouldn't return a malformed `change_multiple_column_values`
 * with an empty map.
 *
 * **`long_text` re-wrap, spec gap.** Monday's
 * `change_multiple_column_values(column_values: JSON!)` accepts a
 * map where each value is either a string or a per-type object.
 * For `long_text` specifically, the per-type object is `{text:
 * <value>}` — so the bare string that `change_simple_column_value`
 * accepts is *not* the right shape inside the multi mutation.
 * `text` / `numbers` stay as bare strings. This wire-shape
 * divergence isn't called out in cli-design.md §5.3 step 5; logged
 * as a spec gap in v0.1-plan.md §3 M5a for backfill. Pinned via
 * fixture in the unit suite.
 */
export const selectMutation = (
  translated: readonly TranslatedColumnValue[],
): SelectedMutation => {
  if (translated.length === 0) {
    throw new UsageError(
      'selectMutation requires at least one translated column value. ' +
        'The command layer should reject the no-`--set` case before ' +
        'reaching this helper.',
      { details: { translated_count: 0 } },
    );
  }
  if (translated.length === 1) {
    const only = translated[0];
    /* c8 ignore next 4 — defensive: length === 1 was just checked,
       so `only` cannot be undefined. The guard exists for
       `noUncheckedIndexedAccess` narrowing. */
    if (only === undefined) {
      throw new UsageError('selectMutation: unreachable indexing guard');
    }
    if (only.payload.format === 'simple') {
      return {
        kind: 'change_simple_column_value',
        columnId: only.columnId,
        value: only.payload.value,
      };
    }
    return {
      kind: 'change_column_value',
      columnId: only.columnId,
      value: only.payload.value,
    };
  }
  // Multi: bundle every translated value into the column_values map.
  // Delegates to `bundleColumnValues` so the long_text re-wrap rule
  // and the duplicate-id gate stay shared with M9's create_item /
  // create_subitem bundling — one source of truth for the
  // `column_values: JSON!` wire shape across every Monday mutation
  // that accepts it.
  const columnValues = bundleColumnValues(translated);
  return { kind: 'change_multiple_column_values', columnValues };
};

/**
 * Projects one translated column value into the per-column blob
 * `change_multiple_column_values` accepts. Three cases:
 *
 *   - rich payload → pass the object through unchanged.
 *   - simple payload, type `long_text` → wrap as `{ text: <value> }`.
 *     Monday's multi-mutation blob for `long_text` requires the
 *     object form (spec gap; see `selectMutation` JSDoc).
 *   - simple payload, any other type → bare string.
 */
const projectForMulti = (t: TranslatedColumnValue): MultiColumnValue => {
  if (t.payload.format === 'rich') {
    return t.payload.value;
  }
  if (t.columnType === 'long_text') {
    return { text: t.payload.value };
  }
  return t.payload.value;
};

/**
 * Bundles a list of translated column values into Monday's
 * `column_values: JSON!` map shape — the input parameter
 * `change_multiple_column_values`, `create_item`, and `create_subitem`
 * all accept. Per-column projection routes through `projectForMulti`,
 * so the `long_text` re-wrap (`{ text: <value> }` inside the map)
 * applies uniformly across every wire surface that takes a
 * `column_values` map.
 *
 * **Why a shared helper.** `selectMutation` builds this map for the
 * multi-update case (M5b); M9's `item create` needs the same shape
 * to bundle `--set` values into `create_item.column_values` /
 * `create_subitem.column_values`. The single-round-trip exit gate
 * (cli-design §5.8) requires the create payload bundles every
 * translated value into one map — and the shape rule should not
 * drift between update and create. The fixture pin in
 * `tests/unit/api/column-values.test.ts` covers both consumers.
 *
 * **Duplicate-column-ID throws `usage_error`.** Same rule as
 * `selectMutation`'s multi case — bundling two values for the same
 * column would silently keep one. The cli-design §5.3 step 2
 * mutual-exclusion contract enforces this resolution-time; the
 * helper duplicates the gate so misuse from a non-command caller
 * still surfaces a typed error.
 */
export const bundleColumnValues = (
  translated: readonly TranslatedColumnValue[],
): Readonly<Record<string, MultiColumnValue>> => {
  const out: Record<string, MultiColumnValue> = {};
  const seen = new Set<string>();
  for (const t of translated) {
    if (seen.has(t.columnId)) {
      // Wording matches the historical `selectMutation` message
      // because existing tests assert on the `Multiple --set values
      // target column` regex; keeping it stable preserves those
      // assertions across both consumers (multi-update + create).
      throw new UsageError(
        `Multiple --set values target column "${t.columnId}". ` +
          `change_multiple_column_values is a map keyed by column ID; ` +
          `bundling two values for the same column would silently keep ` +
          `only one. Pass at most one --set per column.`,
        {
          details: {
            column_id: t.columnId,
            duplicate_count: translated.filter(
              (other) => other.columnId === t.columnId,
            ).length,
          },
        },
      );
    }
    seen.add(t.columnId);
    out[t.columnId] = projectForMulti(t);
  }
  return out;
};

/**
 * Builds the canonical `unsupported_column_type` error (`cli-design.md`
 * §5.3 step 4 + §6.5). Branches on the type's roadmap category so
 * agents get accurate guidance instead of a blanket "wait for the
 * next version" hint.
 *
 * **5-way classifier** (M19 fold of v0.2-plan §22 / v0.3-plan §22
 * non-R-class quality refactor — collapses the prior 5-branch
 * if/else chain into a single category-table dispatch).
 * Categories, in precedence order:
 *
 *   - **read-only forever** (`mirror` / `formula` / `auto_number` /
 *     `creation_log` / `last_updated` / `item_id` / `item_assignees`)
 *     — Monday-computed columns that are not writable via the API
 *     regardless of CLI version. Carry `read_only: true` (no
 *     `deferred_to`); hint points at the underlying source column.
 *     cli-design.md §5.3 writer-expansion roadmap "read-only forever"
 *     row says this explicitly.
 *   - **v0.2 writer-expansion** (`tags` / `board_relation` /
 *     `dependency` — slipped from v0.2 tentative at M18 close;
 *     graduated into the friendly allowlist at M19 close so this
 *     row is unreachable post-M19 but stays as documented dead code
 *     for stability + future tentative-row revival). Carry
 *     `deferred_to: "v0.3"`; hint nudges agents at `--set-raw`.
 *   - **`files`-shaped** (currently `file` only) — Monday writes via
 *     `add_file_to_column` (multipart upload) rather than
 *     `change_column_value`. The friendly dispatch ships across
 *     three call shapes: v0.6-M38 single-item (`monday item set` +
 *     `monday item update <iid>`); v0.7-M42 bulk (`monday item
 *     update --where ...`, per-item multipart fan-out under
 *     `--concurrency` / `--continue-on-error`); both branch off
 *     ahead of the translator at the action body level via the
 *     sibling dispatch leg in `src/api/file-column-set.ts`. The
 *     rejection table row here fires ONLY for paths the friendly
 *     dispatch doesn't cover — `item create` (D6 carve-out fold
 *     deferred to v0.7-M43; `create_item.column_values` is
 *     JSON-only and can't accept a multipart file part) + the
 *     `--set-raw <file-col>=<json>` form (D3 permanent rejection
 *     — `change_column_value` has no JSON wire shape for file
 *     columns). The friendly translator's dispatch-routed entries
 *     never hit this `UNSUPPORTED_TABLE.files_shaped` row —
 *     they branch off ahead of the translator call. Hint points
 *     at every shipped write path: `monday item upload` (v0.4-
 *     M31; verb-shaped multipart) + the v0.6-M38 single-item
 *     friendly form + the v0.7-M42 bulk friendly form.
 *   - **`time_tracking`** — verb-shaped extension (start/stop, not
 *     value writes); v0.3-deferred. Carry `deferred_to: "v0.3"`;
 *     hint points at the upcoming verb surface.
 *   - **future** (anything else — `battery`, `rating`, etc.) —
 *     `deferred_to: "future"`, generic message pointing at
 *     `--set-raw` provided the type accepts `change_column_value`.
 *
 * Exported for unit coverage.
 */
export const unsupportedColumnTypeError = (
  columnId: string,
  type: string,
): ApiError => {
  const category = classifyUnsupported(type);
  const row = UNSUPPORTED_TABLE[category];
  return new ApiError(
    'unsupported_column_type',
    row.message(columnId, type),
    {
      details: {
        column_id: columnId,
        type,
        ...row.details(columnId),
      },
    },
  );
};

type UnsupportedCategory =
  | 'read_only_forever'
  | 'v0_2_writer_expansion'
  | 'files_shaped'
  | 'time_tracking'
  | 'future';

const classifyUnsupported = (type: string): UnsupportedCategory => {
  if (isReadOnlyForeverType(type)) return 'read_only_forever';
  if (isV0_2WriterExpansionType(type)) return 'v0_2_writer_expansion';
  if (isFilesShapedType(type)) return 'files_shaped';
  if (type === 'time_tracking') return 'time_tracking';
  return 'future';
};

interface UnsupportedTableRow {
  readonly message: (columnId: string, type: string) => string;
  readonly details: (columnId: string) => Record<string, unknown>;
}

const UNSUPPORTED_TABLE: Readonly<
  Record<UnsupportedCategory, UnsupportedTableRow>
> = {
  read_only_forever: {
    message: (columnId, type) =>
      `Column "${columnId}" has type "${type}", which Monday computes ` +
      `server-side and does not make writable via the API. This is ` +
      `not a v0.1 limitation — Monday's API rejects write attempts ` +
      `against this type regardless of CLI version, so no future ` +
      `release will lift the restriction. Set the underlying source ` +
      `column instead (e.g. for a mirror column, write to the column ` +
      `the mirror reflects on the linked board).`,
    details: () => ({
      read_only: true,
      hint:
        'this column type is computed by Monday and is permanently ' +
        'read-only via the API. Do not attempt --set / --set-raw — ' +
        'identify the underlying source column (the column the ' +
        'mirror / formula / auto_number / etc. reflects) and write ' +
        'to that instead. See cli-design.md §5.3 writer-expansion ' +
        'roadmap (read-only-forever row) for the full type list.',
    }),
  },
  v0_2_writer_expansion: {
    message: (columnId, type) =>
      `Column "${columnId}" has type "${type}", which is not yet in the ` +
      `friendly --set translator allowlist. The v0.2 writer-expansion ` +
      `tentative row (tags / board_relation / dependency) slipped to ` +
      `v0.3 at M18 close — friendly translators land then once the ` +
      `per-account directory + linked-board enumeration design clears. ` +
      `Use --set-raw <col>=<json> with the documented Monday wire shape ` +
      `in the meantime.`,
    details: (columnId) => ({
      deferred_to: 'v0.3',
      hint:
        `use --set-raw <col>=<json> with the Monday wire shape (e.g. ` +
        `--set-raw ${columnId}='{"tag_ids":[1,2]}' for tags). ` +
        `See https://developer.monday.com/api-reference/reference/` +
        `column-types-reference for per-type wire shapes.`,
    }),
  },
  files_shaped: {
    message: (columnId, type) =>
      `Column "${columnId}" has type "${type}", which Monday writes ` +
      `via add_file_to_column (multipart upload) rather than ` +
      `change_column_value. The friendly --set <file-col>=<path> ` +
      `form dispatches into the multipart wire on \`monday item ` +
      `set\` + \`monday item update <iid>\` (v0.6-M38; single-item) ` +
      `and \`monday item update --where ...\` (v0.7-M42; bulk per-` +
      `item fan-out under --concurrency / --continue-on-error). ` +
      `This rejection row fires only on paths the friendly dispatch ` +
      `doesn't cover: \`monday item create --set <file-col>=<path>\` ` +
      `(deferred to v0.7-M43 per cli-design §5.3 D6) and ` +
      `\`--set-raw <file-col>=<json>\` (permanent rejection per D3 — ` +
      `no JSON wire shape for add_file_to_column). Use \`monday ` +
      `item upload <iid> --column <col> <file>\` (v0.4-M31; ` +
      `verb-shaped) OR the friendly --set on update/set verbs.`,
    details: () => ({
      hint:
        'three write paths reach Monday\'s add_file_to_column ' +
        'multipart wire: (a) `monday item set <iid> <file-col>=' +
        '<path>` / `monday item update <iid> --set <file-col>=' +
        '<path>` (v0.6-M38; single-item friendly translator); ' +
        '(b) `monday item update --where ... --set <file-col>=' +
        '<path>` (v0.7-M42; bulk friendly translator + per-item ' +
        'multipart fan-out under --concurrency / --continue-on-' +
        'error); (c) `monday item upload <iid> --column <col> ' +
        '<file>` (v0.4-M31; verb-shaped). The create + --set-raw ' +
        'paths still reject file-shaped columns: create defers to ' +
        'v0.7-M43 per cli-design §5.3 D6; --set-raw is the permanent ' +
        'D3 rejection.',
    }),
  },
  time_tracking: {
    message: (columnId) =>
      `Column "${columnId}" has type "time_tracking", which Monday ` +
      `mutates via start/stop verbs rather than column-value writes. ` +
      `The friendly --set translator and --set-raw both target ` +
      `change_column_value-shaped types; time_tracking surfaces ` +
      `as the verb-shaped \`monday item time-track start/stop\` ` +
      `pair (v0.3 M20, cli-design §5.2 carve-out 2).`,
    details: () => ({
      // v0.3 ships the verb names as documentation-only — empirical
      // probe (2026-05-10, API version 2026-01) confirmed Monday's
      // public API does not currently support time_tracking writes
      // via either change_simple_column_value or change_column_value.
      // The `deferred_to` slot tracks the milestone the verb pair
      // landed at, not the milestone the wire mutation will ship at
      // (which is on Monday's roadmap, not ours).
      deferred_to: 'v0.3',
      hint:
        'time_tracking uses start/stop verbs, not column-value ' +
        'writes. The verbs `monday item time-track start <iid>` / ' +
        '`monday item time-track stop <iid>` are registered for ' +
        'forward-compatibility but currently throw `usage_error` — ' +
        "Monday's public API does not yet expose a write path for " +
        'time_tracking columns (probed 2026-05-10). Use Monday\'s ' +
        'UI to start/stop time-tracking sessions until API support ' +
        'ships.',
    }),
  },
  future: {
    message: (columnId, type) =>
      `Column "${columnId}" has type "${type}", which is not in the ` +
      `friendly --set translator allowlist (text, long_text, numbers, ` +
      `status, dropdown, date, people, link, email, phone) and is not ` +
      `pinned to a specific roadmap version. Try --set-raw <col>=<json> ` +
      `with the documented Monday wire shape — that path accepts any ` +
      `type Monday writes via change_column_value. Files-shaped types ` +
      `(file) and read-only-forever types (mirror / formula / etc.) are ` +
      `the exception; --set-raw rejects those at column-resolution time.`,
    details: () => ({
      deferred_to: 'future',
      hint:
        'use --set-raw <col>=<json> with the Monday wire shape if the ' +
        'type accepts change_column_value. Examples in this bucket ' +
        '(battery, rating) are not yet scoped on the writer-expansion ' +
        'roadmap. See cli-design.md §5.3.',
    }),
  },
};
