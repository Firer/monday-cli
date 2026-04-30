import { describe, expect, it } from 'vitest';
import { UsageError } from '../../../src/utils/errors.js';
import {
  formatNowInTimezone,
  parseDateInput,
} from '../../../src/api/dates.js';

// Frozen-clock helper for deterministic relative-token resolution.
// Every relative-token test creates one via this factory so the
// "now" instant is auditable in the test source — no wall-clock
// dependency, no timezone-of-the-CI-runner surprises.
const frozenClock = (iso: string): (() => Date) => {
  const instant = new Date(iso);
  return () => instant;
};

// Common timezones tests pin against. London + Auckland are the
// DST-boundary pair the v0.1-plan §3 M5a row calls out (northern
// vs southern hemisphere, opposite-direction transitions on the
// same day, both around midnight in their respective tz).
const LONDON = 'Europe/London';
const AUCKLAND = 'Pacific/Auckland';
const TOKYO = 'Asia/Tokyo'; // No DST — control case for the suite.

describe('parseDateInput — ISO date (YYYY-MM-DD)', () => {
  it('passes a valid ISO date through verbatim with no resolvedFrom echo', () => {
    const out = parseDateInput('2026-04-29', 'due');
    expect(out.payload).toEqual({ date: '2026-04-29' });
    expect(out.resolvedFrom).toBeNull();
  });

  it('accepts a leap-day date (2028-02-29)', () => {
    const out = parseDateInput('2028-02-29', 'due');
    expect(out.payload).toEqual({ date: '2028-02-29' });
  });

  it('rejects a non-leap February 29 (2027-02-29)', () => {
    expect(() => parseDateInput('2027-02-29', 'due')).toThrow(UsageError);
    expect(() => parseDateInput('2027-02-29', 'due')).toThrow(
      /does not match any supported form/u,
    );
  });

  it('rejects an impossible day (2026-04-31 — April has 30)', () => {
    expect(() => parseDateInput('2026-04-31', 'due')).toThrow(UsageError);
  });

  it('rejects month 00 / month 13', () => {
    expect(() => parseDateInput('2026-00-15', 'due')).toThrow(UsageError);
    expect(() => parseDateInput('2026-13-01', 'due')).toThrow(UsageError);
  });

  it('rejects day 00', () => {
    expect(() => parseDateInput('2026-04-00', 'due')).toThrow(UsageError);
  });

  it('rejects partial / sloppy ISO inputs (single-digit day, missing zeros)', () => {
    expect(() => parseDateInput('2026-4-29', 'due')).toThrow(UsageError);
    expect(() => parseDateInput('2026-04-9', 'due')).toThrow(UsageError);
  });
});

describe('parseDateInput — ISO date+time (YYYY-MM-DDTHH:MM[:SS])', () => {
  it('accepts HH:MM and defaults seconds to 00', () => {
    const out = parseDateInput('2026-04-29T14:30', 'due');
    expect(out.payload).toEqual({ date: '2026-04-29', time: '14:30:00' });
    expect(out.resolvedFrom).toBeNull();
  });

  it('accepts HH:MM:SS and preserves seconds', () => {
    const out = parseDateInput('2026-04-29T14:30:45', 'due');
    expect(out.payload).toEqual({ date: '2026-04-29', time: '14:30:45' });
  });

  it('preserves hour 00 and 23 boundary values', () => {
    expect(parseDateInput('2026-04-29T00:00', 'due').payload).toEqual({
      date: '2026-04-29',
      time: '00:00:00',
    });
    expect(parseDateInput('2026-04-29T23:59:59', 'due').payload).toEqual({
      date: '2026-04-29',
      time: '23:59:59',
    });
  });

  it('rejects hour 24', () => {
    expect(() => parseDateInput('2026-04-29T24:00', 'due')).toThrow(UsageError);
  });

  it('rejects minute 60 and second 60', () => {
    expect(() => parseDateInput('2026-04-29T14:60', 'due')).toThrow(UsageError);
    expect(() => parseDateInput('2026-04-29T14:30:60', 'due')).toThrow(UsageError);
  });

  it('rejects a UTC suffix (Z) — cli-design says no offset semantics here', () => {
    // The contract per cli-design §5.3 line 725 is the literal
    // local time the column should display. An agent that has a
    // UTC instant must convert to local before submitting; the
    // CLI does not interpret Z as a UTC pin (which would
    // ambiguate with the column's display tz on Monday).
    expect(() => parseDateInput('2026-04-29T14:30:00Z', 'due')).toThrow(UsageError);
  });

  it('rejects an explicit offset suffix (+01:00)', () => {
    expect(() => parseDateInput('2026-04-29T14:30:00+01:00', 'due')).toThrow(UsageError);
  });

  it('rejects an invalid date inside a date+time form (Feb 30)', () => {
    expect(() => parseDateInput('2026-02-30T12:00', 'due')).toThrow(UsageError);
  });
});

