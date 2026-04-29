import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  COLUMN_FLOOR,
  renderTable,
  truncate,
} from '../../../../src/utils/output/table.js';

const collect = (): {
  stream: PassThrough;
  read: () => string;
} => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
};

describe('truncate', () => {
  it('returns the value unchanged when it fits', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('cuts to width-1 + ellipsis when too long', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
  });

  it('returns just an ellipsis at width 1', () => {
    expect(truncate('abc', 1)).toBe('…');
    expect(truncate('abc', 0)).toBe('…');
  });

  it('uses U+2026 as the ellipsis (single visual character)', () => {
    expect(truncate('abcdef', 4).endsWith('…')).toBe(true);
    expect('…'.length).toBe(1);
  });
});

describe('renderTable — single resource', () => {
  it('emits a key/value table with a trailing newline', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'single',
        data: { id: '12345', name: 'Refactor login' },
        options: { full: true },
      },
      stream,
    );
    const out = read();
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('id');
    expect(out).toContain('12345');
    expect(out).toContain('name');
    expect(out).toContain('Refactor login');
  });

  it('truncates long values when --full is off', () => {
    const longValue = 'x'.repeat(1000);
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'single',
        data: { id: '1', description: longValue },
        options: { width: 60 },
      },
      stream,
    );
    const out = read();
    expect(out).toContain('…');
    expect(out).not.toContain(longValue);
  });

  it('--full disables truncation', () => {
    const longValue = 'x'.repeat(200);
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'single',
        data: { description: longValue },
        options: { full: true, width: 40 },
      },
      stream,
    );
    expect(read()).toContain(longValue);
  });

  it('--columns restricts the visible field set', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'single',
        data: { id: '1', secret: 'shh', name: 'A' },
        options: { full: true, columns: ['id', 'name'] },
      },
      stream,
    );
    const out = read();
    expect(out).toContain('id');
    expect(out).toContain('name');
    expect(out).not.toContain('secret');
  });

  it('honours the column floor of 12 chars', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'single',
        data: { description: 'x'.repeat(50) },
        options: { width: 10 }, // forces the floor
      },
      stream,
    );
    const out = read();
    // The floor guarantees at least COLUMN_FLOOR chars of content
    // before the ellipsis kicks in — assert by counting visible 'x's.
    const xCount = (out.match(/x/gu) ?? []).length;
    expect(xCount).toBeGreaterThanOrEqual(COLUMN_FLOOR - 1);
  });
});

describe('renderTable — collection', () => {
  it('uses union-of-keys as the header in first-seen order', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'collection',
        data: [
          { id: '1', name: 'A' },
          { id: '2', name: 'B', extra: 'present-on-second' },
        ],
        options: { full: true },
      },
      stream,
    );
    const out = read();
    const idPos = out.indexOf('id');
    const namePos = out.indexOf('name');
    const extraPos = out.indexOf('extra');
    expect(idPos).toBeLessThan(namePos);
    expect(namePos).toBeLessThan(extraPos);
  });

  it('renders missing fields as empty cells', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'collection',
        data: [{ id: '1', name: 'A' }, { id: '2' }],
        options: { full: true },
      },
      stream,
    );
    const out = read();
    expect(out).toContain('id');
    expect(out).toContain('name');
    // Second row should still render '2' for id and an empty cell for name.
    expect(out).toContain('2');
  });

  it('handles an empty collection without crashing', () => {
    const { stream, read } = collect();
    renderTable({ kind: 'collection', data: [], options: { full: true } }, stream);
    expect(read()).toMatch(/\n$/u);
  });

  it('truncates row cells when --full is off', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'collection',
        data: [
          { id: '1', name: 'x'.repeat(100) },
          { id: '2', name: 'y'.repeat(100) },
        ],
        options: { width: 40 },
      },
      stream,
    );
    expect(read()).toContain('…');
  });

  it('--columns drops unselected keys', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'collection',
        data: [{ id: '1', secret: 'shh', name: 'A' }],
        options: { full: true, columns: ['id', 'name'] },
      },
      stream,
    );
    const out = read();
    expect(out).not.toContain('secret');
    expect(out).not.toContain('shh');
  });

  it('--columns silently drops unknown keys', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'collection',
        data: [{ id: '1' }],
        options: { full: true, columns: ['id', 'doesNotExist'] },
      },
      stream,
    );
    expect(read()).toContain('id');
  });
});

describe('renderTable — value formatting', () => {
  it('renders nested objects as inline JSON', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'single',
        data: { meta: { a: 1, b: 'x' } },
        options: { full: true },
      },
      stream,
    );
    expect(read()).toContain('{"a":1,"b":"x"}');
  });

  it('renders null and undefined explicitly', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'single',
        data: { absent: null, missing: undefined },
        options: { full: true },
      },
      stream,
    );
    const out = read();
    expect(out).toContain('null');
    // undefined renders as empty content; the row still exists.
    expect(out).toContain('missing');
  });

  it('renders booleans and numbers', () => {
    const { stream, read } = collect();
    renderTable(
      {
        kind: 'single',
        data: { active: true, count: 42 },
        options: { full: true },
      },
      stream,
    );
    const out = read();
    expect(out).toContain('true');
    expect(out).toContain('42');
  });
});
