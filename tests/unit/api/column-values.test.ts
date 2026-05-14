import { describe, expect, it } from 'vitest';
import { ApiError, UsageError } from '../../../src/utils/errors.js';
import {
  bundleColumnValues,
  selectMutation,
  translateColumnClear,
  translateColumnValue,
  translateColumnValueAsync,
  unsupportedColumnTypeError,
  type ColumnValuePayload,
  type SelectedMutation,
  type TranslatedColumnValue,
} from '../../../src/api/column-values.js';
import { translateRawColumnValue } from '../../../src/api/raw-write.js';

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
      tagResolution: null,
      relationResolution: null,
      translatorResolution: null,
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
      tagResolution: null,
      relationResolution: null,
      translatorResolution: null,
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
      tagResolution: null,
      relationResolution: null,
      translatorResolution: null,
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
      tagResolution: null,
      relationResolution: null,
      translatorResolution: null,
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
      tagResolution: null,
      relationResolution: null,
      translatorResolution: null,
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
    // Pinned so the limitation is loud, not silent. The M8
    // --set-raw escape hatch is the workaround.
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
      tagResolution: null,
      relationResolution: null,
      translatorResolution: null,
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

describe('translateColumnValue — async-only column types (sync entry guards)', () => {
  // M19 graduates the full v0.2 tentative row (`tags` Commit 2,
  // `board_relation` Commit 3, `dependency` Commit 4) into the
  // friendly allowlist via the async entry point. Calling the SYNC
  // translator on any of these surfaces a programmer-error
  // `internal_error` with a hint pointing at translateColumnValueAsync.
  // These tests pin the guard so a future regression that wires an
  // async-only type through the sync entry fires loud, not silent.
  it.each([
    ['tags', 'launch', 'tags_1'],
    ['board_relation', '12345', 'rel_1'],
    ['dependency', '12345', 'dep_1'],
  ])(
    '%s (sync entry) → internal_error with a hint to use the async entry',
    (type, value, columnId) => {
      expect(() => translate(type, value, columnId)).toThrow(ApiError);
      try {
        translate(type, value, columnId);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        expect(err.code).toBe('internal_error');
        expect(err.message).toMatch(/translateColumnValueAsync/u);
        expect(err.details).toMatchObject({
          column_id: columnId,
          column_type: type,
        });
      }
    },
  );
});

describe('translateColumnValue — read-only-forever types', () => {
  // Codex M5b cleanup re-review #1: types Monday computes server-
  // side and never makes writable via the API (mirror / formula /
  // auto_number / creation_log / last_updated / item_id) get
  // `read_only: true` instead of `deferred_to`. Pre-fix the error
  // blanket-deferred them to v0.2, falsely promising agents a
  // future write path that will never exist. cli-design.md §5.3
  // writer-expansion roadmap "read-only forever" row pins this.
  // M16 pre-flight (cli-design §4.3 column-create) extended the row
  // to include `item_assignees` (Monday computes it server-side from
  // people columns; never writable via the API).
  it.each([
    'mirror',
    'formula',
    'auto_number',
    'creation_log',
    'last_updated',
    'item_id',
    'item_assignees',
  ])('%s → unsupported_column_type with read_only: true (no v0.2 promise)', (type) => {
    expect(() => translate(type, 'whatever', 'col_z')).toThrow(
      /computed by Monday|not.*writable.*via the API/u,
    );
    try {
      translate(type, 'whatever', 'col_z');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('unsupported_column_type');
      expect(err.details).toMatchObject({
        column_id: 'col_z',
        type,
        read_only: true,
      });
      // Negative regression pins. The whole point of the split is
      // that read-only types must NOT advertise a future write path.
      expect(err.details).not.toHaveProperty('deferred_to');
      expect(err.details).not.toHaveProperty('set_raw_example');
      expect(err.message).not.toMatch(/v0\.2/u);
      expect(err.message).not.toMatch(/--set-raw/u);
      expect(err.message).not.toMatch(/Use --set-raw/u);
    }
  });
});