describe('parseDateInput — relative tokens, word forms', () => {
  it('today resolves to today\'s date in the given tz', () => {
    // 2026-04-29T13:00 UTC = 2026-04-29T14:00 BST = 2026-04-30T01:00 NZST
    const now = frozenClock('2026-04-29T13:00:00Z');
    const inLondon = parseDateInput('today', 'due', { now, timezone: LONDON });
    const inAuckland = parseDateInput('today', 'due', { now, timezone: AUCKLAND });
    expect(inLondon.payload).toEqual({ date: '2026-04-29' });
    expect(inAuckland.payload).toEqual({ date: '2026-04-30' });
  });

  it('today emits a resolvedFrom echo with input/timezone/now', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('today', 'due', { now, timezone: LONDON });
    expect(out.resolvedFrom).toEqual({
      input: 'today',
      timezone: LONDON,
      now: '2026-04-29T14:00:00+01:00',
    });
  });

  it('tomorrow advances by one calendar day in the tz', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const inLondon = parseDateInput('tomorrow', 'due', { now, timezone: LONDON });
    expect(inLondon.payload).toEqual({ date: '2026-04-30' });
  });

  it('case-insensitive: TODAY / Today / tOdAy all resolve identically', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const lower = parseDateInput('today', 'due', { now, timezone: LONDON });
    const upper = parseDateInput('TODAY', 'due', { now, timezone: LONDON });
    const mixed = parseDateInput('Today', 'due', { now, timezone: LONDON });
    expect(upper.payload).toEqual(lower.payload);
    expect(mixed.payload).toEqual(lower.payload);
  });

  it('preserves the verbatim input in resolvedFrom (not lowercased)', () => {
    // The dry-run output should show what the agent typed —
    // case-folding is only for matching, not for the echo.
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('TOMORROW', 'due', { now, timezone: LONDON });
    expect(out.resolvedFrom?.input).toBe('TOMORROW');
  });
});

describe('parseDateInput — relative tokens, +Nd / -Nd / +Nw / -Nw', () => {
  it('+3d advances three calendar days', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('+3d', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-05-02' });
  });

  it('-1d retreats one calendar day', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('-1d', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-04-28' });
  });

  it('+1w advances seven calendar days', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('+1w', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-05-06' });
  });

  it('-2w retreats fourteen calendar days', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('-2w', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-04-15' });
  });

  it('+0d resolves to today (zero offset)', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('+0d', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-04-29' });
  });

  it('handles month rollover (+5d from 2026-04-29)', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('+5d', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-05-04' });
  });

  it('handles year rollover (+30d from 2026-12-15)', () => {
    const now = frozenClock('2026-12-15T13:00:00Z');
    const out = parseDateInput('+30d', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2027-01-14' });
  });

  it('handles leap-year crossing (+1d from 2028-02-28)', () => {
    const now = frozenClock('2028-02-28T13:00:00Z');
    const out = parseDateInput('+1d', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2028-02-29' });
  });

  it('rejects unit "y" (years not in v0.1 grammar)', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    expect(() =>
      parseDateInput('+1y', 'due', { now, timezone: LONDON }),
    ).toThrow(UsageError);
  });

  it('rejects unit "M" (months not in v0.1 grammar)', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    expect(() =>
      parseDateInput('+1M', 'due', { now, timezone: LONDON }),
    ).toThrow(UsageError);
  });
});

