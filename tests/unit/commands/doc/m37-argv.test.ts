/**
 * Argv parser unit tests for the v0.5-M37 doc-content import pre-flight
 * surface (cli-design §4.3 DOC section + §13 v0.5 entry;
 * v0.5-plan §3 M37 + §8 D12-D13).
 *
 * Test matrix scope: per-verb input-schema parse-boundary surface —
 * required-flag absence, optional-flag presence/absence, mutual-
 * exclusion of `--html` / `--html-string` (import-html) +
 * `--markdown` / `--markdown-string` (append-markdown), brand-
 * validation (WorkspaceId / DocId / DocFolderId / DocBlockId),
 * `--kind` 3-value enum, `--html-string` / `--markdown-string`
 * size cap per D13 closure (MAX_DOC_IMPORT_PAYLOAD_BYTES),
 * strict-mode unknown-key rejection. The runtime body (file/stdin
 * read + dispatch + projection per D12) lands at v0.5-M37 IMPL
 * with integration tests there.
 *
 * **No destructive gate at M37** — both verbs are content-creation
 * surfaces; no `confirmation_required` envelope snapshot needed.
 */
import { describe, expect, it } from 'vitest';
import { docImportHtmlCommand } from '../../../../src/commands/doc/import-html.js';
import { docAppendMarkdownCommand } from '../../../../src/commands/doc/append-markdown.js';
import {
  DOC_KIND_VALUES,
  MAX_DOC_IMPORT_PAYLOAD_BYTES,
} from '../../../../src/api/documents.js';
import { UsageError } from '../../../../src/utils/errors.js';
import { parseArgv } from '../../../../src/commands/parse-argv.js';

describe('docImportHtmlCommand.inputSchema (M37 import-html argv)', () => {
  it('parses a minimal valid argv with --html-string', () => {
    const parsed = parseArgv(docImportHtmlCommand.inputSchema, {
      workspace: '5555',
      htmlString: '<h1>Hello</h1>',
    });
    expect(parsed.workspace).toBe('5555');
    expect(parsed.htmlString).toBe('<h1>Hello</h1>');
    expect(parsed.html).toBeUndefined();
    expect(parsed.folder).toBeUndefined();
    expect(parsed.kind).toBeUndefined();
    expect(parsed.title).toBeUndefined();
  });

  it('parses a minimal valid argv with --html file path', () => {
    const parsed = parseArgv(docImportHtmlCommand.inputSchema, {
      workspace: '5555',
      html: './plan.html',
    });
    expect(parsed.html).toBe('./plan.html');
    expect(parsed.htmlString).toBeUndefined();
  });

  it('parses --html `-` for stdin', () => {
    const parsed = parseArgv(docImportHtmlCommand.inputSchema, {
      workspace: '5555',
      html: '-',
    });
    expect(parsed.html).toBe('-');
  });

  it('parses argv with every optional slot', () => {
    const parsed = parseArgv(docImportHtmlCommand.inputSchema, {
      workspace: '5555',
      htmlString: '<h1>x</h1>',
      folder: '12345',
      kind: 'private',
      title: 'Q4 plan',
    });
    expect(parsed.folder).toBe('12345');
    expect(parsed.kind).toBe('private');
    expect(parsed.title).toBe('Q4 plan');
  });

  it('rejects missing --workspace', () => {
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        htmlString: '<h1>x</h1>',
      }),
    ).toThrow(UsageError);
  });

  it('rejects non-numeric --workspace via WorkspaceId brand', () => {
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: 'not-numeric',
        htmlString: '<h1>x</h1>',
      }),
    ).toThrow(UsageError);
  });

  it('rejects both --html and --html-string (mutex)', () => {
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: '5555',
        html: './plan.html',
        htmlString: '<h1>x</h1>',
      }),
    ).toThrow(UsageError);
  });

  it('rejects neither --html nor --html-string (mutex)', () => {
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: '5555',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --html-string', () => {
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: '5555',
        htmlString: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --html', () => {
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: '5555',
        html: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects oversized --html-string per D13 (MAX_DOC_IMPORT_PAYLOAD_BYTES)', () => {
    // One byte over the cap — sized in ASCII so byte-count === string.length.
    const oversized = 'x'.repeat(MAX_DOC_IMPORT_PAYLOAD_BYTES + 1);
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: '5555',
        htmlString: oversized,
      }),
    ).toThrow(UsageError);
  });

  it('accepts --html-string at exactly the cap', () => {
    const atCap = 'x'.repeat(MAX_DOC_IMPORT_PAYLOAD_BYTES);
    const parsed = parseArgv(docImportHtmlCommand.inputSchema, {
      workspace: '5555',
      htmlString: atCap,
    });
    expect(Buffer.byteLength(parsed.htmlString ?? '', 'utf8')).toBe(
      MAX_DOC_IMPORT_PAYLOAD_BYTES,
    );
  });

  it('measures --html-string against UTF-8 byte length, NOT UTF-16 code units', () => {
    // Multi-byte UTF-8 chars (each "✓" is 3 bytes). string.length would
    // underestimate; the schema's byte-length refine catches it.
    const chunkSize = Math.floor(MAX_DOC_IMPORT_PAYLOAD_BYTES / 3) + 1;
    const oversizedMultiByte = '✓'.repeat(chunkSize);
    expect(oversizedMultiByte.length).toBeLessThan(MAX_DOC_IMPORT_PAYLOAD_BYTES);
    expect(Buffer.byteLength(oversizedMultiByte, 'utf8')).toBeGreaterThan(
      MAX_DOC_IMPORT_PAYLOAD_BYTES,
    );
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: '5555',
        htmlString: oversizedMultiByte,
      }),
    ).toThrow(UsageError);
  });

  it.each(DOC_KIND_VALUES)('accepts --kind %s', (kind) => {
    const parsed = parseArgv(docImportHtmlCommand.inputSchema, {
      workspace: '5555',
      htmlString: '<h1>x</h1>',
      kind,
    });
    expect(parsed.kind).toBe(kind);
  });

  it('rejects unknown --kind values at parse boundary', () => {
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: '5555',
        htmlString: '<h1>x</h1>',
        kind: 'not-a-kind' as never,
      }),
    ).toThrow(UsageError);
  });

  it('rejects non-numeric --folder via DocFolderId brand', () => {
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: '5555',
        htmlString: '<h1>x</h1>',
        folder: 'not-numeric',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --title', () => {
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: '5555',
        htmlString: '<h1>x</h1>',
        title: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(docImportHtmlCommand.inputSchema, {
        workspace: '5555',
        htmlString: '<h1>x</h1>',
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(docImportHtmlCommand.name).toBe('doc.import-html');
  });

  it('declares idempotent: false (Monday does not dedupe by content or title)', () => {
    expect(docImportHtmlCommand.idempotent).toBe(false);
  });
});