describe('translateColumnValue — future-roadmap types', () => {
  // Codex M5b cleanup re-review #1: types not in v0.1, not on the
  // v0.2/v0.3 writer-expansion roadmap, and not read-only-forever
  // (battery / rating / etc.) fall into the generic "future" branch.
  // The error advertises future coverage without committing to a
  // specific version. Pinned column types from cli-design §5.3
  // writer-expansion roadmap have their own branches:
  //   - `time_tracking` → `deferred_to: "v0.3"` (start/stop verbs)
  //   - `file` (files-shaped) → `deferred_to: "v0.5"` (the verb-shaped
  //     `monday item upload` shipped at v0.4-M31; the friendly --set
  //     form for file columns slipped from v0.4 to v0.5 at release-prep)
  // Both are tested in the dedicated describe blocks below.
  // M16 pre-flight reclassified `item_assignees` as read-only-forever.
  it.each([
    'battery',
    'rating',
  ])('%s → unsupported_column_type with deferred_to: future', (type) => {
    expect(() => translate(type, 'whatever', 'col_z')).toThrow(
      /not in the friendly --set translator allowlist/u,
    );
    try {
      translate(type, 'whatever', 'col_z');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('unsupported_column_type');
      expect(err.details).toMatchObject({
        column_id: 'col_z',
        type,
        deferred_to: 'future',
      });
      // Negative pins.
      expect(err.details).not.toHaveProperty('set_raw_example');
      expect(err.details).not.toHaveProperty('read_only');
      expect(err.message).not.toMatch(/Use --set-raw/u);
    }
  });

  it('time_tracking → unsupported_column_type with deferred_to: "v0.3" + verb-pointing hint (M20)', () => {
    // cli-design §5.3 writer-expansion roadmap row: time_tracking
    // uses start/stop verbs, not value writes. Pinned as a v0.3
    // candidate. M18 round-2 special-cased it; M20 sharpened the
    // hint to point at the documentation-only verbs (registered at
    // M20 implementation, throwing `usage_error` until Monday's API
    // ships time_tracking writes — probed 2026-05-10).
    expect(() => translate('time_tracking', 'whatever', 'col_z')).toThrow(
      /start\/stop verbs/u,
    );
    try {
      translate('time_tracking', 'whatever', 'col_z');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('unsupported_column_type');
      expect(err.details).toMatchObject({
        column_id: 'col_z',
        type: 'time_tracking',
        deferred_to: 'v0.3',
      });
      // M20 verb-pointing hint: names the start + stop verbs by
      // their documented argv shape so an agent reading the hint
      // has a copy-pasteable next command, plus the
      // documentation-only caveat so the agent knows the verbs
      // currently throw rather than silently failing.
      const hint = err.details?.hint as string;
      expect(hint).toMatch(/monday item time-track start/u);
      expect(hint).toMatch(/monday item time-track stop/u);
      expect(hint).toMatch(/forward-compatibility/u);
      expect(hint).toMatch(/2026-05-10/u);
    }
  });

  it('file (files-shaped) → unsupported_column_type with deferred_to: "v0.5" (Codex M18 round-2 P2; slipped from v0.4 at v0.4 release-prep — `monday item upload` (v0.4-M31) is the alternative path agents should use today)', () => {
    // cli-design §5.3 writer-expansion roadmap row: files-shaped
    // types use add_file_to_column (multipart upload). Pinned as
    // a v0.4 deferral originally; v0.4-M31 shipped the verb-shaped
    // path (`monday item upload`) but NOT the friendly `--set` form
    // for files (the translator boundary doesn't dispatch into the
    // multipart wire). The slot slipped to v0.5 at v0.4 release-prep
    // so v0.4.0 agents don't read `deferred_to: "v0.4"` on the
    // release they're already running.
    expect(() => translate('file', 'whatever', 'col_z')).toThrow(
      /add_file_to_column/u,
    );
    try {
      translate('file', 'whatever', 'col_z');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('unsupported_column_type');
      expect(err.details).toMatchObject({
        column_id: 'col_z',
        type: 'file',
        deferred_to: 'v0.5',
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
      tagResolution: null,
      relationResolution: null,
      translatorResolution: null,
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
        resolveEmail: (_email: string) =>
          Promise.resolve({ id: '42', source: 'live', cacheAgeSeconds: null }),
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
      tagResolution: null,
      relationResolution: null,
      // M19→M20 cleanup-window: people translator threads source/age
      // from resolveEmail through translatorResolution. This stub
      // returns `source: 'live', cacheAgeSeconds: null`, so the
      // aggregated leg is `'live'` (single-token input). Cache-hit
      // paths surface as `'cache'` / `'mixed'` per the source-
      // aggregation tests below + the integration cassette.
      translatorResolution: { source: 'live', cacheAgeSeconds: null },
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

  it('cache-hit email resolution surfaces translatorResolution: { source: "cache", cacheAgeSeconds: <age> } (M19→M20 parity fix)', async () => {
    // Closes the v0.3-plan §11 M19 post-mortem parity gap. Pre-fix
    // the translator emitted translatorResolution: null and cache
    // hits silently dropped from envelope-level meta.source. Post-
    // fix the people translator threads the parsePeopleInput
    // aggregate through, so a cache-served userByEmail leg lands
    // in the envelope merge.
    const out = await translateColumnValueAsync({
      column: { id: 'owner', type: 'people' },
      value: 'alice@example.com',
      peopleResolution: {
        resolveMe: () => Promise.reject(new Error('unused')),
        resolveEmail: () =>
          Promise.resolve({ id: '42', source: 'cache', cacheAgeSeconds: 60 }),
      },
    });
    expect(out.translatorResolution).toEqual({
      source: 'cache',
      cacheAgeSeconds: 60,
    });
  });

  it('mixed me + cache email translator resolution surfaces source: "mixed"', async () => {
    const out = await translateColumnValueAsync({
      column: { id: 'owner', type: 'people' },
      value: 'me,alice@example.com',
      peopleResolution: {
        resolveMe: () => Promise.resolve('7'),
        resolveEmail: () =>
          Promise.resolve({ id: '42', source: 'cache', cacheAgeSeconds: 30 }),
      },
    });
    expect(out.translatorResolution).toEqual({
      source: 'mixed',
      cacheAgeSeconds: 30,
    });
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

describe('translateColumnValueAsync — tags translator (M19)', () => {
  // M19 close: the `tags` friendly translator dispatches via the async
  // entry, calling `tagResolution.resolveTags` to look up tag names
  // against the per-account directory. The translator surfaces the
  // wire payload `{ tag_ids: [N1, N2] }`, populates the per-tag
  // `tagResolution` echo for dry-run rendering, and threads
  // source/cache-age provenance through `translatorResolution`.

  const stubResolveTags =
    (result: {
      ids: readonly number[];
      misses: readonly string[];
      source: 'cache' | 'live' | 'mixed';
      cacheAgeSeconds: number | null;
    }) =>
    (_input: string): Promise<typeof result> =>
      Promise.resolve(result);

  it('happy path: comma-split tags resolve to {tag_ids:[N1,N2]} payload', async () => {
    const out = await translateColumnValueAsync({
      column: { id: 'tags_1', type: 'tags' },
      value: 'launch,priority',
      tagResolution: {
        resolveTags: stubResolveTags({
          ids: [101, 202],
          misses: [],
          source: 'cache',
          cacheAgeSeconds: 30,
        }),
      },
    });
    expect(out.columnId).toBe('tags_1');
    expect(out.columnType).toBe('tags');
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { tag_ids: [101, 202] },
    });
    expect(out.tagResolution).toEqual({
      tokens: [
        { input: 'launch', resolved_id: '101' },
        { input: 'priority', resolved_id: '202' },
      ],
    });
    expect(out.translatorResolution).toEqual({
      source: 'cache',
      cacheAgeSeconds: 30,
    });
    expect(out.resolvedFrom).toBeNull();
    expect(out.peopleResolution).toBeNull();
  });

  it('source: live → translatorResolution carries live + null cache age', async () => {
    const out = await translateColumnValueAsync({
      column: { id: 'tags_1', type: 'tags' },
      value: 'launch',
      tagResolution: {
        resolveTags: stubResolveTags({
          ids: [101],
          misses: [],
          source: 'live',
          cacheAgeSeconds: null,
        }),
      },
    });
    expect(out.translatorResolution).toEqual({
      source: 'live',
      cacheAgeSeconds: null,
    });
  });

  it('multi-miss → tag_not_found ApiError with details.tags array', async () => {
    await expect(
      translateColumnValueAsync({
        column: { id: 'tags_1', type: 'tags' },
        value: 'foo,bar,baz',
        tagResolution: {
          resolveTags: stubResolveTags({
            ids: [],
            misses: ['foo', 'bar', 'baz'],
            source: 'live',
            cacheAgeSeconds: null,
          }),
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);

    try {
      await translateColumnValueAsync({
        column: { id: 'tags_1', type: 'tags' },
        value: 'foo,bar',
        tagResolution: {
          resolveTags: stubResolveTags({
            ids: [],
            misses: ['foo', 'bar'],
            source: 'live',
            cacheAgeSeconds: null,
          }),
        },
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('tag_not_found');
      expect(err.details).toMatchObject({
        tags: ['foo', 'bar'],
        hint: expect.stringContaining('monday account tags') as unknown,
      });
    }
  });

  it('single-miss → tag_not_found surfaces "1 tag not in" wording', async () => {
    try {
      await translateColumnValueAsync({
        column: { id: 'tags_1', type: 'tags' },
        value: 'unknown',
        tagResolution: {
          resolveTags: stubResolveTags({
            ids: [],
            misses: ['unknown'],
            source: 'live',
            cacheAgeSeconds: null,
          }),
        },
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.message).toContain('1 tag not in');
      expect(err.details).toMatchObject({ tags: ['unknown'] });
    }
  });

  it('empty input → usage_error pointing at monday item clear', async () => {
    await expect(
      translateColumnValueAsync({
        column: { id: 'tags_1', type: 'tags' },
        value: '',
        tagResolution: {
          resolveTags: () =>
            Promise.reject(new Error('should not be called')),
        },
      }),
    ).rejects.toThrow(UsageError);

    try {
      await translateColumnValueAsync({
        column: { id: 'tags_1', type: 'tags' },
        value: '  ,  ,  ',
        tagResolution: {
          resolveTags: () =>
            Promise.reject(new Error('should not be called')),
        },
      });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.message).toMatch(/monday item clear/u);
      expect(err.details).toMatchObject({
        column_id: 'tags_1',
        column_type: 'tags',
      });
    }
  });

  it('missing tagResolution context → internal_error with wiring hint', async () => {
    await expect(
      translateColumnValueAsync({
        column: { id: 'tags_1', type: 'tags' },
        value: 'launch',
      }),
    ).rejects.toBeInstanceOf(ApiError);

    try {
      await translateColumnValueAsync({
        column: { id: 'tags_1', type: 'tags' },
        value: 'launch',
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('internal_error');
      expect(err.message).toMatch(/buildResolutionContexts/u);
      expect(err.details).toMatchObject({
        column_id: 'tags_1',
        column_type: 'tags',
      });
    }
  });

  it('NFC + case-fold dedup applied before zipping echo (Launch+launch resolves to one id)', async () => {
    const out = await translateColumnValueAsync({
      column: { id: 'tags_1', type: 'tags' },
      value: 'Launch,launch',
      tagResolution: {
        resolveTags: stubResolveTags({
          ids: [101],
          misses: [],
          source: 'cache',
          cacheAgeSeconds: 0,
        }),
      },
    });
    expect(out.payload).toEqual<ColumnValuePayload>({
      format: 'rich',
      value: { tag_ids: [101] },
    });
    expect(out.tagResolution?.tokens).toHaveLength(1);
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
        resolveEmail: () =>
          Promise.resolve({ id: '42', source: 'live', cacheAgeSeconds: null }),
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

describe('translateColumnValueAsync — board_relation translator (M19)', () => {
  // M19 Commit 3: the `board_relation` friendly translator dispatches
  // via the async entry, calling `relationResolution.validateItems`
  // to confirm each input item belongs to one of the column's
  // allowed boards. Wire payload `{ item_ids: [N1, N2] }`. The
  // per-item `relationResolution` echo populates dry-run rendering;
  // `translatorResolution: { source: 'live', cacheAgeSeconds: null }`
  // since the validator is always live.

  const validBoardRelationSettings = JSON.stringify({ boardIds: [111, 222] });

  const stubValidateItems =
    (result:
      | {
          ok: true;
          items: readonly { itemId: number; boardId: number | null }[];
        }
      | {
          ok: false;
          mismatches: readonly { itemId: number; actualBoard: number | null }[];
        }) =>
    () =>
      Promise.resolve(result);

  it('happy path: comma-split item IDs validated and threaded to {item_ids: [...]} payload', async () => {
    const out = await translateColumnValueAsync({
      column: {
        id: 'rel_1',
        type: 'board_relation',
        settingsStr: validBoardRelationSettings,
      },
      value: '12345,67890',
      relationResolution: {
        validateItems: stubValidateItems({
          ok: true,
          items: [
            { itemId: 12345, boardId: 111 },
            { itemId: 67890, boardId: 222 },
          ],
        }),
      },
    });
    expect(out.columnId).toBe('rel_1');
    expect(out.columnType).toBe('board_relation');
    expect(out.payload).toEqual({
      format: 'rich',
      value: { item_ids: [12345, 67890] },
    });
    expect(out.relationResolution).toEqual({
      context: 'board_relation',
      allowed_boards: [111, 222],
      items: [
        { input: '12345', resolved_board_id: '111' },
        { input: '67890', resolved_board_id: '222' },
      ],
    });
    expect(out.translatorResolution).toEqual({
      source: 'live',
      cacheAgeSeconds: null,
    });
    expect(out.tagResolution).toBeNull();
    expect(out.peopleResolution).toBeNull();
    expect(out.resolvedFrom).toBeNull();
  });

  it('validateItems is called with the parsed itemIds + derived allowedBoards + columnId + context', async () => {
    let capturedInputs:
      | {
          itemIds: readonly number[];
          allowedBoards: readonly number[];
          columnId: string;
          context: 'board_relation' | 'dependency';
        }
      | undefined;
    await translateColumnValueAsync({
      column: {
        id: 'rel_1',
        type: 'board_relation',
        settingsStr: validBoardRelationSettings,
      },
      value: '12345',
      relationResolution: {
        validateItems: (inputs) => {
          capturedInputs = inputs;
          return Promise.resolve({
            ok: true,
            items: [{ itemId: 12345, boardId: 111 }],
          });
        },
      },
    });
    expect(capturedInputs).toEqual({
      itemIds: [12345],
      allowedBoards: [111, 222],
      columnId: 'rel_1',
      context: 'board_relation',
    });
  });

  it('fallback: settings.boardId (singular, legacy numeric) → derives allowedBoards: [boardId]', async () => {
    const legacySettings = JSON.stringify({ boardId: 999 });
    let captured: readonly number[] | undefined;
    await translateColumnValueAsync({
      column: {
        id: 'rel_1',
        type: 'board_relation',
        settingsStr: legacySettings,
      },
      value: '12345',
      relationResolution: {
        validateItems: (inputs) => {
          captured = inputs.allowedBoards;
          return Promise.resolve({
            ok: true,
            items: [{ itemId: 12345, boardId: 999 }],
          });
        },
      },
    });
    expect(captured).toEqual([999]);
  });

  it('fallback: settings.boardId (singular, legacy decimal-string) → derives allowedBoards: [boardId] (Codex P1-2 fix)', async () => {
    // Codex post-Commit-5 P1-2: the legacy singular boardId fallback
    // dropped decimal-string IDs because the gate was
    // `typeof === number`. Monday's legacy boards occasionally
    // return string IDs in settings; routing through the same
    // safe-integer + decimal-string path the array entries use is
    // the documented `boardIds ?? [boardId]` fallback semantics.
    const legacySettings = JSON.stringify({ boardId: '999' });
    let captured: readonly number[] | undefined;
    await translateColumnValueAsync({
      column: {
        id: 'rel_1',
        type: 'board_relation',
        settingsStr: legacySettings,
      },
      value: '12345',
      relationResolution: {
        validateItems: (inputs) => {
          captured = inputs.allowedBoards;
          return Promise.resolve({
            ok: true,
            items: [{ itemId: 12345, boardId: 999 }],
          });
        },
      },
    });
    expect(captured).toEqual([999]);
  });

  it('mismatch result → usage_error with details.mismatches', async () => {
    await expect(
      translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: validBoardRelationSettings,
        },
        value: '12345',
        relationResolution: {
          validateItems: stubValidateItems({
            ok: false,
            mismatches: [{ itemId: 12345, actualBoard: 999 }],
          }),
        },
      }),
    ).rejects.toThrow(UsageError);
    try {
      await translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: validBoardRelationSettings,
        },
        value: '12345',
        relationResolution: {
          validateItems: stubValidateItems({
            ok: false,
            mismatches: [{ itemId: 12345, actualBoard: 999 }],
          }),
        },
      });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.message).toMatch(/allowed-board set/u);
      expect(err.details).toMatchObject({
        column_id: 'rel_1',
        column_type: 'board_relation',
        allowed_boards: [111, 222],
        mismatches: [{ item_id: 12345, actual_board: 999 }],
      });
    }
  });

  it('empty input → usage_error pointing at monday item clear (parseRelationItemIds rejection)', async () => {
    await expect(
      translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: validBoardRelationSettings,
        },
        value: '',
        relationResolution: {
          validateItems: () =>
            Promise.reject(new Error('should not be called')),
        },
      }),
    ).rejects.toThrow(/monday item clear/u);
  });

  it('over-cap input (26 items) → usage_error pre-validator (no validateItems call)', async () => {
    const ids = Array.from({ length: 26 }, (_, i) => (i + 1).toString());
    let validateItemsCalled = false;
    await expect(
      translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: validBoardRelationSettings,
        },
        value: ids.join(','),
        relationResolution: {
          validateItems: () => {
            validateItemsCalled = true;
            return Promise.resolve({ ok: true, items: [] });
          },
        },
      }),
    ).rejects.toThrow(/per-call cap of 25/u);
    expect(validateItemsCalled).toBe(false);
  });

  it('missing relationResolution context → internal_error wiring hint', async () => {
    await expect(
      translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: validBoardRelationSettings,
        },
        value: '12345',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    try {
      await translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: validBoardRelationSettings,
        },
        value: '12345',
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('internal_error');
      expect(err.message).toMatch(/buildResolutionContexts/u);
      expect(err.details).toMatchObject({
        column_id: 'rel_1',
        column_type: 'board_relation',
      });
    }
  });

  it('missing settingsStr (null) → internal_error wiring hint', async () => {
    await expect(
      translateColumnValueAsync({
        column: { id: 'rel_1', type: 'board_relation', settingsStr: null },
        value: '12345',
        relationResolution: {
          validateItems: () =>
            Promise.reject(new Error('should not be called')),
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);
    try {
      await translateColumnValueAsync({
        column: { id: 'rel_1', type: 'board_relation', settingsStr: null },
        value: '12345',
        relationResolution: {
          validateItems: () =>
            Promise.reject(new Error('should not be called')),
        },
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('internal_error');
      expect(err.message).toMatch(/settingsStr/u);
    }
  });

  it('missing settingsStr (undefined) → internal_error wiring hint', async () => {
    await expect(
      translateColumnValueAsync({
        column: { id: 'rel_1', type: 'board_relation' },
        value: '12345',
        relationResolution: {
          validateItems: () =>
            Promise.reject(new Error('should not be called')),
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('empty allowed-boards (no boardIds in settings) → usage_error', async () => {
    await expect(
      translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: '{}',
        },
        value: '12345',
        relationResolution: {
          validateItems: () =>
            Promise.reject(new Error('should not be called')),
        },
      }),
    ).rejects.toThrow(UsageError);
    try {
      await translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: '{}',
        },
        value: '12345',
        relationResolution: {
          validateItems: () =>
            Promise.reject(new Error('should not be called')),
        },
      });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.message).toMatch(/no allowed boards configured/u);
      expect(err.details).toMatchObject({
        column_id: 'rel_1',
        column_type: 'board_relation',
      });
    }
  });

  it('settingsStr that fails JSON.parse → falls through to empty allowedBoards → usage_error', async () => {
    // parseColumnSettings returns null for malformed input;
    // deriveAllowedBoards returns [] for null; the no-allowed-boards
    // branch fires.
    await expect(
      translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: 'not-json',
        },
        value: '12345',
        relationResolution: {
          validateItems: () =>
            Promise.reject(new Error('should not be called')),
        },
      }),
    ).rejects.toThrow(/no allowed boards configured/u);
  });

  it('settings.boardIds with string-form decimal IDs (Monday legacy) → derived as numbers', async () => {
    // Monday occasionally returns boardIds as decimal strings rather
    // than numbers in legacy boards. deriveAllowedBoards parses the
    // string form via the same regex parseRelationItemIds uses.
    const stringSettings = JSON.stringify({ boardIds: ['111', '222'] });
    let captured: readonly number[] | undefined;
    await translateColumnValueAsync({
      column: {
        id: 'rel_1',
        type: 'board_relation',
        settingsStr: stringSettings,
      },
      value: '12345',
      relationResolution: {
        validateItems: (inputs) => {
          captured = inputs.allowedBoards;
          return Promise.resolve({
            ok: true,
            items: [{ itemId: 12345, boardId: 111 }],
          });
        },
      },
    });
    expect(captured).toEqual([111, 222]);
  });

  it('dependency dispatch: same wire shape, reads dependencyBoards (M19 Commit 4)', async () => {
    // Commit 4 sibling: `dependency` translator routes through the
    // same translateRelation helper but reads `dependencyBoards`
    // from settings instead of `boardIds`. Wire shape identical
    // (`{item_ids: [...]}`); validator gets `context: 'dependency'`.
    const dependencySettings = JSON.stringify({ dependencyBoards: [333] });
    let capturedContext: 'board_relation' | 'dependency' | undefined;
    let capturedAllowed: readonly number[] | undefined;
    const out = await translateColumnValueAsync({
      column: {
        id: 'dep_1',
        type: 'dependency',
        settingsStr: dependencySettings,
      },
      value: '12345',
      relationResolution: {
        validateItems: (inputs) => {
          capturedContext = inputs.context;
          capturedAllowed = inputs.allowedBoards;
          return Promise.resolve({
            ok: true,
            items: [{ itemId: 12345, boardId: 333 }],
          });
        },
      },
    });
    expect(capturedContext).toBe('dependency');
    expect(capturedAllowed).toEqual([333]);
    expect(out.columnType).toBe('dependency');
    expect(out.payload).toEqual({
      format: 'rich',
      value: { item_ids: [12345] },
    });
    expect(out.relationResolution).toEqual({
      context: 'dependency',
      allowed_boards: [333],
      items: [{ input: '12345', resolved_board_id: '333' }],
    });
  });

  it('dependency: settings without dependencyBoards → empty allowedBoards → usage_error', async () => {
    // Commit 4 mirror of the empty-allowed-boards branch — dependency
    // settings without a dependencyBoards array has no allowed-boards
    // list to validate against.
    await expect(
      translateColumnValueAsync({
        column: {
          id: 'dep_1',
          type: 'dependency',
          settingsStr: '{}',
        },
        value: '12345',
        relationResolution: {
          validateItems: () =>
            Promise.reject(new Error('should not be called')),
        },
      }),
    ).rejects.toThrow(/no dependency boards configured/u);
  });

  it('multi-mismatch (one missing, one wrong board) → message lists each per-item with annotated reason', async () => {
    // Pins both branches of buildRelationMismatchMessage:
    // `mismatches.length === 1 ? 'item' : 'items'` (multi here) and
    // `actualBoard === null ? '(not visible / deleted)' : '(board N)'`.
    try {
      await translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: validBoardRelationSettings,
        },
        value: '12345,67890',
        relationResolution: {
          validateItems: stubValidateItems({
            ok: false,
            mismatches: [
              { itemId: 12345, actualBoard: null },
              { itemId: 67890, actualBoard: 999 },
            ],
          }),
        },
      });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.message).toMatch(/2 items not in/u);
      expect(err.message).toMatch(/12345 \(not visible \/ deleted\)/u);
      expect(err.message).toMatch(/67890 \(board 999\)/u);
    }
  });

  it('settings.boardIds with malformed entries (non-numeric strings) → filtered to empty → usage_error', async () => {
    // Mix of valid and invalid entries — only valid ones survive the
    // safe-integer guard. All-invalid → empty → no-allowed-boards
    // usage_error.
    const malformedSettings = JSON.stringify({
      boardIds: ['not-numeric', { wrong: 'shape' }, true],
    });
    await expect(
      translateColumnValueAsync({
        column: {
          id: 'rel_1',
          type: 'board_relation',
          settingsStr: malformedSettings,
        },
        value: '12345',
        relationResolution: {
          validateItems: () =>
            Promise.reject(new Error('should not be called')),
        },
      }),
    ).rejects.toThrow(/no allowed boards configured/u);
  });
});
});

