/**
 * Workdocs read + mutation surface for the v0.4-M32 `monday doc
 * list/get` verbs + the v0.5-M35 doc-level CRUD verbs
 * (`cli-design.md` §2.7 + §4.3 + §13 v0.4/v0.5 entries;
 * `v0.4-plan.md` §3 M32; `v0.5-plan.md` §3 M35 + §8 D7-D9).
 *
 * **Wire surface (empirical probe 2026-05-14, API `2026-01`).** Two
 * Monday GraphQL operations land here, both against `Query.docs(...)`:
 *
 *   - **List variant** — `Query.docs(workspace_ids: [ID],
 *     order_by: DocsOrderBy, limit: Int, page: Int) → [Document]`.
 *     Page/limit pagination (NOT cursor — Monday's workdocs surface
 *     has no `items_page`-style cursor). Default `limit: 25` on the
 *     wire side; CLI caps `--limit` at `MAX_DOC_LIST_LIMIT = 100`
 *     to keep response sizes bounded (each Document is rich-text
 *     plus metadata, and a `--limit 500` request could blow past
 *     Monday's complexity budget on doc-heavy accounts). `--page`
 *     is 1-based.
 *   - **Get variant** — `Query.docs(ids: [ID!]) → [Document]` with
 *     the per-doc `blocks` selection hydrated. Returns at most one
 *     Document (single-id list). The CLI extracts the singleton
 *     index 0; an empty array surfaces `not_found` (D8 — Monday's
 *     wire collapses doesn't-exist + not-accessible into the same
 *     shape), while a null `docs` root surfaces `internal_error`
 *     with a drift hint (Monday's documented shape is `[Document]`,
 *     possibly empty, never null — null indicates wire-shape
 *     regression worth surfacing loudly). The
 *     `Document.blocks: [DocumentBlock]` selection adds significant
 *     payload, which is why `doc list` ships WITHOUT `blocks` and
 *     `doc get` is the per-doc body-hydrating path.
 *
 * **`Document` object — 14 fields.** Per the M32 empirical probe:
 * `id` (ID!), `object_id` (ID!), `blocks` ([DocumentBlock]; null
 * unless hydrated), `created_at` (Date, nullable), `created_by`
 * (User, nullable — projected to the slim `{id, name}` shape for
 * envelope compactness), `doc_folder_id` (ID, nullable),
 * `doc_kind` (BoardKind!, returning `'public'`/`'private'`/
 * `'share'` per the DocKind probe at API `2026-01` — non-null on
 * the wire; the standalone `DocKind` enum exists but isn't
 * returned by `Document.doc_kind`), `name` (String!),
 * `relative_url` (String, nullable),
 * `settings` (JSON, nullable), `updated_at` (Date, nullable),
 * `url` (String, nullable absolute URL), `workspace` (Workspace,
 * nullable — projected to `{id, name}`), `workspace_id` (ID,
 * nullable). The `object_id` is Monday's internal opaque object
 * identifier (distinct from `id`); both flow through verbatim.
 *
 * **BoardKind reuse for `Document.doc_kind`.** Monday's wire schema
 * types `Document.doc_kind` as `BoardKind!` (NOT `DocKind!`) — the
 * `BoardKind` enum is reused across `Board.kind` and
 * `Document.doc_kind`, returning the same three string values
 * (`public`/`private`/`share`). The standalone `DocKind` enum exists
 * on the schema but isn't returned by `Document.doc_kind`; it's a
 * wire-side detail with no agent-visible asymmetry (the CLI surface
 * mirrors the wire string values verbatim). Not a new R-NEW-41
 * consumer — the wire-vs-CLI projection is symmetric.
 *
 * **`DocumentBlock` — 9 fields.** Per the M32 probe: `id` (String!),
 * `type` (String, nullable — block type like `'text'` / `'heading'`
 * / `'list'` / etc., values stay verbatim from Monday's wire),
 * `content` (JSON, nullable — block payload), `position` (Float,
 * nullable — fractional ordering within doc), `parent_block_id`
 * (String, nullable — for nested blocks), `doc_id` (ID, nullable),
 * `created_at` (Date, nullable), `created_by` (User, nullable —
 * projected to slim `{id, name}`), `updated_at` (Date, nullable).
 * Block-content schema validity is NOT cross-checked by the CLI;
 * Monday's wire is the source of truth for what blocks look like.
 *
 * **`DocsOrderBy` enum — 2 values.** `created_at` (most-recently-
 * created first; Monday's documented `desc` ordering) and `used_at`
 * (most-recently-viewed-by-current-user first; also `desc`). No
 * ascending variant on Monday's wire — agents that need ascending
 * sort the projection client-side. Default CLI behaviour: `created_
 * at` (matches Monday's wire default at API `2026-01`).
 *
 * **No new ERROR_CODES (29 stays — D8 closure).** Doc-read failures
 * route through existing codes:
 *
 *   - `not_found` — `doc get <did>` against a non-existent or
 *     inaccessible doc ID. Monday's wire returns an empty `docs`
 *     array for both "doesn't exist" and "exists but token can't
 *     read it"; the CLI surfaces both as `not_found` with
 *     `details.doc_id`.
 *   - `usage_error` — argv-parse rejections (out-of-range `--limit`
 *     / `--page`, malformed `--workspace`, unknown `--order-by`).
 *     Caught at parse boundary BEFORE any wire call.
 *   - `validation_failed` — Monday-side rejection (very rare for
 *     reads; included for completeness).
 *   - `forbidden` / `unauthorized` — token lacks workdoc read scope.
 *
 * **Docs are live-only at v0.4-M32.** Per cli-design §8 cache scope,
 * workdocs aren't cached — the `doc list` + `doc get` paths emit
 * `meta.source: "live"` with `cache_age_seconds: null`. Workdocs
 * are content-heavy + frequently human-edited, so caching would
 * regularly surface stale prose. Mirrors `monday usage` (M22) +
 * `monday status` (M22) + webhook list (M27) — diagnostics /
 * volatile surfaces don't cache.
 *
 * **Runtime bodies landed at v0.4-M32 IMPL.** `listDocuments` +
 * `getDocument` each issue a single `client.raw` round-trip with
 * `operationName: 'ListDocs'` / `'GetDoc'` pinned literally at the
 * fetcher boundary (R-NEW-37 W2 audit-point — operationNames are
 * NOT caller-overridable). Responses parse through
 * {@link documentSchema} / {@link documentWithBlocksSchema} via
 * `unwrapOrThrow`, so payload drift surfaces `internal_error` with
 * `details.issues`. The `doc get` empty-array case rewraps to
 * `not_found` with `details.doc_id` per D8 (Monday's wire collapses
 * "doesn't exist" + "not visible to token" into the same shape).
 *
 * **v0.5-M35 mutation surface (empirical probe 2026-05-15, API
 * `2026-01`; v0.5 kickoff rounds 1-3).** Five CLI verbs land here
 * at v0.5-M35, backed by four Monday GraphQL mutations —
 * `create_doc` (2 CLI verbs because Monday's `CreateDocInput` is
 * mutually-exclusive `board` vs `workspace` per D7) +
 * `update_doc_name` + `delete_doc` + `duplicate_doc`. All four
 * wire mutations are synchronous on Monday's wire — the v0.4-W1
 * `dispatchPollingLoop` watch-item DOES NOT fire here.
 *
 *   - **Create-in-workspace variant** — `create_doc(location:
 *     CreateDocInput!) → Document` with `location: { workspace:
 *     CreateDocWorkspaceInput { workspace_id!, name!, kind?:
 *     BoardKind, folder_id? } }`. CLI envelope OMITS the wire's
 *     `blocks` slot entirely (the base 13-field
 *     {@link documentSchema} M32 pin is the create projection).
 *     Monday returns `blocks: null` on a fresh create — agents
 *     needing block hydration (rare on a fresh create — usually
 *     the next step is content authoring) call `monday doc get
 *     <new-doc-id>` per the M32 read cadence.
 *   - **Create-on-column variant** — `create_doc(location:
 *     CreateDocInput!) → Document` with `location: { board:
 *     CreateDocBoardInput { column_id!, item_id! } }`.
 *   - **Rename variant** — `update_doc_name(docId: ID!,
 *     name: String!) → JSON` (opaque scalar). Returns wire-side
 *     opaque payload; the CLI projects to flat `{ doc_id: <input>,
 *     success: true }` envelope at the fetcher boundary per D9.
 *     The agent contract is the projected envelope shape, NOT the
 *     opaque Monday return value.
 *   - **Delete variant** — `delete_doc(docId: ID!) → JSON`
 *     (opaque). Same `{ doc_id, success }` projection per D9.
 *     Destructive gate per cli-design §3.1 (M35 verb requires
 *     `--yes`).
 *   - **Duplicate variant** — `duplicate_doc(docId: ID!,
 *     duplicateType?: DuplicateType) → JSON` (opaque). Same
 *     `{ doc_id, success }` projection per D9. `--with-updates`
 *     argv flag flips wire `duplicateType` from
 *     `duplicate_doc_with_content` (default) to
 *     `duplicate_doc_with_content_and_updates`. **No `--name <n>`
 *     rename slot per D8** — Monday's `duplicate_doc` mutation
 *     carries no name-override arg on the wire, so the CLI defers
 *     the rename-on-duplicate UX (an agent that needs a renamed
 *     duplicate pairs the verb with a follow-up `monday doc
 *     rename <new-id> --name <n>` call).
 *
 * **`CreateDocInput` is mutually-exclusive on Monday's wire.**
 * Per Finding 6 + round-3 nested-inputs probe, supplying both
 * `board` AND `workspace` slots fails server-side. The CLI's
 * two-verb split (`monday doc create-in-workspace` vs `monday doc
 * create-on-column`) flows the mutual-exclusion into the argv
 * boundary — each verb's input schema declares the slot it
 * supports, and there's no way to set both via the CLI surface.
 * Single verb with `--workspace` / `--board` choosers was the
 * D7 alternative; pre-flight ratified the two-verb shape per the
 * agent-UX principle of "fewer ambiguous flags is clearer than
 * one verb with mutually-exclusive choosers" (mirrors how the
 * v0.4 cli-design ships separate `monday item upload` /
 * `monday update upload` verbs for the same multipart wire path).
 *
 * **camelCase vs snake_case asymmetry across the doc-mutation
 * surface (Finding 7).** Monday's `update_doc_name` /
 * `delete_doc` / `duplicate_doc` mutations use **camelCase** arg
 * names (`docId`, `duplicateType`) on the wire — distinct from
 * the snake_case `doc_id` Monday uses for `Document` field names
 * elsewhere on the schema. The fetcher boundary uses the wire's
 * camelCase variable shape verbatim; the CLI argv stays kebab-case
 * throughout (`--name <n>`, `--with-updates`); the error envelope
 * `details.*` keys stay snake_case per cli-design §6.5 (e.g.
 * `details.doc_id`). The asymmetry is wire-side and stays at the
 * fetcher boundary; agents see camelCase nowhere. Cross-link to
 * `docs/architecture.md` "Wire-vs-CLI semantics documentation
 * conventions" — 4th supporting site for R-NEW-41 (camelCase vs
 * snake_case arg-name asymmetry; R-v0.5-NEW-3 graduation candidate
 * at v0.5-plan §22).
 *
 * **Opaque-JSON return shape (D9 closure).** 3 of 4 M35 mutations
 * return Monday's `JSON` scalar — an untyped wire payload whose
 * exact shape isn't pinned by introspection. The CLI projects to
 * a flat `{ doc_id: string, success: true }` envelope at the
 * fetcher boundary so agents read a uniform shape across rename /
 * delete / duplicate; `success` is pinned literal-`true` because
 * Monday surfaces failure via GraphQL `errors[]` (mapped to typed
 * `ApiError`s upstream), not via a wire-side success flag.
 *
 * Per-fetcher null-payload semantics ARE asymmetric (round-1 P2-1
 * closure):
 *
 *   - **`renameDoc` (`update_doc_name`)** — present-but-null
 *     payload → success envelope. Monday's probe description
 *     carries NO "returns X" prose, so null is plausibly an
 *     empty-success indicator.
 *   - **`deleteDoc` (`delete_doc`)** — present-but-null payload
 *     → `not_found`. Probe description: "Returns success status
 *     and the deleted document ID" — null indicates the source
 *     doc was bogus or already-deleted.
 *   - **`duplicateDoc` (`duplicate_doc`)** — present-but-null
 *     payload → `not_found`. Probe description: "Returns the new
 *     document's ID on success" — null indicates the source
 *     wasn't duplicable.
 *
 * Missing-root-key cases for all three uniformly throw
 * `internal_error` via `assertResponseFieldPresent` (schema
 * drift). For `duplicate_doc`, the projected `doc_id` is the
 * **NEWLY-CREATED doc's id** extracted from the opaque JSON via
 * {@link extractDuplicateDocId} — defensive across multiple
 * plausible wire shapes (bare string / number / record-with-`id`
 * / `doc_id` / `new_doc_id`). Capturing a live duplicate-doc wire
 * response would let a future revision narrow the helper's
 * accepted shapes; today's helper is constructed against the
 * read-only probe + Monday's wire description, not a live wire
 * response.
 *
 * **No new ERROR_CODES at M35.** Existing codes route doc-mutation
 * failures: `not_found` (rename/delete/duplicate against a
 * non-existent or inaccessible doc), `usage_error` (argv-parse
 * rejections — bad DocId, missing `--name`, unknown `--kind`),
 * `validation_failed` (Monday-side rejection, e.g. workspace
 * lacks doc-create permission), `forbidden`/`unauthorized` (token
 * lacks workdoc write scope), `confirmation_required` (destructive
 * gate on `doc delete` missing `--yes`).
 *
 * **Doc mutations are live-only at v0.5-M35.** Pure-mutation
 * surfaces don't cache by definition (cli-design §8); `meta.source:
 * "live"`. Dry-run paths emit `meta.source: "none"` per §6.4
 * mutation-dry-run discipline.
 *
 * **Runtime bodies landed at v0.5-M35 IMPL.** All five fetchers
 * issue a single `client.raw` round-trip with their pinned
 * `operationName`; responses parse through the wrapping schemas
 * via `unwrapOrThrow` + `assertResponseFieldPresent`, then either
 * unwrap the per-Document payload (create variants) or project
 * the opaque JSON return to the flat `{ doc_id, success: true }`
 * envelope (rename / delete / duplicate per D9). The
 * `duplicate_doc` projection extracts the new doc id from the
 * opaque JSON via {@link extractDuplicateDocId} — defensive
 * across common wire shapes (bare string, `{id}`, `{doc_id}`,
 * `{new_doc_id}`); unrecognised shapes surface `internal_error`
 * with a re-probe hint.
 *
 * **R-NEW-76 discipline preserved** across all 5 M35 command
 * action bodies — `parseArgv` plus applicable helpers
 * (`parseGlobalFlags` on all five; `enforceDestructiveGate` on
 * `doc delete`) fire BEFORE `resolveClient` so invalid argv +
 * missing-`--yes` surface from the parse boundary, ahead of any
 * `config_error` from a missing token. M35 verbs do not consume
 * comma-separated brand-list flags (`parseBrandedListArg` is an
 * M34 team-writer / M32 `doc list --workspace` helper); the M35
 * surface doesn't need it.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import { assertResponseFieldPresent } from './response-root.js';
import type { MondayClient } from './client.js';
import type { Complexity } from '../utils/output/envelope.js';

/**
 * Schema for a required JSON-scalar slot — the key must be present
 * on the parsed object, but the value can be any JSON shape Monday
 * surfaces (object / array / string / number / boolean / null).
 *
 * Bare `z.unknown()` treats a missing key as "present with value
 * `undefined`", so a wire response that omits `Document.settings`
 * or `DocumentBlock.content` would still pass the strict schema —
 * silently weakening the 13-field / 9-field contract. The
 * `.refine` rejects `undefined` explicitly so a missing key
 * surfaces as a typed parse error at the IMPL response-parse
 * boundary (will fold into `internal_error` via `unwrapOrThrow`),
 * matching every other field's "present-but-typed" semantics.
 *
 * Mirrors the M27 `Webhook.config: z.string().nullable()` pin
 * (config is always present, value can be null) but for JSON-
 * shaped slots whose payload shape varies per surface.
 */
