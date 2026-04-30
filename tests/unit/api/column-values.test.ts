import { describe, expect, it } from 'vitest';
import { ApiError, UsageError } from '../../../src/utils/errors.js';
import {
  translateColumnValue,
  unsupportedColumnTypeError,
  type ColumnValuePayload,
  type TranslatedColumnValue,
} from '../../../src/api/column-values.js';
import type { WritableColumnType } from '../../../src/api/column-types.js';

const translate = (
  type: string,
  value: string,
  columnId = 'col_1',
): TranslatedColumnValue =>
  translateColumnValue({ column: { id: columnId, type }, value });

describe('translateColumnValue — simple types', () => {
  // Wire-shape fixtures (cli-design.md §5.3.3 + §5.3.5). These pins
  // are the v0.1 contract: bare-string `simple` payload, no
  // double-stringification — the SDK / fetch layer is responsible
  // for the JSON-scalar boundary. Future bulk / dry-run consumers
  // inherit this shape unchanged.

  it('text → bare-string simple payload (pass-through)', () => {
    const out = translate('text', 'Refactor login', 'notes');
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'notes',
      columnType: 'text',
      rawInput: 'Refactor login',
      payload: { format: 'simple', value: 'Refactor login' },
    });
  });

  it('text → empty string is preserved verbatim (Monday clears the cell)', () => {
    const out = translate('text', '');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'simple',
      value: '',
    });
  });

  it('text → preserves unicode + leading/trailing whitespace untouched', () => {
    const out = translate('text', '  日本語 / café  ');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'simple',
      value: '  日本語 / café  ',
    });
  });

  it('long_text → bare-string simple payload (multi-line preserved)', () => {
    const out = translate('long_text', 'line one\nline two\nline three');
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'col_1',
      columnType: 'long_text',
      rawInput: 'line one\nline two\nline three',
      payload: {
        format: 'simple',
        value: 'line one\nline two\nline three',
      },
    });
  });

  it('numbers → stringified-numeric pass-through (Monday quirk)', () => {
    const out = translate('numbers', '42');
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'col_1',
      columnType: 'numbers',
      rawInput: '42',
      payload: { format: 'simple', value: '42' },
    });
  });

  it('numbers → does not coerce or validate the input — boundary check is the caller', () => {
    // The translator's contract is "pass through verbatim"; whether
    // the value is a valid number is Monday's call (validation_failed)
    // or the command's argv parser (usage_error). Pinning this
    // behaviour means agents that pass `1e3` see Monday's response,
    // not a CLI-side rejection invented here.
    const out = translate('numbers', '1e3');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'simple',
      value: '1e3',
    });
  });

  it('echoes the resolved columnId regardless of how the column was looked up', () => {
    const out = translate('text', 'hi', 'status_4');
    expect(out.columnId).toBe('status_4');
  });

  it('produces no JSON-stringified payload — the value field is a JS string, not encoded JSON', () => {
    // Anti-regression: it would be tempting for a future contributor
    // to JSON.stringify the simple payload "for the wire". That's
    // wrong — graphql-request stringifies at the boundary, and a
    // double-stringified payload would round-trip as the literal
    // string `"hi"` (with quotes) rather than `hi`.
    const out = translate('text', 'hi');
    if (out.payload.format !== 'simple') throw new Error('expected simple');
    expect(out.payload.value).toBe('hi');
    expect(typeof out.payload.value).toBe('string');
    expect(out.payload.value.startsWith('"')).toBe(false);
  });
});

