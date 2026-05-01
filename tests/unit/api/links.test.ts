/**
 * Unit tests for `parseLinkInput` (`src/api/links.ts`, M8 firm row).
 *
 * Coverage shape mirrors `dates.test.ts` / `people.test.ts` —
 * happy path per accepted form, every rejected form, idempotent
 * re-translation through the dispatcher, Unicode in the visible
 * `text` segment, pipe-form edge cases.
 */
import { describe, expect, it } from 'vitest';
import { parseLinkInput } from '../../../src/api/links.js';
import {
  translateColumnValue,
  type TranslatedColumnValue,
} from '../../../src/api/column-values.js';
import { UsageError } from '../../../src/utils/errors.js';

describe('parseLinkInput — happy paths', () => {
  it('single URL → text defaults to URL', () => {
    expect(parseLinkInput('https://example.com', 'site')).toEqual({
      url: 'https://example.com',
      text: 'https://example.com',
    });
  });

  it('pipe form → both segments preserved', () => {
    expect(parseLinkInput('https://example.com|Example', 'site')).toEqual({
      url: 'https://example.com',
      text: 'Example',
    });
  });

  it('pipe form trims surrounding whitespace from each segment', () => {
    expect(parseLinkInput('  https://example.com  |  Example  ', 'site')).toEqual({
      url: 'https://example.com',
      text: 'Example',
    });
  });

  it('outer trim handles leading/trailing whitespace on single-URL form', () => {
    expect(parseLinkInput('   https://example.com   ', 'site')).toEqual({
      url: 'https://example.com',
      text: 'https://example.com',
    });
  });

  it('pipe-split is max 1 — additional `|` characters land in text segment', () => {
    expect(
      parseLinkInput('https://example.com|foo|bar|baz', 'site'),
    ).toEqual({
      url: 'https://example.com',
      text: 'foo|bar|baz',
    });
  });

  it('Unicode in text segment is preserved verbatim', () => {
    expect(
      parseLinkInput('https://example.com|日本語 / café', 'site'),
    ).toEqual({
      url: 'https://example.com',
      text: '日本語 / café',
    });
  });

  it('http URLs accepted (not just https)', () => {
    expect(parseLinkInput('http://example.com', 'site')).toEqual({
      url: 'http://example.com',
      text: 'http://example.com',
    });
  });

  it('URLs with query strings + fragments preserved', () => {
    expect(
      parseLinkInput('https://example.com/path?q=1#frag', 'site'),
    ).toEqual({
      url: 'https://example.com/path?q=1#frag',
      text: 'https://example.com/path?q=1#frag',
    });
  });
});

describe('parseLinkInput — error paths', () => {
  it('empty input → usage_error pointing at item clear', () => {
    expect(() => parseLinkInput('', 'site')).toThrow(UsageError);
    try {
      parseLinkInput('', 'site');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/needs a URL/u);
      expect(err.details).toMatchObject({
        column_id: 'site',
        column_type: 'link',
      });
      expect((err.details as { hint: string }).hint).toMatch(/--set/u);
    }
  });

  it('whitespace-only input → empty-input usage_error', () => {
    expect(() => parseLinkInput('   ', 'site')).toThrow(/needs a URL/u);
  });

  it('pipe form with empty trailer → usage_error pointing at --set-raw', () => {
    expect(() => parseLinkInput('https://example.com|', 'site')).toThrow(
      UsageError,
    );
    try {
      parseLinkInput('https://example.com|', 'site');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/empty text segment/u);
      // Cli-design §5.3 line 810-811: empty text → use --set-raw.
      expect((err.details as { hint: string }).hint).toMatch(/--set-raw/u);
    }
  });

  it('pipe form with whitespace-only trailer → empty-trailer usage_error', () => {
    expect(() => parseLinkInput('https://example.com|   ', 'site')).toThrow(
      /empty text segment/u,
    );
  });

  it('pipe form with empty leader → empty-input usage_error', () => {
    expect(() => parseLinkInput('|Example', 'site')).toThrow(/needs a URL/u);
  });

  it('invalid URL → usage_error with url_segment in details', () => {
    expect(() => parseLinkInput('not-a-url', 'site')).toThrow(UsageError);
    try {
      parseLinkInput('not-a-url', 'site');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/invalid URL "not-a-url"/u);
      expect(err.details).toMatchObject({
        column_id: 'site',
        column_type: 'link',
        url_segment: 'not-a-url',
      });
    }
  });

  it('invalid URL with pipe form → usage_error names the URL segment, not the raw input', () => {
    try {
      parseLinkInput('not-a-url|Example', 'site');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/"not-a-url"/u);
      expect((err.details as { url_segment: string }).url_segment).toBe('not-a-url');
    }
  });

  it('column_id appears verbatim in the error hint (paste-ready)', () => {
    try {
      parseLinkInput('', 'My Custom Link Column');
    } catch (e) {
      const err = e as UsageError;
      expect((err.details as { hint: string }).hint).toContain(
        'My Custom Link Column',
      );
    }
  });
});

describe('parseLinkInput — dispatcher integration', () => {
  it('translateColumnValue dispatches link → rich payload', () => {
    const out = translateColumnValue({
      column: { id: 'site', type: 'link' },
      value: 'https://example.com|Example',
    });
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'site',
      columnType: 'link',
      rawInput: 'https://example.com|Example',
      payload: {
        format: 'rich',
        value: { url: 'https://example.com', text: 'Example' },
      },
      resolvedFrom: null,
      peopleResolution: null,
    });
  });

  it('idempotent — translating the wire shape\'s own JSON.stringify round-trips structure', () => {
    // Re-running the translator on the same input produces the same
    // wire payload. (The wire payload is not itself a valid input
    // for the translator — JSON shape isn't pipe-form — but
    // re-running on the original input should be deterministic.)
    const first = translateColumnValue({
      column: { id: 'site', type: 'link' },
      value: 'https://example.com|Example',
    });
    const second = translateColumnValue({
      column: { id: 'site', type: 'link' },
      value: 'https://example.com|Example',
    });
    expect(first).toEqual(second);
  });

  it('translator never JSON.stringify\'s the payload (Monday JSON scalar discipline)', () => {
    // cli-design §5.3 step 4: the translator produces a plain JS
    // object; the SDK / fetch layer handles the JSON-scalar boundary.
    // Pinning here so a future refactor doesn't accidentally double-
    // encode (Codex M5a finding shape).
    const out = translateColumnValue({
      column: { id: 'site', type: 'link' },
      value: 'https://example.com',
    });
    expect(typeof out.payload.value).toBe('object');
    expect(out.payload.value).not.toBe(JSON.stringify(out.payload.value));
  });
});
