import { describe, expect, it } from 'vitest';
import { ApiError, UsageError } from '../../../src/utils/errors.js';
import {
  selectMutation,
  translateColumnValue,
  translateColumnValueAsync,
  unsupportedColumnTypeError,
  type ColumnValuePayload,
  type SelectedMutation,
  type TranslatedColumnValue,
} from '../../../src/api/column-values.js';

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
      resolvedFrom: null,
      peopleResolution: null,
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
      resolvedFrom: null,
      peopleResolution: null,
    });
  });

  it('numbers → stringified-numeric pass-through (Monday quirk)', () => {
    const out = translate('numbers', '42');
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'col_1',
      columnType: 'numbers',
      rawInput: '42',
      payload: { format: 'simple', value: '42' },
      resolvedFrom: null,
      peopleResolution: null,
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
      resolvedFrom: null,
      peopleResolution: null,
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

  it('numeric index outside JS safe-integer range → usage_error (no silent precision loss)', () => {
    // Codex review pass-1 finding F1, status side. Same story as
    // dropdown: Number("99...9") rounds past 2^53 - 1 and yields
    // Infinity for ~310+ digit strings. Either case lands at
    // Monday as the wrong number or null. Pin via test that the
    // unsafe path throws rather than silently sending corruption.
    const huge = '9'.repeat(20);
    expect(() => translate('status', huge, 'project_status')).toThrow(UsageError);
    expect(() => translate('status', huge, 'project_status')).toThrow(
      /exceeds JavaScript's safe-integer range/u,
    );
    try {
      translate('status', huge, 'project_status');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_id: 'project_status',
        column_type: 'status',
        raw_input: huge,
      });
    }
  });

  it('status index at MAX_SAFE_INTEGER boundary still works → index path', () => {
    const max = String(Number.MAX_SAFE_INTEGER);
    const out = translate('status', max, 'project_status');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { index: Number.MAX_SAFE_INTEGER },
    });
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
      resolvedFrom: null,
      peopleResolution: null,
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
    // Per testing.md: assert both type AND message — both are part
    // of the contract surface agents rely on for debugging.
    expect(() => translate('dropdown', '', 'tags')).toThrow(UsageError);
    expect(() => translate('dropdown', '', 'tags')).toThrow(
      /needs at least one label or numeric ID/u,
    );
    expect(() => translate('dropdown', '', 'tags')).toThrow(
      /monday item clear <iid> tags/u,
    );
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

  it('clear-hint uses placeholder `<iid>` since translator does not know item ID', () => {
    // Codex review pass-1 finding F2: the helper has no access to
    // the item ID an agent is trying to update. Pinning the
    // placeholder shape so a future "personalised hint" refactor
    // doesn't substitute something that looks like a real ID.
    try {
      translate('dropdown', '', 'tags');
      throw new Error('expected throw');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.message).toContain('monday item clear <iid> tags');
      expect(err.message).toContain('[--board <bid>]');
    }
  });

  it('whitespace-only / commas-only input throws usage_error with the same shape', () => {
    expect(() => translate('dropdown', ' , ,  ', 'tags')).toThrow(UsageError);
    expect(() => translate('dropdown', ' , ,  ', 'tags')).toThrow(
      /needs at least one label or numeric ID/u,
    );
    try {
      translate('dropdown', ' , ,  ', 'tags');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_id: 'tags',
        column_type: 'dropdown',
        raw_input: ' , ,  ',
      });
    }
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

  it('numeric ID outside JS safe-integer range → usage_error (no silent precision loss)', () => {
    // Codex review pass-1 finding F1: `Number("99...9")` either
    // rounds (for inputs > 2^53 - 1) or yields Infinity (for very
    // long digit strings, ~310+ chars). JSON.stringify(Infinity)
    // is "null", so the wire would land at Monday as
    // `{"ids":[null]}` — a worse failure mode than a typed local
    // error. Bound the input through Number.isSafeInteger; throw
    // usage_error for unsafe input.
    const huge = '9'.repeat(20); // 20-digit number well past 2^53
    expect(() => translate('dropdown', huge, 'tags')).toThrow(UsageError);
    expect(() => translate('dropdown', huge, 'tags')).toThrow(
      /exceeds JavaScript's safe-integer range/u,
    );
    try {
      translate('dropdown', huge, 'tags');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_id: 'tags',
        column_type: 'dropdown',
        raw_input: huge,
      });
    }
  });

  it('numeric ID at MAX_SAFE_INTEGER boundary still works → ids path', () => {
    // The boundary is 2^53 - 1 = 9007199254740991. One more would
    // throw; pin both sides of the boundary so a future refactor
    // (e.g. switching to BigInt) doesn't silently shift it.
    const max = String(Number.MAX_SAFE_INTEGER);
    const out = translate('dropdown', max, 'tags');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { ids: [Number.MAX_SAFE_INTEGER] },
    });
  });

  it('one safe + one unsafe ID in mixed input still throws (with the safe-integer message)', () => {
    // The all-numeric branch maps each segment; the first unsafe
    // segment short-circuits with usage_error. Pinned so a future
    // "filter unsafe and continue" refactor surfaces loudly. The
    // message regex is the same one the standalone unsafe-ID test
    // uses so a wrong usage_error path (e.g. an empty-input throw
    // happening to fire on the same input) cannot satisfy this
    // assertion. Codex review pass-2 finding.
    const huge = '9'.repeat(20);
    expect(() => translate('dropdown', `1,${huge}`, 'tags')).toThrow(UsageError);
    expect(() => translate('dropdown', `1,${huge}`, 'tags')).toThrow(
      /exceeds JavaScript's safe-integer range/u,
    );
  });
});

