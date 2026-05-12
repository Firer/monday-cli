/**
 * Webhook surface for the v0.3-M27 `monday webhook list/create/delete`
 * verbs (`cli-design.md` §2.7 + §4.3 + §13 v0.3 entry;
 * `v0.3-plan.md` §3 M27).
 *
 * **Wire surface (empirical probe 2026-05-12, API `2026-01`).** Three
 * Monday GraphQL operations land here:
 *
 *   - `Query.webhooks(board_id: ID!, app_webhooks_only: Boolean)` —
 *     returns `[Webhook!]`. CLI exposes board-scoped only (the
 *     `app_webhooks_only` filter is a future v0.3.x / v0.4 extension
 *     once apps land).
 *   - `Mutation.create_webhook(board_id: ID!, url: String!,
 *     event: WebhookEventType!, config: JSON)` — returns the created
 *     `Webhook`. The CLI surface keeps `--config <json>` as an opaque
 *     JSON string; per-event sub-shape validation happens server-side
 *     at Monday (Decision 9 closure note in §3 M27).
 *   - `Mutation.delete_webhook(id: ID!)` — returns the deleted
 *     `Webhook`. The CLI surfaces the full deleted record so an agent
 *     re-checking the namespace can verify what went away.
 *
 * **Webhook object shape (4 fields).** `id` (ID, non-null), `board_id`
 * (ID, non-null), `event` (WebhookEventType, non-null), `config`
 * (String, nullable). Note the **asymmetric `config` typing**: the
 * `create_webhook` arg is typed `JSON` (any valid JSON value); the
 * read-side `Webhook.config` field is typed `String` (Monday echoes
 * back the stored JSON-encoded string). The CLI's read schema treats
 * `config` as `string | null`; the create-input passes `--config`
 * through as a JSON string at the wire boundary.
 *
 * **Decision 9 (webhook event-type validation) — CLOSED at M27
 * pre-flight via the `WEBHOOK_EVENT_TYPES` 21-value closed enum.**
 * Per cli-design §8 default recommendation: zod enum at parse
 * boundary; unknown events surface `usage_error` before hitting
 * the wire. Empirical probe (`scripts/probe/m27-create-webhook
 * -input.ts`, 2026-05-12, API `2026-01`) pinned the vocabulary
 * directly from Monday's introspection — `WebhookEventType` is an
 * `ENUM` with exactly 21 values; additions land as additive minor
 * bumps. Renames or removals are a major version bump.
 *
 * **No new ERROR_CODES (29 stays).** Webhook failures route through
 * the existing codes: `not_found` (missing board / missing webhook),
 * `usage_error` (unknown event-type / malformed URL), `unauthorized`
 * (token lacks webhook-management scope), `forbidden` (account
 * permissions), `validation_failed` (Monday-side rejection of the
 * create payload). No webhook-specific failure mode requires new
 * code-registry surface.
 *
 * **Webhooks are live-only for v0.3.** Per cli-design §8 cache scope,
 * webhooks aren't cached — the live `webhook list` read and the live
 * `webhook create` / `webhook delete` mutation paths emit
 * `meta.source: "live"` with `cache_age_seconds: null`. `--dry-run`
 * paths emit `meta.source: "none"` per the canonical `DryRunEnvelope`
 * contract; all 3 write-verb dry-runs are strictly argv-derived (no
 * pre-mutation read fires — Monday's `webhooks(board_id:)` query is
 * board-scoped but `webhook delete <wid>` carries no board ID, so a
 * pre-read enrichment would require a §4.3 amendment).
 * Adding webhooks to the §8 cache scope would be a contract
 * extension (v0.3.x / v0.4).
 *
 * **Pre-flight stubs.** Runtime fetchers (`listWebhooks` /
 * `createWebhook` / `deleteWebhook`) reject with `internal_error`
 * under `c8 ignore start/stop` block-wraps; M27 IMPL drops the wraps
 * + lands the wire bodies (mirrors M21 oauth-stub / M24 history-stub
 * / M25 partial-success-bulk / M26 dev-conventions precedents).
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import type { MondayClient } from './client.js';

/**
 * Monday's `WebhookEventType` enum vocabulary (empirical probe
 * 2026-05-12, API `2026-01`; 21 values). Pinned at M27 pre-flight
 * to close Decision 9 (webhook event-type validation). The CLI
 * validates `webhook create --event <type>` against this closed
 * list at parse boundary; unknown events surface `usage_error`
 * before hitting the wire.
 *
 * Adding an event to Monday's wire surface is a minor (additive)
 * bump for the CLI — extend this list and the per-command flag
 * help. Renames or removals are a major version bump.
 *
 * The 21 values cover three event families (6 + 10 + 5 = 21):
 *   - **Column-value + name-change events (6):** `change_column_value`,
 *     `change_specific_column_value`, `change_status_column_value`,
 *     `change_subitem_column_value`, `change_name`,
 *     `change_subitem_name`.
 *   - **Item / subitem lifecycle events (10):** `create_item`,
 *     `create_subitem`, `item_archived`, `item_deleted`,
 *     `item_moved_to_any_group`, `item_moved_to_specific_group`,
 *     `item_restored`, `move_subitem`, `subitem_archived`,
 *     `subitem_deleted`.
 *   - **Update / column-management events (5):** `create_update`,
 *     `create_subitem_update`, `edit_update`, `delete_update`,
 *     `create_column`.
 */
