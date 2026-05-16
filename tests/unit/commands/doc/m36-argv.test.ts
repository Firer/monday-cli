/**
 * Argv parser unit tests for the v0.5-M36 per-block CRUD pre-flight
 * surface (cli-design §4.3 DOC section + §13 v0.5 entry;
 * v0.5-plan §3 M36 + §8 D10-D11).
 *
 * Test matrix scope: per-verb input-schema parse-boundary surface
 * — required-flag absence, optional-flag presence/absence, brand-
 * validation (DocId numeric / DocBlockId opaque non-empty string),
 * 16-value `DocBlockContentType` closed-enum rejection at parse,
 * JSON-content parse via `parseJsonArg` (success + invalid JSON).
 * Schema-level branch-rejection is the agent contract surface per
 * cli-design §6.5 (`usage_error.details.issues[]`); the runtime
 * body (wire dispatch + envelope emit) lands at v0.5-M36 IMPL with
 * integration tests there.
 *
 * **Destructive-gate path on `block-delete`** is covered by the
 * `confirmation_required` envelope snapshot at
 * `tests/integration/envelope-snapshots.test.ts:"doc block-delete
 * (confirmation_required without --yes / --dry-run)"`, NOT by
 * this file — the gate lives in the action body's pre-c8 prelude
 * (after `parseArgv`, before the c8-ignored stub throw), not in
 * the input schema. The schema-only tests below cover the parse-
 * boundary surface; the action-body gate ordering is exercised by
 * the integration runner.
 */
import { describe, expect, it } from 'vitest';
import { docBlockCreateCommand } from '../../../../src/commands/doc/block-create.js';
import { docBlockUpdateCommand } from '../../../../src/commands/doc/block-update.js';
import { docBlockDeleteCommand } from '../../../../src/commands/doc/block-delete.js';
import {
  DOC_BLOCK_CONTENT_TYPE_VALUES,
  docBlockContentTypeSchema,
  documentBlockIdOnlySchema,
} from '../../../../src/api/documents.js';
import { UsageError } from '../../../../src/utils/errors.js';
import { parseArgv } from '../../../../src/commands/parse-argv.js';
import { parseJsonArg } from '../../../../src/utils/json.js';