describe('parseDateInput — relative tokens, +Nh / -Nh', () => {
  it('+2h shifts the wall-clock hour and emits date+time', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('+2h', 'due', { now, timezone: LONDON });
    // 13:00 UTC + 2h = 15:00 UTC = 16:00 BST (DST active)
    expect(out.payload).toEqual({ date: '2026-04-29', time: '16:00:00' });
  });

  it('-3h retreats three hours in instant time', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('-3h', 'due', { now, timezone: LONDON });
    // 13:00 UTC - 3h = 10:00 UTC = 11:00 BST
    expect(out.payload).toEqual({ date: '2026-04-29', time: '11:00:00' });
  });

  it('+24h crosses to the next day (no DST shift on a non-boundary day)', () => {
    const now = frozenClock('2026-06-15T13:00:00Z');
    const out = parseDateInput('+24h', 'due', { now, timezone: LONDON });
    // 13:00 UTC = 14:00 BST; +24h = 14:00 BST next day
    expect(out.payload).toEqual({ date: '2026-06-16', time: '14:00:00' });
  });

  it('emits resolvedFrom with the now timestamp in the resolution tz', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('+2h', 'due', { now, timezone: LONDON });
    expect(out.resolvedFrom).toEqual({
      input: '+2h',
      timezone: LONDON,
      now: '2026-04-29T14:00:00+01:00',
    });
  });
});

