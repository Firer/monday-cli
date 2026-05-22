import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/utils/errors.js';
import {
  ITEM_DESCRIPTION_QUERY,
  documentBlockSchema,
  itemDescriptionSchema,
  parseItemDescription,
} from '../../../src/api/item-description.js';

describe('ITEM_DESCRIPTION_QUERY', () => {
  it('selects items.description with the 4-field DocumentBlock projection', () => {
    expect(ITEM_DESCRIPTION_QUERY).toContain('items(ids: $ids)');
    // Selection-pin assertion mirrors the cassette match_query — if a
    // refactor drops the `description { ... }` block from the document
    // this test fails before reaching CI.
    expect(ITEM_DESCRIPTION_QUERY).toMatch(/description\s*\{/);
    // 4 projected block fields (id / type / content / position) — the
    // narrow surface chosen at D1 closure 2026-05-23. Codex pre-flight
    // R1 P3-1 (W5) tightened the assertion: scope it to the
    // `blocks { ... }` selection so the four named subfields are
    // pinned INSIDE that block (a bare `\bid\b` check is satisfied
    // by `$ids`, the item-row `id`, or the description `id` — a
    // refactor dropping `blocks { id ... }` would still pass).
    expect(ITEM_DESCRIPTION_QUERY).toMatch(
      /blocks\s*\{[^}]*\bid\b[^}]*\btype\b[^}]*\bcontent\b[^}]*\bposition\b/s,
    );
  });

  it('uses the canonical operation name + variable shape ItemGetDescription($ids: [ID!]!)', () => {
    expect(ITEM_DESCRIPTION_QUERY).toContain('ItemGetDescription');
    expect(ITEM_DESCRIPTION_QUERY).toContain('$ids: [ID!]!');
  });
});

describe('documentBlockSchema', () => {
  it('parses a populated wire block (every wire-required key present)', () => {
    const parsed = documentBlockSchema.parse({
      id: 'b1',
      type: 'normal text',
      content: { deltaFormat: [{ insert: 'hello' }] },
      position: 1024,
    });
    expect(parsed).toEqual({
      id: 'b1',
      type: 'normal text',
      content: { deltaFormat: [{ insert: 'hello' }] },
      position: 1024,
    });
  });

  it('accepts null for type / content / position (wire-nullable per 2026-01 introspection)', () => {
    expect(
      documentBlockSchema.parse({ id: 'b2', type: null, content: null, position: null }),
    ).toEqual({ id: 'b2', type: null, content: null, position: null });
  });

  it('rejects an empty id (wire-NON_NULL String)', () => {
    expect(() =>
      documentBlockSchema.parse({ id: '', type: 't', content: {}, position: 0 }),
    ).toThrow();
  });

  it('rejects unknown keys (.strict() — guards against silent shape drift)', () => {
    expect(() =>
      documentBlockSchema.parse({
        id: 'b3',
        type: 't',
        content: {},
        position: 0,
        extra: 'rogue',
      }),
    ).toThrow();
  });

  it('rejects undefined content (jsonScalarOrNull guard — fixture cannot silently omit a wire-selected JSON-scalar field)', () => {
    // `z.unknown()` would accept missing keys (the Zod quirk M52
    // documented under R-v0.9-NEW-10); the helper rejects undefined
    // explicitly so an absent key surfaces at the parse boundary.
    expect(() =>
      documentBlockSchema.parse({ id: 'b4', type: 't', position: 0 }),
    ).toThrow();
  });
});

describe('itemDescriptionSchema', () => {
  it('parses a populated description (non-null id + non-empty blocks)', () => {
    const parsed = itemDescriptionSchema.parse({
      id: '8781640',
      blocks: [
        { id: 'b1', type: 'normal text', content: null, position: 1 },
      ],
    });
    expect(parsed.id).toBe('8781640');
    expect(parsed.blocks).toHaveLength(1);
  });

  it('parses the sentinel shape {id: null, blocks: []} that parseItemDescription synthesises for the wire-null case', () => {
    expect(itemDescriptionSchema.parse({ id: null, blocks: [] })).toEqual({
      id: null,
      blocks: [],
    });
  });

  it('rejects unknown keys (.strict())', () => {
    expect(() =>
      itemDescriptionSchema.parse({ id: 'x', blocks: [], extra: 1 }),
    ).toThrow();
  });
});

describe('parseItemDescription', () => {
  it('normalises a wire-null description to {id: null, blocks: []}', () => {
    expect(parseItemDescription(null, { item_id: '99' })).toEqual({
      id: null,
      blocks: [],
    });
  });

  it('normalises undefined the same way (defensive — Monday occasionally omits a wire-nullable key)', () => {
    expect(parseItemDescription(undefined, { item_id: '99' })).toEqual({
      id: null,
      blocks: [],
    });
  });

  it('round-trips a populated description verbatim', () => {
    const block = { id: 'b1', type: 'normal text', content: null, position: 0 };
    const parsed = parseItemDescription(
      { id: '42', blocks: [block] },
      { item_id: '12345' },
    );
    expect(parsed).toEqual({ id: '42', blocks: [block] });
  });

  it('wraps a shape-drift failure as ApiError(internal_error) with details (R18 parse-boundary)', () => {
    // `blocks: 'not-an-array'` violates the schema; a bare ZodError
    // would lose the failing field path through the runner's catch-
    // all. The unwrapOrThrow wrap surfaces `details.issues` + the
    // caller-supplied `details.item_id` per `validation.md` "Never
    // bubble raw ZodError out of a parse boundary".
    try {
      parseItemDescription(
        { id: '42', blocks: 'not-an-array' },
        { item_id: '12345' },
      );
      throw new Error('expected ApiError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('internal_error');
      expect((err as ApiError).message).toMatch(/malformed item-description/);
      const details = (err as ApiError).details as
        | { item_id?: unknown; issues?: unknown[] }
        | undefined;
      expect(details?.item_id).toBe('12345');
      expect(Array.isArray(details?.issues)).toBe(true);
    }
  });

  it('preserves agent-supplied details on the error envelope so the failing item is identifiable', () => {
    try {
      parseItemDescription(
        { id: 42 },
        { item_id: '999', extra: 'context' },
      );
      throw new Error('expected ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const details = (err as ApiError).details as
        | { item_id?: unknown; extra?: unknown }
        | undefined;
      expect(details?.item_id).toBe('999');
      expect(details?.extra).toBe('context');
    }
  });
});