describe('docBlockCreateCommand.inputSchema (M36 block-create argv)', () => {
  it('parses a minimal valid argv', () => {
    const parsed = parseArgv(docBlockCreateCommand.inputSchema, {
      docId: '88010',
      type: 'normal_text',
      content: '{"alignment":"left","content":"Hello"}',
    });
    expect(parsed.docId).toBe('88010');
    expect(parsed.type).toBe('normal_text');
    expect(parsed.content).toBe('{"alignment":"left","content":"Hello"}');
    expect(parsed.after).toBeUndefined();
    expect(parsed.parent).toBeUndefined();
  });

  it('parses argv with every optional slot', () => {
    const parsed = parseArgv(docBlockCreateCommand.inputSchema, {
      docId: '88010',
      type: 'code',
      content: '{"language":"ts","code":"x"}',
      after: 'blk_abc123',
      parent: 'blk_layout1',
    });
    expect(parsed.after).toBe('blk_abc123');
    expect(parsed.parent).toBe('blk_layout1');
  });

  it('rejects missing <doc-id>', () => {
    expect(() =>
      parseArgv(docBlockCreateCommand.inputSchema, {
        type: 'normal_text',
        content: '{}',
      }),
    ).toThrow(UsageError);
  });

  it('rejects non-numeric <doc-id> via DocId brand', () => {
    expect(() =>
      parseArgv(docBlockCreateCommand.inputSchema, {
        docId: 'not-numeric',
        type: 'normal_text',
        content: '{}',
      }),
    ).toThrow(UsageError);
  });

  it('rejects missing --type', () => {
    expect(() =>
      parseArgv(docBlockCreateCommand.inputSchema, {
        docId: '88010',
        content: '{}',
      }),
    ).toThrow(UsageError);
  });

  it('rejects unknown --type values at parse boundary (D10 closure)', () => {
    expect(() =>
      parseArgv(docBlockCreateCommand.inputSchema, {
        docId: '88010',
        type: 'not-a-block-type' as never,
        content: '{}',
      }),
    ).toThrow(UsageError);
  });

  it.each(DOC_BLOCK_CONTENT_TYPE_VALUES)('accepts --type %s', (type) => {
    const parsed = parseArgv(docBlockCreateCommand.inputSchema, {
      docId: '88010',
      type,
      content: '{}',
    });
    expect(parsed.type).toBe(type);
  });

  it('rejects missing --content', () => {
    expect(() =>
      parseArgv(docBlockCreateCommand.inputSchema, {
        docId: '88010',
        type: 'normal_text',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --content', () => {
    expect(() =>
      parseArgv(docBlockCreateCommand.inputSchema, {
        docId: '88010',
        type: 'normal_text',
        content: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --after via DocBlockId brand', () => {
    expect(() =>
      parseArgv(docBlockCreateCommand.inputSchema, {
        docId: '88010',
        type: 'normal_text',
        content: '{}',
        after: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --parent via DocBlockId brand', () => {
    expect(() =>
      parseArgv(docBlockCreateCommand.inputSchema, {
        docId: '88010',
        type: 'normal_text',
        content: '{}',
        parent: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(docBlockCreateCommand.inputSchema, {
        docId: '88010',
        type: 'normal_text',
        content: '{}',
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(docBlockCreateCommand.name).toBe('doc.block-create');
  });

  it('declares idempotent: false (Monday allows duplicate blocks at the same anchor)', () => {
    expect(docBlockCreateCommand.idempotent).toBe(false);
  });
});

describe('docBlockUpdateCommand.inputSchema (M36 block-update argv)', () => {
  it('parses a valid argv', () => {
    const parsed = parseArgv(docBlockUpdateCommand.inputSchema, {
      blockId: 'blk_abc123',
      content: '{"alignment":"center","content":"Hi"}',
    });
    expect(parsed.blockId).toBe('blk_abc123');
    expect(parsed.content).toBe('{"alignment":"center","content":"Hi"}');
  });

  it('rejects missing <block-id>', () => {
    expect(() =>
      parseArgv(docBlockUpdateCommand.inputSchema, {
        content: '{}',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty <block-id> via DocBlockId brand', () => {
    expect(() =>
      parseArgv(docBlockUpdateCommand.inputSchema, {
        blockId: '',
        content: '{}',
      }),
    ).toThrow(UsageError);
  });

  it('rejects missing --content', () => {
    expect(() =>
      parseArgv(docBlockUpdateCommand.inputSchema, {
        blockId: 'blk_abc123',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --content', () => {
    expect(() =>
      parseArgv(docBlockUpdateCommand.inputSchema, {
        blockId: 'blk_abc123',
        content: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(docBlockUpdateCommand.inputSchema, {
        blockId: 'blk_abc123',
        content: '{}',
        type: 'normal_text',
      }),
    ).toThrow(UsageError);
  });

  it('does NOT accept a --type slot (Monday\'s wire has no type arg on update_doc_block)', () => {
    // Schema's strict mode rejects unknown keys; `type` is one such
    // key on `block-update`. Agents needing to change a block's
    // content type use `block-delete` + `block-create` (lossy).
    expect(() =>
      parseArgv(docBlockUpdateCommand.inputSchema, {
        blockId: 'blk_abc123',
        content: '{}',
        type: 'code' as never,
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(docBlockUpdateCommand.name).toBe('doc.block-update');
  });

  it('declares idempotent: true (Monday wire is a no-op when content matches)', () => {
    expect(docBlockUpdateCommand.idempotent).toBe(true);
  });
});

describe('docBlockDeleteCommand.inputSchema (M36 block-delete argv)', () => {
  it('parses a valid argv', () => {
    const parsed = parseArgv(docBlockDeleteCommand.inputSchema, {
      blockId: 'blk_abc123',
    });
    expect(parsed.blockId).toBe('blk_abc123');
  });

  it('rejects missing <block-id>', () => {
    expect(() =>
      parseArgv(docBlockDeleteCommand.inputSchema, {}),
    ).toThrow(UsageError);
  });

  it('rejects empty <block-id> via DocBlockId brand', () => {
    expect(() =>
      parseArgv(docBlockDeleteCommand.inputSchema, { blockId: '' }),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(docBlockDeleteCommand.inputSchema, {
        blockId: 'blk_abc123',
        yes: true,
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(docBlockDeleteCommand.name).toBe('doc.block-delete');
  });

  it('declares idempotent: false (re-deletes surface not_found)', () => {
    expect(docBlockDeleteCommand.idempotent).toBe(false);
  });
});

describe('DOC_BLOCK_CONTENT_TYPE_VALUES (M36 closed enum, D10 closure)', () => {
  it('exposes exactly 16 values', () => {
    expect(DOC_BLOCK_CONTENT_TYPE_VALUES).toHaveLength(16);
  });

  it('matches the v0.5 empirical probe vocabulary verbatim', () => {
    // Probe report at `scripts/probe/v0.5-inputs-and-results.report.txt`
    // pins the 16 values; the CLI surface must mirror them character-
    // for-character so unknown values reject at parse and known values
    // surface untouched to Monday's wire.
    expect([...DOC_BLOCK_CONTENT_TYPE_VALUES].sort()).toEqual(
      [
        'bulleted_list',
        'check_list',
        'code',
        'divider',
        'image',
        'large_title',
        'layout',
        'medium_title',
        'normal_text',
        'notice_box',
        'numbered_list',
        'page_break',
        'quote',
        'small_title',
        'table',
        'video',
      ].sort(),
    );
  });

  it('docBlockContentTypeSchema accepts every enum value', () => {
    for (const value of DOC_BLOCK_CONTENT_TYPE_VALUES) {
      expect(docBlockContentTypeSchema.parse(value)).toBe(value);
    }
  });

  it('docBlockContentTypeSchema rejects unknown values', () => {
    expect(docBlockContentTypeSchema.safeParse('not-a-block').success).toBe(false);
    expect(docBlockContentTypeSchema.safeParse('').success).toBe(false);
  });
});

describe('documentBlockIdOnlySchema (M36 delete return shape)', () => {
  it('accepts the single-field {id} shape', () => {
    const parsed = documentBlockIdOnlySchema.parse({ id: 'blk_abc123' });
    expect(parsed.id).toBe('blk_abc123');
  });

  it('rejects an empty id', () => {
    expect(documentBlockIdOnlySchema.safeParse({ id: '' }).success).toBe(false);
  });

  it('rejects missing id', () => {
    expect(documentBlockIdOnlySchema.safeParse({}).success).toBe(false);
  });

  it('rejects extra keys (strict)', () => {
    expect(
      documentBlockIdOnlySchema.safeParse({ id: 'blk_abc123', extra: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('parseJsonArg via --content boundary (M36 R-NEW-42 consumer-4/5)', () => {
  // The command action body parses `--content` via parseJsonArg
  // BEFORE the c8-ignored stub throw (R-NEW-76 discipline). The
  // helper's own branches are covered exhaustively in
  // `tests/unit/utils/json.test.ts`; the tests below confirm the
  // helper integrates correctly at the M36 argv boundary.

  it('parses a valid JSON object string', () => {
    const parsed = parseJsonArg('{"alignment":"left","content":"x"}', {
      context: '--content must be a valid JSON-encoded string',
      details: { doc_id: '88010' },
    });
    expect(parsed).toEqual({ alignment: 'left', content: 'x' });
  });

  it('parses a valid JSON array string', () => {
    const parsed = parseJsonArg('["a","b","c"]', {
      context: '--content must be a valid JSON-encoded string',
      details: { block_id: 'blk_abc123' },
    });
    expect(parsed).toEqual(['a', 'b', 'c']);
  });

  it('rejects malformed JSON as UsageError', () => {
    expect(() =>
      parseJsonArg('{invalid', {
        context: '--content must be a valid JSON-encoded string',
        details: { doc_id: '88010' },
      }),
    ).toThrow(UsageError);
  });
});
