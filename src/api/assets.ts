/**
 * Asset upload surface for the v0.4-M31 `monday item upload` +
 * `monday update upload` verbs (`cli-design.md` §2.2 + §4.3 + §6.4
 * + §13 v0.4 entry; `v0.4-plan.md` §3 M31).
 *
 * **Wire surface (empirical probe 2026-05-13, API `2026-01`).** Two
 * Monday GraphQL multipart mutations land here:
 *
 *   - `Mutation.add_file_to_column(column_id: String!, file: File!,
 *     item_id: ID!) → Asset` — attaches a file to a `file`-typed
 *     column on a specific item. Note **`column_id` is `String!`
 *     not `ID!`** (the SDK's column-id surface is consistently
 *     `String!` because column IDs are user-defined-looking tokens
 *     like `'files'` / `'attachments_3'` rather than numeric).
 *   - `Mutation.add_file_to_update(file: File!, update_id: ID!) →
 *     Asset` — attaches a file to an Update (comment) record. Item
 *     ID is implicit (the update's parent item).
 *
 * Both mutations cross the wire via `multipart/form-data` per the
 * standard GraphQL multipart-request specification (jaydenseric).
 * The `File` scalar is Monday's own (NOT the spec-standard `Upload`);
 * the multipart envelope is otherwise spec-compliant — `operations`
 * + `map` JSON parts + the file part keyed by index `0`.
 *
 * **Asset object — 10 fields.** `id` (ID, non-null), `name` (String,
 * non-null — the multipart `filename` parameter), `url` (String,
 * non-null — direct download), `public_url` (String, non-null —
 * sharable), `file_extension` (String, non-null), `file_size` (Int,
 * non-null — bytes), `created_at` (Date, nullable), `uploaded_by`
 * (User, non-null — the token's owner; projected to the slim
 * `{id, name}` shape for envelope compactness), `original_geometry`
 * (String, nullable — image dimensions like `'1920x1080'`),
 * `url_thumbnail` (String, nullable — image thumbnails only).
 *
 * **R-NEW-41 3rd consumer fires here.** Asset upload is the third
 * site (after M27 `Webhook.config` JSON/String asymmetry + M27
 * `NotificationTargetType` collapse) where the wire-vs-CLI semantics
 * carry a documented asymmetry. This module's transport choice
 * (sibling multipart module, NOT extension of `transport.ts`) is
 * itself the load-bearing asymmetry shape — the JSON envelope's
 * `body: JSON.stringify(...)` invariant doesn't compose with
 * multipart/form-data's `FormData`-driven boundary parameter, so
 * the two transports live in sibling modules with parallel
 * interfaces. See `docs/architecture.md` §X "Wire-vs-CLI semantics
 * documentation conventions" for the canonical writeup.
 *
 * **No new ERROR_CODES (29 stays).** Asset-upload failures route
 * through the existing codes:
 *
 *   - `usage_error` — file path doesn't exist / not readable
 *     (`details.reason: 'file_not_readable'`); file is empty
 *     (`details.reason: 'file_empty'`); upload exceeded Monday's
 *     per-file size limit (Monday surfaces this server-side;
 *     `details.reason: 'file_too_large'` rewrap).
 *   - `unsupported_column_type` — `--column <col>` resolves to a
 *     non-`file` column type. Hint points back at the §5.3 writer
 *     surface (Monday writes files via `add_file_to_column` for
 *     `file` columns only; other column types route via
 *     `change_column_value`).
 *   - `not_found` — item / update / column doesn't exist or isn't
 *     visible to the token.
 *   - `validation_failed` — Monday-side rejection of the upload
 *     payload (malformed filename, server-side virus scan flag,
 *     etc.).
 *   - `forbidden` / `unauthorized` — token lacks asset-write scope.
 *
 * Monday's per-file size cap is plan-tier-dependent and NOT exposed
 * via the schema (verified at M31 pre-flight probe — `Plan` +
 * `Account` carry no file-quota fields). The CLI does NOT pre-check
 * file size against a hardcoded ceiling; Monday's runtime rejection
 * (typically `FILE_SIZE_LIMIT_EXCEEDED` or a generic 413) is rewrapped
 * as `usage_error` with `details.reason: 'file_too_large'` +
 * `details.file_size_bytes` at IMPL.
 *
 * **Idempotency: NO.** Each successful upload mints a new Asset
 * with a new ID — re-running `item upload` with the same args
 * uploads the file a second time. Agents needing register-once
 * semantics dedupe on the CLI side (e.g., read `Item.assets` first
 * and skip the upload if a matching `Asset.name` exists).
 *
 * **Status: PRE-FLIGHT STUB.** Runtime bodies for both fetchers land
 * at v0.4-M31 IMPL. The exports below ship as `Promise.reject
 * (internal_error)` stubs under c8 ignore start/stop block-wraps
 * (the testing.md preferred form). Pinned operation names + Asset
 * schema + argv input schemas are the real shipped surface; the
 * `dispatchPlaceholder` block-wraps drop with the IMPL feat.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import type { MondayClient } from './client.js';
import type { MultipartTransport } from './multipart-transport.js';
import type { Complexity } from '../utils/output/envelope.js';

/**
 * Slim projection of Monday's `User` for the `Asset.uploaded_by`
 * slot. Monday's full User type is ~30 fields; the envelope echoes
 * only `id` + `name` (matching the M19 `User`-projection cadence
 * elsewhere in the CLI — `account_tags`, `board describe`'s
 * subscribers, etc.). Future verbs that need wider User detail
 * (`user get <uid>`) read against the full type.
 */