describe('parseDateInput — DST boundaries (Europe/London)', () => {
  // Europe/London 2026 transitions:
  //   spring forward: Sun 29 March 2026 — 01:00 GMT → 02:00 BST
  //   fall back:      Sun 25 October 2026 — 02:00 BST → 01:00 GMT

  it('+1d across spring-forward boundary still advances exactly one calendar day', () => {
    // From 2026-03-28 in London → expect 2026-03-29 (the lost
    // hour doesn't change the calendar count).
    const now = frozenClock('2026-03-28T12:00:00Z');
    const out = parseDateInput('+1d', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-03-29' });
  });

  it('+1d across fall-back boundary still advances exactly one calendar day', () => {
    // From 2026-10-24 in London → expect 2026-10-25 (the
    // doubled hour doesn't change the calendar count).
    const now = frozenClock('2026-10-24T12:00:00Z');
    const out = parseDateInput('+1d', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-10-25' });
  });

  it('+24h across spring-forward shifts wall-clock hour by 1 (industry standard)', () => {
    // 2026-03-29 00:30 UTC = 00:30 GMT in London (still GMT;
    // DST flips at 01:00 GMT). +24h = 2026-03-30 00:30 UTC =
    // 01:30 BST in London (post-DST). The wall-clock hour
    // shifted from 00:30 to 01:30 — that's the documented
    // semantic for "+Nh" as instant arithmetic.
    const now = frozenClock('2026-03-29T00:30:00Z');
    const out = parseDateInput('+24h', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-03-30', time: '01:30:00' });
  });

  it('+24h across fall-back shifts wall-clock hour by -1', () => {
    // 2026-10-25 00:30 UTC = 01:30 BST. +24h = 2026-10-26
    // 00:30 UTC = 00:30 GMT (post-fall-back). Wall-clock
    // hour shifted from 01:30 to 00:30.
    const now = frozenClock('2026-10-25T00:30:00Z');
    const out = parseDateInput('+24h', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-10-26', time: '00:30:00' });
  });

  it('today around the DST transition reports the correct local date', () => {
    // 2026-03-29 at 00:30 UTC = 00:30 local in London (still
    // GMT, just before the spring forward at 01:00). today
    // should still report 2026-03-29.
    const now = frozenClock('2026-03-29T00:30:00Z');
    const out = parseDateInput('today', 'due', { now, timezone: LONDON });
    expect(out.payload).toEqual({ date: '2026-03-29' });
    expect(out.resolvedFrom?.now).toBe('2026-03-29T00:30:00+00:00');
  });
});

describe('parseDateInput — DST boundaries (Pacific/Auckland)', () => {
  // Pacific/Auckland 2026 transitions:
  //   fall back (autumn for southern hemisphere):
  //     Sun 5 April 2026 — 03:00 NZDT → 02:00 NZST
  //   spring forward (spring for southern hemisphere):
  //     Sun 27 September 2026 — 02:00 NZST → 03:00 NZDT

  it('today during NZDT (Apr 4) reports the correct local date', () => {
    // 2026-04-04 at 12:00 UTC = 2026-04-05 01:00 NZDT (UTC+13).
    const now = frozenClock('2026-04-04T12:00:00Z');
    const out = parseDateInput('today', 'due', { now, timezone: AUCKLAND });
    expect(out.payload).toEqual({ date: '2026-04-05' });
  });

  it('today during NZST (Apr 6) reports the correct local date', () => {
    // 2026-04-06 at 11:00 UTC = 2026-04-06 23:00 NZST (UTC+12).
    const now = frozenClock('2026-04-06T11:00:00Z');
    const out = parseDateInput('today', 'due', { now, timezone: AUCKLAND });
    expect(out.payload).toEqual({ date: '2026-04-06' });
  });

  it('+24h across fall-back shifts wall-clock hour by -1 in NZ', () => {
    // The fall-back happens at 03:00 NZDT on Apr 5 = 14:00 UTC
    // Apr 4. Codex review pass-1 finding F3: a start instant
    // OF EXACTLY 14:00 UTC sits at the transition itself, where
    // Intl reports 02:00 NZST (post-transition). To pin the
    // intended -1h wall-clock shift the start has to be
    // pre-transition. 13:30Z gives:
    //   start  = 2026-04-04T13:30 UTC = 2026-04-05T02:30 NZDT (still NZDT)
    //   +24h   = 2026-04-05T13:30 UTC = 2026-04-06T01:30 NZST (now NZST)
    // Wall-clock shifted from 02:30 to 01:30 — the -1h fall-back
    // hour.
    const now = frozenClock('2026-04-04T13:30:00Z');
    const out = parseDateInput('+24h', 'due', { now, timezone: AUCKLAND });
    expect(out.payload).toEqual({ date: '2026-04-06', time: '01:30:00' });
  });

  it('resolvedFrom.now reflects the +13/+12 NZ offset correctly', () => {
    // During NZDT (April 4 in 2026), NZ is UTC+13.
    const nzdtNow = frozenClock('2026-04-04T12:00:00Z');
    const nzdt = parseDateInput('today', 'due', {
      now: nzdtNow,
      timezone: AUCKLAND,
    });
    expect(nzdt.resolvedFrom?.now).toBe('2026-04-05T01:00:00+13:00');
    // After fall-back (April 6), NZ is UTC+12.
    const nzstNow = frozenClock('2026-04-06T11:00:00Z');
    const nzst = parseDateInput('today', 'due', {
      now: nzstNow,
      timezone: AUCKLAND,
    });
    expect(nzst.resolvedFrom?.now).toBe('2026-04-06T23:00:00+12:00');
  });
});

describe('parseDateInput — non-DST timezone control (Asia/Tokyo)', () => {
  it('today in Tokyo reports the local date with +09:00 offset', () => {
    // 2026-04-29 14:00 UTC = 2026-04-29 23:00 JST (UTC+9 always).
    const now = frozenClock('2026-04-29T14:00:00Z');
    const out = parseDateInput('today', 'due', { now, timezone: TOKYO });
    expect(out.payload).toEqual({ date: '2026-04-29' });
    expect(out.resolvedFrom?.now).toBe('2026-04-29T23:00:00+09:00');
  });

  it('today in Tokyo near midnight UTC may report the next day', () => {
    // 2026-04-29 23:00 UTC = 2026-04-30 08:00 JST.
    const now = frozenClock('2026-04-29T23:00:00Z');
    const out = parseDateInput('today', 'due', { now, timezone: TOKYO });
    expect(out.payload).toEqual({ date: '2026-04-30' });
  });
});

describe('parseDateInput — UTC timezone control', () => {
  it('today in UTC produces the +00:00 offset for resolvedFrom.now', () => {
    const now = frozenClock('2026-04-29T13:00:00Z');
    const out = parseDateInput('today', 'due', { now, timezone: 'UTC' });
    expect(out.resolvedFrom?.now).toBe('2026-04-29T13:00:00+00:00');
  });
});

describe('parseDateInput — error paths', () => {
  it('empty input throws usage_error with a structured details payload', () => {
    expect(() => parseDateInput('', 'due')).toThrow(UsageError);
    expect(() => parseDateInput('', 'due')).toThrow(
      /does not match any supported form/u,
    );
    try {
      parseDateInput('', 'due');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_id: 'due',
        column_type: 'date',
        raw_input: '',
      });
    }
  });

  it('whitespace-only input is treated as empty (trimmed to length 0)', () => {
    expect(() => parseDateInput('   ', 'due')).toThrow(UsageError);
  });

  it('garbled input throws usage_error with a hint that lists every supported form', () => {
    expect(() => parseDateInput('not-a-date', 'due')).toThrow(UsageError);
    try {
      parseDateInput('not-a-date', 'due');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.details).toMatchObject({
        hint: expect.stringContaining('--set due=2026-05-01') as unknown,
      });
    }
  });

  it('rejects relative-token-like input with extra suffix (+3days, -1week)', () => {
    expect(() => parseDateInput('+3days', 'due')).toThrow(UsageError);
    expect(() => parseDateInput('-1week', 'due')).toThrow(UsageError);
  });

  it('rejects relative-token with no number (+d)', () => {
    expect(() => parseDateInput('+d', 'due')).toThrow(UsageError);
  });

  it('rejects relative-token with non-digit amount (+abcd)', () => {
    expect(() => parseDateInput('+abcd', 'due')).toThrow(UsageError);
  });

  it('rejects relative-token with leading zero allowed but unsafe-integer rejected', () => {
    // The regex accepts +007d (Number("007") = 7, safe). What it
    // must NOT accept is a digit string > 2^53 — that would
    // silently round via Number(). Pin both sides for the day
    // path AND the hour path so a future "share the parser
    // for both units" refactor can't drop the guard on one
    // accidentally.
    const now = frozenClock('2026-04-29T12:00:00Z');
    const okay = parseDateInput('+007d', 'due', { now, timezone: LONDON });
    expect(okay.payload).toEqual({ date: '2026-05-06' });
    expect(() =>
      parseDateInput('+99999999999999999999d', 'due', {
        now,
        timezone: LONDON,
      }),
    ).toThrow(UsageError);
    expect(() =>
      parseDateInput('+99999999999999999999h', 'due', {
        now,
        timezone: LONDON,
      }),
    ).toThrow(UsageError);
  });

  it('error message names the column id verbatim', () => {
    try {
      parseDateInput('garbage', 'project_due');
      throw new Error('expected throw');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.message).toContain('"project_due"');
    }
  });
});