describe('translateColumnValue — date (rich)', () => {
  // The full grammar lives in tests/unit/api/dates.test.ts —
  // here we just pin the column-values.ts surface contract:
  // the translator delegates to dates.parseDateInput, populates
  // the resolvedFrom slot for relative tokens, and leaves it
  // null for explicit ISO inputs. The DST + tz coverage is in
  // dates.test.ts to keep concerns separated.

  it('ISO date → rich payload, null resolvedFrom', () => {
    const out = translateColumnValue({
      column: { id: 'due', type: 'date' },
      value: '2026-05-01',
    });
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'due',
      columnType: 'date',
      rawInput: '2026-05-01',
      payload: { format: 'rich', value: { date: '2026-05-01' } },
      resolvedFrom: null,
      peopleResolution: null,
    });
  });

  it('ISO date+time → rich payload with {date, time}', () => {
    const out = translateColumnValue({
      column: { id: 'due', type: 'date' },
      value: '2026-05-01T14:30',
    });
    if (out.payload.format !== 'rich') throw new Error('expected rich');
    expect(out.payload.value).toEqual({ date: '2026-05-01', time: '14:30:00' });
    expect(out.resolvedFrom).toBeNull();
  });

  it('relative token with injected clock + tz populates resolvedFrom', () => {
    const now = (): Date => new Date('2026-04-29T13:00:00Z');
    const out = translateColumnValue({
      column: { id: 'due', type: 'date' },
      value: '+3d',
      dateResolution: { now, timezone: 'Europe/London' },
    });
    if (out.payload.format !== 'rich') throw new Error('expected rich');
    expect(out.payload.value).toEqual({ date: '2026-05-02' });
    expect(out.resolvedFrom).toEqual({
      input: '+3d',
      timezone: 'Europe/London',
      now: '2026-04-29T14:00:00+01:00',
    });
  });

  it('garbled input throws usage_error from the date parser', () => {
    expect(() =>
      translateColumnValue({
        column: { id: 'due', type: 'date' },
        value: 'next thursday',
      }),
    ).toThrow(UsageError);
  });

  it('non-date column ignores dateResolution silently', () => {
    // The dateResolution slot is type-agnostic on the input
    // surface; non-date columns should not even read it. Pin
    // via test that passing a context to a `text` column has
    // no effect on the payload.
    const out = translateColumnValue({
      column: { id: 'notes', type: 'text' },
      value: 'hi',
      dateResolution: {
        now: () => new Date('2026-04-29T13:00:00Z'),
        timezone: 'Pacific/Auckland',
      },
    });
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'simple',
      value: 'hi',
    });
    expect(out.resolvedFrom).toBeNull();
  });
});