describe('translateColumnValue — status (rich)', () => {
  // Wire-shape fixtures (cli-design.md §5.3 step 3). Status payload
  // is one of {label: <string>} or {index: <number>}; the
  // translator emits the JS object verbatim — no JSON.stringify.
  // The simple/rich split here is on payload shape; status is
  // "rich" because the consumer (change_column_value) takes a JSON
  // object, not a bare string.

  it('alphanumeric input → {label: <verbatim>} rich payload', () => {
    const out = translate('status', 'Done', 'project_status');
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'project_status',
      columnType: 'status',
      rawInput: 'Done',
      payload: { format: 'rich', value: { label: 'Done' } },
    });
  });

  it('non-negative integer input → {index: N} (number, not string)', () => {
    const out = translate('status', '5', 'project_status');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { index: 5 },
    });
    if (out.payload.format !== 'rich') throw new Error('expected rich');
    // Anti-regression: pin that index is a JS number, so the JSON
    // scalar serialises `5` not `"5"`.
    expect(typeof out.payload.value.index).toBe('number');
  });

  it('"0" → {index: 0} — zero is a valid index for the first label', () => {
    const out = translate('status', '0');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { index: 0 },
    });
  });

  it('negative numeric → falls through to label path (Monday rejects)', () => {
    // Monday status indexes are >= 0, so "-1" is a label not an
    // index. Pinning this means a future contributor doesn't
    // accept negative indexes and silently produce a payload
    // Monday returns 200 + validation_failed for.
    const out = translate('status', '-1');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { label: '-1' },
    });
  });

  it('decimal numeric → label path (Monday rejects)', () => {
    const out = translate('status', '1.5');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { label: '1.5' },
    });
  });

  it('scientific-notation numeric → label path (Number(raw) would coerce)', () => {
    // `1e3` parses to 1000 via Number() but is not a status index
    // input the user is asking for — they typed letters. The
    // regex gates this so a future Number()-based check doesn't
    // mis-route.
    const out = translate('status', '1e3');
    if (out.payload.format !== 'rich') throw new Error('expected rich');
    expect(out.payload.value).toEqual({ label: '1e3' });
  });

  it('empty string → {label: ""} — not a clear intent (use `item clear`)', () => {
    const out = translate('status', '');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { label: '' },
    });
  });

  it('preserves whitespace + unicode in labels (no NFC/casefold here)', () => {
    // The column-resolver upstream NFC-folds the *column* token
    // (cli-design §5.3 step 2.b). Status *values* are not folded
    // — Monday matches the label server-side. Pinning that the
    // translator passes the value through untouched means a
    // future contributor doesn't add label normalisation here
    // and silently break agents whose status labels end with a
    // trailing space.
    const out = translate('status', '  日本語  ');
    if (out.payload.format !== 'rich') throw new Error('expected rich');
    expect(out.payload.value).toEqual({ label: '  日本語  ' });
  });

  it('does not look up the index from settings_str — labels go through verbatim', () => {
    // §5.3 step 3 says the CLI emits {label: ...} for label input
    // and {index: N} for numeric input. It does NOT traverse the
    // column's settings_str to translate the label to its stable
    // index server-side. A future contributor who adds that
    // lookup would need to plumb settings_str through this
    // function — and at that point the choice between "send
    // label, let Monday resolve" vs "send index, faster but stale
    // on rename" becomes a design call, not a refactor.
    // Pinned by the absence of any settings dependency: this
    // assertion just verifies the input column shape doesn't
    // need it.
    const out = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Working on it',
    });
    if (out.payload.format !== 'rich') throw new Error('expected rich');
    expect(out.payload.value).toEqual({ label: 'Working on it' });
  });
});

describe('translateColumnValue — dropdown (rich)', () => {
  it('single label → {labels: ["Backend"]} (still an array)', () => {
    const out = translate('dropdown', 'Backend', 'tags');
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'tags',
      columnType: 'dropdown',
      rawInput: 'Backend',
      payload: { format: 'rich', value: { labels: ['Backend'] } },
    });
  });

  it('comma-split labels → {labels: [...]} preserving order', () => {
    const out = translate('dropdown', 'Backend,Frontend,Infra');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { labels: ['Backend', 'Frontend', 'Infra'] },
    });
  });

  it('trims whitespace around each segment', () => {
    const out = translate('dropdown', ' Backend , Frontend ');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { labels: ['Backend', 'Frontend'] },
    });
  });

  it('drops empty segments from a sloppy comma-list', () => {
    // "Backend,,Frontend" should still produce a clean two-label
    // payload — one stray comma is a typo, not a third unnamed
    // label. Pinned so a future "preserve everything" contributor
    // doesn't silently send {labels: ["Backend", "", "Frontend"]}
    // which Monday would 200 + validation_failed.
    const out = translate('dropdown', 'Backend,,Frontend');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { labels: ['Backend', 'Frontend'] },
    });
  });

  it('all-numeric input → {ids: [N1, N2]} (numbers, not strings)', () => {
    const out = translate('dropdown', '1,2,3');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { ids: [1, 2, 3] },
    });
    if (out.payload.format !== 'rich') throw new Error('expected rich');
    const ids = out.payload.value.ids as readonly unknown[];
    expect(ids.every((n) => typeof n === 'number')).toBe(true);
  });

  it('single numeric input → {ids: [N]}', () => {
    const out = translate('dropdown', '7');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { ids: [7] },
    });
  });

  it('mixed numeric + label input → labels path (numeric segment becomes a label string)', () => {
    // Disambiguation rule: ALL segments must be numeric to take
    // the ids path. A single non-numeric segment routes to
    // labels — including the would-be-numeric segments, as
    // strings. Pinned because the cleanest alternative ("filter
    // numerics into ids, keep labels in labels") would require
    // emitting both `ids` and `labels` in the same payload, and
    // Monday's dropdown column doesn't accept that shape.
    const out = translate('dropdown', '1,Backend');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { labels: ['1', 'Backend'] },
    });
  });

  it('empty input throws usage_error (use `item clear` to clear)', () => {
    expect(() => translate('dropdown', '', 'tags')).toThrow(UsageError);
    try {
      translate('dropdown', '', 'tags');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      // `usage_error` is the documented exit-1 code; pin via the
      // typed error's `.code` field, not the message string.
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_id: 'tags',
        column_type: 'dropdown',
        raw_input: '',
      });
    }
  });

  it('whitespace-only / commas-only input throws usage_error', () => {
    expect(() => translate('dropdown', ' , ,  ', 'tags')).toThrow(UsageError);
  });

  it('numeric label collision known limitation: literal "1" parses as id', () => {
    // A dropdown label literally named "1" cannot be set via the
    // friendly translator — `--set tags=1` resolves to {ids: [1]}.
    // Pinned so the limitation is loud, not silent: agents who
    // hit it use --set-raw to bypass.
    const out = translate('dropdown', '1');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { ids: [1] },
    });
  });
});