describe('parseDateInput — relative offset out-of-range bound (Codex F1)', () => {
  // Pre-fix, +99999999d produced {date:"0NaN-NaN-NaN"} — the
  // safe-integer check passed but the resulting Date was beyond
  // JS's representable range, and getUTCFullYear() returned NaN.
  // The bound caps relative offsets to ~100 years magnitude so
  // the wire shape stays valid and the failure mode is a typed
  // usage_error.

  it('+50000d (>100 years) throws usage_error with the bound named in details', () => {
    const now = frozenClock('2026-04-29T12:00:00Z');
    expect(() =>
      parseDateInput('+50000d', 'due', { now, timezone: LONDON }),
    ).toThrow(UsageError);
    expect(() =>
      parseDateInput('+50000d', 'due', { now, timezone: LONDON }),
    ).toThrow(/exceeds the translator's maximum magnitude/u);
    try {
      parseDateInput('+50000d', 'due', { now, timezone: LONDON });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_type: 'date',
        unit: 'days',
        amount: 50000,
        max_amount: 36500,
      });
    }
  });

  it('+10000w (= 70000 days, > 100 years) throws because weeks multiply', () => {
    // The bound is on days, so a large weeks value still has
    // to be checked post-multiply. Pinned so a future "bound
    // weeks separately" refactor doesn't quietly miss this.
    const now = frozenClock('2026-04-29T12:00:00Z');
    expect(() =>
      parseDateInput('+10000w', 'due', { now, timezone: LONDON }),
    ).toThrow(UsageError);
  });

  it('+1000000h (~114 years) throws usage_error with hours unit in details', () => {
    const now = frozenClock('2026-04-29T12:00:00Z');
    expect(() =>
      parseDateInput('+1000000h', 'due', { now, timezone: LONDON }),
    ).toThrow(UsageError);
    try {
      parseDateInput('+1000000h', 'due', { now, timezone: LONDON });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.details).toMatchObject({
        unit: 'hours',
        amount: 1000000,
        max_amount: 876000,
      });
    }
  });

  it('+36500d (= max) succeeds — bound is inclusive', () => {
    const now = frozenClock('2026-04-29T12:00:00Z');
    const out = parseDateInput('+36500d', 'due', { now, timezone: LONDON });
    // 36500 days from 2026-04-29 ≈ 2126-04-04 (allow either
    // side of the leap-year correction; just assert the
    // shape, not the exact day, so the test stays robust to
    // the leap-day count between 2026 and 2126).
    expect(out.payload).toMatchObject({
      date: expect.stringMatching(/^21\d{2}-\d{2}-\d{2}$/u) as unknown,
    });
  });

  it('+36501d (max + 1) throws — bound is enforced strictly', () => {
    const now = frozenClock('2026-04-29T12:00:00Z');
    expect(() =>
      parseDateInput('+36501d', 'due', { now, timezone: LONDON }),
    ).toThrow(UsageError);
  });

  it('-50000d (large negative magnitude) throws — bound applies in both directions via |sign|', () => {
    // The implementation checks `days > MAX` before applying
    // the sign, so -50000 still trips the same bound.
    const now = frozenClock('2026-04-29T12:00:00Z');
    expect(() =>
      parseDateInput('-50000d', 'due', { now, timezone: LONDON }),
    ).toThrow(UsageError);
  });
});