describe('unsupportedColumnTypeError', () => {
  // M19 close (Commits 2-4) graduated the full v0.2 tentative row
  // into WRITABLE_COLUMN_TYPES. The `v0_2_writer_expansion` category
  // branch in the classifier is now unreachable through the runtime
  // — `V0_2_WRITER_EXPANSION_TYPES` is empty, so `isV0_2WriterExpansionType`
  // returns false for every input. The branch + category row stay
  // as documented dead code for stability + future tentative-row
  // revival (next time the writer-expansion roadmap has a tentative
  // slot, populating the set re-enables the branch without touching
  // the classifier shape).

  it('read-only-forever type (mirror) → read_only: true (no version promise)', () => {
    const err = unsupportedColumnTypeError('col_42', 'mirror');
    expect(err.code).toBe('unsupported_column_type');
    expect(err.details).toMatchObject({
      column_id: 'col_42',
      type: 'mirror',
      // Codex M5b cleanup re-review #1: types Monday computes
      // server-side never become writable via the API. The error
      // says so explicitly instead of falsely deferring to a
      // future version.
      read_only: true,
    });
    // Negative regression pins: read-only types must not advertise
    // a future write path or a --set-raw escape.
    expect(err.details).not.toHaveProperty('deferred_to');
    expect(err.details).not.toHaveProperty('set_raw_example');
    expect(err.message).not.toMatch(/v0\.[23]/u);
    expect(err.message).not.toMatch(/--set-raw/u);
  });

  it('future / unspecified type (battery) → deferred_to: "future" (no version promise)', () => {
    const err = unsupportedColumnTypeError('col_42', 'battery');
    expect(err.code).toBe('unsupported_column_type');
    expect(err.details).toMatchObject({
      column_id: 'col_42',
      type: 'battery',
      // Codex M5b cleanup re-review #1: types not on the v0.3
      // roadmap and not read-only-forever fall into the "future"
      // bucket — surface that explicitly rather than over-promise.
      deferred_to: 'future',
    });
    expect(err.details).not.toHaveProperty('set_raw_example');
    expect(err.details).not.toHaveProperty('read_only');
  });

  it('read-only-forever branch never positively advertises --set-raw (escape hatch rejects these)', () => {
    // Path B regression guard for the read-only-forever row. M8's
    // `--set-raw` rejects mirror / formula / etc. post-resolution,
    // so the unsupported_column_type error must not POSITIVELY
    // suggest the escape hatch. The message MAY mention `--set-raw`
    // in the negative ("Do not attempt --set / --set-raw") so an
    // agent reading the error knows the escape hatch is out too.
    // v0.2 writer-expansion tentatives + future types DO get
    // pointed at --set-raw as the suggested workaround — that's
    // the whole point of the escape hatch.
    const err = unsupportedColumnTypeError('col_42', 'mirror');
    // Positive-advertise patterns (forbidden):
    expect(err.message).not.toMatch(/[Uu]se --set-raw/u);
    expect(err.message).not.toMatch(/[Tt]ry --set-raw/u);
    expect(err.message).not.toMatch(/[Pp]ass.*--set-raw/u);
    const hint = (err.details as { hint?: string } | undefined)?.hint ?? '';
    expect(hint).not.toMatch(/[Uu]se --set-raw/u);
    expect(hint).not.toMatch(/[Tt]ry --set-raw/u);
    expect(hint).not.toMatch(/[Pp]ass.*--set-raw/u);
  });
});