describe('translateColumnValue — allowlisted but not yet implemented (M5a follow-ups)', () => {
  // date / people remain in the v0.1 writable allowlist but their
  // translation logic ships in follow-up sessions. Until then they
  // surface as `unsupported_column_type` — same code, same shape —
  // so callers see one contract.
  it.each<[WritableColumnType, string]>([
    ['date', '2026-05-01'],
    ['people', 'alice@example.test'],
  ])('%s → unsupported_column_type until follow-up sessions land', (type, value) => {
    expect(() => translate(type, value, 'col_x')).toThrow(ApiError);
    try {
      translate(type, value, 'col_x');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('unsupported_column_type');
      expect(err.details).toMatchObject({
        column_id: 'col_x',
        type,
        set_raw_example: `--set-raw col_x='<json>'`,
      });
    }
  });
});

describe('translateColumnValue — non-allowlisted types', () => {
  it.each([
    'mirror',
    'formula',
    'battery',
    'item_assignees',
    'time_tracking',
    'auto_number',
    'creation_log',
    'last_updated',
    'phone',
    'rating',
  ])('%s → unsupported_column_type with column_id + type + --set-raw example', (type) => {
    expect(() => translate(type, 'whatever', 'col_z')).toThrow(
      /not in the v0.1/u,
    );
    try {
      translate(type, 'whatever', 'col_z');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('unsupported_column_type');
      expect(err.details).toMatchObject({
        column_id: 'col_z',
        type,
        set_raw_example: `--set-raw col_z='<json>'`,
        // The hint must point an agent at Monday's docs without
        // pretending to know the exact shape — see the module
        // header for why we don't stub a per-type guess here.
        hint: expect.stringContaining('--set-raw') as unknown,
      });
    }
  });

  it('empty-string type still surfaces unsupported_column_type, not a crash', () => {
    // Defensive: if M3's metadata loader ever produces a column
    // with `type: ""` (legacy boards have produced empty strings on
    // archived columns), we still surface a stable code rather
    // than letting the switch fall through to a TypeError.
    expect(() => translate('', 'value', 'col_a')).toThrow(ApiError);
  });
});

describe('unsupportedColumnTypeError', () => {
  it('builds an ApiError with the documented details shape', () => {
    const err = unsupportedColumnTypeError('col_42', 'mirror');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('unsupported_column_type');
    expect(err.retryable).toBe(false);
    expect(err.details).toMatchObject({
      column_id: 'col_42',
      type: 'mirror',
      set_raw_example: `--set-raw col_42='<json>'`,
    });
  });

  it('does not leak a column-id with an unescaped quote — agents read this verbatim', () => {
    // The example is cosmetic but the column-id appears inside a
    // single-quoted shell context. If a future column ID ever
    // contains a `'` (Monday IDs are snake_case so today this is
    // moot), the example would mislead. Pin the current behaviour
    // so a regression is loud rather than silent — if Monday ever
    // allows quoted IDs, this test is the trigger to add escaping.
    const err = unsupportedColumnTypeError("o'brien_col", 'mirror');
    expect(err.details?.set_raw_example).toBe(`--set-raw o'brien_col='<json>'`);
  });
});