describe('translateColumnValue — sync entry on a people column', () => {
  // People resolution is async (email→ID lookup hits the
  // directory cache or `users(emails:)`). The sync entry point
  // throws `internal_error` rather than `unsupported_column_type`
  // because people IS in the v0.1 allowlist — the failure mode
  // is "wrong entry point" not "type not supported". M5b's
  // command layer always uses translateColumnValueAsync; this
  // throw exists so a future contributor who wires sync sees
  // the loud error instead of silent payload corruption.
  it('routes people through internal_error with a hint to use the async entry', () => {
    expect(() => translate('people', 'alice@example.test', 'col_x')).toThrow(ApiError);
    try {
      translate('people', 'alice@example.test', 'col_x');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('internal_error');
      expect(err.message).toMatch(/translateColumnValueAsync/u);
      expect(err.details).toMatchObject({
        column_id: 'col_x',
        column_type: 'people',
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

// =============================================================================
// selectMutation — cli-design.md §5.3 step 5 dispatch
// =============================================================================

describe('selectMutation — single value', () => {
  // Wire-shape fixtures for the single-value paths. Pinning the
  // exact `kind` + field shape per simple/rich category — M5b's
  // command layer threads these directly into the SDK call.

  it('1 simple value → change_simple_column_value (bare-string value)', () => {
    const t = translateColumnValue({
      column: { id: 'notes', type: 'text' },
      value: 'Refactor login',
    });
    const out = selectMutation([t]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_simple_column_value',
      columnId: 'notes',
      value: 'Refactor login',
    });
  });

  it('1 simple long_text → change_simple_column_value (still bare string here)', () => {
    // Pinning the contrast with the multi case: in the *single*
    // path, long_text uses the bare string Monday's
    // change_simple_column_value(value: String!) accepts. The
    // {text: ...} re-wrap only kicks in when bundled into the
    // multi mutation (different signature accepts both shapes,
    // and rejects the bare string for long_text).
    const t = translateColumnValue({
      column: { id: 'description', type: 'long_text' },
      value: 'multi\nline',
    });
    const out = selectMutation([t]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_simple_column_value',
      columnId: 'description',
      value: 'multi\nline',
    });
  });

  it('1 simple numbers → change_simple_column_value', () => {
    const t = translateColumnValue({
      column: { id: 'estimate', type: 'numbers' },
      value: '42',
    });
    const out = selectMutation([t]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_simple_column_value',
      columnId: 'estimate',
      value: '42',
    });
  });

  it('1 rich status (label) → change_column_value with object value', () => {
    const t = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Done',
    });
    const out = selectMutation([t]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_column_value',
      columnId: 'status_4',
      value: { label: 'Done' },
    });
  });

  it('1 rich status (index) → change_column_value with {index: N}', () => {
    const t = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: '2',
    });
    const out = selectMutation([t]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_column_value',
      columnId: 'status_4',
      value: { index: 2 },
    });
  });

  it('1 rich dropdown (labels) → change_column_value with {labels: [...]}', () => {
    const t = translateColumnValue({
      column: { id: 'tags', type: 'dropdown' },
      value: 'Backend,Frontend',
    });
    const out = selectMutation([t]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_column_value',
      columnId: 'tags',
      value: { labels: ['Backend', 'Frontend'] },
    });
  });

  it('1 rich dropdown (ids) → change_column_value with {ids: [...]}', () => {
    const t = translateColumnValue({
      column: { id: 'tags', type: 'dropdown' },
      value: '1,2',
    });
    const out = selectMutation([t]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_column_value',
      columnId: 'tags',
      value: { ids: [1, 2] },
    });
  });
});

describe('selectMutation — multi value (change_multiple_column_values)', () => {
  // The multi mutation's `column_values` map projects each
  // translated value to a string (simple text/numbers) or an
  // object (rich + long_text re-wrap). Pinning per-cell wire
  // shape so M5b inherits an identical contract.

  it('2 simple values (text + numbers) → bare strings in the column_values map', () => {
    const text = translateColumnValue({
      column: { id: 'notes', type: 'text' },
      value: 'hi',
    });
    const numbers = translateColumnValue({
      column: { id: 'estimate', type: 'numbers' },
      value: '5',
    });
    const out = selectMutation([text, numbers]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_multiple_column_values',
      columnValues: {
        notes: 'hi',
        estimate: '5',
      },
    });
  });

  it('long_text inside multi → re-wrapped as {text: <value>} (spec gap, pinned)', () => {
    // The single-value path passes long_text through as a bare
    // string; the multi-value path wraps it as {text: ...}. This
    // is a wire-shape divergence imposed by Monday's
    // change_multiple_column_values signature: per-column blob is
    // string-or-object, and long_text's per-column blob is the
    // object form. Pinned via fixture so M5b's bulk surface and
    // v0.2 inherit the wrap unchanged. cli-design.md §5.3 step 5
    // doesn't call this out — surfaced as a spec gap in
    // v0.1-plan.md §3 M5a.
    const text = translateColumnValue({
      column: { id: 'notes', type: 'text' },
      value: 'hi',
    });
    const longText = translateColumnValue({
      column: { id: 'description', type: 'long_text' },
      value: 'paragraph\nwith\nnewlines',
    });
    const out = selectMutation([text, longText]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_multiple_column_values',
      columnValues: {
        notes: 'hi',
        description: { text: 'paragraph\nwith\nnewlines' },
      },
    });
  });

  it('mixed simple + rich → bare strings + objects keyed by column id', () => {
    const text = translateColumnValue({
      column: { id: 'notes', type: 'text' },
      value: 'hi',
    });
    const status = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Done',
    });
    const dropdown = translateColumnValue({
      column: { id: 'tags', type: 'dropdown' },
      value: 'Backend',
    });
    const out = selectMutation([text, status, dropdown]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_multiple_column_values',
      columnValues: {
        notes: 'hi',
        status_4: { label: 'Done' },
        tags: { labels: ['Backend'] },
      },
    });
  });

  it('two rich values → both objects in the same map (no shape merge)', () => {
    const status = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Done',
    });
    const dropdown = translateColumnValue({
      column: { id: 'tags', type: 'dropdown' },
      value: '1,2',
    });
    const out = selectMutation([status, dropdown]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_multiple_column_values',
      columnValues: {
        status_4: { label: 'Done' },
        tags: { ids: [1, 2] },
      },
    });
  });

  it('preserves caller-supplied order in the map insertion order', () => {
    // JS objects preserve insertion order for string keys — pinning
    // that the helper iterates `translated` in caller order so the
    // dry-run renderer's column-by-column diff list matches the
    // `--set` flag order the agent passed.
    const a = translateColumnValue({
      column: { id: 'b_col', type: 'text' },
      value: 'beta',
    });
    const b = translateColumnValue({
      column: { id: 'a_col', type: 'text' },
      value: 'alpha',
    });
    const out = selectMutation([a, b]);
    if (out.kind !== 'change_multiple_column_values') {
      throw new Error('expected multi');
    }
    expect(Object.keys(out.columnValues)).toEqual(['b_col', 'a_col']);
  });
});

