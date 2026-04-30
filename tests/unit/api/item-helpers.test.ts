/**
 * Unit tests for `src/api/item-helpers.ts` (R9 lift).
 *
 * The helpers are mostly behaviour-preserving lifts of code that was
 * already covered through integration tests for `item list / search
 * / find / get / subitems`. This file pins the unit-level shape of
 * each helper directly so any future per-helper behaviour change is
 * caught at the API-test layer.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COLUMN_VALUES_FRAGMENT,
  ITEM_FIELDS_FRAGMENT,
  collectColumnHeads,
  projectFromRaw,
  resolveMeFactory,
  titleMap,
} from '../../../src/api/item-helpers.js';
import { UsageError } from '../../../src/utils/errors.js';
import type { MondayClient } from '../../../src/api/client.js';

describe('COLUMN_VALUES_FRAGMENT', () => {
  it('contains every §6.2 column-value field', () => {
    // The fragment is interpolated into many queries — drift here
    // ripples to every consumer. Pin the field set explicitly so a
    // future "remove column.title to save bytes" patch fails loudly.
    expect(COLUMN_VALUES_FRAGMENT).toContain('column_values {');
    expect(COLUMN_VALUES_FRAGMENT).toContain('id');
    expect(COLUMN_VALUES_FRAGMENT).toContain('type');
    expect(COLUMN_VALUES_FRAGMENT).toContain('text');
    expect(COLUMN_VALUES_FRAGMENT).toContain('value');
    expect(COLUMN_VALUES_FRAGMENT).toContain('column { title }');
  });
});

describe('ITEM_FIELDS_FRAGMENT', () => {
  it('contains every scalar §6.2 field plus the column_values fragment', () => {
    expect(ITEM_FIELDS_FRAGMENT).toContain('id');
    expect(ITEM_FIELDS_FRAGMENT).toContain('name');
    expect(ITEM_FIELDS_FRAGMENT).toContain('state');
    expect(ITEM_FIELDS_FRAGMENT).toContain('url');
    expect(ITEM_FIELDS_FRAGMENT).toContain('created_at');
    expect(ITEM_FIELDS_FRAGMENT).toContain('updated_at');
    expect(ITEM_FIELDS_FRAGMENT).toContain('board { id }');
    expect(ITEM_FIELDS_FRAGMENT).toContain('group { id title }');
    expect(ITEM_FIELDS_FRAGMENT).toContain('parent_item { id }');
    // The full COLUMN_VALUES_FRAGMENT must be embedded byte-for-byte
    // so the rendered query stays a single source of truth.
    expect(ITEM_FIELDS_FRAGMENT).toContain(COLUMN_VALUES_FRAGMENT);
  });
});

describe('collectColumnHeads', () => {
  it('builds a §6.3 column-head map keyed by id', () => {
    const heads = collectColumnHeads({
      columns: [
        { id: 'status_4', type: 'status', title: 'Status' },
        { id: 'date4', type: 'date', title: 'Due date' },
      ],
    });
    expect(heads).toEqual({
      status_4: { id: 'status_4', type: 'status', title: 'Status' },
      date4: { id: 'date4', type: 'date', title: 'Due date' },
    });
  });

  it('emits an empty record for a metadata payload with no columns', () => {
    expect(collectColumnHeads({ columns: [] })).toEqual({});
  });
});

describe('titleMap', () => {
  it('builds an id → title ReadonlyMap', () => {
    const map = titleMap({
      columns: [
        { id: 'status_4', title: 'Status' },
        { id: 'date4', title: 'Due date' },
      ],
    });
    expect(map.get('status_4')).toBe('Status');
    expect(map.get('date4')).toBe('Due date');
    expect(map.get('missing')).toBeUndefined();
  });

  it('emits an empty Map for empty metadata', () => {
    const map = titleMap({ columns: [] });
    expect(map.size).toBe(0);
  });
});

describe('resolveMeFactory', () => {
  it('returns the resolved Monday user id from whoami()', async () => {
    const whoami = vi.fn().mockResolvedValue({
      data: {
        me: {
          id: '999',
          name: 'Alice',
          email: 'alice@example.test',
          is_guest: false,
          enabled: true,
        },
      },
    });
    const client = { whoami } as unknown as MondayClient;
    const resolveMe = resolveMeFactory(client);
    await expect(resolveMe()).resolves.toBe('999');
    expect(whoami).toHaveBeenCalledOnce();
  });
});

describe('projectFromRaw', () => {
  const raw = {
    id: '12345',
    name: 'Refactor login',
    state: 'active',
    url: 'https://example.monday.com/items/12345',
    created_at: '2026-04-29T10:00:00Z',
    updated_at: '2026-04-29T11:00:00Z',
    board: { id: '111' },
    group: { id: 'topics', title: 'Topics' },
    parent_item: null,
    column_values: [
      {
        id: 'status_4',
        type: 'status',
        text: 'Done',
        value: '{"label":"Done","index":1}',
        column: { title: 'Status' },
      },
    ],
  };
  const titles = new Map<string, string>([['status_4', 'Status']]);

  it('drops per-cell titles when omitColumnTitles is true', () => {
    const projected = projectFromRaw(raw, titles, { omitColumnTitles: true });
    const cell = projected.columns['status_4'];
    expect(cell?.title).toBeUndefined();
    expect(cell?.label).toBe('Done');
    expect(cell?.index).toBe(1);
  });

  it('keeps per-cell titles when omitColumnTitles is false', () => {
    const projected = projectFromRaw(raw, titles, { omitColumnTitles: false });
    const cell = projected.columns['status_4'];
    expect(cell?.title).toBe('Status');
  });
});
