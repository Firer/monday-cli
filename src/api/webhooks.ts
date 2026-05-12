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
 * `config` as `string | null`; the create-input parses `--config`
 * once at the parse boundary (in the command's action body) and
 * threads the resulting JS value to Monday's `JSON` scalar (sending
 * the raw string would double-encode).
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
 * **Runtime bodies (M27 IMPL).** Three fetchers — `listWebhooks` /
 * `createWebhook` / `deleteWebhook` — each issue a single
 * `client.raw` round-trip with a named operation (`Webhooks` /
 * `CreateWebhook` / `DeleteWebhook`) matching the document's named
 * operation per the R-NEW-37 W2 audit-point. Results parse through
 * {@link webhookSchema} via `unwrapOrThrow` so payload drift surfaces
 * `internal_error` with `details.issues`; null payloads surface
 * `not_found` with `details.webhook_id` (or `details.board_id` for
 * the list verb).
 */

import { z } from 'zod';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import { assertResponseFieldPresent } from './response-root.js';
import { ApiError } from '../utils/errors.js';
import type { MondayClient } from './client.js';
import type { Complexity } from '../utils/output/envelope.js';

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
}

export interface ListWebhooksResult {
  readonly webhooks: readonly Webhook[];
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

const LIST_WEBHOOKS_QUERY = `
  query Webhooks($boardId: ID!) {
    webhooks(board_id: $boardId) {
      id
      board_id
      event
      config
    }
  }
`;

const listWebhooksResponseSchema = z
  .object({
    webhooks: z.array(webhookSchema).nullable(),
  })
  .loose();

/**
 * Fetches the webhooks configured on `inputs.boardId` via a single
 * `Query.webhooks(board_id:)` round-trip. `operationName: 'Webhooks'`
 * stays in sync with the named operation in {@link LIST_WEBHOOKS_QUERY}
 * (R-NEW-37 W2 audit-point). Source is always `'live'` per cli-design
 * §8 cache scope; webhooks aren't cached at v0.3.
 *
 * A null `webhooks` root surfaces `not_found` with `details.board_id`
 * — matches the M10/M15 lifecycle verbs so agents key off one error
 * code regardless of which read they ran.
 */
export const listWebhooks = async (
  inputs: ListWebhooksInputs,
): Promise<ListWebhooksResult> => {
  const response = await inputs.client.raw<unknown>(
    LIST_WEBHOOKS_QUERY,
    { boardId: inputs.boardId },
    { operationName: 'Webhooks' },
  );
  const parsed = unwrapOrThrow(
    listWebhooksResponseSchema.safeParse(response.data),
    {
      context: 'Monday `Query.webhooks` response',
      details: { board_id: inputs.boardId },
      hint: 'Monday may have amended the `webhooks(board_id:)` selection — re-probe and amend `src/api/webhooks.ts` if so',
    },
  );
  if (parsed.webhooks === null) {
    throw new ApiError(
      'not_found',
      `Monday returned no webhooks payload for board ${inputs.boardId}`,
      { details: { board_id: inputs.boardId } },
    );
  }
  return {
    webhooks: parsed.webhooks,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface CreateWebhookInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly url: string;
  readonly event: WebhookEventType;
  /**
   * Pre-parsed JSON value threaded to Monday's `JSON` scalar `config`
   * arg. The CLI accepts `--config <json>` at argv as a JSON-encoded
   * string; the command's action body parses it once at the parse
   * boundary (surfacing malformed JSON as `usage_error`) and threads
   * the resulting JS value through. Omitting the field skips the
   * argument entirely so Monday's per-event default applies.
   */
  readonly config?: unknown;
}

export interface CreateWebhookResult {
  readonly webhook: Webhook;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

const CREATE_WEBHOOK_MUTATION = `
  mutation CreateWebhook(
    $boardId: ID!,
    $url: String!,
    $event: WebhookEventType!,
    $config: JSON
  ) {
    create_webhook(
      board_id: $boardId,
      url: $url,
      event: $event,
      config: $config
    ) {
      id
      board_id
      event
      config
    }
  }
`;

interface CreateWebhookResponse {
  readonly create_webhook: unknown;
}

/**
 * Registers a new webhook against Monday's `create_webhook` mutation.
 * `operationName: 'CreateWebhook'` stays in sync with the named
 * operation in {@link CREATE_WEBHOOK_MUTATION} (R-NEW-37 W2 audit-
 * point). The `config` input crosses the wire as the `JSON` scalar
 * when supplied — the caller threads any pre-parsed JSON value;
 * when `inputs.config` is `undefined` the `$config` variable is
 * omitted entirely so Monday's per-event server-side default
 * applies (rather than overwriting with `null`). Per-event
 * structural validation lives server-side at Monday.
 *
 * Re-running creates a fresh webhook with a new ID — `idempotent:
 * false`. Agents needing register-once semantics should `webhook
 * list` first and skip the create if a matching entry exists.
 */
export const createWebhook = async (
  inputs: CreateWebhookInputs,
): Promise<CreateWebhookResult> => {
  const variables: Record<string, unknown> = {
    boardId: inputs.boardId,
    url: inputs.url,
    event: inputs.event,
  };
  if (inputs.config !== undefined) {
    variables.config = inputs.config;
  }
  const response = await inputs.client.raw<CreateWebhookResponse>(
    CREATE_WEBHOOK_MUTATION,
    variables,
    { operationName: 'CreateWebhook' },
  );
  assertResponseFieldPresent({
    data: response.data,
    key: 'create_webhook',
    operationLabel: 'CreateWebhook',
    details: { board_id: inputs.boardId, event: inputs.event },
    nullHandling: 'caller_handles',
  });
  const raw = response.data.create_webhook;
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned no webhook payload from create_webhook for board ${inputs.boardId}`,
      {
        details: {
          board_id: inputs.boardId,
          event: inputs.event,
        },
      },
    );
  }
  const webhook = unwrapOrThrow(webhookSchema.safeParse(raw), {
    context: 'Monday `create_webhook` response',
    details: { board_id: inputs.boardId, event: inputs.event },
    hint: 'Monday may have amended the `Webhook` selection — re-probe and amend `src/api/webhooks.ts` if so',
  });
  return {
    webhook,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};

export interface DeleteWebhookInputs {
  readonly client: MondayClient;
  readonly webhookId: string;
}

export interface DeleteWebhookResult {
  readonly webhook: Webhook;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

const DELETE_WEBHOOK_MUTATION = `
  mutation DeleteWebhook($id: ID!) {
    delete_webhook(id: $id) {
      id
      board_id
      event
      config
    }
  }
`;

interface DeleteWebhookResponse {
  readonly delete_webhook: unknown;
}

/**
 * Deletes a webhook via Monday's `delete_webhook` mutation.
 * `operationName: 'DeleteWebhook'` stays in sync with the named
 * operation in {@link DELETE_WEBHOOK_MUTATION} (R-NEW-37 W2 audit-
 * point). Returns the deleted record so an agent confirms what was
 * removed (event / board / config) in a single envelope.
 *
 * A null `delete_webhook` surfaces `not_found` with
 * `details.webhook_id` (matches the M10/M15 lifecycle verbs so
 * agents key off one error code regardless of which delete verb
 * they ran).
 */
export const deleteWebhook = async (
  inputs: DeleteWebhookInputs,
): Promise<DeleteWebhookResult> => {
  const response = await inputs.client.raw<DeleteWebhookResponse>(
    DELETE_WEBHOOK_MUTATION,
    { id: inputs.webhookId },
    { operationName: 'DeleteWebhook' },
  );
  assertResponseFieldPresent({
    data: response.data,
    key: 'delete_webhook',
    operationLabel: 'DeleteWebhook',
    details: { webhook_id: inputs.webhookId },
    nullHandling: 'caller_handles',
  });
  const raw = response.data.delete_webhook;
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no webhook payload from delete_webhook for id ${inputs.webhookId}`,
      { details: { webhook_id: inputs.webhookId } },
    );
  }
  const webhook = unwrapOrThrow(webhookSchema.safeParse(raw), {
    context: 'Monday `delete_webhook` response',
    details: { webhook_id: inputs.webhookId },
    hint: 'Monday may have amended the `Webhook` selection — re-probe and amend `src/api/webhooks.ts` if so',
  });
  return {
    webhook,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};
