/**
 * Notification send surface for the v0.3-M27 `monday notification
 * send` verb (`cli-design.md` §2.7 + §4.3 + §13 v0.3 entry;
 * `v0.3-plan.md` §3 M27).
 *
 * **Wire surface (empirical probe 2026-05-12, API `2026-01`).** One
 * Monday GraphQL operation lands here:
 *
 *   - `Mutation.create_notification(user_id: ID!, target_id: ID!,
 *     target_type: NotificationTargetType!, text: String!)` — returns
 *     the created `Notification { id, text }`.
 *
 * **`NotificationTargetType` is a 2-value wire enum: `Post` / `Project`.**
 * Monday's `Post` value targets an Update (sending a notification
 * about a specific post); `Project` targets an Item OR a Board (the
 * wire enum doesn't distinguish). The CLI surface keeps the
 * documented `--target-type item|board` argv vocabulary from
 * cli-design §4.3 — both CLI values map to wire `Project`. The CLI
 * preserves the item-vs-board distinction at the parse boundary
 * (driving target-shape validation at M27 IMPL) even though the
 * wire collapses both to one enum. Monday's `Post` variant is
 * unreachable at v0.3 — a v0.3.x / v0.4 contract-extension may add
 * `--target-type update` once a clean argv-discriminator design is
 * pinned (cli-design §13 v0.3 entry M27 sub-block carries the
 * deferred note).
 *
 * **`Notification` read shape is minimal (2 fields).** `id` (ID,
 * non-null), `text` (String, nullable). The CLI echoes the input
 * fields (`user_id`, `target_id`, `target_type`) alongside the
 * Monday-side fields so an agent verifies what was sent from a
 * single envelope read.
 *
 * **No new ERROR_CODES (29 stays).** Notification send failures
 * route through the existing codes: `not_found` (target user / item
 * / board missing or invisible to the token), `usage_error` (text
 * empty / malformed argv / target_type / target_id mismatch),
 * `unauthorized` (token lacks notification scope), `forbidden`
 * (account permissions), `validation_failed` (Monday-side rejection).
 *
 * **Notification send is single-recipient at v0.3** per cli-design
 * §4.3 — the `--user <uid>` flag accepts one ID. Multi-recipient
 * fan-out is a v0.3.x / v0.4 contract-extension (agents needing
 * fan-out call `notification send` N times).
 *
 * **Notification send is not idempotent.** Re-running the verb
 * produces a fresh notification with a new `id` (Monday treats
 * each `create_notification` call as a discrete send). Agents
 * needing send-once-semantics dedup on the CLI side; the verb
 * does not enforce idempotency.
 *
 * **Pre-flight stub.** Runtime fetcher (`sendNotification`)
 * rejects with `internal_error` under `c8 ignore start/stop`
 * block-wraps; M27 IMPL drops the wraps + lands the wire body
 * (mirrors the M21 oauth-stub / M24 history-stub / M25
 * partial-success-bulk / M26 dev-conventions precedents).
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import type { MondayClient } from './client.js';

/**
 * CLI-side `target_type` vocabulary for `monday notification send
 * --target-type <type>`. Both values map to Monday's wire
 * `NotificationTargetType.Project` (which represents both items and
 * boards) — the CLI keeps the item-vs-board distinction for argv
 * validation discipline (the runtime body at M27 IMPL will verify
 * the supplied `--target <id>` actually names an item or board to
 * match the supplied type before firing the wire mutation).
 *
 * Monday's third wire enum value (`Post`, for Update-targeted
 * notifications) is intentionally not surfaced at v0.3 per
 * cli-design §4.3. A v0.3.x / v0.4 contract-extension may add
 * `--target-type update`.
 */
export const NOTIFICATION_TARGET_TYPES = ['item', 'board'] as const;

export type NotificationTargetType =
  (typeof NOTIFICATION_TARGET_TYPES)[number];

export const notificationTargetTypeSchema = z.enum(NOTIFICATION_TARGET_TYPES);

/**
 * Output shape for `monday notification send --user <uid> --target
 * <iid|bid> --target-type item|board --text <t>`. Carries both the
 * Monday-side fields (`id` of the minted notification, server-echo
 * `text`) and the CLI-side inputs (`user_id`, `target_id`,
 * `target_type`) so an agent verifies what was sent from a single
 * envelope read.
 *
 * `text` is nullable on the wire (Monday's `Notification.text` is
 * `String` not `String!`); we preserve nullability for fidelity even
 * though `create_notification`'s input `text` is non-null. In
 * practice it round-trips the input value.
 */
export const notificationSendOutputSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().nullable(),
    user_id: z.string().min(1),
    target_id: z.string().min(1),
    target_type: notificationTargetTypeSchema,
  })
  .strict();

export type NotificationSendOutput = z.infer<
  typeof notificationSendOutputSchema
>;

export interface SendNotificationInputs {
  readonly client: MondayClient;
  readonly userId: string;
  readonly targetId: string;
  readonly targetType: NotificationTargetType;
  readonly text: string;
  readonly operationName?: string;
}

export interface SendNotificationResult {
  readonly notification: NotificationSendOutput;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: number | null;
}

/**
 * Stub fetcher for {@link notificationSendCommand}. M27 IMPL lands
 * the wire body: a single `Mutation.create_notification` round-trip
 * via `client.raw` with `operationName: 'CreateNotification'`
 * (R-NEW-37 watch-item: keep doc-named-operation + wire-
 * operationName in sync). Both CLI `--target-type` values map to
 * wire `Project`; the IMPL body translates at the parse boundary.
 */
/* c8 ignore start -- pre-flight stub; runtime body at M27 IMPL */
export const sendNotification = async (
  _inputs: SendNotificationInputs,
): Promise<SendNotificationResult> => {
  await Promise.reject(
    new ApiError(
      'internal_error',
      'sendNotification not yet implemented (v0.3-M27 pre-flight stub)',
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