export const uploadedBySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export type UploadedBy = z.infer<typeof uploadedBySchema>;

/**
 * Asset read-projection shape — surfaces Monday's full 10-field
 * `Asset` object (per `scripts/probe/m31-asset-upload.ts` 2026-05-13,
 * API `2026-01`). The output envelope echoes this verbatim so an
 * agent reading the upload result has every field a follow-up
 * `Query.assets(ids:)` read would surface, plus the inputs the CLI
 * sent (echoed by the caller, not this module).
 *
 * `original_geometry` + `url_thumbnail` are image-only; nullable
 * for non-image uploads. `created_at` is nullable in Monday's
 * schema even though every successful upload sets it (the
 * nullability is preserved for fidelity against the introspected
 * type).
 */
export const assetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().min(1),
    public_url: z.string().min(1),
    file_extension: z.string(),
    file_size: z.number().int().nonnegative(),
    created_at: z.string().nullable(),
    uploaded_by: uploadedBySchema,
    original_geometry: z.string().nullable(),
    url_thumbnail: z.string().nullable(),
  })
  .strict();

export type Asset = z.infer<typeof assetSchema>;

/**
 * Output shape for `monday item upload <iid> --column <col> <file>`.
 * Echoes the wire `Asset` record plus the agent-supplied inputs
 * (`item_id`, `column_id`, `filename`, `file_size_bytes`) so one
 * envelope read carries the full upload context.
 *
 * `file_size_bytes` is the CLI-measured size at upload time (from
 * the local file's `fs.stat()`); `asset.file_size` is Monday's
 * server-stored size (usually identical to `file_size_bytes` but
 * preserved separately for asymmetric-storage-encoding fidelity).
 *
 * `asset` is the canonical wire record; future field additions
 * land additively per the §6.1 envelope evolution rules.
 */
export const itemUploadOutputSchema = z
  .object({
    operation: z.literal('add_file_to_column'),
    item_id: z.string().min(1),
    column_id: z.string().min(1),
    filename: z.string().min(1),
    file_size_bytes: z.number().int().nonnegative(),
    asset: assetSchema,
  })
  .strict();

export type ItemUploadOutput = z.infer<typeof itemUploadOutputSchema>;

/**
 * Output shape for `monday update upload <uid> <file>`. Same general
 * shape as `itemUploadOutputSchema` but carries `update_id` instead
 * of `item_id` + `column_id` (an Update record is the target;
 * Monday's `Update.assets` collection grows by one on success).
 */
export const updateUploadOutputSchema = z
  .object({
    operation: z.literal('add_file_to_update'),
    update_id: z.string().min(1),
    filename: z.string().min(1),
    file_size_bytes: z.number().int().nonnegative(),
    asset: assetSchema,
  })
  .strict();

export type UpdateUploadOutput = z.infer<typeof updateUploadOutputSchema>;

/**
 * Mutation document for `add_file_to_column`. Operation name is
 * pinned literally to `AddFileToColumn` and matches the wire
 * `operationName` payload (R-NEW-37 W2 audit-point — caller-
 * overridable operationName slots were closed at M27 IMPL round-1
 * P2-1).
 *
 * `$file: File!` — Monday's own scalar (NOT the spec-standard
 * `Upload!`); the multipart wire dispatcher (`assets.ts`'s caller
 * via `MultipartTransport`) populates this slot via the spec-
 * compliant `map` JSON pointing the file part at `variables.file`.
 *
 * Returns the full 10-field `Asset` selection so the output
 * envelope captures Monday's complete view of the upload in one
 * round-trip (no follow-up `Query.assets(ids:)` re-read needed).
 */
