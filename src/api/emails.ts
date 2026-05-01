/**
 * Pure email-resolution helpers for the `email` column-value translator
 * (`cli-design.md` §5.3 step 3 v0.2 expansion, `v0.2-plan.md` §3 M8).
 *
 * Surface:
 *   - `parseEmailInput` — accepts the two pipe-form shapes cli-design
 *     §5.3 enumerates: `<email>` (text defaults to the email) and
 *     `<email>|<text>` (both segments trimmed; pipe-split max 1
 *     split). Email validated via `z.string().email()`.
 *
 * **Note: `email` is the column type, distinct from `people`.**
 * The `email` column is a free-form contact-info column on the item
 * (e.g. "support contact"). The `people` column is the assignee
 * column that takes Monday users by ID. They share zero wire shape.
 *
 * **Why a separate module.** Same template `links.ts` / `dates.ts`
 * follow — column-values.ts owns translator dispatch; the per-type
 * grammar machinery + zod boundary lives one module deeper. Splitting
 * keeps each translator's tests + corner-case coverage isolated.
 *
 * **Pipe-form max 1 split.** Same rule as `links.ts` — `text` may
 * contain literal `|` characters. cli-design doesn't pin this, but
 * pinning here means agents who want a `|` in their visible label
 * get it without reaching for `--set-raw`.
 */

import { z } from 'zod';
import { UsageError } from '../utils/errors.js';

/**
 * Wire payload shape for an `email` column. Matches Monday's
 * `change_column_value(value: JSON!)` JSON scalar:
 *   `{email: <email>, text: <text>}`
 *
 * cli-design.md §5.3 step 3 v0.2 expansion line 812-814 pins the
 * shape. `text` defaults to the email when the pipe form is absent —
 * Monday's email-column UI shows the `text` segment as the visible
 * label.
 */
export interface EmailPayload {
  readonly email: string;
  readonly text: string;
}

const EMAIL_SCHEMA = z.email();

/**
 * Parses an `email` column input per cli-design.md §5.3 step 3 v0.2
 * expansion.
 *
 * Accepted inputs:
 *   - **Single email** `alice@example.com` → `{email, text: <email>}`.
 *     The email doubles as the visible text — Monday's email-column
 *     UI shows `text` as the displayed label.
 *   - **Pipe form** `alice@example.com|Alice` → `{email, text}`.
 *     Both segments trimmed; pipe-split max 1.
 *
 * Throws `UsageError(usage_error)`:
 *   - Email fails `z.string().email()` validation.
 *   - Pipe form with empty trailer or empty leader.
 *   - Empty input after trim.
 *
 * @param raw - The raw user-supplied value (post-`--set` parsing).
 * @param columnId - Column ID for error messages.
 */
export const parseEmailInput = (
  raw: string,
  columnId: string,
): EmailPayload => {
  const trimmedRaw = raw.trim();
  if (trimmedRaw.length === 0) {
    throw emptyEmailInputError(columnId, raw);
  }

  const pipeIdx = trimmedRaw.indexOf('|');
  let emailSegment: string;
  let textSegment: string;
  if (pipeIdx === -1) {
    emailSegment = trimmedRaw;
    textSegment = trimmedRaw;
  } else {
    emailSegment = trimmedRaw.slice(0, pipeIdx).trim();
    textSegment = trimmedRaw.slice(pipeIdx + 1).trim();
    if (emailSegment.length === 0) {
      throw emptyEmailInputError(columnId, raw);
    }
    if (textSegment.length === 0) {
      throw new UsageError(
        `Email column "${columnId}" got pipe-form input with an empty ` +
          `text segment ("${raw}"). The friendly translator requires ` +
          `non-empty text after "|"; pass a single email (text defaults ` +
          `to the email) or use --set-raw to write an email with empty text.`,
        {
          details: {
            column_id: columnId,
            column_type: 'email',
            raw_input: raw,
            hint:
              `pass a single email (--set ${columnId}=alice@example.com) ` +
              `or pipe-form (--set ${columnId}='alice@example.com|Alice'). ` +
              `For empty text, use --set-raw ${columnId}=` +
              `'{"email":"alice@example.com","text":""}'.`,
          },
        },
      );
    }
  }

  const emailResult = EMAIL_SCHEMA.safeParse(emailSegment);
  if (!emailResult.success) {
    throw new UsageError(
      `Email column "${columnId}" got invalid email "${emailSegment}". ` +
        `Monday's email column requires a well-formed email address ` +
        `(e.g. alice@example.com).`,
      {
        details: {
          column_id: columnId,
          column_type: 'email',
          raw_input: raw,
          email_segment: emailSegment,
          hint:
            `pass an email address (--set ${columnId}=alice@example.com). ` +
            `The pipe form (--set ${columnId}='alice@example.com|Alice') ` +
            `sets a custom visible label.`,
        },
      },
    );
  }

  return { email: emailResult.data, text: textSegment };
};

const emptyEmailInputError = (columnId: string, raw: string): UsageError =>
  new UsageError(
    `Email column "${columnId}" needs an email address. Got "${raw}". ` +
      `To clear an email column, use \`monday item clear <iid> ${columnId} ` +
      `[--board <bid>]\` instead.`,
    {
      details: {
        column_id: columnId,
        column_type: 'email',
        raw_input: raw,
        hint:
          `pass an email (--set ${columnId}=alice@example.com) or ` +
          `pipe-form with a visible label (--set ${columnId}=` +
          `'alice@example.com|Alice').`,
      },
    },
  );
