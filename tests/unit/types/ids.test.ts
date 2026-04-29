import { describe, expect, it } from 'vitest';
import {
  BoardIdSchema,
  ColumnIdSchema,
  GroupIdSchema,
  ItemIdSchema,
  UpdateIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type BoardId,
  type ItemId,
} from '../../../src/types/ids.js';

describe('numeric ID schemas', () => {
  it.each([
    ['BoardIdSchema', BoardIdSchema],
    ['ItemIdSchema', ItemIdSchema],
    ['UserIdSchema', UserIdSchema],
    ['WorkspaceIdSchema', WorkspaceIdSchema],
    ['UpdateIdSchema', UpdateIdSchema],
  ])('%s parses a decimal-string ID', (_name, schema) => {
    expect(schema.parse('12345')).toBe('12345');
  });

  it.each([
    ['BoardIdSchema', BoardIdSchema],
    ['ItemIdSchema', ItemIdSchema],
    ['UserIdSchema', UserIdSchema],
    ['WorkspaceIdSchema', WorkspaceIdSchema],
    ['UpdateIdSchema', UpdateIdSchema],
  ])('%s preserves IDs beyond Number.MAX_SAFE_INTEGER', (_name, schema) => {
    // Monday IDs can outrun JS-safe integers — the string-typed contract
    // is exactly what protects against silent precision loss.
    const big = '9007199254740993';
    expect(schema.parse(big)).toBe(big);
  });

  it.each([
    ['empty', ''],
    ['letters', 'abc'],
    ['mixed', '12a3'],
    ['negative', '-1'],
    ['leading-plus', '+1'],
    ['decimal', '1.0'],
    ['whitespace', ' 12345 '],
  ])('rejects %s as a BoardId', (_label, value) => {
    expect(() => BoardIdSchema.parse(value)).toThrow();
  });

  it('rejects non-string input', () => {
    expect(() => BoardIdSchema.parse(12345)).toThrow();
    expect(() => BoardIdSchema.parse(null)).toThrow();
    expect(() => BoardIdSchema.parse(undefined)).toThrow();
  });
});

describe('slug ID schemas', () => {
  it('ColumnIdSchema accepts non-empty slugs', () => {
    expect(ColumnIdSchema.parse('status_4')).toBe('status_4');
    expect(ColumnIdSchema.parse('person')).toBe('person');
  });

  it('GroupIdSchema accepts non-empty slugs', () => {
    expect(GroupIdSchema.parse('topics')).toBe('topics');
  });

  it('rejects empty strings', () => {
    expect(() => ColumnIdSchema.parse('')).toThrow();
    expect(() => GroupIdSchema.parse('')).toThrow();
  });

  it('rejects non-string input', () => {
    expect(() => ColumnIdSchema.parse(42)).toThrow();
  });
});

describe('brand distinctness', () => {
  it('compiler treats BoardId and ItemId as nominally distinct', () => {
    const board: BoardId = BoardIdSchema.parse('123');
    const item: ItemId = ItemIdSchema.parse('456');

    // The point of brands is that this assignment would fail to type-check
    // — the runtime value is just a string, so we assert the runtime side.
    expect(typeof board).toBe('string');
    expect(typeof item).toBe('string');
    expect(board).not.toBe(item);
  });
});