describe('parseDateInput — pre-1900 ISO date (Codex F2)', () => {
  // Pre-fix, isCalendarDate used Date.UTC(y, m-1, d) which maps
  // years 0-99 onto 1900-1999 (a JS legacy quirk for two-digit
  // years). 0001-01-01 round-tripped to 1901-01-01 and got
  // rejected. setUTCFullYear-based round-trip accepts the
  // literal year. Translator's contract is "let Monday be
  // the validator" — pre-1900 dates are Monday's call to
  // accept or reject as validation_failed, not the CLI's.

  it('accepts 1899-12-31 (one day before the JS two-digit-year boundary)', () => {
    const out = parseDateInput('1899-12-31', 'due');
    expect(out.payload).toEqual({ date: '1899-12-31' });
  });

  it('accepts 0099-12-31 (inside the JS two-digit-year range)', () => {
    const out = parseDateInput('0099-12-31', 'due');
    expect(out.payload).toEqual({ date: '0099-12-31' });
  });

  it('accepts 0001-01-01 (year 1)', () => {
    const out = parseDateInput('0001-01-01', 'due');
    expect(out.payload).toEqual({ date: '0001-01-01' });
  });

  it('still rejects an impossible pre-1900 date (0099-02-30)', () => {
    expect(() => parseDateInput('0099-02-30', 'due')).toThrow(UsageError);
  });
});

describe('parseDateInput — defaults (system clock + system tz)', () => {
  it('omitting ctx falls back to system clock + system tz without throwing', () => {
    // Can't assert a deterministic result without a frozen
    // clock, but we can assert the contract: defaults must
    // produce a valid payload + resolvedFrom shape rather than
    // throwing. The dry-run engine relies on this when no
    // MONDAY_TIMEZONE is set.
    const out = parseDateInput('today', 'due');
    expect(out.payload).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) as unknown });
    expect(out.resolvedFrom).not.toBeNull();
    expect(out.resolvedFrom?.input).toBe('today');
    expect(typeof out.resolvedFrom?.timezone).toBe('string');
  });

  it('omitting just ctx.timezone uses the system tz default', () => {
    const out = parseDateInput('today', 'due', {
      now: frozenClock('2026-04-29T13:00:00Z'),
    });
    // Whatever system tz is, the payload must be a valid date.
    expect(out.payload).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) as unknown });
    expect(out.resolvedFrom?.timezone).toBeTruthy();
  });
});

describe('formatNowInTimezone — the resolvedFrom.now sample shape', () => {
  it('matches cli-design §5.3 line 786 sample exactly', () => {
    // Sample: "now": "2026-04-25T14:00:00+01:00"
    const instant = new Date('2026-04-25T13:00:00Z');
    expect(formatNowInTimezone(instant, LONDON)).toBe('2026-04-25T14:00:00+01:00');
  });

  it('emits +00:00 for UTC (not GMT, not Z)', () => {
    const instant = new Date('2026-04-25T13:00:00Z');
    expect(formatNowInTimezone(instant, 'UTC')).toBe('2026-04-25T13:00:00+00:00');
  });

  it('emits the correct sign for a negative offset (America/New_York)', () => {
    // 2026-04-25 13:00 UTC = 09:00 EDT (UTC-4 during DST).
    const instant = new Date('2026-04-25T13:00:00Z');
    expect(formatNowInTimezone(instant, 'America/New_York')).toBe(
      '2026-04-25T09:00:00-04:00',
    );
  });

  it('preserves the offset across the DST boundary day (London)', () => {
    // Just before spring-forward: 00:30 GMT = +00:00.
    const before = new Date('2026-03-29T00:30:00Z');
    expect(formatNowInTimezone(before, LONDON)).toBe('2026-03-29T00:30:00+00:00');
    // Just after spring-forward: 02:30 BST = +01:00.
    const after = new Date('2026-03-29T01:30:00Z');
    expect(formatNowInTimezone(after, LONDON)).toBe('2026-03-29T02:30:00+01:00');
  });
});
