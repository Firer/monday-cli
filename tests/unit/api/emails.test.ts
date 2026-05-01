/**
 * Unit tests for `parseEmailInput` (`src/api/emails.ts`, M8 firm row).
 *
 * Mirrors the link translator's coverage shape — happy paths + every
 * rejected form + dispatcher integration.
 *
 * **`email` is the column type, distinct from `people`.** The
 * `email` column is a free-form contact-info column on the item
 * (e.g. "support contact"). `people` is the assignee column.
 */
import { describe, expect, it } from 'vitest';
import { parseEmailInput } from '../../../src/api/emails.js';
import {
  translateColumnValue,
  type TranslatedColumnValue,
} from '../../../src/api/column-values.js';
import { UsageError } from '../../../src/utils/errors.js';

describe('parseEmailInput — happy paths', () => {
  it('single email → text defaults to email', () => {
    expect(parseEmailInput('alice@example.com', 'contact')).toEqual({
      email: 'alice@example.com',
      text: 'alice@example.com',
    });
  });

  it('pipe form → both segments preserved', () => {
    expect(
      parseEmailInput('alice@example.com|Alice', 'contact'),
    ).toEqual({
      email: 'alice@example.com',
      text: 'Alice',
    });
  });

  it('pipe form trims surrounding whitespace from each segment', () => {
    expect(
      parseEmailInput('  alice@example.com  |  Alice  ', 'contact'),
    ).toEqual({
      email: 'alice@example.com',
      text: 'Alice',
    });
  });

  it('outer trim handles leading/trailing whitespace on single-email form', () => {
    expect(parseEmailInput('   alice@example.com   ', 'contact')).toEqual({
      email: 'alice@example.com',
      text: 'alice@example.com',
    });
  });

  it('pipe-split is max 1 — additional `|` characters land in text segment', () => {
    expect(
      parseEmailInput('alice@example.com|Alice|Pipes|Allowed', 'contact'),
    ).toEqual({
      email: 'alice@example.com',
      text: 'Alice|Pipes|Allowed',
    });
  });

  it('Unicode in text segment is preserved verbatim', () => {
    expect(
      parseEmailInput('alice@example.com|アリス / Café', 'contact'),
    ).toEqual({
      email: 'alice@example.com',
      text: 'アリス / Café',
    });
  });

  it('emails with subdomains + plus-addressing accepted', () => {
    expect(
      parseEmailInput('alice+filter@mail.example.co.uk', 'contact'),
    ).toEqual({
      email: 'alice+filter@mail.example.co.uk',
      text: 'alice+filter@mail.example.co.uk',
    });
  });
});

describe('parseEmailInput — error paths', () => {
  it('empty input → usage_error pointing at item clear', () => {
    expect(() => parseEmailInput('', 'contact')).toThrow(UsageError);
    try {
      parseEmailInput('', 'contact');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/needs an email address/u);
      expect(err.details).toMatchObject({
        column_id: 'contact',
        column_type: 'email',
      });
    }
  });

  it('whitespace-only input → empty-input usage_error', () => {
    expect(() => parseEmailInput('   ', 'contact')).toThrow(
      /needs an email address/u,
    );
  });

  it('pipe form with empty trailer → usage_error pointing at --set-raw', () => {
    expect(() => parseEmailInput('alice@example.com|', 'contact')).toThrow(
      UsageError,
    );
    try {
      parseEmailInput('alice@example.com|', 'contact');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/empty text segment/u);
      expect((err.details as { hint: string }).hint).toMatch(/--set-raw/u);
    }
  });

  it('pipe form with empty leader → empty-input usage_error', () => {
    expect(() => parseEmailInput('|Alice', 'contact')).toThrow(
      /needs an email address/u,
    );
  });

  it('invalid email → usage_error with email_segment in details', () => {
    expect(() => parseEmailInput('not-an-email', 'contact')).toThrow(UsageError);
    try {
      parseEmailInput('not-an-email', 'contact');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/invalid email "not-an-email"/u);
      expect(err.details).toMatchObject({
        column_id: 'contact',
        column_type: 'email',
        email_segment: 'not-an-email',
      });
    }
  });

  it('invalid email with pipe form → error names email segment, not raw input', () => {
    try {
      parseEmailInput('not-an-email|Alice', 'contact');
    } catch (e) {
      const err = e as UsageError;
      expect((err.details as { email_segment: string }).email_segment).toBe(
        'not-an-email',
      );
    }
  });

  it('column_id appears verbatim in the error hint (paste-ready)', () => {
    try {
      parseEmailInput('', 'My Email Column');
    } catch (e) {
      const err = e as UsageError;
      expect((err.details as { hint: string }).hint).toContain(
        'My Email Column',
      );
    }
  });
});

describe('parseEmailInput — dispatcher integration', () => {
  it('translateColumnValue dispatches email → rich payload', () => {
    const out = translateColumnValue({
      column: { id: 'contact', type: 'email' },
      value: 'alice@example.com|Alice',
    });
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'contact',
      columnType: 'email',
      rawInput: 'alice@example.com|Alice',
      payload: {
        format: 'rich',
        value: { email: 'alice@example.com', text: 'Alice' },
      },
      resolvedFrom: null,
      peopleResolution: null,
    });
  });

  it('idempotent — re-translating the same input is deterministic', () => {
    const first = translateColumnValue({
      column: { id: 'contact', type: 'email' },
      value: 'alice@example.com',
    });
    const second = translateColumnValue({
      column: { id: 'contact', type: 'email' },
      value: 'alice@example.com',
    });
    expect(first).toEqual(second);
  });
});
