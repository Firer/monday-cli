/**
 * Pure date-resolution helpers for the `date` column-value
 * translator (`cli-design.md` §5.3 step 3 + the
 * "Relative dates and timezone" subsection).
 *
 * Two surfaces:
 *
 *   - `parseDateInput` — accepts every input shape `cli-design.md`
 *     §5.3 step 3 enumerates: ISO date (`YYYY-MM-DD`), ISO date+time
 *     (`YYYY-MM-DDTHH:MM[:SS]`), and the relative-token set
 *     (`today`, `tomorrow`, `+Nd`, `-Nw`, `+Nh`). Returns the
 *     Monday wire payload (`{date}` or `{date, time}`) plus the
 *     `resolvedFrom` echo `cli-design.md` §6.4 puts on the
 *     dry-run envelope.
 *   - `formatNowInTimezone` — used internally to format an
 *     instant in an IANA timezone for the `resolvedFrom.now`
 *     echo. Exported because the dry-run engine (M5a follow-up)
 *     will need the same shape for non-date columns' `now`
 *     timestamp.
 *
 * **Why a separate module.** column-values.ts owns translator
 * *dispatch* — the switch over WritableColumnType, the
 * mutation-selection helper, and the ApiError builder. The date
 * translator's machinery is ~150 LOC of regex + Intl
 * gymnastics with no dispatch concerns. Splitting keeps
 * column-values.ts at one screen of dispatch logic and the date
 * machinery isolated for unit testing.
 *
 * **No external dep.** Uses only `Intl.DateTimeFormat` for tz
 * formatting + `Date` arithmetic. The CLI rules forbid pulling
 * in luxon / date-fns / dayjs for stdlib-doable work; Node 22
 * ships full ICU and `longOffset` tz formatting, which covers
 * everything `cli-design.md` §5.3 needs.
 */

import { UsageError } from '../utils/errors.js';

/**
 * Wire payload shape for a `date` column. Matches Monday's
 * `change_column_value(value: JSON!)` JSON scalar:
 *   - date-only input → `{date: "YYYY-MM-DD"}`
 *   - date+time input → `{date: "YYYY-MM-DD", time: "HH:MM:SS"}`
 *
 * `time` is always `HH:MM:SS` (24-hour, padded). Inputs that
 * omit seconds default to `:00` so the wire shape stays
 * consistent — Monday's API accepts `:30` as `:30:00` already
 * but pinning the format here means the round-trip diff in
 * dry-run output stays stable.
 */
export type DatePayload =
  | { readonly date: string }
  | { readonly date: string; readonly time: string };

/**
 * The `resolved_from` echo `cli-design.md` §5.3 lines 783-786 +
 * §6.4 prescribe for the dry-run envelope. Returned by
 * `parseDateInput` for relative-token inputs (where the agent
 * benefits from seeing the absolute date the CLI computed) and
 * `null` for explicit ISO inputs (which need no resolution).
 *
 * Shape is a struct, not a string blob, because the dry-run
 * engine (M5a follow-up) reads `timezone` to decide whether
 * to emit a `MONDAY_TIMEZONE not set` warning when the system
 * tz was used as a fallback.
 */
export interface DateResolution {
  /** The literal input the agent passed (e.g. `+1w`). */
  readonly input: string;
  /** IANA timezone string used for resolution (e.g. `Europe/London`). */
  readonly timezone: string;
  /**
   * The instant "now" was sampled at, formatted as a local-time
   * ISO string with offset (e.g. `2026-04-25T14:00:00+01:00`).
   * cli-design §5.3 sample at line 786 pins this format.
   */
  readonly now: string;
}

export interface DateResolutionContext {
  /**
   * Source of "now" for relative-date resolution. Defaults to
   * `() => new Date()`. Tests inject a deterministic clock to
   * pin DST-boundary behaviour without wall-clock waits — same
   * pattern as `pagination.ts`'s cursor clock (M4 §14
   * post-mortem prophylactic).
   */
  readonly now?: () => Date;
  /**
   * IANA timezone string for relative-date resolution. Defaults
   * to the system timezone via
   * `Intl.DateTimeFormat().resolvedOptions().timeZone` per
   * cli-design §5.3 line 766. M5b's command layer plumbs
   * `MONDAY_TIMEZONE` env override through this slot.
   */
  readonly timezone?: string;
}

