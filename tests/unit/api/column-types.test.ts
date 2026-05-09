import { describe, expect, it } from 'vitest';
import {
  READ_ONLY_FOREVER_TYPES,
  WRITABLE_COLUMN_TYPES,
  categorizeNoncanonicalColumnType,
  isReadOnlyForeverType,
  isWritableColumnType,
  parseColumnSettings,
} from '../../../src/api/column-types.js';

describe('WRITABLE_COLUMN_TYPES', () => {
  it('matches the v0.1 + M8 firm + M19 (tags + board_relation) allowlist exactly, in declared order', () => {
    // Order is part of the contract — tests iterate the array form
    // and downstream snapshots pin the literal sequence. v0.1 entries
    // come first (`text` … `people`); M8 firm additions follow in
    // roadmap order (`link` / `email` / `phone`); M19 graduates
    // `tags` (Commit 2) + `board_relation` (Commit 3) from the v0.2
    // tentative row. `dependency` graduates at Commit 4.
    expect(WRITABLE_COLUMN_TYPES).toEqual([
      'text',
      'long_text',
      'numbers',
      'status',
      'dropdown',
      'date',
      'people',
      'link',
      'email',
      'phone',
      'tags',
      'board_relation',
    ]);
  });
});

describe('isWritableColumnType', () => {
  it.each(WRITABLE_COLUMN_TYPES)('returns true for allowlisted type %s', (type) => {
    expect(isWritableColumnType(type)).toBe(true);
  });

  it.each([
    'mirror',
    'formula',
    'battery',
    'item_assignees',
    'time_tracking',
    'auto_number',
    'creation_log',
    'last_updated',
    // M19 still-tentative row: `dependency` graduates at Commit 4.
    // `tags` graduated at Commit 2; `board_relation` at Commit 3.
    'dependency',
    'rating',
    '',
    'TEXT', // case-sensitive — Monday types are stable lowercase strings
  ])('returns false for non-allowlisted type %s', (type) => {
    expect(isWritableColumnType(type)).toBe(false);
  });

  it('narrows the input type so callers can switch without re-casting', () => {
    const candidate = 'status' as string;
    if (isWritableColumnType(candidate)) {
      // Compile-time check: this would not type-check if the predicate
      // didn't narrow `candidate` to `WritableColumnType`. Union
      // includes M8 firm additions (link / email / phone) and M19
      // (`tags`).
      const narrowed:
        | 'text'
        | 'long_text'
        | 'numbers'
        | 'status'
        | 'dropdown'
        | 'date'
        | 'people'
        | 'link'
        | 'email'
        | 'phone'
        | 'tags'
        | 'board_relation' = candidate;
      expect(narrowed).toBe('status');
    } else {
      throw new Error('expected status to be writable');
    }
  });
});

describe('parseColumnSettings', () => {
  it('returns null for null input', () => {
    expect(parseColumnSettings(null)).toBeNull();
  });

  it('returns null for empty-string input', () => {
    expect(parseColumnSettings('')).toBeNull();
  });

  it('returns null for malformed JSON without throwing', () => {
    expect(parseColumnSettings('not-json')).toBeNull();
    expect(parseColumnSettings('{ unterminated')).toBeNull();
    expect(parseColumnSettings('{"a":}')).toBeNull();
  });

  it('parses well-formed JSON objects', () => {
    expect(parseColumnSettings('{"labels":{"0":"Backlog"}}')).toEqual({
      labels: { '0': 'Backlog' },
    });
  });

  it('parses well-formed JSON arrays', () => {
    expect(parseColumnSettings('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses JSON primitives — Monday occasionally returns them', () => {
    expect(parseColumnSettings('null')).toBeNull();
    expect(parseColumnSettings('42')).toBe(42);
    expect(parseColumnSettings('"hi"')).toBe('hi');
    expect(parseColumnSettings('true')).toBe(true);
  });
});

describe('READ_ONLY_FOREVER_TYPES', () => {
  it('matches the v0.1 set + the M16 pre-flight pin (item_assignees)', () => {
    // Order is contract — `--set-raw` and column-create's
    // noncanonical_column_type warning iterate this set. M16 added
    // `item_assignees` per cli-design §4.3 column-create (Monday
    // computes it server-side; no write surface).
    expect(READ_ONLY_FOREVER_TYPES).toEqual([
      'mirror',
      'formula',
      'auto_number',
      'creation_log',
      'last_updated',
      'item_id',
      'item_assignees',
    ]);
  });

  it('isReadOnlyForeverType returns true for each entry', () => {
    for (const type of READ_ONLY_FOREVER_TYPES) {
      expect(isReadOnlyForeverType(type)).toBe(true);
    }
  });

  it('isReadOnlyForeverType returns false for writable + raw-writable types', () => {
    expect(isReadOnlyForeverType('text')).toBe(false);
    expect(isReadOnlyForeverType('country')).toBe(false);
    expect(isReadOnlyForeverType('hour')).toBe(false);
    expect(isReadOnlyForeverType('file')).toBe(false);
  });
});

describe('categorizeNoncanonicalColumnType (M16 noncanonical_column_type warning)', () => {
  it('returns null for canonical types in WRITABLE_COLUMN_TYPES', () => {
    for (const type of WRITABLE_COLUMN_TYPES) {
      expect(categorizeNoncanonicalColumnType(type)).toBeNull();
    }
  });

  it.each([
    'mirror',
    'formula',
    'auto_number',
    'creation_log',
    'last_updated',
    'item_id',
    'item_assignees',
  ])('%s → read_only_forever with suggested_write_path: null', (type) => {
    expect(categorizeNoncanonicalColumnType(type)).toEqual({
      category: 'read_only_forever',
      suggestedWritePath: null,
    });
  });

  it('file → files_shaped with the v0.4 add_file_to_column hint', () => {
    expect(categorizeNoncanonicalColumnType('file')).toEqual({
      category: 'files_shaped',
      suggestedWritePath: 'add_file_to_column (deferred to v0.4)',
    });
  });

  it.each([
    'country',
    'hour',
    'timeline',
    // `tags` (Commit 2) and `board_relation` (Commit 3) graduated
    // to WRITABLE_COLUMN_TYPES at M19 close —
    // `categorizeNoncanonicalColumnType` returns null for them now.
    'dependency',
    'rating',
    'battery',
    'time_tracking',
    'checkbox',
    'world_clock',
    'week',
    'unsupported',
  ])('%s → raw_writable with --set-raw hint', (type) => {
    expect(categorizeNoncanonicalColumnType(type)).toEqual({
      category: 'raw_writable',
      suggestedWritePath: '--set-raw <col>=<json>',
    });
  });

  it('unknown future type → raw_writable (default branch)', () => {
    // Forward-compat: a column type Monday adds tomorrow that the CLI
    // doesn't know about should default to the raw_writable branch
    // (agents reach for `--set-raw`). The contract treats absent
    // membership as "Monday accepts change_column_value", which is
    // the conservative-helpful assumption.
    expect(categorizeNoncanonicalColumnType('not_a_real_type')).toEqual({
      category: 'raw_writable',
      suggestedWritePath: '--set-raw <col>=<json>',
    });
  });
});
