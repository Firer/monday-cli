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
 * interfaces. See `docs/architecture.md` "Wire-vs-CLI semantics
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
 * `details.file_size_bytes` (the local `fs.stat()` measurement
 * captured at upload time — Monday's wire rejection may not surface
 * a size field, but the CLI already has the local size from the
 * read leg and threads it for a stable agent-keyed envelope).
 *
 * **Idempotency: NO.** Each successful upload mints a new Asset
 * with a new ID — re-running `item upload` with the same args
 * uploads the file a second time. Agents needing register-once
 * semantics dedupe on the CLI side (e.g., read `Item.assets` first
 * and skip the upload if a matching `Asset.name` exists).
 *
 * **Status: runtime body shipped at v0.4-M31 IMPL.** Both fetchers
 * dispatch via `inputs.multipart.request(...)` wrapped in
 * `withRetry(...)` per cli-design §2.5; the response-parse boundary
 * uses `mapResponse` (mirroring `MondayClient.raw`'s discipline) +
 * `assertResponseFieldPresent` for the schema-drift / null-payload
 * distinction + `assetSchema.safeParse(...)` via `unwrapOrThrow`
 * for the per-field shape. Server-side size-cap rewrap fires at
 * the error-mapping layer below.
 */

import { z } from 'zod';
import { ApiError, MondayCliError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import { parseComplexity } from './complexity.js';
import { mapResponse, wrapTransportError } from './errors.js';
import { withRetry } from './retry.js';
import { assertResponseFieldPresent } from './response-root.js';
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
  /**
   * **Required** AbortSignal threaded into the multipart wire
   * dispatch via `MultipartTransportRequest.signal` at IMPL.
   * Callers MUST pass the runner's combined signal (`ctx.signal`)
   * explicitly — `MondayClient.signal` is private + multipart
   * dispatch bypasses `MondayClient.raw`, so no implicit fallback
   * exists. Abort propagation follows the standard
   * `--timeout` / SIGINT plumbing (`src/api/transport.ts`'s
   * `combineSignals` mirrors the multipart-transport's own
   * combined-signal logic at IMPL).
   *
   * **Retry semantics pinned (cli-design §2.5).** Asset upload
   * honors the global `--retry <n>` contract: the IMPL session
   * wraps `multipart.request(...)` in `withRetry(...)` using the
   * `retries` value threaded from `client.config`'s retry slot.
   * Re-readability is safe — Web `Blob.stream()` returns a fresh
   * `ReadableStream` per call, so multipart payload assembly can
   * re-execute on each retry attempt without buffering.
   * Retryable conditions match the JSON transport's set
   * (`rate_limited` / `complexity_exceeded` /
   * `concurrency_exceeded` / `ip_rate_limited` /
   * `resource_locked` / `network_error`); non-retryable
   * conditions (`forbidden`, `not_found`, `validation_failed`,
   * `usage_error` with `file_too_large`) surface immediately.
   */
  readonly signal: AbortSignal;
  /**
   * Maximum retry count for transient failures (default
   * `--retry 3`, range `[0, ...]`). Threaded through to
   * `withRetry(...)` at IMPL — same retry layer the JSON
   * transport uses (cli-design §2.5).
   */
  readonly retries: number;
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
  /**
   * **Required** — same semantics as
   * {@link AddFileToColumnInputs.signal}. Callers MUST pass
   * `ctx.signal` explicitly (no implicit fallback from
   * `client`).
   */
  readonly signal: AbortSignal;
  /**
   * Same semantics as {@link AddFileToColumnInputs.retries} —
   * threaded into `withRetry(...)` around the multipart
   * dispatch at IMPL.
   */
  readonly retries: number;
}

export interface AddFileToUpdateResult {
  readonly asset: Asset;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Re-wraps Monday's server-side file-size rejection as the
 * agent-stable `usage_error` shape (D3 closure). Monday surfaces the
 * cap a couple of ways depending on the error path — common signals:
 *
 *   - `extensions.code: 'FILE_SIZE_LIMIT_EXCEEDED'` on a 200 GraphQL
 *     errors[] payload (the most common shape — Monday's GraphQL
 *     server stays on 200 even for input-validation rejections).
 *   - `extensions.error_code: 'FILE_SIZE_LIMIT_EXCEEDED'` (older API
 *     shape preserved across versions).
 *   - HTTP 413 with no GraphQL body (rare; intermediated by an LB
 *     between us and Monday's server).
 *   - The bare error message contains "file size" / "file too large"
 *     / "exceeds the limit" (string-fallback for proxy-mediated paths
 *     that strip extensions).
 *
 * The matcher reads `mapResponse`'s typed error rather than the raw
 * body — `mapResponse` already extracted the GraphQL extensions +
 * Monday code into the `validation_failed` ApiError; we then check
 * the same signals here to upgrade the rewrap. `details.file_size_
 * bytes` is the local `fs.stat()` measurement the caller threaded
 * (D3 — Monday's wire rejection may not surface a size, but the CLI
 * has the local size from the read leg and threads a stable
 * envelope).
 */
const isFileTooLargeRejection = (err: MondayCliError): boolean => {
  if (err.httpStatus === 413) return true;
  const monday = err.mondayCode?.toUpperCase() ?? '';
  if (monday === 'FILE_SIZE_LIMIT_EXCEEDED') return true;
  // Fallback to the message vocabulary — Monday occasionally returns
  // a generic `validation_failed` with the size language inline.
  const msg = err.message.toLowerCase();
  if (
    msg.includes('file size limit') ||
    msg.includes('file too large') ||
    msg.includes('exceeds the limit')
  ) {
    return true;
  }
  return false;
};

interface RewrapSizeRejectionInputs {
  readonly err: MondayCliError;
  readonly fileSizeBytes: number;
  readonly filename: string;
}

const rewrapAsFileTooLarge = ({
  err,
  fileSizeBytes,
  filename,
}: RewrapSizeRejectionInputs): ApiError =>
  new ApiError(
    'usage_error',
    `Monday rejected the upload — file ${JSON.stringify(filename)} ` +
      `exceeds the per-file size limit (uploaded ${String(fileSizeBytes)} bytes).`,
    {
      cause: err,
      details: {
        reason: 'file_too_large',
        file_size_bytes: fileSizeBytes,
        filename,
        hint:
          "Monday's per-file cap is plan-tier-dependent (typically 500 MB at " +
          'standard tiers, larger at enterprise); contact Monday support to ' +
          "confirm your account's exact ceiling.",
      },
    },
  );

interface DispatchInputs {
  readonly multipart: MultipartTransport;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly operationName: string;
  readonly fileVariableName: string;
  readonly file: Blob;
  readonly filename: string;
  readonly signal: AbortSignal;
}

interface DispatchResult {
  readonly data: unknown;
  readonly complexity: Complexity | null;
}

/**
 * Single multipart round-trip with the standard parse-boundary
 * (mirrors `MondayClient.raw`'s shape but for the multipart seam):
 *
 *   1. `multipart.request(...)` → raw transport response.
 *   2. `mapResponse<unknown>` → tagged `MapResult` ({ok, data} or
 *      {ok, error}); non-ok throws the typed ApiError directly so
 *      `withRetry` can inspect `error.retryable` + `retry_after_
 *      seconds` upstream.
 *   3. `parseComplexity` projects any `complexity` block Monday
 *      surfaces (asset-upload mutations don't return one today, but
 *      keeping the same shape as `MondayClient.raw` means future
 *      Monday API revisions surface complexity uniformly).
 *
 * Wrapped with `wrapTransportError` so a non-ApiError throw (a bug
 * in the fixture transport, a future SDK shim) becomes
 * `internal_error` rather than escaping unmapped.
 */
const dispatchMultipartOnce = async (
  inputs: DispatchInputs,
): Promise<DispatchResult> => {
  try {
    const response = await inputs.multipart.request({
      query: inputs.query,
      variables: inputs.variables,
      operationName: inputs.operationName,
      fileVariableName: inputs.fileVariableName,
      file: inputs.file,
      filename: inputs.filename,
      signal: inputs.signal,
    });
    const mapped = mapResponse({
      status: response.status,
      headers: response.headers,
      body: response.body,
    });
    if (!mapped.ok) {
      throw mapped.error;
    }
    const complexity = parseComplexity(response.body);
    return { data: mapped.data, complexity };
  } catch (err) {
    throw wrapTransportError(err);
  }
};

/**
 * Fires Monday's `add_file_to_column` mutation via the multipart
 * transport (operationName `AddFileToColumn`, pinned literally per
 * R-NEW-37 W2 — NOT caller-overridable). Builds the operations
 * payload with the `file: null` placeholder per the GraphQL
 * multipart-request spec, dispatches through `inputs.multipart` +
 * `withRetry(...)`, parses the response — null `add_file_to_column`
 * → `not_found` with `details.{item_id, column_id}`; non-Asset
 * shape → `internal_error` via `assetSchema.safeParse + unwrapOr
 * Throw`. Server-side size rejections rewrap as `usage_error` with
 * `details.reason: 'file_too_large'` + `details.file_size_bytes`
 * from the caller-supplied local `fs.stat()` measurement (D3).
 *
 * Not idempotent — re-running mints a new `Asset` ID.
 */
export const addFileToColumn = async (
  inputs: AddFileToColumnInputs,
): Promise<AddFileToColumnResult> => {
  // Spec-compliant operations payload: the file variable's value is
  // `null` (mandatory placeholder); the multipart `map` JSON in the
  // transport pins the file part at `variables.file`.
  const variables: Record<string, unknown> = {
    itemId: inputs.itemId,
    columnId: inputs.columnId,
    file: null,
  };

  let result;
  try {
    result = await withRetry(
      () =>
        dispatchMultipartOnce({
          multipart: inputs.multipart,
          query: ADD_FILE_TO_COLUMN_MUTATION,
          variables,
          operationName: 'AddFileToColumn',
          fileVariableName: 'file',
          file: inputs.file,
          filename: inputs.filename,
          signal: inputs.signal,
        }),
      {
        retries: inputs.retries,
        signal: inputs.signal,
      },
    );
  } catch (err) {
    if (err instanceof MondayCliError && isFileTooLargeRejection(err)) {
      throw rewrapAsFileTooLarge({
        err,
        fileSizeBytes: inputs.file.size,
        filename: inputs.filename,
      });
    }
    throw err;
  }

  // Reference `inputs.client` so future complexity-passthrough work
  // can inspect verbose mode without changing the call signature.
  // Today the multipart wire bypasses the JSON client entirely; the
  // slot stays for symmetry with the JSON fetchers' shape.
  void inputs.client;

  const wireData = result.value.data;
  assertResponseFieldPresent({
    data: wireData,
    key: 'add_file_to_column',
    operationLabel: 'AddFileToColumn',
    details: { item_id: inputs.itemId, column_id: inputs.columnId },
    nullHandling: 'caller_handles',
  });
  // After `assertResponseFieldPresent`, `wireData` is structurally a
  // record with the `add_file_to_column` key present (might be null).
  const root = (wireData as Record<string, unknown>).add_file_to_column;
  if (root === null || root === undefined) {
    throw new ApiError(
      'not_found',
      `Item ${inputs.itemId} or column ${JSON.stringify(inputs.columnId)} ` +
        `does not exist on a board the token has write access to.`,
      {
        details: {
          item_id: inputs.itemId,
          column_id: inputs.columnId,
        },
      },
    );
  }
  const asset = unwrapOrThrow(assetSchema.safeParse(root), {
    context:
      'Monday returned a malformed Asset shape from add_file_to_column',
    details: {
      item_id: inputs.itemId,
      column_id: inputs.columnId,
      filename: inputs.filename,
    },
  });
  return {
    asset,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: result.value.complexity,
  };
};

/**
 * Fires Monday's `add_file_to_update` mutation via the multipart
 * transport (operationName `AddFileToUpdate`, pinned literally per
 * R-NEW-37 W2). Mirrors {@link addFileToColumn}'s shape minus the
 * `column_id` slot — Updates carry attachments via `Update.assets`
 * directly. Same response-parse boundary, same `file_too_large`
 * rewrap, same idempotency caveat (re-running mints a new Asset).
 */
export const addFileToUpdate = async (
  inputs: AddFileToUpdateInputs,
): Promise<AddFileToUpdateResult> => {
  const variables: Record<string, unknown> = {
    updateId: inputs.updateId,
    file: null,
  };

  let result;
  try {
    result = await withRetry(
      () =>
        dispatchMultipartOnce({
          multipart: inputs.multipart,
          query: ADD_FILE_TO_UPDATE_MUTATION,
          variables,
          operationName: 'AddFileToUpdate',
          fileVariableName: 'file',
          file: inputs.file,
          filename: inputs.filename,
          signal: inputs.signal,
        }),
      {
        retries: inputs.retries,
        signal: inputs.signal,
      },
    );
  } catch (err) {
    if (err instanceof MondayCliError && isFileTooLargeRejection(err)) {
      throw rewrapAsFileTooLarge({
        err,
        fileSizeBytes: inputs.file.size,
        filename: inputs.filename,
      });
    }
    throw err;
  }

  void inputs.client;

  const wireData = result.value.data;
  assertResponseFieldPresent({
    data: wireData,
    key: 'add_file_to_update',
    operationLabel: 'AddFileToUpdate',
    details: { update_id: inputs.updateId },
    nullHandling: 'caller_handles',
  });
  const root = (wireData as Record<string, unknown>).add_file_to_update;
  if (root === null || root === undefined) {
    throw new ApiError(
      'not_found',
      `Update ${inputs.updateId} does not exist or the token has no write ` +
        `access.`,
      { details: { update_id: inputs.updateId } },
    );
  }
  const asset = unwrapOrThrow(assetSchema.safeParse(root), {
    context: 'Monday returned a malformed Asset shape from add_file_to_update',
    details: {
      update_id: inputs.updateId,
      filename: inputs.filename,
    },
  });
  return {
    asset,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: result.value.complexity,
  };
};