export interface ParsedDateInput {
  readonly payload: DatePayload;
  /**
   * `null` for explicit ISO inputs — the input *is* the
   * resolved value; nothing to echo. A struct for relative
   * tokens — the dry-run envelope shows the agent what the
   * CLI computed against which tz at which clock instant.
   */
  readonly resolvedFrom: DateResolution | null;
}

/**
 * Parses a `date` column input per cli-design §5.3 step 3.
 *
 * Accepted inputs:
 *   - **ISO date** `YYYY-MM-DD` → `{date}` payload, no
 *     resolution echo.
 *   - **ISO date+time** `YYYY-MM-DDTHH:MM` or
 *     `YYYY-MM-DDTHH:MM:SS` → `{date, time}` payload, no
 *     resolution echo. Seconds default to `:00`.
 *   - **Relative tokens**:
 *     - `today` → today's date in `ctx.timezone`.
 *     - `tomorrow` → today + 1 day in `ctx.timezone`.
 *     - `+Nd` / `-Nd` (days), `+Nw` / `-Nw` (weeks) →
 *       date-only output, calendar arithmetic in `ctx.timezone`.
 *     - `+Nh` / `-Nh` (hours) → date+time output, instant
 *       arithmetic (UTC offset preserved across DST per
 *       industry standard — `+24h` from a GMT instant lands
 *       at the same UTC instant +24h, which may shift the
 *       wall-clock time by an hour on a DST boundary day).
 *
 * Throws `usage_error` with a structured `details` shape for
 * unrecognised input. The error message lists the supported
 * forms so an agent's debug log shows the right shape to
 * paste-and-edit.
 *
 * @param raw - The raw user-supplied value (post-`--set`
 *   parsing).
 * @param columnId - Column ID for error messages.
 * @param ctx - Resolution context. Defaults to system clock +
 *   system tz when omitted; M5b's command layer plumbs the
 *   `MONDAY_TIMEZONE` env override.
 */
export const parseDateInput = (
  raw: string,
  columnId: string,
  ctx: DateResolutionContext = {},
): ParsedDateInput => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw unrecognisedDateInputError(columnId, raw);
  }
  // Try the explicit shapes first — they're cheaper and more
  // common for agent-driven workflows that already have an
  // absolute due date in hand.
  const isoDate = parseIsoDate(trimmed);
  if (isoDate !== null) {
    return { payload: { date: isoDate }, resolvedFrom: null };
  }
  const isoDateTime = parseIsoDateTime(trimmed);
  if (isoDateTime !== null) {
    return { payload: isoDateTime, resolvedFrom: null };
  }
  // Lower-case relative tokens — `Today`, `TOMORROW`, `+3D`
  // all resolve identically. Case-fold here, not in the input
  // (the resolvedFrom echo carries `raw` verbatim so the
  // dry-run output shows what the agent typed).
  const relative = parseRelative(trimmed.toLowerCase(), raw, ctx);
  if (relative !== null) {
    return relative;
  }
  throw unrecognisedDateInputError(columnId, raw);
};

/**
 * Validates `YYYY-MM-DD` and returns the literal string when
 * it represents a real calendar date. Returns `null` when the
 * shape doesn't match or the date is impossible (e.g.
 * `2026-02-30`, `2026-13-01`).
 */
const parseIsoDate = (raw: string): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
  if (match === null) return null;
  const [, yStr, mStr, dStr] = match;
  // The regex captures fix the array shape, but TS's regex
  // typings don't narrow the tuple — the explicit guard keeps
  // noUncheckedIndexedAccess happy without an `as const` cast.
  /* c8 ignore next 3 — defensive: regex captures three groups,
     so all three are always defined post-match. */
  if (yStr === undefined || mStr === undefined || dStr === undefined) {
    return null;
  }
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!isCalendarDate(y, m, d)) return null;
  return `${yStr}-${mStr}-${dStr}`;
};

