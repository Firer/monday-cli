/**
 * Pure phone-resolution helpers for the `phone` column-value translator
 * (`cli-design.md` §5.3 step 3 v0.2 expansion, `v0.2-plan.md` §3 M8).
 *
 * Surface:
 *   - `parsePhoneInput` — accepts the **mandatory** pipe-form
 *     `<phone>|<country>` cli-design §5.3 enumerates. E.164-loose
 *     phone validation; ISO 3166-1 alpha-2 country code validated
 *     against a frozen allowlist (`iso-country-codes.ts`).
 *
 * **Why pipe form is mandatory.** Monday's phone-column validation
 * requires both the number AND the 2-letter country code AND verifies
 * they match (per Monday's phone-validation changelog). The friendly
 * translator can't safely default `countryShortName: ""` — Monday
 * would reject the mutation as `validation_failed`. Agents who need
 * to write a phone with no country (Monday allows it for some legacy
 * fixtures) use `--set-raw`.
 *
 * **E.164-loose validation.** The phone segment matches `+?\d{6,15}`
 * — leading `+` optional, 6-15 digits otherwise. E.164's strict rule
 * is "1-15 digits" but the CLI insists on at least 6 to catch
 * obvious typos (`--set Mobile=+1|US` would silently land at Monday
 * and fail server-side). The bound is a sanity check, not a
 * complete E.164 validator — Monday is the validator of last resort.
 *
 * **No internal whitespace, no dashes.** `+1 555 123 4567` and
 * `+1-555-123-4567` are rejected. cli-design doesn't pin this
 * explicitly but Monday's API expects bare digits + an optional
 * leading `+`. Agents who paste a formatted phone strip the
 * separators in the shell pipeline (`tr -d ' -'`).
 *
 * **Why a separate module.** Same template `links.ts` / `dates.ts`
 * follow — column-values.ts owns translator dispatch; the per-type
 * grammar machinery lives one module deeper. The ISO allowlist is
 * larger again (`iso-country-codes.ts`) so the layering keeps
 * column-values.ts at one screen of dispatch logic.
 */

import { UsageError } from '../utils/errors.js';
import { isIsoCountryCode } from './iso-country-codes.js';

/**
 * Wire payload shape for a `phone` column. Matches Monday's
 * `change_column_value(value: JSON!)` JSON scalar:
 *   `{phone: <phone>, countryShortName: <country>}`
 *
 * cli-design.md §5.3 step 3 v0.2 expansion line 815-827 pins the
 * shape. `countryShortName` is the uppercase 2-letter ISO 3166-1
 * alpha-2 code; the field name spelling is Monday's choice
 * (camelCase, no trailing `code`).
 */
export interface PhonePayload {
  readonly phone: string;
  readonly countryShortName: string;
}

const PHONE_PATTERN = /^\+?\d{6,15}$/u;

/**
 * Parses a `phone` column input per cli-design.md §5.3 step 3 v0.2
 * expansion.
 *
 * Accepted input — pipe form is **mandatory**:
 *   - `<phone>|<country>` → `{phone, countryShortName}`. Both
 *     segments trimmed; pipe-split max 1. Country code uppercased
 *     before allowlist check (so `us` and `US` both work).
 *
 * Rejected (all `usage_error`):
 *   - **Single segment** (`+15551234567` without `|US`) — Monday
 *     requires both. Agents who need an empty country use
 *     `--set-raw`. cli-design §5.3 line 819-827.
 *   - **Phone fails E.164-loose** (`+?\d{6,15}` after trim).
 *   - **Country fails ISO allowlist** (after uppercase).
 *   - **Empty leader / trailer** (`|US` or `+1555|`).
 *   - **Empty input** after trim.
 *
 * @param raw - The raw user-supplied value (post-`--set` parsing).
 * @param columnId - Column ID for error messages.
 */