export const WEBHOOK_EVENT_TYPES = [
  'change_column_value',
  'change_name',
  'change_specific_column_value',
  'change_status_column_value',
  'change_subitem_column_value',
  'change_subitem_name',
  'create_column',
  'create_item',
  'create_subitem',
  'create_subitem_update',
  'create_update',
  'delete_update',
  'edit_update',
  'item_archived',
  'item_deleted',
  'item_moved_to_any_group',
  'item_moved_to_specific_group',
  'item_restored',
  'move_subitem',
  'subitem_archived',
  'subitem_deleted',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

/**
 * The read-side `Webhook` shape returned by `Query.webhooks` and as
 * the result of `create_webhook` / `delete_webhook` mutations.
 *
 * `config` is **nullable string** on read (Monday echoes the stored
 * JSON-encoded config as a string; for events that don't carry
 * server-side config, the field comes back `null`). The
 * `create_webhook` arg is typed `JSON` (any valid JSON value); CLI
 * input takes a JSON-encoded string and threads it to the wire
 * via the `JSON` scalar.
 */
export const webhookSchema = z
  .object({
    id: z.string().min(1),
    board_id: z.string().min(1),
    event: webhookEventTypeSchema,
    config: z.string().nullable(),
  })
  .strict();

export type Webhook = z.infer<typeof webhookSchema>;

/**
 * Output shape for `monday webhook list <bid>` — an array of
 * {@link Webhook} entries scoped to the supplied board. Pure read
 * surface, no mutation envelope.
 */
export const webhookListOutputSchema = z.array(webhookSchema);

export type WebhookListOutput = readonly Webhook[];

/**
 * Output shape for `monday webhook create <bid> --url <u>
 * --event <e> [--config <json>]`. The mutation echoes the created
 * `Webhook` (with the freshly-minted ID); we surface that record
 * directly so an agent can pin the new `id` for a later
 * `webhook delete <wid>`.
 */
export const webhookCreateOutputSchema = webhookSchema;

export type WebhookCreateOutput = Webhook;

/**
 * Output shape for `monday webhook delete <wid> --yes`. Monday's
 * `delete_webhook` returns the deleted `Webhook` record; the CLI
 * surfaces that directly so an agent confirms what was removed
 * (event / board / config). Re-deleting an already-deleted webhook
 * surfaces `not_found` (matches the M10 `item delete` / M15
 * `board delete` shape so agents key off one error code regardless
 * of which delete verb they ran).
 */
export const webhookDeleteOutputSchema = webhookSchema;

export type WebhookDeleteOutput = Webhook;

export interface ListWebhooksInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly operationName?: string;
}

