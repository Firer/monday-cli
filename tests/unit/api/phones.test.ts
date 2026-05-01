/**
 * Unit tests for `parsePhoneInput` (`src/api/phones.ts`, M8 firm row)
 * + `isIsoCountryCode` from `iso-country-codes.ts`.
 *
 * Covers the mandatory pipe-form contract (cli-design §5.3 line
 * 815-827), every rejection branch, and the dispatcher integration.
 */
import { describe, expect, it } from 'vitest';
import { parsePhoneInput } from '../../../src/api/phones.js';
import {
  ISO_3166_1_ALPHA_2_CODES,
  isIsoCountryCode,
} from '../../../src/api/iso-country-codes.js';
import {
  translateColumnValue,
  type TranslatedColumnValue,
} from '../../../src/api/column-values.js';
import { UsageError } from '../../../src/utils/errors.js';

describe('isIsoCountryCode', () => {
  it.each(['US', 'GB', 'JP', 'NZ', 'BR', 'ZW'])(
    'recognises officially-assigned code %s',
    (code) => {
      expect(isIsoCountryCode(code)).toBe(true);
    },
  );

  it.each([
    'UK', // exceptionally-reserved (the official code is GB)
    'EU', // exceptionally-reserved
    'AA', // user-assigned
    'XX', // not assigned
    '',
    'USA', // 3-letter ISO 3166-1 alpha-3, not alpha-2
    'us', // case-sensitive — caller uppercases
  ])('rejects non-allowlisted code %s', (code) => {
    expect(isIsoCountryCode(code)).toBe(false);
  });

  it('list size matches the documented 249-code count (regression guard)', () => {
    // Pinned because typo-counting in a hand-edited 249-entry array
    // is exactly the kind of drift Codex caught in M5a's roadmap
    // table. If ISO publishes a new code, bump this number alongside
    // the code itself.
    expect(ISO_3166_1_ALPHA_2_CODES.length).toBe(249);
  });
});

describe('parsePhoneInput — happy paths', () => {
  it('pipe form with leading + → preserved verbatim', () => {
    expect(parsePhoneInput('+15551234567|US', 'mobile')).toEqual({
      phone: '+15551234567',
      countryShortName: 'US',
    });
  });

  it('pipe form without leading + → preserved verbatim', () => {
    expect(parsePhoneInput('15551234567|US', 'mobile')).toEqual({
      phone: '15551234567',
      countryShortName: 'US',
    });
  });

  it('pipe form trims surrounding whitespace from each segment', () => {
    expect(parsePhoneInput('  +15551234567  |  US  ', 'mobile')).toEqual({
      phone: '+15551234567',
      countryShortName: 'US',
    });
  });

  it('country code is uppercased before validation', () => {
    expect(parsePhoneInput('+15551234567|us', 'mobile')).toEqual({
      phone: '+15551234567',
      countryShortName: 'US',
    });
  });

  it('mixed-case country code uppercased', () => {
    expect(parsePhoneInput('+44207946000|gB', 'mobile')).toEqual({
      phone: '+44207946000',
      countryShortName: 'GB',
    });
  });

  it.each([
    // E.164 minimum (6 digits)
    ['+123456', 'US'],
    ['123456', 'US'],
    // E.164 max (15 digits)
    ['+123456789012345', 'US'],
    ['123456789012345', 'US'],
  ])('accepts E.164-loose phone %s with country %s', (phone, country) => {
    expect(parsePhoneInput(`${phone}|${country}`, 'mobile')).toEqual({
      phone,
      countryShortName: country,
    });
  });
});