describe('docAppendMarkdownCommand.inputSchema (M37 append-markdown argv)', () => {
  it('parses a minimal valid argv with --markdown-string', () => {
    const parsed = parseArgv(docAppendMarkdownCommand.inputSchema, {
      docId: '88010',
      markdownString: '# Heading\n\nBody.',
    });
    expect(parsed.docId).toBe('88010');
    expect(parsed.markdownString).toBe('# Heading\n\nBody.');
    expect(parsed.markdown).toBeUndefined();
    expect(parsed.after).toBeUndefined();
  });

  it('parses a minimal valid argv with --markdown file path', () => {
    const parsed = parseArgv(docAppendMarkdownCommand.inputSchema, {
      docId: '88010',
      markdown: './notes.md',
    });
    expect(parsed.markdown).toBe('./notes.md');
    expect(parsed.markdownString).toBeUndefined();
  });

  it('parses --markdown `-` for stdin', () => {
    const parsed = parseArgv(docAppendMarkdownCommand.inputSchema, {
      docId: '88010',
      markdown: '-',
    });
    expect(parsed.markdown).toBe('-');
  });

  it('parses argv with --after anchor', () => {
    const parsed = parseArgv(docAppendMarkdownCommand.inputSchema, {
      docId: '88010',
      markdownString: '# x',
      after: 'blk_anchor',
    });
    expect(parsed.after).toBe('blk_anchor');
  });

  it('rejects missing <doc-id>', () => {
    expect(() =>
      parseArgv(docAppendMarkdownCommand.inputSchema, {
        markdownString: '# x',
      }),
    ).toThrow(UsageError);
  });

  it('rejects non-numeric <doc-id> via DocId brand', () => {
    expect(() =>
      parseArgv(docAppendMarkdownCommand.inputSchema, {
        docId: 'not-numeric',
        markdownString: '# x',
      }),
    ).toThrow(UsageError);
  });

  it('rejects both --markdown and --markdown-string (mutex)', () => {
    expect(() =>
      parseArgv(docAppendMarkdownCommand.inputSchema, {
        docId: '88010',
        markdown: './notes.md',
        markdownString: '# x',
      }),
    ).toThrow(UsageError);
  });

  it('rejects neither --markdown nor --markdown-string (mutex)', () => {
    expect(() =>
      parseArgv(docAppendMarkdownCommand.inputSchema, {
        docId: '88010',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --markdown-string', () => {
    expect(() =>
      parseArgv(docAppendMarkdownCommand.inputSchema, {
        docId: '88010',
        markdownString: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --markdown', () => {
    expect(() =>
      parseArgv(docAppendMarkdownCommand.inputSchema, {
        docId: '88010',
        markdown: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects oversized --markdown-string per D13', () => {
    const oversized = 'x'.repeat(MAX_DOC_IMPORT_PAYLOAD_BYTES + 1);
    expect(() =>
      parseArgv(docAppendMarkdownCommand.inputSchema, {
        docId: '88010',
        markdownString: oversized,
      }),
    ).toThrow(UsageError);
  });

  it('accepts --markdown-string at exactly the cap', () => {
    const atCap = 'x'.repeat(MAX_DOC_IMPORT_PAYLOAD_BYTES);
    const parsed = parseArgv(docAppendMarkdownCommand.inputSchema, {
      docId: '88010',
      markdownString: atCap,
    });
    expect(Buffer.byteLength(parsed.markdownString ?? '', 'utf8')).toBe(
      MAX_DOC_IMPORT_PAYLOAD_BYTES,
    );
  });

  it('rejects empty --after via DocBlockId brand', () => {
    expect(() =>
      parseArgv(docAppendMarkdownCommand.inputSchema, {
        docId: '88010',
        markdownString: '# x',
        after: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(docAppendMarkdownCommand.inputSchema, {
        docId: '88010',
        markdownString: '# x',
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(docAppendMarkdownCommand.name).toBe('doc.append-markdown');
  });

  it('declares idempotent: false (Monday does not dedupe append operations)', () => {
    expect(docAppendMarkdownCommand.idempotent).toBe(false);
  });
});
