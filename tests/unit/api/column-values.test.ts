import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/utils/errors.js';
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

describe('translateColumnValue — allowlisted but not yet implemented (M5a follow-ups)', () => {
  // status / dropdown / date / people are in the v0.1 writable
  // allowlist but their translation logic ships in follow-up
  // sessions. Until then they surface as `unsupported_column_type`
  // — same code, same shape — so callers see one contract.
  it.each<[WritableColumnType, string]>([
    ['status', 'Done'],
    ['dropdown', 'Backend,Frontend'],
    ['date', '2026-05-01'],
    ['people', 'alice@example.test'],
  ])('%s → unsupported_column_type until rich types land', (type, value) => {
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