describe('translateColumnClear', () => {
  // Per-type clear payload (M5b `item clear` verb). Pinned via wire-
  // shape fixtures so the dry-run engine + live mutation see the
  // exact same `to` shape across every type. Drift here would split
  // the v0.1 contract between dry-run preview and live execution.

  it('text → simple bare empty string', () => {
    const out = translateColumnClear({ id: 'text_1', type: 'text' });
    expect(out.payload).toEqual({ format: 'simple', value: '' });
    expect(out.columnType).toBe('text');
    expect(out.rawInput).toBe('');
    expect(out.resolvedFrom).toBeNull();
    expect(out.peopleResolution).toBeNull();
  });

  it('long_text → simple bare empty string', () => {
    const out = translateColumnClear({ id: 'lt_1', type: 'long_text' });
    expect(out.payload).toEqual({ format: 'simple', value: '' });
    expect(out.columnType).toBe('long_text');
  });

  it('numbers → simple bare empty string', () => {
    const out = translateColumnClear({ id: 'n_1', type: 'numbers' });
    expect(out.payload).toEqual({ format: 'simple', value: '' });
    expect(out.columnType).toBe('numbers');
  });

  it('status → rich empty object {}', () => {
    const out = translateColumnClear({ id: 'status_4', type: 'status' });
    expect(out.payload).toEqual({ format: 'rich', value: {} });
    expect(out.columnType).toBe('status');
  });

  it('dropdown → rich empty object {}', () => {
    const out = translateColumnClear({ id: 'tags_d', type: 'dropdown' });
    expect(out.payload).toEqual({ format: 'rich', value: {} });
    expect(out.columnType).toBe('dropdown');
  });

  it('date → rich empty object {}', () => {
    const out = translateColumnClear({ id: 'date_4', type: 'date' });
    expect(out.payload).toEqual({ format: 'rich', value: {} });
    expect(out.columnType).toBe('date');
  });

  it('people → rich empty object {} (no email resolution required for clear)', () => {
    const out = translateColumnClear({ id: 'owner_p', type: 'people' });
    expect(out.payload).toEqual({ format: 'rich', value: {} });
    expect(out.columnType).toBe('people');
  });

  it.each(['link', 'email', 'phone'])(
    '%s (M8 firm row) → rich empty object {} (clear via change_column_value)',
    (type) => {
      // M8 firm row clears match the rich-type pattern verbatim per
      // cli-design §5.3 "Clearing column values" table — payload `{}`,
      // mutation `change_column_value`. No special-casing.
      const out = translateColumnClear({ id: `${type}_1`, type });
      expect(out.payload).toEqual({ format: 'rich', value: {} });
      expect(out.columnType).toBe(type);
      expect(out.rawInput).toBe('');
      expect(out.resolvedFrom).toBeNull();
      expect(out.peopleResolution).toBeNull();
    },
  );

  it('unsupported types throw unsupported_column_type ApiError', () => {
    expect(() =>
      translateColumnClear({ id: 'formula_1', type: 'formula' }),
    ).toThrow(ApiError);
    try {
      translateColumnClear({ id: 'formula_1', type: 'formula' });
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.code).toBe('unsupported_column_type');
      expect(err.details?.column_id).toBe('formula_1');
    }
  });
});