describe('selectMutation — error paths', () => {
  it('throws usage_error when called with an empty list', () => {
    expect(() => selectMutation([])).toThrow(UsageError);
    expect(() => selectMutation([])).toThrow(
      /at least one translated column value/u,
    );
    try {
      selectMutation([]);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({ translated_count: 0 });
    }
  });

  it('throws usage_error when two translated values share a column id', () => {
    // Bundling two `--set status=...` values would give the
    // change_multiple_column_values map last-write-wins
    // semantics; the agent has no way to know which one Monday
    // applied. Surfacing as usage_error at the bundling boundary
    // forces M5b's command layer to reject the duplicate before
    // the mutation goes out.
    const a = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Done',
    });
    const b = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Doing',
    });
    expect(() => selectMutation([a, b])).toThrow(UsageError);
    expect(() => selectMutation([a, b])).toThrow(
      /Multiple --set values target column "status_4"/u,
    );
    try {
      selectMutation([a, b]);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_id: 'status_4',
        duplicate_count: 2,
      });
    }
  });

  it('counts all duplicates of a colliding column id, not just the second', () => {
    const a = translateColumnValue({
      column: { id: 'tags', type: 'text' },
      value: 'a',
    });
    const b = translateColumnValue({
      column: { id: 'tags', type: 'text' },
      value: 'b',
    });
    const c = translateColumnValue({
      column: { id: 'tags', type: 'text' },
      value: 'c',
    });
    try {
      selectMutation([a, b, c]);
      throw new Error('expected throw');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.details).toMatchObject({ duplicate_count: 3 });
    }
  });
});

describe('selectMutation — JSON scalar discipline (no double-stringification)', () => {
  // Anti-regression: it would be tempting for a future contributor
  // to JSON.stringify the rich payloads "for the wire". That's
  // wrong — graphql-request stringifies at the boundary, and a
  // double-stringified payload would arrive at Monday as the
  // literal string `'{"label":"Done"}'` (with quotes), which the
  // GraphQL JSON scalar would then accept as a JSON-encoded string
  // and fail validation. Pin per category.

  it('change_column_value rich value is a plain JS object, not a JSON string', () => {
    const t = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Done',
    });
    const out = selectMutation([t]);
    if (out.kind !== 'change_column_value') throw new Error('expected single rich');
    expect(typeof out.value).toBe('object');
    expect(out.value).not.toBeInstanceOf(String);
  });

  it('multi columnValues entries are bare strings or plain objects, never JSON strings', () => {
    const text = translateColumnValue({
      column: { id: 'notes', type: 'text' },
      value: 'hi',
    });
    const status = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Done',
    });
    const out = selectMutation([text, status]);
    if (out.kind !== 'change_multiple_column_values') throw new Error('expected multi');
    expect(out.columnValues.notes).toBe('hi');
    expect(out.columnValues.notes).not.toMatch(/^"/u);
    const richEntry = out.columnValues.status_4;
    expect(typeof richEntry).toBe('object');
    expect(richEntry).toEqual({ label: 'Done' });
  });
});