/**
 * Validates `YYYY-MM-DDTHH:MM` or `YYYY-MM-DDTHH:MM:SS` and
 * returns the date+time payload (with `time` always
 * `HH:MM:SS`, seconds defaulting to `:00` when omitted).
 * Returns `null` when the shape or values are invalid.
 *
 * Does NOT accept a `Z` or offset suffix — the contract per
 * cli-design §5.3 line 725 is the literal local time the
 * column should display, not a UTC instant. An agent that
 * needs UTC submits `2026-04-29T14:30:00` after converting.
 */
const parseIsoDateTime = (raw: string): DatePayload | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(raw);
  if (match === null) return null;
  const [, yStr, mStr, dStr, hStr, minStr, secStr] = match;
  /* c8 ignore next 5 — defensive: required regex groups are
     always defined post-match. The optional seconds group
     (`secStr`) genuinely can be undefined and is handled below. */
  if (
    yStr === undefined || mStr === undefined || dStr === undefined ||
    hStr === undefined || minStr === undefined
  ) {
    return null;
  }
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const h = Number(hStr);
  const min = Number(minStr);
  const s = secStr === undefined ? 0 : Number(secStr);
  if (!isCalendarDate(y, m, d)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59 || s < 0 || s > 59) return null;
  const sec = secStr ?? '00';
  return {
    date: `${yStr}-${mStr}-${dStr}`,
    time: `${hStr}:${minStr}:${sec}`,
  };
};

/**
 * Validates that a year/month/day triple represents a real
 * calendar date. Catches `2026-02-30`, `2026-13-01`,
 * `2026-04-31`. Uses Date.UTC + round-trip — the simplest
 * stdlib-only way to validate without listing leap-year
 * rules.
 */
const isCalendarDate = (y: number, m: number, d: number): boolean => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const utc = Date.UTC(y, m - 1, d);
  const round = new Date(utc);
  return (
    round.getUTCFullYear() === y &&
    round.getUTCMonth() === m - 1 &&
    round.getUTCDate() === d
  );
};

/**
 * Resolves a relative token (`today`, `tomorrow`, `+3d`,
 * `-1w`, `+2h`) against the resolution context. Returns
 * `null` when the input doesn't match any relative token shape
 * (the caller falls through to the unrecognised-input error).
 *
 * @param normalised - The lowercased input (`+3d`, `today`).
 * @param verbatim - The original input — preserved in
 *   `resolvedFrom.input` so the dry-run output shows what the
 *   agent typed, not the lowercased form.
 */
const parseRelative = (
  normalised: string,
  verbatim: string,
  ctx: DateResolutionContext,
): ParsedDateInput | null => {
  const now = (ctx.now ?? defaultNow)();
  const timezone = ctx.timezone ?? defaultTimezone();

  // Word forms first — the exact-match path is faster and
  // the regex below would also match `to3d` (it doesn't, but
  // the assertion is loud).
  if (normalised === 'today') {
    return resolveDateOnly(now, 0, timezone, verbatim);
  }
  if (normalised === 'tomorrow') {
    return resolveDateOnly(now, 1, timezone, verbatim);
  }
  // +Nd / -Nd / +Nw / -Nw — date-only output (calendar
  // arithmetic in tz, no time component).
  const dayWeek = /^([+-])(\d+)([dw])$/u.exec(normalised);
  if (dayWeek !== null) {
    const [, signStr, amountStr, unit] = dayWeek;
    /* c8 ignore next 3 — required regex groups always defined. */
    if (signStr === undefined || amountStr === undefined || unit === undefined) {
      return null;
    }
    const amount = Number(amountStr);
    if (!Number.isSafeInteger(amount)) return null;
    const days = amount * (unit === 'w' ? 7 : 1);
    const signed = signStr === '-' ? -days : days;
    return resolveDateOnly(now, signed, timezone, verbatim);
  }
  // +Nh / -Nh — date+time output (instant arithmetic, UTC
  // offset preserved). cli-design line 763 lists `+2h`
  // explicitly; minutes/seconds aren't in the v0.1 grammar.
  const hour = /^([+-])(\d+)h$/u.exec(normalised);
  if (hour !== null) {
    const [, signStr, amountStr] = hour;
    /* c8 ignore next 3 — required regex groups always defined. */
    if (signStr === undefined || amountStr === undefined) return null;
    const amount = Number(amountStr);
    if (!Number.isSafeInteger(amount)) return null;
    const signedHours = signStr === '-' ? -amount : amount;
    return resolveDateTime(now, signedHours, timezone, verbatim);
  }
  return null;
};