const requiredJsonValueSchema = z.unknown().refine((v) => v !== undefined, {
  message: 'required JSON value (may be null, but the key must be present)',
});

/**
 * Inclusive range for the `--limit` argv slot on `monday doc list`.
 * Default `25` matches Monday's wire-side default at API `2026-01`
 * (per the M32 empirical probe `Query.docs.args.limit.description`:
 * "Number of items to get, the default is 25"); ceiling `100` keeps
 * worst-case response sizes bounded for doc-heavy accounts (a
 * `--limit 500` request would multiply payload across 500 rich-text
 * Document records, easily blowing Monday's complexity budget).
 */
export const MIN_DOC_LIST_LIMIT = 1;
export const MAX_DOC_LIST_LIMIT = 100;
export const DEFAULT_DOC_LIST_LIMIT = 25;

/**
 * Monday's `DocsOrderBy` enum vocabulary (empirical probe 2026-05-14,
 * API `2026-01`; 2 values). Pinned at M32 pre-flight as a closed
 * literal-union enum so unknown `--order-by` values reject at parse
 * boundary with `usage_error`.
 *
 * Both values sort `desc` on Monday's wire (most-recent first); no
 * ascending variant is exposed. Adding a third value to Monday's
 * enum is a minor (additive) bump for the CLI — extend this list +
 * the per-command flag help.
 */