export interface ListWebhooksResult {
  readonly webhooks: readonly Webhook[];
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: number | null;
}

/**
 * Stub fetcher for {@link webhookListCommand}. M27 IMPL lands the
 * wire body: a single `Query.webhooks(board_id:)` round-trip via
 * `client.raw` with `operationName: 'Webhooks'` (R-NEW-37 watch-
 * item: keep doc-named-operation + wire-operationName in sync).
 * The supplied document carries a named `query Webhooks` operation
 * that aligns with the threaded operationName. Result is projected
 * through {@link webhookSchema} via the parse-boundary helpers.
 * Source is always `'live'` per cli-design §8 cache scope.
 */
/* c8 ignore start -- pre-flight stub; runtime body at M27 IMPL */
export const listWebhooks = async (
  _inputs: ListWebhooksInputs,
): Promise<ListWebhooksResult> => {
  await Promise.reject(
    new ApiError(
      'internal_error',
      'listWebhooks not yet implemented (v0.3-M27 pre-flight stub)',
      {
        details: {
          hint: 'M27 IMPL session lands the wire body; see docs/v0.3-plan.md §3 M27',
        },
      },
    ),
  );
  throw new Error('unreachable');
};
/* c8 ignore stop */

export interface CreateWebhookInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly url: string;
  readonly event: WebhookEventType;
  readonly config?: string;
  readonly operationName?: string;
}

export interface CreateWebhookResult {
  readonly webhook: Webhook;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: number | null;
}

/**
 * Stub fetcher for {@link webhookCreateCommand}. M27 IMPL lands the
 * wire body via `client.raw` against the `CreateWebhook` mutation
 * with `operationName: 'CreateWebhook'` (R-NEW-37 watch-item: keep
 * doc-named-operation + wire-operationName in sync). The `config`
 * input crosses the wire as the `JSON` scalar — the CLI accepts an
 * opaque JSON string at argv and threads it through; per-event
 * structural validation lives server-side at Monday.
 */
/* c8 ignore start -- pre-flight stub; runtime body at M27 IMPL */
export const createWebhook = async (
  _inputs: CreateWebhookInputs,
): Promise<CreateWebhookResult> => {
  await Promise.reject(
    new ApiError(
      'internal_error',
      'createWebhook not yet implemented (v0.3-M27 pre-flight stub)',
      {
        details: {
          hint: 'M27 IMPL session lands the wire body; see docs/v0.3-plan.md §3 M27',
        },
      },
    ),
  );
  throw new Error('unreachable');
};
/* c8 ignore stop */

export interface DeleteWebhookInputs {
  readonly client: MondayClient;
  readonly webhookId: string;
  readonly operationName?: string;
}

export interface DeleteWebhookResult {
  readonly webhook: Webhook;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: number | null;
}

/**
 * Stub fetcher for {@link webhookDeleteCommand}. M27 IMPL lands the
 * wire body via `client.raw` against the `DeleteWebhook` mutation
 * with `operationName: 'DeleteWebhook'`. Re-deleting an already-
 * deleted webhook surfaces `not_found` (matches the M10/M15 lifecycle
 * verbs).
 */
/* c8 ignore start -- pre-flight stub; runtime body at M27 IMPL */
export const deleteWebhook = async (
  _inputs: DeleteWebhookInputs,
): Promise<DeleteWebhookResult> => {
  await Promise.reject(
    new ApiError(
      'internal_error',
      'deleteWebhook not yet implemented (v0.3-M27 pre-flight stub)',
      {
        details: {
          hint: 'M27 IMPL session lands the wire body; see docs/v0.3-plan.md §3 M27',
        },
      },
    ),
  );
  throw new Error('unreachable');
};
/* c8 ignore stop */
