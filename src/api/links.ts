/**
 * Pure link-resolution helpers for the `link` column-value translator
 * (`cli-design.md` §5.3 step 3 v0.2 expansion, `v0.2-plan.md` §3 M8).
 *
 * Surface:
 *   - `parseLinkInput` — accepts the two pipe-form shapes cli-design
 *     §5.3 enumerates: `<url>` (text defaults to the URL) and
 *     `<url>|<text>` (both segments trimmed; pipe-split max 1 split).
 *     URL validated via `z.string().url()`.
 *
 * **Why a separate module.** Same template `dates.ts` / `people.ts`
 * follow — column-values.ts owns translator dispatch; the per-type
 * grammar machinery + zod boundary lives one module deeper. Split
 * keeps column-values.ts at one screen of dispatch logic and each
 * translator's tests + corner-case coverage isolated.
 *
 * **Pipe-form max 1 split.** `<url>|<text>` allows `|` inside the
 * `<text>` segment because `splitOnFirstPipe` only splits on the
 * first `|`. So `https://example.com|foo|bar` parses as
 * `{url: "https://example.com", text: "foo|bar"}`. Cli-design
 * doesn't pin this — but pinning here means agents who want a `|`
 * literal in their link text get it without reaching for `--set-raw`.
 *
 * **Empty trailer rejected.** `<url>|` (pipe with empty trailer) is
 * rejected with `usage_error`. Cli-design §5.3 line 810-811: "Pipe-
 * form with empty trailer rejected (usage_error); use --set-raw
 * (below) to write a link with empty text." A user who wants empty
 * text takes the escape hatch.
 */

import { z } from 'zod';
import { UsageError } from '../utils/errors.js';

/**
 * Wire payload shape for a `link` column. Matches Monday's
 * `change_column_value(value: JSON!)` JSON scalar:
 *   `{url: <url>, text: <text>}`
 *
 * cli-design.md §5.3 step 3 v0.2 expansion line 806-811 pins the
 * shape. `text` defaults to the URL when the pipe form is absent —
 * Monday's link-column UI shows the `text` segment as the visible
 * label, so a missing text would render as an empty hyperlink.
 */
export interface LinkPayload {
  readonly url: string;
  readonly text: string;
}

const URL_SCHEMA = z.url();

/**
 * Parses a `link` column input per cli-design.md §5.3 step 3 v0.2
 * expansion.
 *
 * Accepted inputs:
 *   - **Single URL** `https://example.com` → `{url, text: <url>}`.
 *     The URL doubles as the visible text — Monday's link UI shows
 *     `text` as the hyperlink label.
 *   - **Pipe form** `https://example.com|Site` → `{url, text}`.
 *     Both segments trimmed; pipe-split max 1 (so `text` may
 *     contain literal `|` characters).
 *
 * Throws `UsageError(usage_error)`:
 *   - URL fails `z.string().url()` validation. The error names the
 *     failing URL so the agent can see what they sent.
 *   - Pipe form with empty trailer (`https://x|` or `https://x|   `).
 *     Cli-design §5.3 line 810-811 names this rule explicitly: "use
 *     --set-raw to write a link with empty text".
 *   - Empty input after trim.
 *   - Pipe form with empty leader (`|Site` after trim). Same shape
 *     as the empty-input branch — there's no URL to validate.
 *
 * @param raw - The raw user-supplied value (post-`--set` parsing).
 * @param columnId - Column ID for error messages.
 */
export const parseLinkInput = (
  raw: string,
  columnId: string,
): LinkPayload => {
  const trimmedRaw = raw.trim();
  if (trimmedRaw.length === 0) {
    throw emptyLinkInputError(columnId, raw);
  }

  const pipeIdx = trimmedRaw.indexOf('|');
  let urlSegment: string;
  let textSegment: string;
  if (pipeIdx === -1) {
    // Single-segment form: text defaults to URL.
    urlSegment = trimmedRaw;
    textSegment = trimmedRaw;
  } else {
    urlSegment = trimmedRaw.slice(0, pipeIdx).trim();
    textSegment = trimmedRaw.slice(pipeIdx + 1).trim();
    if (urlSegment.length === 0) {
      throw emptyLinkInputError(columnId, raw);
    }
    if (textSegment.length === 0) {
      // Cli-design §5.3 line 810-811: "Pipe-form with empty trailer
      // rejected (usage_error); use --set-raw to write a link with
      // empty text." Agents who genuinely want an empty visible label
      // take the escape hatch.
      throw new UsageError(
        `Link column "${columnId}" got pipe-form input with an empty ` +
          `text segment ("${raw}"). The friendly translator requires ` +
          `non-empty text after "|"; pass a single URL (text defaults ` +
          `to the URL) or use --set-raw to write a link with empty text.`,
        {
          details: {
            column_id: columnId,
            column_type: 'link',
            raw_input: raw,
            hint:
              `pass a single URL (--set ${columnId}=https://example.com) ` +
              `or pipe-form (--set ${columnId}='https://example.com|Site'). ` +
              `For empty text, use --set-raw ${columnId}=` +
              `'{"url":"https://example.com","text":""}'.`,
          },
        },
      );
    }
  }

  const urlResult = URL_SCHEMA.safeParse(urlSegment);
  if (!urlResult.success) {
    throw new UsageError(
      `Link column "${columnId}" got invalid URL "${urlSegment}". ` +
        `Monday's link column requires a well-formed absolute URL ` +
        `(e.g. https://example.com).`,
      {
        details: {
          column_id: columnId,
          column_type: 'link',
          raw_input: raw,
          url_segment: urlSegment,
          hint:
            `pass an absolute URL (e.g. --set ${columnId}=` +
            `https://example.com). The pipe form (--set ${columnId}=` +
            `'https://example.com|Site') sets a custom visible label.`,
        },
      },
    );
  }

  return { url: urlResult.data, text: textSegment };
};

const emptyLinkInputError = (columnId: string, raw: string): UsageError =>
  new UsageError(
    `Link column "${columnId}" needs a URL. Got "${raw}". To clear a ` +
      `link column, use \`monday item clear <iid> ${columnId} ` +
      `[--board <bid>]\` instead.`,
    {
      details: {
        column_id: columnId,
        column_type: 'link',
        raw_input: raw,
        hint:
          `pass an absolute URL (--set ${columnId}=https://example.com) ` +
          `or pipe-form with a visible label (--set ${columnId}=` +
          `'https://example.com|Site').`,
      },
    },
  );
