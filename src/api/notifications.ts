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
 * for argv-validation discipline and to echo the agent-supplied
 * kind in the output envelope; the CLI does NOT pre-verify that
 * the supplied `--target <id>` actually names the declared kind,
 * and Monday cannot either (the wire enum collapses both kinds to
 * `Project`). Invisible / non-existent targets surface `not_found`
 * at mutation time, but a passing `--target-type item` with a
 * board-shaped ID succeeds and echoes the CLI-declared kind even
 * though the record is a board. Monday's `Post` variant is
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
 * **Runtime body (M27 IMPL).** Single `client.raw` round-trip
 * against `mutation CreateNotification` with `operationName:
 * 'CreateNotification'` (R-NEW-37 W2 audit-point). The CLI's
 * 2-value `--target-type` enum collapses to wire `Project` at the
 * runtime boundary; the CLI-side echo (`user_id` / `target_id` /
 * `target_type`) is composed at the parse boundary so the envelope
 * carries both the Monday-minted `id` + the agent-supplied inputs.
 */

import { z } from 'zod';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import { assertResponseFieldPresent } from './response-root.js';
import { ApiError } from '../utils/errors.js';
import type { MondayClient } from './client.js';
import type { Complexity } from '../utils/output/envelope.js';

/**
 * CLI-side `target_type` vocabulary for `monday notification send
 * --target-type <type>`. Both values map to Monday's wire
 * `NotificationTargetType.Project` (which represents both items and
 * boards) — the CLI keeps the item-vs-board distinction for argv
 * validation discipline AND to echo the agent-supplied kind in the
 * output envelope. The pairing of `--target-type` with `--target
 * <id>` is **trusted, not verified**: the CLI validates the enum +
 * numeric ID shape; Monday validates that the target is a visible
 * `Project` (surfacing invisible / non-existent targets as
 * `not_found`); but neither side verifies that the CLI-declared
 * kind matches what the ID actually names — the wire enum
 * collapses both kinds to `Project`. A CLI-side pre-read is
 * deferred (v0.3.x / v0.4 contract-extension if agents need
 * strict-kind enforcement).
 *
 * Monday's wire enum has only two values (`Post` / `Project`); the
 * `Post` value targets Updates and is intentionally not surfaced
 * at v0.3 per cli-design §4.3. A v0.3.x / v0.4 contract-extension
 * may add a CLI third target-type `update` that dispatches to wire
 * `Post`.
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
}

export interface SendNotificationResult {
  readonly notification: NotificationSendOutput;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

const CREATE_NOTIFICATION_MUTATION = `
  mutation CreateNotification(
    $userId: ID!,
    $targetId: ID!,
    $targetType: NotificationTargetType!,
    $text: String!
  ) {
    create_notification(
      user_id: $userId,
      target_id: $targetId,
      target_type: $targetType,
      text: $text
    ) {
      id
      text
    }
  }
`;

interface CreateNotificationResponse {
  readonly create_notification: unknown;
}

const wireNotificationSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().nullable(),
  })
  .strict();

/**
 * Fires Monday's `create_notification` mutation. Both CLI
 * `--target-type` values (`item`/`board`) map to the wire enum
 * `NotificationTargetType.Project` — Monday's wire surface doesn't
 * distinguish items from boards at the enum level. Monday
 * validates that `target_id` is a visible `Project` (invisible /
 * non-existent targets surface `not_found`) but does NOT verify
 * that the kind matches the CLI-declared `target_type`; the
 * pairing is trusted and echoed but not enforced.
 *
 * The wire payload returns only `{id, text}`; the CLI-side echo
 * (`user_id` / `target_id` / `target_type`) is composed at the
 * caller's parse boundary so the resulting envelope carries both the
 * Monday-minted `id` and the agent-supplied inputs in one read.
 *
 * `operationName: 'CreateNotification'` stays in sync with the named
 * operation in {@link CREATE_NOTIFICATION_MUTATION} (R-NEW-37 W2
 * audit-point). Not idempotent — re-running mints a fresh
 * notification with a new ID.
 */
export const sendNotification = async (
  inputs: SendNotificationInputs,
): Promise<SendNotificationResult> => {
  // CLI's 2-value enum collapses to wire `Project` (Monday's wire
  // surface has no item-vs-board distinction). The `Post` wire value
  // is unreachable at v0.3 per cli-design §4.3.
  const wireTargetType = 'Project';
  const response = await inputs.client.raw<CreateNotificationResponse>(
    CREATE_NOTIFICATION_MUTATION,
    {
      userId: inputs.userId,
      targetId: inputs.targetId,
      targetType: wireTargetType,
      text: inputs.text,
    },
    { operationName: 'CreateNotification' },
  );
  assertResponseFieldPresent({
    data: response.data,
    key: 'create_notification',
    operationLabel: 'CreateNotification',
    details: {
      user_id: inputs.userId,
      target_id: inputs.targetId,
      target_type: inputs.targetType,
    },
    nullHandling: 'caller_handles',
  });
  const raw = response.data.create_notification;
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no notification payload from create_notification for user ${inputs.userId} on target ${inputs.targetId}`,
      {
        details: {
          user_id: inputs.userId,
          target_id: inputs.targetId,
          target_type: inputs.targetType,
        },
      },
    );
  }
  const wire = unwrapOrThrow(wireNotificationSchema.safeParse(raw), {
    context: 'Monday `create_notification` response',
    details: {
      user_id: inputs.userId,
      target_id: inputs.targetId,
      target_type: inputs.targetType,
    },
    hint: 'Monday may have amended the `Notification` selection — re-probe and amend `src/api/notifications.ts` if so',
  });
  return {
    notification: {
      id: wire.id,
      text: wire.text,
      user_id: inputs.userId,
      target_id: inputs.targetId,
      target_type: inputs.targetType,
    },
    source: 'live',
    cacheAgeSeconds: null,
    complexity: response.complexity,
  };
};