export const ADD_FILE_TO_COLUMN_MUTATION = `
  mutation AddFileToColumn(
    $itemId: ID!,
    $columnId: String!,
    $file: File!
  ) {
    add_file_to_column(
      item_id: $itemId,
      column_id: $columnId,
      file: $file
    ) {
      id
      name
      url
      public_url
      file_extension
      file_size
      created_at
      uploaded_by { id name }
      original_geometry
      url_thumbnail
    }
  }
`;

/**
 * Mutation document for `add_file_to_update`. Operation name pinned
 * to `AddFileToUpdate` (R-NEW-37 W2). No `column_id` — Updates
 * carry attachments directly via `Update.assets`.
 */
export const ADD_FILE_TO_UPDATE_MUTATION = `
  mutation AddFileToUpdate(
    $updateId: ID!,
    $file: File!
  ) {
    add_file_to_update(
      update_id: $updateId,
      file: $file
    ) {
      id
      name
      url
      public_url
      file_extension
      file_size
      created_at
      uploaded_by { id name }
      original_geometry
      url_thumbnail
    }
  }
`;

export interface AddFileToColumnInputs {
  readonly client: MondayClient;
  readonly multipart: MultipartTransport;
  readonly itemId: string;
  readonly columnId: string;
  readonly file: Blob;
  readonly filename: string;
}

export interface AddFileToColumnResult {
  readonly asset: Asset;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

export interface AddFileToUpdateInputs {
  readonly client: MondayClient;
  readonly multipart: MultipartTransport;
  readonly updateId: string;
  readonly file: Blob;
  readonly filename: string;
}

export interface AddFileToUpdateResult {
  readonly asset: Asset;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/* c8 ignore start — pre-flight stub bodies. IMPL replaces both
   functions with the real `multipart.request(...)` dispatch + the
   response-parse boundary (zod `assetSchema` via `unwrapOrThrow`)
   + complexity passthrough. The c8 ignore drops with the IMPL feat
   per the M30 pre-flight cadence. */

/**
 * **PRE-FLIGHT STUB.** Fires Monday's `add_file_to_column` mutation
 * via the multipart transport. IMPL replaces this body with:
 *
 *   1. Build the operations payload — `{query: ADD_FILE_TO_COLUMN
 *      _MUTATION, variables: {itemId, columnId, file: null},
 *      operationName: 'AddFileToColumn'}`. The `file: null`
 *      placeholder is mandatory per the multipart spec.
 *   2. Dispatch via `inputs.multipart.request({query, variables,
 *      operationName, fileVariableName: 'file', file, filename,
 *      signal})`.
 *   3. Map the response — null `add_file_to_column` → `not_found`
 *      with `details.{item_id, column_id}`; non-Asset shape →
 *      `internal_error` with `details.issues` from
 *      `assetSchema.safeParse(...)`.
 *   4. Return the parsed `Asset` + `source: 'live'` +
 *      `cacheAgeSeconds: null` + the wire complexity.
 *
 * `operationName: 'AddFileToColumn'` stays in sync with the named
 * operation in {@link ADD_FILE_TO_COLUMN_MUTATION} (R-NEW-37 W2).
 * Not caller-overridable.
 *
 * Not idempotent — re-running mints a new Asset record.
 */
export const addFileToColumn = (
  inputs: AddFileToColumnInputs,
): Promise<AddFileToColumnResult> => {
  void inputs;
  return Promise.reject(
    new ApiError(
      'internal_error',
      'addFileToColumn stub — runtime body lands at v0.4-M31 IMPL',
      {
        details: {
          deferred_to: 'v0.4-M31 IMPL',
          hint: 'this code path is unreachable in v0.4-M30 release surface; pre-flight stub lands the type signature + mutation document + Asset schema before the runtime body.',
        },
      },
    ),
  );
};

/**
 * **PRE-FLIGHT STUB.** Fires Monday's `add_file_to_update` mutation
 * via the multipart transport. IMPL mirrors {@link addFileToColumn}'s
 * shape — same multipart-payload assembly, same response-parse
 * boundary, same idempotency caveat.
 */
export const addFileToUpdate = (
  inputs: AddFileToUpdateInputs,
): Promise<AddFileToUpdateResult> => {
  void inputs;
  return Promise.reject(
    new ApiError(
      'internal_error',
      'addFileToUpdate stub — runtime body lands at v0.4-M31 IMPL',
      {
        details: {
          deferred_to: 'v0.4-M31 IMPL',
          hint: 'this code path is unreachable in v0.4-M30 release surface; pre-flight stub lands the type signature + mutation document + Asset schema before the runtime body.',
        },
      },
    ),
  );
};

/* c8 ignore stop */