describe('parsePhoneInput — error paths', () => {
  it('empty input → usage_error pointing at item clear', () => {
    expect(() => parsePhoneInput('', 'mobile')).toThrow(UsageError);
    try {
      parsePhoneInput('', 'mobile');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/needs <phone>\|<country> input/u);
    }
  });

  it('whitespace-only input → empty-input usage_error', () => {
    expect(() => parsePhoneInput('   ', 'mobile')).toThrow(
      /needs <phone>\|<country> input/u,
    );
  });

  it('single-segment input (no pipe) → usage_error pointing at --set-raw', () => {
    expect(() => parsePhoneInput('+15551234567', 'mobile')).toThrow(UsageError);
    try {
      parsePhoneInput('+15551234567', 'mobile');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/requires the pipe form/u);
      // Cli-design §5.3 line 819-827: "Use --set-raw to write a phone
      // with no country if Monday's legacy behaviour permits it."
      expect((err.details as { hint: string }).hint).toMatch(/--set-raw/u);
    }
  });

  it('pipe form with empty phone segment → usage_error', () => {
    expect(() => parsePhoneInput('|US', 'mobile')).toThrow(
      /empty phone segment/u,
    );
  });

  it('pipe form with empty country segment → usage_error pointing at --set-raw', () => {
    expect(() => parsePhoneInput('+15551234567|', 'mobile')).toThrow(
      /empty country segment/u,
    );
  });

  it('phone with internal whitespace → rejected (strip in shell first)', () => {
    expect(() => parsePhoneInput('+1 555 123 4567|US', 'mobile')).toThrow(
      /invalid phone/u,
    );
  });

  it('phone with dashes → rejected (strip in shell first)', () => {
    expect(() => parsePhoneInput('+1-555-123-4567|US', 'mobile')).toThrow(
      /invalid phone/u,
    );
  });

  it('phone shorter than 6 digits → rejected', () => {
    expect(() => parsePhoneInput('+12345|US', 'mobile')).toThrow(
      /invalid phone/u,
    );
  });

  it('phone longer than 15 digits → rejected', () => {
    expect(() => parsePhoneInput('+1234567890123456|US', 'mobile')).toThrow(
      /invalid phone/u,
    );
  });

  it('phone with non-digit characters → rejected', () => {
    expect(() => parsePhoneInput('+1555ABC4567|US', 'mobile')).toThrow(
      /invalid phone/u,
    );
  });

  it('country code not in allowlist → usage_error names the segment', () => {
    expect(() => parsePhoneInput('+15551234567|XX', 'mobile')).toThrow(
      UsageError,
    );
    try {
      parsePhoneInput('+15551234567|XX', 'mobile');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/invalid country code "XX"/u);
      expect(err.details).toMatchObject({
        column_id: 'mobile',
        column_type: 'phone',
        country_segment: 'XX',
      });
    }
  });

  it('country code "UK" (exceptionally-reserved) is rejected — official is GB', () => {
    // Pinned because "UK" feels right to a human but ISO 3166-1
    // alpha-2 reserves it (the actual code is "GB"). Surfacing the
    // wrong code at Monday silently fails server-side; the CLI
    // catches it locally.
    expect(() => parsePhoneInput('+44207946000|UK', 'mobile')).toThrow(
      /invalid country code "UK"/u,
    );
  });

  it('country code "USA" (3-letter alpha-3) is rejected', () => {
    expect(() => parsePhoneInput('+15551234567|USA', 'mobile')).toThrow(
      /invalid country code "USA"/u,
    );
  });

  it('column_id appears verbatim in the error hint (paste-ready)', () => {
    try {
      parsePhoneInput('', 'My Mobile Column');
    } catch (e) {
      const err = e as UsageError;
      expect((err.details as { hint: string }).hint).toContain(
        'My Mobile Column',
      );
    }
  });
});

describe('parsePhoneInput — dispatcher integration', () => {
  it('translateColumnValue dispatches phone → rich payload', () => {
    const out = translateColumnValue({
      column: { id: 'mobile', type: 'phone' },
      value: '+15551234567|US',
    });
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'mobile',
      columnType: 'phone',
      rawInput: '+15551234567|US',
      payload: {
        format: 'rich',
        value: { phone: '+15551234567', countryShortName: 'US' },
      },
      resolvedFrom: null,
      peopleResolution: null,
    });
  });

  it('idempotent — re-translating the same input is deterministic', () => {
    const first = translateColumnValue({
      column: { id: 'mobile', type: 'phone' },
      value: '+15551234567|US',
    });
    const second = translateColumnValue({
      column: { id: 'mobile', type: 'phone' },
      value: '+15551234567|US',
    });
    expect(first).toEqual(second);
  });
});