/**
 * Resolves a date-only relative offset (today, tomorrow, +Nd,
 * +Nw). Calendar arithmetic in the user's tz: extract today's
 * y/m/d in tz, add `dayOffset` days via UTC component math,
 * format as `YYYY-MM-DD`.
 *
 * Why this is correct across DST: we're producing a *calendar
 * date*, not a UTC instant. The user's tz determines what
 * "today" means; once we have y/m/d as integers, adding 1 day
 * is a pure calendar operation that doesn't care about DST
 * (Date.UTC component math handles month rollovers, leap
 * years, and the absent ambiguity correctly).
 */
const resolveDateOnly = (
  now: Date,
  dayOffset: number,
  timezone: string,
  input: string,
): ParsedDateInput => {
  const today = formatYmdInTimezone(now, timezone);
  const offsetMs = Date.UTC(today.year, today.month - 1, today.day + dayOffset);
  const target = new Date(offsetMs);
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, '0');
  const d = String(target.getUTCDate()).padStart(2, '0');
  return {
    payload: { date: `${String(y).padStart(4, '0')}-${m}-${d}` },
    resolvedFrom: {
      input,
      timezone,
      now: formatNowInTimezone(now, timezone),
    },
  };
};

/**
 * Resolves an hour-granularity relative offset (+Nh, -Nh).
 * Instant arithmetic — N hours in absolute time — then
 * format the result in the user's tz to extract date + time.
 * Across a DST boundary this means `+24h` from a GMT instant
 * may shift the wall-clock hour by 1 (industry standard;
 * matches luxon / date-fns-tz / Temporal `Instant.add`
 * semantics).
 */
const resolveDateTime = (
  now: Date,
  hourOffset: number,
  timezone: string,
  input: string,
): ParsedDateInput => {
  const targetMs = now.getTime() + hourOffset * 3_600_000;
  const target = new Date(targetMs);
  const parts = formatYmdHmsInTimezone(target, timezone);
  const date = `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`;
  const time = `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
  return {
    payload: { date, time },
    resolvedFrom: {
      input,
      timezone,
      now: formatNowInTimezone(now, timezone),
    },
  };
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Extracts year/month/day for an instant in an IANA timezone
 * via Intl.DateTimeFormat. Returns numbers (not strings) so
 * caller can do component arithmetic without parseInt clutter.
 *
 * Intl reports `hour: '24'` for midnight in some locales; we
 * use 'en-US' explicitly + `hourCycle: 'h23'` (downstream)
 * to get 0-23, which avoids the bug. For the date-only
 * extraction here, hour isn't read — but the formatter is
 * shared with formatYmdHmsInTimezone, which does.
 */
const formatYmdInTimezone = (
  instant: Date,
  timezone: string,
): { year: number; month: number; day: number } => {
  const parts = formatYmdHmsInTimezone(instant, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
};

const formatYmdHmsInTimezone = (
  instant: Date,
  timezone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} => {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    /* c8 ignore next 7 — defensive: every type the formatter
       was configured to emit is always present in the output;
       this guard exists for noUncheckedIndexedAccess narrowing. */
    if (part === undefined) {
      throw new Error(
        `Intl.DateTimeFormat did not emit expected part "${type}" for tz "${timezone}"`,
      );
    }
    return Number(part.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
};

/**
 * Formats an instant as a local-time ISO string with UTC
 * offset, e.g. `2026-04-25T14:00:00+01:00`. cli-design §5.3
 * line 786 sample pins this exact shape.
 *
 * Uses Intl's `longOffset` token (Node 22+ ICU full data) for
 * the offset suffix; falls back to `+00:00` if the runtime's
 * Intl reports an unparseable form. Exported for the dry-run
 * engine which uses the same formatter for non-date columns'
 * `now` echo.
 */
export const formatNowInTimezone = (instant: Date, timezone: string): string => {
  const parts = formatYmdHmsInTimezone(instant, timezone);
  const ymd =
    `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`;
  const hms = `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
  const offset = utcOffsetForTimezone(instant, timezone);
  return `${ymd}T${hms}${offset}`;
};