export const DOCS_ORDER_BY = ['created_at', 'used_at'] as const;

export type DocsOrderBy = (typeof DOCS_ORDER_BY)[number];

export const docsOrderBySchema = z.enum(DOCS_ORDER_BY);

export const DEFAULT_DOCS_ORDER_BY: DocsOrderBy = 'created_at';

/**
 * Slim projection of Monday's `User` for the `Document.created_by` +
 * `DocumentBlock.created_by` slots. Mirrors the M19 `account_tags`
 * + M31 `Asset.uploaded_by` slim-User cadence: `{id, name}` only,
 * keeping envelope size bounded. Full-User reads route through
 * `monday user get <uid>`.
 */
export const docUserSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export type DocUser = z.infer<typeof docUserSchema>;

/**
 * Slim projection of Monday's `Workspace` for the `Document.workspace`
 * slot. Same `{id, name}` shape as {@link docUserSchema}. Full-
 * Workspace reads route through `monday workspace get <wid>`.
 */
export const docWorkspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export type DocWorkspace = z.infer<typeof docWorkspaceSchema>;

/**
 * `doc_kind` literal-union enum (3 values per the M32 probe + the
 * DocKind introspection result). Monday's wire types this field as
 * `BoardKind!` — see the module header's "BoardKind reuse" note for
 * the wire-side type-name aliasing. The CLI surface mirrors the
 * three string values verbatim with no projection drift.
 */
export const DOC_KIND_VALUES = ['public', 'private', 'share'] as const;

export type DocKind = (typeof DOC_KIND_VALUES)[number];

export const docKindSchema = z.enum(DOC_KIND_VALUES);

/**
 * DocumentBlock projection — Monday's 9-field block shape per the
 * M32 probe. `content` is `JSON` on the wire (block payload — schema
 * varies per `type`); the CLI passes it through unmodified as
 * `unknown` so agents introspect the per-block-type payload
 * themselves (Monday's wire is the source of truth for the per-
 * block-type schema).
 *
 * Only surfaces under `doc get` envelopes (the per-doc body-hydrating
 * path); `doc list` envelopes ship Documents WITHOUT `blocks` per
 * the D6 list-row-projection closure.
 */
export const documentBlockSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().nullable(),
    content: requiredJsonValueSchema,
    position: z.number().nullable(),
    parent_block_id: z.string().nullable(),
    doc_id: z.string().nullable(),
    created_at: z.string().nullable(),
    created_by: docUserSchema.nullable(),
    updated_at: z.string().nullable(),
  })
  .strict();

export type DocumentBlock = z.infer<typeof documentBlockSchema>;

/**
 * Base Document projection (13 fields — all of Monday's 14 minus
 * `blocks`). Used as the list-row shape under `doc list` envelopes;
 * appended with the required `blocks: [DocumentBlock]` slot for
 * `doc get` envelopes via {@link documentWithBlocksSchema} (the
 * extension makes `blocks` mandatory — `doc get` always hydrates
 * the rich-text body per D6).
 *
 * `settings` is `JSON` on the wire (per-doc display/sharing config)
 * — passed through as `unknown` for the same reason
 * `DocumentBlock.content` is. Agents that need a specific settings
 * key destructure client-side.
 */
export const documentSchema = z
  .object({
    id: z.string().min(1),
    object_id: z.string().min(1),
    name: z.string().min(1),
    doc_kind: docKindSchema,
    url: z.string().nullable(),
    relative_url: z.string().nullable(),
    workspace_id: z.string().nullable(),
    workspace: docWorkspaceSchema.nullable(),
    doc_folder_id: z.string().nullable(),
    created_at: z.string().nullable(),
    created_by: docUserSchema.nullable(),
    updated_at: z.string().nullable(),
    settings: requiredJsonValueSchema,
  })
  .strict();

export type Document = z.infer<typeof documentSchema>;

/**
 * `doc get` projection — base Document + the `blocks` slot hydrated.
 * Same shape as {@link documentSchema} with `blocks:
 * [DocumentBlock]` appended (Monday's wire returns the block array
 * directly under `Document.blocks`; the CLI surfaces it verbatim).
 *
 * `blocks` is non-null on the wire when the selection is requested;
 * an empty doc surfaces `blocks: []` rather than `null`. The schema
 * pins non-null for envelope predictability — an unexpected null
 * surfaces `internal_error` at the IMPL parse boundary.
 */
export const documentWithBlocksSchema = documentSchema
  .extend({
    blocks: z.array(documentBlockSchema),
  })
  .strict();

export type DocumentWithBlocks = z.infer<typeof documentWithBlocksSchema>;

/**
 * Output shape for `monday doc list [--workspace <wid>,...]
 * [--order-by <created_at|used_at>] [--limit <n>] [--page <n>]`.
 * Wrapped record (NOT bare array) because page/limit pagination
 * surfaces pagination context inline rather than via `meta.cursor`
 * (cli-design §6.1 cursor slot is for items_page-style surfaces;
 * the workdocs wire has no cursor).
 *
 * `documents` — Monday's wire-ordered array (server-applied
 * `created_at desc` or `used_at desc` per `--order-by`).
 * `page` / `limit` — echoed inputs confirming what the wire saw.
 * `returned_count` — `documents.length` cached for agent ergonomics.
 * `has_more` — heuristic `returned_count === limit`; Monday's wire
 * doesn't surface a total count, so "exactly `limit` rows returned"
 * is the only signal that a follow-up page exists. Agents
 * pessimistically re-fetch with `page + 1` if `has_more: true`.
 */
export const docListOutputSchema = z
  .object({
    documents: z.array(documentSchema),
    page: z.number().int().min(1),
    limit: z
      .number()
      .int()
      .min(MIN_DOC_LIST_LIMIT)
      .max(MAX_DOC_LIST_LIMIT),
    returned_count: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  // Pagination-invariant cross-field check (round-2 P2-1 fix +
  // round-3 P2-1 guard). The schema-level field types/ranges don't
  // enforce the documented invariants between `returned_count` /
  // `documents.length` / `limit` / `has_more` — an IMPL bug could
  // emit inconsistent pagination data and still pass output
  // validation, then bleed agent-visible drift into the envelope.
  // Pin the two invariants here so the unwrap-or-throw boundary
  // catches violations at parse time:
  //
  //   1. `returned_count === documents.length` — the count field is
  //      the cached array length, not an independent counter.
  //   2. `has_more === (returned_count === limit)` — Monday's wire
  //      surface doesn't expose a total-count, so "exactly `limit`
  //      rows returned" is the only signal that a follow-up page
  //      may exist (D9 closure).
  //
  // **Round-3 P2-1 fix — early-return guard.** Zod's `.superRefine`
  // still runs even when scalar range checks above have produced
  // "dirty" issues. Without this guard, a malformed input like
  // `{ limit: 0, returned_count: 0, has_more: false }` would emit
  // BOTH the legitimate `limit` range-floor violation AND a
  // misleading `has_more` invariant violation (because `has_more
  // === (returned_count === limit)` evaluates against the invalid
  // limit value). Short-circuit when participating scalars are
  // out-of-range so the user sees only the underlying range
  // violation, not a derived inconsistency error stacked on top.
  .superRefine((value, ctx) => {
    if (
      value.limit < MIN_DOC_LIST_LIMIT ||
      value.limit > MAX_DOC_LIST_LIMIT ||
      value.returned_count < 0 ||
      !Number.isInteger(value.limit) ||
      !Number.isInteger(value.returned_count)
    ) {
      return;
    }
    if (value.returned_count !== value.documents.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['returned_count'],
        message:
          `returned_count (${String(value.returned_count)}) must equal ` +
          `documents.length (${String(value.documents.length)})`,
      });
    }
    const expectedHasMore = value.returned_count === value.limit;
    if (value.has_more !== expectedHasMore) {
      ctx.addIssue({
        code: 'custom',
        path: ['has_more'],
        message:
          `has_more (${String(value.has_more)}) must equal ` +
          `(returned_count === limit) which is ${String(expectedHasMore)}`,
      });
    }
  });