describe('translateColumnValueAsync — surface contract', () => {
  // The async entry point is a thin wrapper: delegates to the sync
  // translator for non-people types, dispatches to parsePeopleInput
  // for people. The full people grammar lives in
  // tests/unit/api/people.test.ts — here we just pin the
  // column-values.ts surface contract: dispatch, peopleResolution
  // wiring, and the TranslatedColumnValue shape for people output.

  it('non-people column delegates to the sync translator (text → simple payload)', async () => {
    const out = await translateColumnValueAsync({
      column: { id: 'notes', type: 'text' },
      value: 'Refactor login',
    });
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'notes',
      columnType: 'text',
      rawInput: 'Refactor login',
      payload: { format: 'simple', value: 'Refactor login' },
      resolvedFrom: null,
      peopleResolution: null,
    });
  });

  it('non-people column delegates to the sync translator (date → rich payload)', async () => {
    const out = await translateColumnValueAsync({
      column: { id: 'due', type: 'date' },
      value: '2026-05-01',
    });
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { date: '2026-05-01' },
    });
    expect(out.resolvedFrom).toBeNull();
  });

  it('people column with peopleResolution → rich personsAndTeams payload', async () => {
    const out = await translateColumnValueAsync({
      column: { id: 'owner', type: 'people' },
      value: 'alice@example.com',
      peopleResolution: {
        resolveMe: () => Promise.resolve('999'),
        resolveEmail: (_email: string) => Promise.resolve('42'),
      },
    });
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'owner',
      columnType: 'people',
      rawInput: 'alice@example.com',
      payload: {
        format: 'rich',
        value: { personsAndTeams: [{ id: 42, kind: 'person' }] },
      },
      resolvedFrom: null,
      peopleResolution: {
        tokens: [{ input: 'alice@example.com', resolved_id: '42' }],
      },
    });
  });

  it('people column without peopleResolution → internal_error with a wiring hint', async () => {
    // Programmer wiring bug: M5b's command layer always passes the
    // resolution context; missing it is a code-path regression we
    // want loud. Pin the error code + message regex so a refactor
    // that swaps to a silent fallback fires the test.
    await expect(
      translateColumnValueAsync({
        column: { id: 'owner', type: 'people' },
        value: 'alice@example.com',
      }),
    ).rejects.toThrow(ApiError);
    try {
      await translateColumnValueAsync({
        column: { id: 'owner', type: 'people' },
        value: 'alice@example.com',
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('internal_error');
      expect(err.message).toMatch(/peopleResolution/u);
      expect(err.details).toMatchObject({
        column_id: 'owner',
        column_type: 'people',
      });
    }
  });

  it('non-people column ignores peopleResolution silently (parity with dateResolution)', async () => {
    // The peopleResolution slot is type-agnostic on the input
    // surface; non-people columns should not even read it. Pin
    // via test that passing a context to a `text` column has no
    // effect on the payload.
    const out = await translateColumnValueAsync({
      column: { id: 'notes', type: 'text' },
      value: 'hi',
      peopleResolution: {
        resolveMe: () => Promise.reject(new Error('should not be called')),
        resolveEmail: () => Promise.reject(new Error('should not be called')),
      },
    });
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'simple',
      value: 'hi',
    });
  });

  it('selectMutation accepts a people-translated value and emits change_column_value', async () => {
    // Pinning that the people TranslatedColumnValue threads through
    // the existing selectMutation dispatch unchanged — it's a rich
    // payload, so single → change_column_value with the object.
    const t = await translateColumnValueAsync({
      column: { id: 'owner', type: 'people' },
      value: 'alice@example.com',
      peopleResolution: {
        resolveMe: () => Promise.resolve('999'),
        resolveEmail: () => Promise.resolve('42'),
      },
    });
    const out = selectMutation([t]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_column_value',
      columnId: 'owner',
      value: { personsAndTeams: [{ id: 42, kind: 'person' }] },
    });
  });

  it('selectMutation bundles people alongside other rich types (multi)', async () => {
    const status = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Done',
    });
    const people = await translateColumnValueAsync({
      column: { id: 'owner', type: 'people' },
      value: 'me',
      peopleResolution: {
        resolveMe: () => Promise.resolve('7'),
        resolveEmail: () => Promise.reject(new Error('should not be called')),
      },
    });
    const out = selectMutation([status, people]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_multiple_column_values',
      columnValues: {
        status_4: { label: 'Done' },
        owner: { personsAndTeams: [{ id: 7, kind: 'person' }] },
      },
    });
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