/**
 * Returns the UTC offset of an instant in an IANA timezone as
 * `±HH:MM`. Uses Intl's `longOffset` form (e.g. `GMT+01:00`)
 * and trims the `GMT` prefix; the literal `GMT` (offset 0)
 * comes back as plain `GMT` and is mapped to `+00:00` for
 * stable formatting.
 */
const utcOffsetForTimezone = (instant: Date, timezone: string): string => {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  });
  const parts = fmt.formatToParts(instant);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value;
  /* c8 ignore next 4 — defensive: every modern Node runtime
     emits a timeZoneName part when the option is set; the
     fallback exists so a future ICU regression doesn't
     produce a malformed envelope. */
  if (tzName === undefined) return '+00:00';
  if (tzName === 'GMT') return '+00:00';
  // longOffset form is `GMT+HH:MM` or `GMT-HH:MM`.
  const match = /^GMT([+-])(\d{2}):(\d{2})$/u.exec(tzName);
  /* c8 ignore next 2 — defensive: longOffset emits this exact
     shape on Node 22+ ICU; fallback handles ICU edge cases. */
  if (match === null) return '+00:00';
  // Captures are guaranteed defined post-match for this regex
  // (no optional groups). The non-null assertions satisfy
  // noUncheckedIndexedAccess without adding `?? '...'` defaults
  // that would inflate branch count for unreachable cases.
  const sign = match[1];
  const hh = match[2];
  const mm = match[3];
  /* c8 ignore next 4 — defensive: regex captures all three
     groups by construction. The guard exists for type-narrowing
     under noUncheckedIndexedAccess; it cannot fire at runtime. */
  if (sign === undefined || hh === undefined || mm === undefined) {
    return '+00:00';
  }
  return `${sign}${hh}:${mm}`;
};

const defaultNow = (): Date => new Date();

/**
 * System default IANA timezone via Intl.DateTimeFormat. Falls
 * back to `UTC` if the runtime's Intl returns an empty string
 * (extremely rare on modern Node, but the contract is
 * "default to system tz" — UTC is the sane fallback when
 * "system tz" is genuinely unknown).
 */
const defaultTimezone = (): string => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  /* c8 ignore next 2 — defensive fallback when Intl returns an
     empty string. Full-ICU Node 22 always populates the
     timeZone field; the fallback keeps the contract "default
     to a real tz, never throw on resolution". */
  if (tz.length === 0) return 'UTC';
  return tz;
};

/**
 * Builds the `usage_error` for inputs that don't match any of
 * the cli-design §5.3 step 3 forms. The hint enumerates the
 * full grammar so an agent's debug log shows every supported
 * form without consulting docs.
 */
const unrecognisedDateInputError = (
  columnId: string,
  raw: string,
): UsageError =>
  new UsageError(
    `Date column "${columnId}" got input "${raw}" that does not match ` +
      `any supported form. Supported: ` +
      `ISO date "YYYY-MM-DD", ISO date+time "YYYY-MM-DDTHH:MM[:SS]", ` +
      `or a relative token (today, tomorrow, +Nd, -Nw, +Nh).`,
    {
      details: {
        column_id: columnId,
        column_type: 'date',
        raw_input: raw,
        hint:
          'examples: --set due=2026-05-01, --set due=2026-05-01T14:30, ' +
          '--set due=tomorrow, --set due=+3d, --set due=+2h',
      },
    },
  );