export type DocListOutput = z.infer<typeof docListOutputSchema>;

/**
 * Output shape for `monday doc get <did>`. Direct unwrap of the
 * single Document (with blocks hydrated) — matches the convention
 * for read-one verbs (`monday board get <bid>` returns `data:
 * <Board>`, `monday user get <uid>` returns `data: <User>`).
 *
 * The Document's own `id` field is the echoed input — no separate
 * `doc_id` slot needed.
 */
export const docGetOutputSchema = documentWithBlocksSchema;

export type DocGetOutput = DocumentWithBlocks;

/**
 * GraphQL query document for `Query.docs(...)` listing variant.
 * Operation name pinned literally to `ListDocs` and matches the
 * wire `operationName` payload (R-NEW-37 W2 audit-point — caller-
 * overridable operationName slots were closed at M27 IMPL round-1
 * P2-1; M32 maintains the safely-by-construction shape).
 *
 * Selects every list-row field (no `blocks` selection — list rows
 * project the 13-field base shape per D6). `workspace_ids:` typed
 * as `[ID]` to mirror Monday's wire signature (the inner ID is
 * nullable on Monday's side — an empirical-probe finding that
 * doesn't show up in the contract today but stays preserved for
 * future-proofing).
 */
export const LIST_DOCS_QUERY = `
  query ListDocs(
    $workspaceIds: [ID],
    $orderBy: DocsOrderBy,
    $limit: Int,
    $page: Int
  ) {
    docs(
      workspace_ids: $workspaceIds,
      order_by: $orderBy,
      limit: $limit,
      page: $page
    ) {
      id
      object_id
      name
      doc_kind
      url
      relative_url
      workspace_id
      workspace { id name }
      doc_folder_id
      created_at
      created_by { id name }
      updated_at
      settings
    }
  }
`;

/**
 * GraphQL query document for `Query.docs(ids:)` single-id read
 * variant. Operation name pinned to `GetDoc` (R-NEW-37 W2). Selects
 * all base Document fields plus the `blocks` selection (the per-doc
 * body-hydrating leg).
 *
 * Single-id wire shape — Monday returns `[Document]` (an array even
 * for one id); the fetcher extracts index 0. An empty array
 * (Monday's response for "doc not found" or "doc not visible to
 * token") surfaces `not_found` with `details.doc_id`.
 */
export const GET_DOC_QUERY = `
  query GetDoc($ids: [ID!]!) {
    docs(ids: $ids) {
      id
      object_id
      name
      doc_kind
      url
      relative_url
      workspace_id
      workspace { id name }
      doc_folder_id
      created_at
      created_by { id name }
      updated_at
      settings
      blocks {
        id
        type
        content
        position
        parent_block_id
        doc_id
        created_at
        created_by { id name }
        updated_at
      }
    }
  }
`;

/**
 * Wrapping response schema for the `ListDocs` operation. Monday's
 * documented wire shape is `[Document]` (an array, possibly empty)
 * — never null. The wrapper accepts `null` defensively so a wire-
 * shape regression parses cleanly and is rewrapped by the fetcher
 * as `internal_error` with a drift hint (rather than faulting the
 * parse with a confusing zod issue path). Both fetchers reject a
 * null root post-parse; null is NEVER a `not_found` rewrap target
 * — that's the empty-array D8 case in `getDocument`.
 *
 * `.loose()` mirrors the M27 `listWebhooksResponseSchema` cadence —
 * Monday occasionally returns side-band debug keys (`extensions`,
 * `account_id`) alongside the documented data root; the loose
 * mode lets them pass without faulting the parse.
 */
const listDocsResponseSchema = z
  .object({
    docs: z.array(documentSchema).nullable(),
  })
  .loose();

/**
 * Wrapping response schema for the `GetDoc` operation. Same shape
 * as the list variant but with `blocks` hydrated on every entry.
 */
const getDocResponseSchema = z
  .object({
    docs: z.array(documentWithBlocksSchema).nullable(),
  })
  .loose();

export interface ListDocumentsInputs {
  readonly client: MondayClient;
  /**
   * Workspace ID filter slot — maps to wire `workspace_ids: [ID]`.
   * Optional; absent → unfiltered (every visible doc across the
   * account). Inaccessible workspace IDs surface as empty filter
   * results (Monday's wire silently drops them — no resolver
   * warning fires per D4 closure).
   */
  readonly workspaceIds?: readonly string[];
  /**
   * Order slot — maps to wire `order_by: DocsOrderBy`. Defaults
   * to `'created_at'` per Monday's wire default. Both values sort
   * `desc` server-side.
   */
  readonly orderBy?: DocsOrderBy;
  /**
   * Page size — `[1, 100]`, default `25`. Mirrors Monday's wire-
   * side default; ceiling pins worst-case payload size per D3.
   */
  readonly limit?: number;
  /**
   * 1-based page number. Default `1`. Page/limit pagination is the
   * only mechanism the workdocs surface exposes (no cursor).
   */
  readonly page?: number;
}

