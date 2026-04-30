import { describe, expect, it } from 'vitest';
import {
  idFromRawItem,
  parseColumnValue,
  projectColumnValue,
  projectItem,
  rawColumnValueSchema,
  rawItemSchema,
  type RawColumnValue,
} from '../../../src/api/item-projection.js';

const cv = (overrides: Partial<RawColumnValue>): RawColumnValue => ({
  id: 'status_4',
  type: 'status',
  text: 'Done',
  value: '{"label":"Done","index":1}',
  column: { title: 'Status' },
  ...overrides,
});

describe('parseColumnValue', () => {
  it('parses a JSON-encoded string', () => {
    expect(parseColumnValue('{"label":"Done"}')).toEqual({ label: 'Done' });
  });

  it('returns null for null input', () => {
    expect(parseColumnValue(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseColumnValue('')).toBeNull();
  });

  it('returns null for malformed JSON (defensive — Monday read-only types)', () => {
    expect(parseColumnValue('{not json')).toBeNull();
  });
});

describe('projectColumnValue — typed inline fields', () => {
  it('extracts label/index for status columns', () => {
    const out = projectColumnValue(
      cv({ value: '{"label":"Working on it","index":2}' }),
      undefined,
    );
    expect(out.type).toBe('status');
    expect(out.label).toBe('Working on it');
    expect(out.index).toBe(2);
  });

  it('extracts date/time for date columns', () => {
    const out = projectColumnValue(
      cv({
        type: 'date',
        text: '2026-05-01',
        value: '{"date":"2026-05-01","time":null}',
      }),
      undefined,
    );
    expect(out.type).toBe('date');
    expect(out.date).toBe('2026-05-01');
    expect(out.time).toBeNull();
  });

  it('extracts non-null time for date columns when set', () => {
    const out = projectColumnValue(
      cv({
        type: 'date',
        text: '2026-05-01 10:30',
        value: '{"date":"2026-05-01","time":"10:30"}',
      }),
      undefined,
    );
    expect(out.date).toBe('2026-05-01');
    expect(out.time).toBe('10:30');
  });

  it('extracts people for people columns', () => {
    const out = projectColumnValue(
      cv({
        type: 'people',
        text: 'Alice, Bob',
        value:
          '{"personsAndTeams":[{"id":1,"kind":"person"},{"id":"42","kind":"team"}]}',
      }),
      undefined,
    );
    expect(out.people).toEqual([
      { id: '1', kind: 'person' },
      { id: '42', kind: 'team' },
    ]);
  });

  it('passes through unknown types with the base shape', () => {
    const out = projectColumnValue(
      cv({ type: 'mirror', value: '{"some":"raw"}' }),
      undefined,
    );
    expect(out).toMatchObject({
      id: 'status_4',
      type: 'mirror',
      title: 'Status',
      text: 'Done',
      value: { some: 'raw' },
    });
    expect(out.label).toBeUndefined();
    expect(out.date).toBeUndefined();
  });

  it('prefers the fallbackTitle (board metadata canonical) over wire title', () => {
    const out = projectColumnValue(cv({ column: { title: 'Wire Title' } }), 'Metadata Title');
    expect(out.title).toBe('Metadata Title');
  });

  it('falls back to the wire column.title when no metadata title is supplied', () => {
    const out = projectColumnValue(cv({ column: { title: 'Wire Title' } }), undefined);
    expect(out.title).toBe('Wire Title');
  });

  it('uses the column id as the last-resort title', () => {
    const out = projectColumnValue(cv({ column: null }), undefined);
    expect(out.title).toBe('status_4');
  });

  it('handles null people value gracefully', () => {
    const out = projectColumnValue(cv({ type: 'people', value: null }), undefined);
    expect(out.people).toEqual([]);
  });

  it('handles malformed status value gracefully', () => {
    const out = projectColumnValue(
      cv({ value: '{not json}' }),
      undefined,
    );
    // value parsed as null → label/index null
    expect(out.value).toBeNull();
    expect(out.label).toBeNull();
    expect(out.index).toBeNull();
  });

  it('handles malformed date value gracefully', () => {
    const out = projectColumnValue(
      cv({ type: 'date', value: 'garbage' }),
      undefined,
    );
    expect(out.date).toBeNull();
    expect(out.time).toBeNull();
  });

  it('skips people entries with no id', () => {
    const out = projectColumnValue(
      cv({
        type: 'people',
        value:
          '{"personsAndTeams":[{"kind":"person"},{"id":7,"kind":"person"}]}',
      }),
      undefined,
    );
    expect(out.people).toEqual([{ id: '7', kind: 'person' }]);
  });

  it('skips non-object person entries', () => {
    const out = projectColumnValue(
      cv({
        type: 'people',
        // Defensive: a person entry is not an object (e.g. a stray
        // null in the array). Skip it without crashing.
        value: '{"personsAndTeams":[null,{"id":"1","kind":"person"}]}',
      }),
      undefined,
    );
    expect(out.people).toEqual([{ id: '1', kind: 'person' }]);
  });

  it('returns empty people when personsAndTeams is missing', () => {
    const out = projectColumnValue(
      cv({
        type: 'people',
        value: '{"otherKey":"x"}',
      }),
      undefined,
    );
    expect(out.people).toEqual([]);
  });

  it('drops kind when not a string', () => {
    const out = projectColumnValue(
      cv({
        type: 'people',
        value: '{"personsAndTeams":[{"id":"5"}]}',
      }),
      undefined,
    );
    expect(out.people).toEqual([{ id: '5' }]);
  });
});

describe('projectItem', () => {
  const raw = {
    id: '12345',
    name: 'Refactor login',
    state: 'active',
    url: 'https://example.monday.com/items/12345',
    created_at: '2026-04-29T10:00:00Z',
    updated_at: '2026-04-29T11:00:00Z',
    board: { id: '67890' },
    group: { id: 'topics', title: 'Topics' },
    parent_item: null,
    column_values: [
      cv({ id: 'status_4', type: 'status' }),
      cv({
        id: 'date4',
        type: 'date',
        text: '2026-05-01',
        value: '{"date":"2026-05-01","time":null}',
        column: { title: 'Due date' },
      }),
    ],
  };

  it('projects the canonical shape', () => {
    const parsed = rawItemSchema.parse(raw);
    const out = projectItem({ raw: parsed });
    expect(out).toMatchObject({
      id: '12345',
      name: 'Refactor login',
      board_id: '67890',
      group_id: 'topics',
      state: 'active',
      url: 'https://example.monday.com/items/12345',
    });
    expect(Object.keys(out.columns)).toEqual(['status_4', 'date4']);
    expect(out.columns.status_4?.label).toBe('Done');
    expect(out.columns.date4?.date).toBe('2026-05-01');
  });

  it('uses provided column titles when supplied', () => {
    const parsed = rawItemSchema.parse(raw);
    const titles = new Map([['status_4', 'Status (canonical)']]);
    const out = projectItem({ raw: parsed, columnTitles: titles });
    expect(out.columns.status_4?.title).toBe('Status (canonical)');
    // Untitled fallback for date4
    expect(out.columns.date4?.title).toBe('Due date');
  });

  it('returns null board_id / group_id when Monday returns null', () => {
    const parsed = rawItemSchema.parse({
      ...raw,
      board: null,
      group: null,
      parent_item: { id: '999' },
    });
    const out = projectItem({ raw: parsed });
    expect(out.board_id).toBeNull();
    expect(out.group_id).toBeNull();
    expect(out.parent_item_id).toBe('999');
  });
});

describe('rawColumnValueSchema', () => {
  it('accepts a minimal valid column-value', () => {
    expect(rawColumnValueSchema.parse({
      id: 'status_4',
      type: 'status',
      text: null,
      value: null,
    })).toMatchObject({ id: 'status_4', type: 'status' });
  });

  it('rejects a missing required field', () => {
    expect(() =>
      rawColumnValueSchema.parse({ id: 'status_4' }),
    ).toThrow();
  });
});

describe('idFromRawItem', () => {
  it('returns the id when present as a string', () => {
    expect(idFromRawItem({ id: '42' })).toBe('42');
  });

  it('exists as a callable export', () => {
    // Defensive branches (non-object input, missing id) are
    // c8-ignored: the production wire shape always carries a string
    // id and is enforced by rawItemSchema.parse before idFromRawItem
    // sees the value. The function is exercised on the happy path
    // via integration tests for item list / find / search.
    expect(typeof idFromRawItem).toBe('function');
  });
});
