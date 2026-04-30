import { describe, expect, it } from 'vitest';
import { exampleSetForColumn } from '../../../src/commands/board/describe.js';
import type { BoardColumn } from '../../../src/api/board-metadata.js';

const col = (over: Partial<BoardColumn>): BoardColumn => ({
  id: over.id ?? 'col_1',
  title: over.title ?? 'Col',
  type: over.type ?? 'text',
  description: over.description ?? null,
  archived: over.archived ?? false,
  settings_str: over.settings_str ?? null,
  width: over.width ?? null,
});

describe('exampleSetForColumn — every writable column type', () => {
  it('text: pass-through string suggestion', () => {
    expect(exampleSetForColumn(col({ id: 'notes', type: 'text' }))).toEqual([
      `--set notes='Refactor login'`,
    ]);
  });

  it('long_text: multi-line suggestion', () => {
    const out = exampleSetForColumn(col({ id: 'desc', type: 'long_text' }));
    expect(out?.[0]).toContain('long_text' in {} ? 'desc' : 'desc');
    expect(out?.[0]).toContain('Multi-line');
  });

  it('numbers: numeric suggestion', () => {
    expect(exampleSetForColumn(col({ id: 'pri', type: 'numbers' }))).toEqual([
      `--set pri=42`,
    ]);
  });

  it('status: derives a real label from settings_str.labels', () => {
    const out = exampleSetForColumn(
      col({
        id: 'st',
        type: 'status',
        settings_str: JSON.stringify({
          labels: { '0': 'Backlog', '5': 'Working on it' },
        }),
      }),
    );
    expect(out).toEqual([
      `--set st='Backlog'`,
      `--set st=0   # by index`,
    ]);
  });

  it('status: falls back to Done/1 when settings has no labels', () => {
    const out = exampleSetForColumn(
      col({ id: 'st', type: 'status', settings_str: '{}' }),
    );
    expect(out).toEqual([
      `--set st=Done`,
      `--set st=1   # by index`,
    ]);
  });

  it('status: handles malformed settings_str without throwing', () => {
    const out = exampleSetForColumn(
      col({ id: 'st', type: 'status', settings_str: 'not-json' }),
    );
    expect(out).toEqual([
      `--set st=Done`,
      `--set st=1   # by index`,
    ]);
  });

  it('dropdown: samples first labels, suggests by id too', () => {
    const out = exampleSetForColumn(
      col({
        id: 'dd',
        type: 'dropdown',
        settings_str: JSON.stringify({
          labels: [
            { id: 1, name: 'Backend' },
            { id: 2, name: 'Frontend' },
            { id: 3, name: 'Mobile' },
          ],
        }),
      }),
    );
    expect(out?.[0]).toBe(`--set dd='Backend,Frontend'`);
    expect(out?.[1]).toBe(`--set dd='1'   # by id`);
  });

  it('dropdown: empty labels falls back to a generic suggestion', () => {
    const out = exampleSetForColumn(
      col({ id: 'dd', type: 'dropdown', settings_str: '{}' }),
    );
    expect(out).toEqual([`--set dd='Backend,Frontend'`]);
  });

  it('date: ISO + relative variants', () => {
    expect(exampleSetForColumn(col({ id: 'due', type: 'date' }))).toEqual([
      `--set due=2026-05-01`,
      `--set due=tomorrow`,
      `--set due=+3d`,
    ]);
  });

  it('people: email + me sugar', () => {
    expect(exampleSetForColumn(col({ id: 'owner', type: 'people' }))).toEqual([
      `--set owner=alice@example.com`,
      `--set owner=me`,
    ]);
  });
});

describe('exampleSetForColumn — non-writable types', () => {
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
  ])('%s returns null', (type) => {
    expect(exampleSetForColumn(col({ type }))).toBeNull();
  });
});
