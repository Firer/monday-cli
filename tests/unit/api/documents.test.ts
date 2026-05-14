/**
 * Schema-level unit tests for `src/api/documents.ts` v0.4-M32
 * pre-flight surface. Pins the wire-response-parse contract for
 * `documentSchema` / `documentBlockSchema` / `documentWithBlocksSchema`
 * / `docListOutputSchema` / `docGetOutputSchema` — agents reading
 * the M32 envelope key off the strict-object shape, so a missing
 * required key has to surface a typed parse error rather than
 * silently passing through.
 *
 * Specifically pins Codex round-1 P2-2 fix — Monday's `settings`
 * (Document) + `content` (DocumentBlock) wire slots are `JSON`
 * scalars whose runtime values can be any JSON shape (object /
 * array / string / number / boolean / null). The schema uses a
 * `requiredJsonValueSchema` (`z.unknown().refine(v !== undefined)`)
 * so a missing key fails the parse — bare `z.unknown()` would
 * silently accept omission and weaken the 13-field / 9-field
 * contract pin.
 *
 * Runtime fetcher behaviour (the `internal_error` stub throws)
 * lives in the M32 IMPL integration test surface; this unit suite
 * stays narrow to the schemas + their parse-boundary semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  documentBlockSchema,
  documentSchema,
  documentWithBlocksSchema,
  docListOutputSchema,
  docGetOutputSchema,
  DOC_KIND_VALUES,
  DOCS_ORDER_BY,
  DEFAULT_DOC_LIST_LIMIT,
  DEFAULT_DOCS_ORDER_BY,
  MAX_DOC_LIST_LIMIT,
  MIN_DOC_LIST_LIMIT,
} from '../../../src/api/documents.js';

const validBlock = {
  id: 'block-1',
  type: 'text',
  content: { text: 'hello' },
  position: 1.0,
  parent_block_id: null,
  doc_id: '12345',
  created_at: '2026-01-01T00:00:00Z',
  created_by: { id: '1', name: 'Alice' },
  updated_at: '2026-01-01T00:00:00Z',
};

const validDocument = {
  id: '12345',
  object_id: '67890',
  name: 'Sample',
  doc_kind: 'private',
  url: 'https://example.monday.com/docs/12345',
  relative_url: '/docs/12345',
  workspace_id: '5555',
  workspace: { id: '5555', name: 'Marketing' },
  doc_folder_id: null,
  created_at: '2026-01-01T00:00:00Z',
  created_by: { id: '1', name: 'Alice' },
  updated_at: '2026-01-01T00:00:00Z',
  settings: null,
};

describe('documents.ts schemas', () => {
  describe('documentBlockSchema (9 fields; Monday wire shape)', () => {
    it('accepts a complete block with non-null content', () => {
      expect(documentBlockSchema.safeParse(validBlock).success).toBe(true);
    });

    it('accepts null content (Monday returns null for empty-payload blocks)', () => {
      const parsed = documentBlockSchema.safeParse({
        ...validBlock,
        content: null,
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts every JSON shape Monday may surface for `content`', () => {
      for (const payload of [
        { text: 'hello' },
        ['item-1', 'item-2'],
        'plain string',
        42,
        true,
        null,
      ]) {
        const parsed = documentBlockSchema.safeParse({
          ...validBlock,
          content: payload,
        });
        expect(parsed.success).toBe(true);
      }
    });

    // Codex round-1 P2-2 regression — bare `z.unknown()` would
    // silently accept a missing `content` key; the
    // `requiredJsonValueSchema` rejects undefined explicitly so a
    // wire response that omits `content` fails the parse boundary
    // rather than reaching agents as a present-but-undefined slot.
    it('REJECTS a missing content key (required JSON slot)', () => {
      const { content: _omitted, ...rest } = validBlock;
      void _omitted;
      const parsed = documentBlockSchema.safeParse(rest);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const paths = parsed.error.issues.map((i) => i.path.join('.'));
        expect(paths).toContain('content');
      }
    });

    it('REJECTS extra keys (strict object)', () => {
      const parsed = documentBlockSchema.safeParse({
        ...validBlock,
        unknown_field: 'oops',
      });
      expect(parsed.success).toBe(false);
    });

    it('REJECTS an empty id', () => {
      expect(
        documentBlockSchema.safeParse({ ...validBlock, id: '' }).success,
      ).toBe(false);
    });
  });

  describe('documentSchema (13 base fields)', () => {
    it('accepts a complete Document with null settings', () => {
      expect(documentSchema.safeParse(validDocument).success).toBe(true);
    });

    it('accepts every JSON shape Monday may surface for `settings`', () => {
      for (const payload of [
        { sharing: 'public' },
        ['flag-1'],
        'plain string',
        42,
        true,
        null,
      ]) {
        const parsed = documentSchema.safeParse({
          ...validDocument,
          settings: payload,
        });
        expect(parsed.success).toBe(true);
      }
    });

    // Codex round-1 P2-2 regression — same shape as the
    // `content` test above.
    it('REJECTS a missing settings key (required JSON slot)', () => {
      const { settings: _omitted, ...rest } = validDocument;
      void _omitted;
      const parsed = documentSchema.safeParse(rest);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const paths = parsed.error.issues.map((i) => i.path.join('.'));
        expect(paths).toContain('settings');
      }
    });

    it('REJECTS an unknown `doc_kind` (closed enum per D2 closure)', () => {
      const parsed = documentSchema.safeParse({
        ...validDocument,
        doc_kind: 'guest',
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts every documented doc_kind value', () => {
      for (const kind of DOC_KIND_VALUES) {
        const parsed = documentSchema.safeParse({
          ...validDocument,
          doc_kind: kind,
        });
        expect(parsed.success).toBe(true);
      }
    });

    it('REJECTS extra keys (strict object — blocks would be a drift here)', () => {
      const parsed = documentSchema.safeParse({
        ...validDocument,
        blocks: [],
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts null workspace + workspace_id slots', () => {
      const parsed = documentSchema.safeParse({
        ...validDocument,
        workspace: null,
        workspace_id: null,
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe('documentWithBlocksSchema (= documentSchema + blocks)', () => {
    it('accepts a Document with an empty blocks array', () => {
      const parsed = documentWithBlocksSchema.safeParse({
        ...validDocument,
        blocks: [],
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts a Document with a populated blocks array', () => {
      const parsed = documentWithBlocksSchema.safeParse({
        ...validDocument,
        blocks: [validBlock],
      });
      expect(parsed.success).toBe(true);
    });

    it('REJECTS a missing blocks key (D6 — `doc get` envelope ships blocks)', () => {
      const parsed = documentWithBlocksSchema.safeParse(validDocument);
      expect(parsed.success).toBe(false);
    });

    it('REJECTS a null blocks slot (must be empty array on success)', () => {
      const parsed = documentWithBlocksSchema.safeParse({
        ...validDocument,
        blocks: null,
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('docListOutputSchema (wrapped paginated record per D9)', () => {
    const validList = {
      documents: [validDocument],
      page: 1,
      limit: DEFAULT_DOC_LIST_LIMIT,
      returned_count: 1,
      has_more: false,
    };

    it('accepts a complete list envelope', () => {
      expect(docListOutputSchema.safeParse(validList).success).toBe(true);
    });

    it('accepts an empty documents array', () => {
      const parsed = docListOutputSchema.safeParse({
        ...validList,
        documents: [],
        returned_count: 0,
      });
      expect(parsed.success).toBe(true);
    });

    it('REJECTS limit below the floor', () => {
      const parsed = docListOutputSchema.safeParse({
        ...validList,
        limit: MIN_DOC_LIST_LIMIT - 1,
      });
      expect(parsed.success).toBe(false);
    });

    it('REJECTS limit above the ceiling', () => {
      const parsed = docListOutputSchema.safeParse({
        ...validList,
        limit: MAX_DOC_LIST_LIMIT + 1,
      });
      expect(parsed.success).toBe(false);
    });

    it('REJECTS page below 1', () => {
      const parsed = docListOutputSchema.safeParse({
        ...validList,
        page: 0,
      });
      expect(parsed.success).toBe(false);
    });

    it('REJECTS a missing has_more (flat shape — NOT nested under summary)', () => {
      const { has_more: _omitted, ...rest } = validList;
      void _omitted;
      const parsed = docListOutputSchema.safeParse(rest);
      expect(parsed.success).toBe(false);
    });

    // Codex round-2 P2-1 regression — the pagination invariants
    // documented in D9 closure (returned_count === documents.length;
    // has_more === (returned_count === limit)) are enforced by a
    // `.superRefine` so an IMPL bug that emits inconsistent
    // pagination data fails parse rather than silently shipping
    // drift through the success envelope.
    it('REJECTS returned_count not equal to documents.length (round-2 P2-1 invariant)', () => {
      const parsed = docListOutputSchema.safeParse({
        ...validList,
        returned_count: 99,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const paths = parsed.error.issues.map((i) => i.path.join('.'));
        expect(paths).toContain('returned_count');
      }
    });

    it('REJECTS has_more=true when returned_count < limit (round-2 P2-1 invariant)', () => {
      const parsed = docListOutputSchema.safeParse({
        ...validList,
        has_more: true,
        // returned_count (1) < limit (25), so has_more must be false
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const paths = parsed.error.issues.map((i) => i.path.join('.'));
        expect(paths).toContain('has_more');
      }
    });

    it('REJECTS has_more=false when returned_count === limit (round-2 P2-1 invariant)', () => {
      // Build a list where returned_count === limit (1 doc, limit=1).
      const parsed = docListOutputSchema.safeParse({
        documents: [validDocument],
        page: 1,
        limit: 1,
        returned_count: 1,
        has_more: false,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const paths = parsed.error.issues.map((i) => i.path.join('.'));
        expect(paths).toContain('has_more');
      }
    });

    it('ACCEPTS has_more=true when returned_count === limit (round-2 P2-1 positive case)', () => {
      const parsed = docListOutputSchema.safeParse({
        documents: [validDocument],
        page: 1,
        limit: 1,
        returned_count: 1,
        has_more: true,
      });
      expect(parsed.success).toBe(true);
    });

    // Round-3 P2-1 — superRefine guard. An out-of-range `limit`
    // must surface ONLY the range violation, not a derived
    // has_more invariant error stacked on top (which would be
    // misleading because the invariant evaluates `returned_count
    // === limit` against the invalid limit value). Without the
    // guard, `{ limit: 0, returned_count: 0, has_more: false }`
    // would emit both `limit` (too_small) AND `has_more` (custom)
    // issues; with the guard, only `limit` (too_small) surfaces.
    it('REJECTS invalid limit with ONLY the range violation, not the derived has_more error (round-3 P2-1 guard)', () => {
      const parsed = docListOutputSchema.safeParse({
        documents: [],
        page: 1,
        limit: 0,
        returned_count: 0,
        has_more: false,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const paths = parsed.error.issues.map((i) => i.path.join('.'));
        const codes = parsed.error.issues.map((i) => i.code);
        // The limit-floor violation must fire.
        expect(paths).toContain('limit');
        // The has_more derived invariant must NOT fire — the guard
        // short-circuits when limit is out of range.
        expect(paths).not.toContain('has_more');
        // And no `custom` issue should be present (only the
        // `too_small` range violation).
        expect(codes).not.toContain('custom');
      }
    });

    it('REJECTS invalid limit ceiling with ONLY the range violation (round-3 P2-1 guard)', () => {
      const parsed = docListOutputSchema.safeParse({
        documents: [],
        page: 1,
        limit: MAX_DOC_LIST_LIMIT + 1,
        returned_count: 0,
        has_more: false,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const paths = parsed.error.issues.map((i) => i.path.join('.'));
        expect(paths).toContain('limit');
        expect(paths).not.toContain('has_more');
        expect(paths).not.toContain('returned_count');
      }
    });
  });

  describe('docGetOutputSchema (= documentWithBlocksSchema direct unwrap per D9)', () => {
    it('accepts a Document with blocks', () => {
      const parsed = docGetOutputSchema.safeParse({
        ...validDocument,
        blocks: [validBlock],
      });
      expect(parsed.success).toBe(true);
    });

    it('REJECTS a Document without blocks (must hydrate per D6)', () => {
      expect(docGetOutputSchema.safeParse(validDocument).success).toBe(false);
    });
  });

  describe('module-level constants', () => {
    it('pins DOCS_ORDER_BY to 2 values per D5 + the empirical probe', () => {
      expect(DOCS_ORDER_BY).toEqual(['created_at', 'used_at']);
    });

    it('pins DOC_KIND_VALUES to 3 values per the BoardKind reuse', () => {
      expect(DOC_KIND_VALUES).toEqual(['public', 'private', 'share']);
    });

    it('pins the limit range floor + ceiling + default per D3', () => {
      expect(MIN_DOC_LIST_LIMIT).toBe(1);
      expect(MAX_DOC_LIST_LIMIT).toBe(100);
      expect(DEFAULT_DOC_LIST_LIMIT).toBe(25);
    });

    it('defaults order-by to created_at (matches Monday wire default)', () => {
      expect(DEFAULT_DOCS_ORDER_BY).toBe('created_at');
    });
  });
});