export const parsePhoneInput = (
  raw: string,
  columnId: string,
): PhonePayload => {
  const trimmedRaw = raw.trim();
  if (trimmedRaw.length === 0) {
    throw emptyPhoneInputError(columnId, raw);
  }

  const pipeIdx = trimmedRaw.indexOf('|');
  if (pipeIdx === -1) {
    // Single-segment input — rejected. Monday requires both phone +
    // country, and the friendly translator won't paper over the
    // mismatch by silently defaulting `countryShortName: ""`.
    throw new UsageError(
      `Phone column "${columnId}" requires the pipe form ` +
        `<phone>|<country> (got "${raw}"). Monday's phone-column ` +
        `validation needs both the number and a 2-letter ISO 3166-1 ` +
        `alpha-2 country code AND verifies they match — the friendly ` +
        `translator can't safely default the country. Use --set-raw to ` +
        `write a phone with no country if Monday's legacy behaviour ` +
        `permits it.`,
      {
        details: {
          column_id: columnId,
          column_type: 'phone',
          raw_input: raw,
          hint:
            `pass --set ${columnId}='+15551234567|US'. The country code ` +
            `is uppercase ISO 3166-1 alpha-2 (e.g. US, GB, JP). To write ` +
            `with empty country: --set-raw ${columnId}=` +
            `'{"phone":"+15551234567","countryShortName":""}'.`,
        },
      },
    );
  }

  const phoneSegment = trimmedRaw.slice(0, pipeIdx).trim();
  const countrySegment = trimmedRaw.slice(pipeIdx + 1).trim();

  if (phoneSegment.length === 0) {
    throw new UsageError(
      `Phone column "${columnId}" got an empty phone segment ("${raw}"). ` +
        `The friendly translator requires a non-empty number before "|".`,
      {
        details: {
          column_id: columnId,
          column_type: 'phone',
          raw_input: raw,
          hint:
            `pass --set ${columnId}='+15551234567|US' with the phone ` +
            `before the "|" and the ISO 3166-1 alpha-2 country after.`,
        },
      },
    );
  }
  if (countrySegment.length === 0) {
    throw new UsageError(
      `Phone column "${columnId}" got an empty country segment ("${raw}"). ` +
        `Monday requires a 2-letter ISO 3166-1 alpha-2 country code after ` +
        `the "|". Use --set-raw to write a phone with no country.`,
      {
        details: {
          column_id: columnId,
          column_type: 'phone',
          raw_input: raw,
          hint:
            `pass --set ${columnId}='+15551234567|US'. To write with ` +
            `empty country: --set-raw ${columnId}=` +
            `'{"phone":"+15551234567","countryShortName":""}'.`,
        },
      },
    );
  }

  if (!PHONE_PATTERN.test(phoneSegment)) {
    throw new UsageError(
      `Phone column "${columnId}" got invalid phone "${phoneSegment}". ` +
        `The friendly translator accepts E.164-loose digits with an ` +
        `optional leading "+" (6-15 digits, no whitespace, no dashes). ` +
        `Strip separators before --set, or use --set-raw with Monday's ` +
        `documented wire shape.`,
      {
        details: {
          column_id: columnId,
          column_type: 'phone',
          raw_input: raw,
          phone_segment: phoneSegment,
          hint:
            `strip whitespace and dashes — pass --set ${columnId}=` +
            `'+15551234567|US' (not "+1 555 123 4567|US"). The shell ` +
            `pipeline can do this with \`tr -d ' -'\`.`,
        },
      },
    );
  }

  const countryUpper = countrySegment.toUpperCase();
  if (!isIsoCountryCode(countryUpper)) {
    throw new UsageError(
      `Phone column "${columnId}" got invalid country code ` +
        `"${countrySegment}". Monday requires a 2-letter ISO 3166-1 ` +
        `alpha-2 code (e.g. US, GB, JP). The CLI checks against a ` +
        `frozen 249-code allowlist; exceptionally-reserved (UK, EU), ` +
        `transitional, and user-assigned codes are excluded.`,
      {
        details: {
          column_id: columnId,
          column_type: 'phone',
          raw_input: raw,
          country_segment: countrySegment,
          hint:
            `pass an ISO 3166-1 alpha-2 code (US, GB, JP, etc.). The ` +
            `code is uppercased before validation, so "us" works the ` +
            `same as "US". The full list is at ` +
            `https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2.`,
        },
      },
    );
  }

  return { phone: phoneSegment, countryShortName: countryUpper };
};

const emptyPhoneInputError = (columnId: string, raw: string): UsageError =>
  new UsageError(
    `Phone column "${columnId}" needs <phone>|<country> input. Got ` +
      `"${raw}". To clear a phone column, use \`monday item clear ` +
      `<iid> ${columnId} [--board <bid>]\` instead.`,
    {
      details: {
        column_id: columnId,
        column_type: 'phone',
        raw_input: raw,
        hint:
          `pass --set ${columnId}='+15551234567|US'. The country code ` +
          `is uppercase ISO 3166-1 alpha-2 (e.g. US, GB, JP).`,
      },
    },
  );