export interface ListDocumentsResult {
  readonly documents: readonly Document[];
  /**
   * Echoed page input (defaults to `1` when caller omits). Surfaces
   * into `data.page` so the agent sees what Monday actually
   * received.
   */
  readonly page: number;
  /**
   * Echoed limit input (defaults to {@link DEFAULT_DOC_LIST_LIMIT}
   * when caller omits). Surfaces into `data.limit`.
   */
  readonly limit: number;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Fetches the workdocs visible to the token via a single
 * `Query.docs(...)` round-trip with `operationName: 'ListDocs'`
 * (R-NEW-37 W2). Source is always `'live'` per cli-design §8 cache
 * scope; workdocs aren't cached at v0.4 per D7.
 *
 * Variables map to Monday's wire `Query.docs(...)` args:
 * `workspaceIds` → `workspace_ids: [ID]`; `orderBy` →
 * `order_by: DocsOrderBy`; `limit` → `limit: Int`; `page` →
 * `page: Int`. Omitted inputs drop the corresponding `$variable`
 * so Monday's per-arg server-side default applies (rather than
 * threading an explicit `null` that the wire treats as "field
 * present").
 *
 * Echoed `page` / `limit` carry Monday's defaults when the caller
 * omits them ({@link DEFAULT_DOC_LIST_LIMIT} for limit, `1` for
 * page) so the envelope's pagination-invariant `.superRefine`
 * sees consistent values regardless of which inputs the verb
 * received.
 *
 * A null `docs` root surfaces `internal_error` (Monday's documented
 * shape is `[Document]` even for empty accounts — the array, never
 * null at this layer). Schema drift in the per-doc shape rewraps to
 * `internal_error` with `details.issues` via `unwrapOrThrow`.
 */
export const listDocuments = async (
  inputs: ListDocumentsInputs,
): Promise<ListDocumentsResult> => {
  const variables: Record<string, unknown> = {};
  if (inputs.workspaceIds !== undefined) {
    variables.workspaceIds = inputs.workspaceIds;
  }
  if (inputs.orderBy !== undefined) {
    variables.orderBy = inputs.orderBy;
  }
  if (inputs.limit !== undefined) {
    variables.limit = inputs.limit;
  }
  if (inputs.page !== undefined) {
    variables.page = inputs.page;
  }
  const response = await inputs.client.raw<unknown>(
    LIST_DOCS_QUERY,
    variables,
    { operationName: 'ListDocs' },
  );
  const parsed = unwrapOrThrow(
    listDocsResponseSchema.safeParse(response.data),
    {
      context: 'Monday `Query.docs(ListDocs)` response',
      hint: 'Monday may have amended the `Document` selection — re-probe and amend `src/api/documents.ts` if so',
    },
  );
  if (parsed.docs === null) {
    throw new ApiError(
      'internal_error',
      'Monday returned a null `docs` payload from ListDocs',
      {
        details: {
          hint:
            'Monday\'s documented shape is `[Document]` (an array, possibly empty) — ' +
            'a null root indicates a wire change that needs re-probing',
        },
      },
    );
  }
  return {
    documents: parsed.docs,
    page: inputs.page ?? 1,
    limit: inputs.limit ?? DEFAULT_DOC_LIST_LIMIT,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface GetDocumentInputs {
  readonly client: MondayClient;
  readonly docId: string;
}

export interface GetDocumentResult {
  readonly document: DocumentWithBlocks;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Fetches a single workdoc by ID via a single `Query.docs(ids:)`
 * round-trip with `operationName: 'GetDoc'` (R-NEW-37 W2). Returns
 * the Document with `blocks` hydrated. Source is always `'live'`
 * per cli-design §8 cache scope.
 *
 * Empty wire response (Monday's shape for "doc doesn't exist" OR
 * "doc not visible to token") surfaces `not_found` with
 * `details.doc_id` — no `forbidden` rewrap, because Monday's wire
 * collapses the two cases into one shape and the CLI can't
 * distinguish them per D8.
 *
 * A multi-element wire response (which Monday's `docs(ids:)`
 * shouldn't return for a single-id query) surfaces `internal_error`
 * as a defensive guard — the CLI assumes one doc per id and a
 * count mismatch indicates a wire-shape regression worth surfacing
 * loudly rather than silently dropping entries.
 */
export const getDocument = async (
  inputs: GetDocumentInputs,
): Promise<GetDocumentResult> => {
  const response = await inputs.client.raw<unknown>(
    GET_DOC_QUERY,
    { ids: [inputs.docId] },
    { operationName: 'GetDoc' },
  );
  const parsed = unwrapOrThrow(
    getDocResponseSchema.safeParse(response.data),
    {
      context: 'Monday `Query.docs(GetDoc)` response',
      details: { doc_id: inputs.docId },
      hint: 'Monday may have amended the `Document` / `DocumentBlock` selection — re-probe and amend `src/api/documents.ts` if so',
    },
  );
  if (parsed.docs === null) {
    throw new ApiError(
      'internal_error',
      `Monday returned a null \`docs\` payload from GetDoc(${inputs.docId})`,
      {
        details: {
          doc_id: inputs.docId,
          hint:
            'Monday\'s documented shape is `[Document]` (an array, possibly empty) — ' +
            'a null root indicates a wire change that needs re-probing',
        },
      },
    );
  }
  if (parsed.docs.length === 0) {
    throw new ApiError(
      'not_found',
      `workdoc ${inputs.docId} not found (does not exist or not visible to token)`,
      { details: { doc_id: inputs.docId } },
    );
  }
  if (parsed.docs.length > 1) {
    throw new ApiError(
      'internal_error',
      `Monday returned ${String(parsed.docs.length)} docs for a single-id GetDoc query`,
      {
        details: {
          doc_id: inputs.docId,
          hint: 'wire shape regression — re-probe `Query.docs(ids:)`',
        },
      },
    );
  }
  const [document] = parsed.docs;
  /* c8 ignore next 6 */
  if (document === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned a sparse docs array for GetDoc(${inputs.docId})`,
      { details: { doc_id: inputs.docId } },
    );
  }
  return {
    document,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

// ===========================================================================
// v0.5-M35 doc-level CRUD mutation surface
// ===========================================================================
// All five fetchers below landed runtime bodies at v0.5-M35 IMPL. Each
// issues a single `client.raw` round-trip with its pinned `operationName`,
// parses via the wrapping response schema + `assertResponseFieldPresent`,
// and either unwraps the Document payload (create variants) or projects
// the opaque JSON return into the flat `{ doc_id, success: true }`
// envelope per D9 (rename / delete / duplicate).

/**
 * Monday's `DuplicateType` enum vocabulary (empirical probe 2026-05-15,
 * API `2026-01`; 2 values). Pinned at M35 pre-flight as a closed
 * literal-union so unknown values reject at the parse boundary with
 * `usage_error`.
 *
 * - `duplicate_doc_with_content` — clone the doc body only; comments
 *   and update history are NOT copied. Wire-side default when
 *   `duplicateType` is omitted.
 * - `duplicate_doc_with_content_and_updates` — clone the doc body
 *   AND every comment / update thread attached to the source doc.
 *   Picks up Monday's "full backup" duplicate semantics.
 *
 * Maps to the CLI's boolean `--with-updates` flag at the M35
 * `monday doc duplicate` argv boundary: absent → wire default
 * (`duplicate_doc_with_content`, content-only); present → wire
 * `duplicate_doc_with_content_and_updates`. The two-value enum
 * stays internal to the fetcher — agents see a boolean opt-in, not
 * the wire enum name.
 *
 * Adding a third value to Monday's enum is a minor (additive) bump
 * for the CLI — extend this list + the fetcher mapping; the
 * boolean argv stays.
 */
export const DUPLICATE_TYPE_VALUES = [
  'duplicate_doc_with_content',
  'duplicate_doc_with_content_and_updates',
] as const;

export type DuplicateType = (typeof DUPLICATE_TYPE_VALUES)[number];

export const duplicateTypeSchema = z.enum(DUPLICATE_TYPE_VALUES);

/**
 * Projected envelope shape for the three opaque-JSON mutation
 * results (`update_doc_name` / `delete_doc` / `duplicate_doc`).
 * Per D9 closure, the CLI surfaces a flat `{ doc_id: string,
 * success: true }` envelope so agents read a uniform shape across
 * mutations — Monday's wire returns an opaque `JSON` scalar whose
 * exact shape isn't pinned by introspection (the v0.5 doc-CRUD
 * probe was read-only — no live mutation response was captured).
 * The projection insulates agents from any wire-side shape drift;
 * the runtime accepts plausible-defensive shapes today, and a
 * future live wire response would narrow what the helper accepts.
 *
 * `success` is pinned to literal `true` because Monday surfaces
 * failure via GraphQL `errors[]` (mapped to typed `ApiError`s at
 * the transport layer); a JSON return that reaches this projection
 * is by construction the success path. If Monday ever flips to a
 * `success/error` result OBJECT shape for these mutations (mirroring
 * `import_doc_from_html` / `add_content_to_doc_from_markdown` per
 * Finding 6), the projection widens to a discriminated union — for
 * today the literal-`true` form keeps the shape pinned.
 *
 * `doc_id` semantics differ per mutation:
 *
 *   - `rename` / `delete` — echoes the input id (the operation
 *     targets that specific doc; success means it was renamed /
 *     deleted).
 *   - `duplicate` — emits the **NEWLY-CREATED** doc's id (Monday's
 *     `duplicate_doc` description: "Returns the new document's ID
 *     on success"; the fetcher extracts the new id from the
 *     opaque JSON via {@link extractDuplicateDocId}, which is
 *     defensive across plausible wire shapes today). The original
 *     source-doc id stays available via the argv positional.
 */
export const docMutationResultSchema = z
  .object({
    doc_id: z.string().min(1),
    success: z.literal(true),
  })
  .strict();

export type DocMutationResult = z.infer<typeof docMutationResultSchema>;

/**
 * Output shape for `monday doc create-in-workspace --workspace
 * <wid> --name <n> [--folder <fid>] [--kind public|private|share]`.
 * Direct unwrap of the created Document — `data: <Document>` per
 * cli-design §6.1 single-record convention. The envelope OMITS
 * the `blocks` slot entirely (the base {@link documentSchema} M32
 * pin is the 13-field projection without `blocks`).
 *
 * **Rationale for the omit.** Monday's wire returns
 * `blocks: null` on a fresh `create_doc` because a freshly-
 * created doc has no rich-text body yet (Monday hasn't
 * materialised it). Surfacing a constant-null `blocks` slot on
 * every create envelope would add agent-noise — every caller
 * has to ignore it. Agents that need block hydration (rare on a
 * fresh create — usually the next step is content authoring)
 * call `monday doc get <new-doc-id>` per the M32 read cadence.
 * The omit is a contract decision, not a schema-flexibility
 * artifact.
 */
export const docCreateInWorkspaceOutputSchema = documentSchema;

export type DocCreateInWorkspaceOutput = Document;

/**
 * Output shape for `monday doc create-on-column --item <iid>
 * --column <cid>`. Same shape as
 * {@link docCreateInWorkspaceOutputSchema} — Monday's wire returns
 * the full Document regardless of placement; the two-verb split
 * (per D7) lives at the argv layer, not the response shape.
 */
export const docCreateOnColumnOutputSchema = documentSchema;

export type DocCreateOnColumnOutput = Document;

/**
 * Output shape for `monday doc rename <doc-id> --name <n>`.
 * Projected from Monday's opaque `JSON` scalar return per D9 — the
 * fetcher emits `{ doc_id: <echoed>, success: true }`. Agents key
 * off `ok: true` for retry/idempotency reasoning; the literal
 * `success: true` slot exists for envelope-snapshot stability and
 * future-proofing (if Monday ever surfaces a wire-side success
 * flag, the schema widens to read the wire value rather than
 * always emitting `true`).
 */
export const docRenameOutputSchema = docMutationResultSchema;

export type DocRenameOutput = DocMutationResult;

/**
 * Output shape for `monday doc delete <doc-id> --yes`. Same
 * `{ doc_id: <echoed>, success: true }` projection as rename per
 * D9. The destructive-gate envelope sits at the action body —
 * `confirmation_required` fires BEFORE this output schema is
 * referenced (cli-design §3.1 #6).
 */
export const docDeleteOutputSchema = docMutationResultSchema;

export type DocDeleteOutput = DocMutationResult;

/**
 * Output shape for `monday doc duplicate <doc-id> [--with-updates]`.
 * Same flat `{ doc_id, success: true }` projection per D9, BUT the
 * `doc_id` slot carries the **newly-created duplicate's id** — NOT
 * the source-doc id. The verb's positional argv is the source-doc
 * id; the wire returns the new id in its JSON payload, which
 * {@link extractDuplicateDocId} pulls out (defensive across
 * plausible shapes today; a future live wire response would
 * narrow what the helper accepts).
 *
 * **No `--name <n>` slot per D8** — Monday's `duplicate_doc`
 * mutation carries no rename-on-duplicate arg. Agents needing a
 * renamed duplicate pair with a follow-up `monday doc rename
 * <new-id> --name <n>` call.
 */
export const docDuplicateOutputSchema = docMutationResultSchema;

export type DocDuplicateOutput = DocMutationResult;

/**
 * GraphQL mutation document for `create_doc(location: {workspace:
 * ...})`. Operation name pinned to `CreateDocInWorkspace`
 * (R-NEW-37 W2 audit-point — operationNames NOT caller-overridable).
 * Selects every base-Document field per the M32 cadence; `blocks`
 * deliberately omitted (Monday's wire returns `blocks: null` on a
 * fresh create — see the module header's create-variant note).
 *
 * `$input: CreateDocInput!` carries the mutually-exclusive wire
 * shape; the verb's action body composes
 * `{ workspace: { workspace_id, name, folder_id?, kind? } }` from
 * the parsed argv. The `board` slot stays unset at the wire — the
 * two-verb CLI split (per D7) makes the mutual-exclusion safely-
 * by-construction.
 */
export const CREATE_DOC_IN_WORKSPACE_MUTATION = `
  mutation CreateDocInWorkspace($input: CreateDocInput!) {
    create_doc(location: $input) {
      id
      object_id
      name
      doc_kind
      url
      relative_url
      workspace_id
      workspace { id name }
      doc_folder_id
      created_at
      created_by { id name }
      updated_at
      settings
    }
  }
`;

/**
 * GraphQL mutation document for `create_doc(location: {board: ...})`.
 * Operation name pinned to `CreateDocOnColumn` (R-NEW-37 W2). Same
 * Document selection as {@link CREATE_DOC_IN_WORKSPACE_MUTATION};
 * `$input: CreateDocInput!` is composed as `{ board: { column_id,
 * item_id } }` at the action body. Distinct named operation per
 * verb so the wire-side `operationName` payload mirrors the CLI
 * verb name verbatim (agents tracing wire traffic can identify the
 * verb without parsing the doc body).
 */
export const CREATE_DOC_ON_COLUMN_MUTATION = `
  mutation CreateDocOnColumn($input: CreateDocInput!) {
    create_doc(location: $input) {
      id
      object_id
      name
      doc_kind
      url
      relative_url
      workspace_id
      workspace { id name }
      doc_folder_id
      created_at
      created_by { id name }
      updated_at
      settings
    }
  }
`;

/**
 * GraphQL mutation document for `update_doc_name(docId, name) →
 * JSON`. Operation name pinned to `UpdateDocName` (R-NEW-37 W2).
 * The wire return type is the opaque `JSON` scalar — no selection
 * set per GraphQL grammar (scalars are leaves). The CLI projects
 * the opaque value to the flat `{ doc_id, success }` envelope at
 * the fetcher boundary per D9.
 *
 * `docId` + `name` are camelCase on Monday's wire per Finding 7;
 * the variable names mirror the wire shape verbatim. CLI argv is
 * `<doc-id>` positional + `--name <n>` flag (kebab-case throughout).
 */
export const UPDATE_DOC_NAME_MUTATION = `
  mutation UpdateDocName($docId: ID!, $name: String!) {
    update_doc_name(docId: $docId, name: $name)
  }
`;

/**
 * GraphQL mutation document for `delete_doc(docId) → JSON`.
 * Operation name pinned to `DeleteDoc` (R-NEW-37 W2). Wire return
 * is opaque JSON — same projection cadence as
 * {@link UPDATE_DOC_NAME_MUTATION}.
 *
 * **Destructive-gate ordering.** The verb's action body MUST call
 * `enforceDestructiveGate` BEFORE this fetcher per the M10 round-1
 * P2 invariant. A missing `--yes` surfaces as
 * `confirmation_required` from the action layer, never masked by
 * `config_error` when no token is configured.
 */
export const DELETE_DOC_MUTATION = `
  mutation DeleteDoc($docId: ID!) {
    delete_doc(docId: $docId)
  }
`;

/**
 * GraphQL mutation document for `duplicate_doc(docId,
 * duplicateType?) → JSON`. Operation name pinned to `DuplicateDoc`
 * (R-NEW-37 W2). `duplicateType` is the optional 2-value enum
 * (see {@link DUPLICATE_TYPE_VALUES}); when omitted at the variable
 * boundary, Monday's wire-side default (`duplicate_doc_with_content`,
 * content-only) applies.
 *
 * The verb's `--with-updates` boolean argv maps to:
 * absent → omit the variable entirely (wire default applies);
 * present → `duplicateType: 'duplicate_doc_with_content_and_updates'`.
 * The omit-vs-null discipline mirrors M34 `team-create`'s
 * `is_guest_team` handling — Monday treats a `null` variable as
 * "field present with null value" rather than "field omitted".
 *
 * Wire return is opaque JSON — same projection cadence as the
 * rename + delete mutations.
 */
export const DUPLICATE_DOC_MUTATION = `
  mutation DuplicateDoc($docId: ID!, $duplicateType: DuplicateType) {
    duplicate_doc(docId: $docId, duplicateType: $duplicateType)
  }
`;

/**
 * Wrapping response schema for the `CreateDocInWorkspace` /
 * `CreateDocOnColumn` mutations. Monday's wire shape returns the
 * full Document on success; a `null` payload surfaces
 * `internal_error` (a successful `create_doc` must return the
 * created Document per Monday's documented contract — null
 * indicates a wire-shape regression worth surfacing loudly rather
 * than silently dropping the response).
 *
 * Shared between both create-variants because the wire returns
 * the same Document shape regardless of placement; the schema's
 * `.loose()` mode mirrors M27 / M32 / M34 — Monday occasionally
 * surfaces side-band debug keys (`extensions`, `account_id`)
 * alongside the documented data root, and the loose mode lets
 * them pass without faulting the parse.
 *
 * The `create_doc` slot widens to `unknown` so the wrapping parse
 * tolerates Monday's side-band keys and any rare `null` payload;
 * the post-parse layer pins the value against {@link documentSchema}
 * via `unwrapOrThrow` so per-field drift surfaces with structured
 * `details.issues` (mirrors M34 createTeam's two-stage parse).
 */
const createDocResponseSchema = z
  .object({
    create_doc: z.unknown(),
  })
  .loose();

/**
 * Wrapping response schema for the `UpdateDocName` mutation. The
 * `update_doc_name` root carries Monday's opaque `JSON` scalar —
 * `z.unknown()` accepts any wire shape (null / record / scalar)
 * and the projection layer extracts what it needs. Missing key
 * surfaces `internal_error` via `assertResponseFieldPresent`.
 */
const updateDocNameResponseSchema = z
  .object({
    update_doc_name: z.unknown(),
  })
  .loose();

/**
 * Wrapping response schema for the `DeleteDoc` mutation. Same
 * shape as {@link updateDocNameResponseSchema} — opaque JSON
 * scalar at the root; projection layer handles the extraction.
 * A `null` value surfaces `not_found` (mirrors M14 workspace-
 * delete + M34 team-delete cadence — id bogus / already deleted
 * by a concurrent caller).
 */
const deleteDocResponseSchema = z
  .object({
    delete_doc: z.unknown(),
  })
  .loose();

/**
 * Wrapping response schema for the `DuplicateDoc` mutation. Same
 * opaque-JSON shape as the rename/delete variants. Monday's wire
 * carries the newly-created doc id in this opaque JSON payload
 * (probe description: "Returns the new document's ID on
 * success"); the exact shape isn't pinned by introspection and
 * the v0.5 doc-CRUD probe was read-only. The fetcher extracts
 * the new id via {@link extractDuplicateDocId}, which accepts
 * multiple plausible shapes defensively (bare string / number /
 * record-with-`id` / `doc_id` / `new_doc_id`). A future live
 * wire response would let a follow-up commit narrow what the
 * helper accepts to the exact wire shape.
 */
const duplicateDocResponseSchema = z
  .object({
    duplicate_doc: z.unknown(),
  })
  .loose();

export interface CreateDocInWorkspaceInputs {
  readonly client: MondayClient;
  readonly workspaceId: string;
  readonly name: string;
  readonly folderId?: string;
  readonly kind?: DocKind;
}

export interface CreateDocInWorkspaceResult {
  readonly document: Document;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Creates a workspace-scoped workdoc via `create_doc(location:
 * { workspace: {...} })` with `operationName:
 * 'CreateDocInWorkspace'` (R-NEW-37 W2). Returns the created
 * Document with `id` populated post-create.
 *
 * The fetcher composes `location: { workspace: { workspace_id,
 * name, folder_id?, kind? } }` from the inputs; `folderId` /
 * `kind` are omitted entirely from the wire payload when unset
 * (Monday's per-arg server-side defaults apply — null would be
 * treated as "field present" rather than "field omitted",
 * mirroring M34 `createTeam`'s discipline).
 *
 * A missing-key wire response surfaces `internal_error` via
 * `assertResponseFieldPresent`; a null payload surfaces
 * `internal_error` too — a successful `create_doc` mutation must
 * return the created Document per Monday's documented contract.
 */
export const createDocInWorkspace = async (
  inputs: CreateDocInWorkspaceInputs,
): Promise<CreateDocInWorkspaceResult> => {
  const workspaceInput: Record<string, unknown> = {
    workspace_id: inputs.workspaceId,
    name: inputs.name,
  };
  if (inputs.folderId !== undefined) {
    workspaceInput.folder_id = inputs.folderId;
  }
  if (inputs.kind !== undefined) {
    workspaceInput.kind = inputs.kind;
  }
  const response = await inputs.client.raw<unknown>(
    CREATE_DOC_IN_WORKSPACE_MUTATION,
    { input: { workspace: workspaceInput } },
    { operationName: 'CreateDocInWorkspace' },
  );
  const data = unwrapOrThrow(
    createDocResponseSchema.safeParse(response.data),
    {
      context: 'Monday returned a malformed CreateDocInWorkspace response',
      details: { workspace_id: inputs.workspaceId, name: inputs.name },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update `createDocResponseSchema` if ' +
        'Monday\'s contract has changed.',
    },
  );
  assertResponseFieldPresent({
    data,
    key: 'create_doc',
    operationLabel: 'CreateDocInWorkspace',
    details: { workspace_id: inputs.workspaceId, name: inputs.name },
    nullHandling: 'caller_handles',
  });
  const rawDoc = data.create_doc;
  if (rawDoc === null || rawDoc === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned no document payload from create_doc(location: {workspace: ${inputs.workspaceId}}, name: ${JSON.stringify(inputs.name)}).`,
      { details: { workspace_id: inputs.workspaceId, name: inputs.name } },
    );
  }
  const document = unwrapOrThrow(
    documentSchema.safeParse(rawDoc),
    {
      context: `Monday returned a malformed Document payload from create_doc (workspace ${inputs.workspaceId})`,
      details: { workspace_id: inputs.workspaceId, name: inputs.name },
    },
  );
  return {
    document,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface CreateDocOnColumnInputs {
  readonly client: MondayClient;
  readonly itemId: string;
  readonly columnId: string;
}

export interface CreateDocOnColumnResult {
  readonly document: Document;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Creates an item-scoped workdoc via `create_doc(location:
 * { board: {...} })` with `operationName: 'CreateDocOnColumn'`
 * (R-NEW-37 W2). Returns the created Document; the doc is
 * embedded into the named column of the named item.
 *
 * The fetcher composes `location: { board: { column_id, item_id
 * } }` from the inputs. Both slots are required on Monday's wire
 * (`CreateDocBoardInput.column_id!` + `CreateDocBoardInput.
 * item_id!`); the CLI verb's `--item <iid>` + `--column <cid>`
 * flags are both required at the parse boundary.
 *
 * Failure modes mirror the workspace variant: missing-key
 * response → `internal_error`; null payload → `internal_error`;
 * column not configured for docs → `validation_failed` (Monday-
 * side rejection — the CLI doesn't pre-check column-type
 * compatibility, mirroring M8's `change_column_value` cadence).
 */
export const createDocOnColumn = async (
  inputs: CreateDocOnColumnInputs,
): Promise<CreateDocOnColumnResult> => {
  const response = await inputs.client.raw<unknown>(
    CREATE_DOC_ON_COLUMN_MUTATION,
    {
      input: {
        board: { item_id: inputs.itemId, column_id: inputs.columnId },
      },
    },
    { operationName: 'CreateDocOnColumn' },
  );
  const data = unwrapOrThrow(
    createDocResponseSchema.safeParse(response.data),
    {
      context: 'Monday returned a malformed CreateDocOnColumn response',
      details: { item_id: inputs.itemId, column_id: inputs.columnId },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update `createDocResponseSchema` if ' +
        'Monday\'s contract has changed.',
    },
  );
  assertResponseFieldPresent({
    data,
    key: 'create_doc',
    operationLabel: 'CreateDocOnColumn',
    details: { item_id: inputs.itemId, column_id: inputs.columnId },
    nullHandling: 'caller_handles',
  });
  const rawDoc = data.create_doc;
  if (rawDoc === null || rawDoc === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned no document payload from create_doc(location: {board: {item_id: ${inputs.itemId}, column_id: ${inputs.columnId}}}).`,
      { details: { item_id: inputs.itemId, column_id: inputs.columnId } },
    );
  }
  const document = unwrapOrThrow(
    documentSchema.safeParse(rawDoc),
    {
      context: `Monday returned a malformed Document payload from create_doc (item ${inputs.itemId}, column ${inputs.columnId})`,
      details: { item_id: inputs.itemId, column_id: inputs.columnId },
    },
  );
  return {
    document,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface RenameDocInputs {
  readonly client: MondayClient;
  readonly docId: string;
  readonly name: string;
}

export interface RenameDocResult {
  readonly result: DocMutationResult;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Renames a workdoc via `update_doc_name(docId, name)` with
 * `operationName: 'UpdateDocName'` (R-NEW-37 W2). Projects
 * Monday's opaque JSON return into the flat
 * `{ doc_id: <echoed>, success: true }` envelope per D9.
 *
 * Failure modes:
 *
 *   - **Missing `update_doc_name` key** → `internal_error` via
 *     `assertResponseFieldPresent` (schema drift — Monday's
 *     response shape regressed).
 *   - **Present-but-null payload** → projected as success (the
 *     `{doc_id, success: true}` envelope). Monday's probe
 *     description for `update_doc_name` carries NO "returns X"
 *     prose (unlike `delete_doc` which promises "success status
 *     and the deleted document ID"), so a null wire payload is a
 *     plausible empty-success indicator. If Monday returns a
 *     typed error for non-existent doc IDs, that bubbles via
 *     GraphQL `errors[]` (mapped to typed `ApiError`s upstream) —
 *     a present-but-null JSON return reaching this projection is
 *     by construction the success path. Distinct from
 *     `deleteDoc` + `duplicateDoc` cadence which DO treat null
 *     as `not_found` because their probe descriptions explicitly
 *     promise a non-null return payload on success.
 *   - **Typed Monday errors** (forbidden / not_found from a wire-
 *     side `errors[]`) → bubble through the transport's error-
 *     mapping layer.
 */
export const renameDoc = async (
  inputs: RenameDocInputs,
): Promise<RenameDocResult> => {
  const response = await inputs.client.raw<unknown>(
    UPDATE_DOC_NAME_MUTATION,
    { docId: inputs.docId, name: inputs.name },
    { operationName: 'UpdateDocName' },
  );
  const data = unwrapOrThrow(
    updateDocNameResponseSchema.safeParse(response.data),
    {
      context: 'Monday returned a malformed UpdateDocName response',
      details: { doc_id: inputs.docId },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update `updateDocNameResponseSchema` ' +
        'if Monday\'s contract has changed.',
    },
  );
  assertResponseFieldPresent({
    data,
    key: 'update_doc_name',
    operationLabel: 'UpdateDocName',
    details: { doc_id: inputs.docId },
    nullHandling: 'caller_handles',
  });
  // Project Monday's opaque JSON return per D9 — agents see a
  // uniform `{ doc_id, success: true }` envelope regardless of
  // what's inside `data.update_doc_name`. Unlike `delete_doc` +
  // `duplicate_doc`, a present `null` is NOT remapped to
  // `not_found` (round-1 P2-1 closure — Monday's
  // `update_doc_name` probe description makes no return-shape
  // promise, so null is a plausible empty-success indicator).
  return {
    result: { doc_id: inputs.docId, success: true },
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface DeleteDocInputs {
  readonly client: MondayClient;
  readonly docId: string;
}

export interface DeleteDocResult {
  readonly result: DocMutationResult;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Deletes a workdoc by ID via `delete_doc(docId)` with
 * `operationName: 'DeleteDoc'` (R-NEW-37 W2). Projects Monday's
 * opaque JSON return into the flat `{ doc_id: <echoed>,
 * success: true }` envelope per D9.
 *
 * A null `delete_doc` payload surfaces `not_found` — same
 * cadence as M34 team-delete + M14 workspace-delete. A missing
 * key surfaces `internal_error`.
 *
 * **Destructive-gate ordering.** The verb's action body MUST
 * call `enforceDestructiveGate` BEFORE this fetcher per the
 * M10 round-1 P2 invariant. A missing `--yes` surfaces as
 * `confirmation_required` from the action layer, never masked
 * by `config_error` when no token is configured.
 */
export const deleteDoc = async (
  inputs: DeleteDocInputs,
): Promise<DeleteDocResult> => {
  const response = await inputs.client.raw<unknown>(
    DELETE_DOC_MUTATION,
    { docId: inputs.docId },
    { operationName: 'DeleteDoc' },
  );
  const data = unwrapOrThrow(
    deleteDocResponseSchema.safeParse(response.data),
    {
      context: 'Monday returned a malformed DeleteDoc response',
      details: { doc_id: inputs.docId },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update `deleteDocResponseSchema` if ' +
        'Monday\'s contract has changed.',
    },
  );
  assertResponseFieldPresent({
    data,
    key: 'delete_doc',
    operationLabel: 'DeleteDoc',
    details: { doc_id: inputs.docId },
    nullHandling: 'caller_handles',
  });
  const rawPayload = data.delete_doc;
  if (rawPayload === null || rawPayload === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no payload from delete_doc for doc ${inputs.docId}`,
      { details: { doc_id: inputs.docId } },
    );
  }
  return {
    result: { doc_id: inputs.docId, success: true },
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface DuplicateDocInputs {
  readonly client: MondayClient;
  readonly docId: string;
  readonly duplicateType?: DuplicateType;
}

export interface DuplicateDocResult {
  readonly result: DocMutationResult;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Duplicates a workdoc by ID via `duplicate_doc(docId,
 * duplicateType?)` with `operationName: 'DuplicateDoc'`
 * (R-NEW-37 W2). Projects Monday's opaque JSON return into the
 * flat `{ doc_id: <NEW>, success: true }` envelope per D9 — the
 * `doc_id` slot carries the **newly-created duplicate's id**,
 * NOT the input source-doc id (the source id stays accessible
 * via the verb's positional argv).
 *
 * The fetcher omits the `duplicateType` variable entirely when
 * `inputs.duplicateType` is unset so Monday's wire-side default
 * applies (the M34 `team-create` omit-vs-null discipline). A
 * null `duplicate_doc` payload surfaces `not_found` (source
 * doc id bogus or inaccessible); missing key surfaces
 * `internal_error`. The new-id extraction tolerates several
 * common shapes Monday's opaque JSON might carry (bare string,
 * `{id}`, `{doc_id}`, `{new_doc_id}`) — anything else surfaces
 * `internal_error` with a re-probe hint.
 */
/**
 * Best-effort extractor for the new doc's id from
 * `duplicate_doc`'s opaque JSON return. Monday's wire description
 * says "Returns the new document's ID on success" but doesn't
 * pin the wire shape; the schema introspection types the return
 * as the opaque `JSON` scalar.
 *
 * Tries common shapes:
 *
 *   - Bare string → that's the new id.
 *   - Numeric scalar → stringify (Monday's wire mixes ID + Int
 *     types; the CLI's brand stays string-shaped).
 *   - Record with `id` / `doc_id` / `new_doc_id` field carrying a
 *     non-empty string or number → extract.
 *
 * Anything else surfaces `internal_error` with a hint pointing
 * at re-probing `duplicate_doc` live so a future commit can
 * narrow the helper to Monday's actual wire shape.
 */
const extractDuplicateDocId = (
  raw: unknown,
  sourceId: string,
): string => {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    for (const key of ['id', 'doc_id', 'new_doc_id']) {
      const value = rec[key];
      if (typeof value === 'string' && value.length > 0) return value;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
    }
  }
  throw new ApiError(
    'internal_error',
    `duplicate_doc returned an opaque JSON payload the CLI could not extract a new doc id from (source ${sourceId})`,
    {
      details: {
        doc_id: sourceId,
        hint:
          'Monday\'s `duplicate_doc` wire shape changed — re-probe via ' +
          '`scripts/probe/` and extend `extractDuplicateDocId` to cover ' +
          'the new shape.',
      },
    },
  );
};

export const duplicateDoc = async (
  inputs: DuplicateDocInputs,
): Promise<DuplicateDocResult> => {
  const variables: Record<string, unknown> = { docId: inputs.docId };
  if (inputs.duplicateType !== undefined) {
    variables.duplicateType = inputs.duplicateType;
  }
  const response = await inputs.client.raw<unknown>(
    DUPLICATE_DOC_MUTATION,
    variables,
    { operationName: 'DuplicateDoc' },
  );
  const data = unwrapOrThrow(
    duplicateDocResponseSchema.safeParse(response.data),
    {
      context: 'Monday returned a malformed DuplicateDoc response',
      details: { doc_id: inputs.docId },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update `duplicateDocResponseSchema` ' +
        'if Monday\'s contract has changed.',
    },
  );
  assertResponseFieldPresent({
    data,
    key: 'duplicate_doc',
    operationLabel: 'DuplicateDoc',
    details: { doc_id: inputs.docId },
    nullHandling: 'caller_handles',
  });
  const rawPayload = data.duplicate_doc;
  if (rawPayload === null || rawPayload === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no payload from duplicate_doc for source doc ${inputs.docId}`,
      { details: { doc_id: inputs.docId } },
    );
  }
  const newDocId = extractDuplicateDocId(rawPayload, inputs.docId);
  return {
    result: { doc_id: newDocId, success: true },
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};
