/**
 * Workdocs read surface for the v0.4-M32 `monday doc list/get` verbs
 * (`cli-design.md` §2.7 + §4.3 + §13 v0.4 entry; `v0.4-plan.md` §3
 * M32).
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
 *     index 0 — null/empty array surfaces `not_found`. The
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
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
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
 * wire returns `{ docs: [Document] | null }` under `data.docs`; a
 * null root surfaces `not_found` (the wrapper schema accepts it
 * upstream, the fetcher rewraps after parse).
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
  if (parsed.docs === null || parsed.docs.length === 0) {
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