describe('bundleColumnValues — create_item.column_values shape pin (M9)', () => {
  // M9 pre-flight (cli-design §5.3 carve-in line ~921-940): the
  // `column_values: JSON!` parameter to Monday's `create_item` and
  // `create_subitem` accepts the same map shape as the existing
  // `change_multiple_column_values.column_values` input. The
  // `long_text` re-wrap rule (`{text: <value>}` inside the map vs.
  // bare-string in `change_simple_column_value`) is expected to
  // apply identically across both wire surfaces. This block pins
  // the rule via `bundleColumnValues` (the shared helper both
  // `selectMutation` multi-update and M9's create command call), so
  // a future Monday API change that diverges between update and
  // create surfaces would fail this test loud and we'd revisit the
  // contract before the next M9-shaped milestone ships.
  //
  // The M9 spec gap will close in cli-design's M9 docs sweep once
  // a real fixture against Monday's create_item.column_values
  // confirms the shape; until then these unit tests are the binding
  // pin.

  it('text + long_text → simple bare string for text, {text:...} re-wrap for long_text', () => {
    const text = translateColumnValue({
      column: { id: 'notes', type: 'text' },
      value: 'hi',
    });
    const longText = translateColumnValue({
      column: { id: 'description', type: 'long_text' },
      value: 'paragraph\nwith\nnewlines',
    });
    const bundled = bundleColumnValues([text, longText]);
    expect(bundled).toEqual({
      notes: 'hi',
      description: { text: 'paragraph\nwith\nnewlines' },
    });
  });

  it('mixed simple + rich → bare strings + objects in caller order', () => {
    const text = translateColumnValue({
      column: { id: 'notes', type: 'text' },
      value: 'hi',
    });
    const status = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Done',
    });
    const date = translateColumnValue({
      column: { id: 'due', type: 'date' },
      value: '2026-05-01',
    });
    const bundled = bundleColumnValues([text, status, date]);
    expect(bundled).toEqual({
      notes: 'hi',
      status_4: { label: 'Done' },
      due: { date: '2026-05-01' },
    });
    expect(Object.keys(bundled)).toEqual(['notes', 'status_4', 'due']);
  });

  it('rich-only → identical map to selectMutation multi-form output', () => {
    // The shape contract: `bundleColumnValues` and `selectMutation`
    // multi must agree byte-for-byte on the column_values map. M9's
    // create command should produce the exact same wire bytes
    // bulk update would for the same translated values.
    const status = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Done',
    });
    const dropdown = translateColumnValue({
      column: { id: 'tags', type: 'dropdown' },
      value: '1,2',
    });
    const bundled = bundleColumnValues([status, dropdown]);
    const multi = selectMutation([status, dropdown]);
    if (multi.kind !== 'change_multiple_column_values') {
      throw new Error('expected multi');
    }
    expect(bundled).toEqual(multi.columnValues);
  });

  it('--set-raw payloads pass through unchanged (no long_text re-wrap on rich)', () => {
    // M9 supports --set-raw alongside --set on create. A raw
    // payload's `payload.format` is always 'rich' (raw-write.ts
    // contract), so projectForMulti's long_text branch never fires
    // for raw — the payload object passes through verbatim.
    const raw = translateRawColumnValue(
      { id: 'long_desc', type: 'long_text' },
      { text: 'paragraph', someExtra: 'agent supplied' },
      '{"text":"paragraph","someExtra":"agent supplied"}',
    );
    const bundled = bundleColumnValues([raw]);
    expect(bundled).toEqual({
      long_desc: { text: 'paragraph', someExtra: 'agent supplied' },
    });
  });

  it('duplicate column ID throws usage_error', () => {
    const a = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Done',
    });
    const b = translateColumnValue({
      column: { id: 'status_4', type: 'status' },
      value: 'Doing',
    });
    expect(() => bundleColumnValues([a, b])).toThrow(UsageError);
    try {
      bundleColumnValues([a, b]);
    } catch (e) {
      const err = e as UsageError;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_id: 'status_4',
        duplicate_count: 2,
      });
    }
  });

  it('empty list → empty map (caller is responsible for the no-op gate)', () => {
    // Unlike `selectMutation`, `bundleColumnValues` does not throw
    // on the empty case — M9's create-without-`--set` path is a
    // legitimate caller (`create_item(item_name: ..., column_values:
    // null)` semantically equals "no values"). The command layer
    // decides whether to send `column_values` at all; the helper
    // just shapes whatever's passed.
    expect(bundleColumnValues([])).toEqual({});
  });
});
