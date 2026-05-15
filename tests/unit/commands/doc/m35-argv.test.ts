/**
 * Argv parser unit tests for the v0.5-M35 doc-level CRUD pre-flight
 * surface (cli-design §4.3 DOC section + §13 v0.5 entry;
 * v0.5-plan §3 M35 + §8 D7-D9).
 *
 * Test matrix scope: per-verb input-schema parse-boundary surface
 * — required-flag absence, optional-flag presence/absence,
 * brand-validation (DocId / WorkspaceId / DocFolderId / ItemId /
 * ColumnId), and DocKind / DuplicateType closed-enum rejection at
 * the parse boundary. Schema-level branch-rejection is the agent
 * contract surface per cli-design §6.5 (`usage_error.details.
 * issues[]`); the runtime body (wire dispatch + opaque-JSON
 * projection + destructive-gate emit) lands at v0.5-M35 IMPL with
 * integration tests there.
 */
import { describe, expect, it } from 'vitest';
import { docCreateInWorkspaceCommand } from '../../../../src/commands/doc/create-in-workspace.js';
import { docCreateOnColumnCommand } from '../../../../src/commands/doc/create-on-column.js';
import { docRenameCommand } from '../../../../src/commands/doc/rename.js';
import { docDeleteCommand } from '../../../../src/commands/doc/delete.js';
import { docDuplicateCommand } from '../../../../src/commands/doc/duplicate.js';
import {
  DOC_KIND_VALUES,
  DUPLICATE_TYPE_VALUES,
  docMutationResultSchema,
  duplicateTypeSchema,
} from '../../../../src/api/documents.js';
import { UsageError } from '../../../../src/utils/errors.js';
import { parseArgv } from '../../../../src/commands/parse-argv.js';

describe('docCreateInWorkspaceCommand.inputSchema (M35 create-in-workspace argv)', () => {
  it('parses a minimal valid argv', () => {
    const parsed = parseArgv(docCreateInWorkspaceCommand.inputSchema, {
      workspace: '5555',
      name: 'Q4 launch plan',
    });
    expect(parsed.workspace).toBe('5555');
    expect(parsed.name).toBe('Q4 launch plan');
    expect(parsed.folder).toBeUndefined();
    expect(parsed.kind).toBeUndefined();
  });

  it('parses argv with every optional slot', () => {
    const parsed = parseArgv(docCreateInWorkspaceCommand.inputSchema, {
      workspace: '5555',
      name: 'Q4 launch plan',
      folder: '12345',
      kind: 'private',
    });
    expect(parsed.folder).toBe('12345');
    expect(parsed.kind).toBe('private');
  });

  it('rejects missing --workspace', () => {
    expect(() =>
      parseArgv(docCreateInWorkspaceCommand.inputSchema, {
        name: 'no workspace',
      }),
    ).toThrow(UsageError);
  });

  it('rejects missing --name', () => {
    expect(() =>
      parseArgv(docCreateInWorkspaceCommand.inputSchema, {
        workspace: '5555',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --name', () => {
    expect(() =>
      parseArgv(docCreateInWorkspaceCommand.inputSchema, {
        workspace: '5555',
        name: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects non-numeric --workspace via WorkspaceId brand', () => {
    expect(() =>
      parseArgv(docCreateInWorkspaceCommand.inputSchema, {
        workspace: 'not-numeric',
        name: 'foo',
      }),
    ).toThrow(UsageError);
  });

  it('rejects non-numeric --folder via DocFolderId brand', () => {
    expect(() =>
      parseArgv(docCreateInWorkspaceCommand.inputSchema, {
        workspace: '5555',
        name: 'foo',
        folder: 'not-numeric',
      }),
    ).toThrow(UsageError);
  });

  it('rejects unknown --kind values', () => {
    expect(() =>
      parseArgv(docCreateInWorkspaceCommand.inputSchema, {
        workspace: '5555',
        name: 'foo',
        kind: 'something-else' as never,
      }),
    ).toThrow(UsageError);
  });

  it.each(DOC_KIND_VALUES)('accepts --kind %s', (kind) => {
    const parsed = parseArgv(docCreateInWorkspaceCommand.inputSchema, {
      workspace: '5555',
      name: 'foo',
      kind,
    });
    expect(parsed.kind).toBe(kind);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(docCreateInWorkspaceCommand.inputSchema, {
        workspace: '5555',
        name: 'foo',
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('rejects board-variant slots `item` / `column` (D7 mutual-exclusion guard)', () => {
    // D7 closure splits Monday's mutually-exclusive `CreateDocInput`
    // (`board` vs `workspace`) into two CLI verbs. The workspace
    // verb's strict schema must reject the board-variant slots
    // outright so the argv boundary catches a mis-targeted invocation
    // before the wire call.
    expect(() =>
      parseArgv(docCreateInWorkspaceCommand.inputSchema, {
        workspace: '5555',
        name: 'foo',
        item: '12345',
      }),
    ).toThrow(UsageError);
    expect(() =>
      parseArgv(docCreateInWorkspaceCommand.inputSchema, {
        workspace: '5555',
        name: 'foo',
        column: 'doc_column_1',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(docCreateInWorkspaceCommand.name).toBe('doc.create-in-workspace');
  });

  it('declares idempotent: false (Monday allows duplicate-named docs)', () => {
    expect(docCreateInWorkspaceCommand.idempotent).toBe(false);
  });
});

describe('docCreateOnColumnCommand.inputSchema (M35 create-on-column argv)', () => {
  it('parses a valid argv', () => {
    const parsed = parseArgv(docCreateOnColumnCommand.inputSchema, {
      item: '12345',
      column: 'doc_column_1',
    });
    expect(parsed.item).toBe('12345');
    expect(parsed.column).toBe('doc_column_1');
  });

  it('rejects missing --item', () => {
    expect(() =>
      parseArgv(docCreateOnColumnCommand.inputSchema, {
        column: 'doc_column_1',
      }),
    ).toThrow(UsageError);
  });

  it('rejects missing --column', () => {
    expect(() =>
      parseArgv(docCreateOnColumnCommand.inputSchema, {
        item: '12345',
      }),
    ).toThrow(UsageError);
  });

  it('rejects non-numeric --item via ItemId brand', () => {
    expect(() =>
      parseArgv(docCreateOnColumnCommand.inputSchema, {
        item: 'not-numeric',
        column: 'doc_column_1',
      }),
    ).toThrow(UsageError);
  });

  it('accepts non-numeric --column slug (column IDs are slugs, not numeric)', () => {
    const parsed = parseArgv(docCreateOnColumnCommand.inputSchema, {
      item: '12345',
      column: 'doc_column_1',
    });
    expect(parsed.column).toBe('doc_column_1');
  });

  it('rejects empty --column slug', () => {
    expect(() =>
      parseArgv(docCreateOnColumnCommand.inputSchema, {
        item: '12345',
        column: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(docCreateOnColumnCommand.inputSchema, {
        item: '12345',
        column: 'doc_column_1',
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('rejects workspace-variant slots `workspace` / `folder` / `kind` / `name` (D7 mutual-exclusion guard)', () => {
    // D7 closure: column verb's strict schema must reject every
    // workspace-variant slot outright so the argv boundary catches
    // mis-targeted invocations before the wire call.
    expect(() =>
      parseArgv(docCreateOnColumnCommand.inputSchema, {
        item: '12345',
        column: 'doc_column_1',
        workspace: '5555',
      }),
    ).toThrow(UsageError);
    expect(() =>
      parseArgv(docCreateOnColumnCommand.inputSchema, {
        item: '12345',
        column: 'doc_column_1',
        folder: '67890',
      }),
    ).toThrow(UsageError);
    expect(() =>
      parseArgv(docCreateOnColumnCommand.inputSchema, {
        item: '12345',
        column: 'doc_column_1',
        kind: 'public',
      }),
    ).toThrow(UsageError);
    expect(() =>
      parseArgv(docCreateOnColumnCommand.inputSchema, {
        item: '12345',
        column: 'doc_column_1',
        name: 'doc name',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(docCreateOnColumnCommand.name).toBe('doc.create-on-column');
  });

  it('declares idempotent: false', () => {
    expect(docCreateOnColumnCommand.idempotent).toBe(false);
  });
});

describe('docRenameCommand.inputSchema (M35 rename argv)', () => {
  it('parses a valid argv', () => {
    const parsed = parseArgv(docRenameCommand.inputSchema, {
      docId: '12345678',
      name: 'Q4 launch plan (revised)',
    });
    expect(parsed.docId).toBe('12345678');
    expect(parsed.name).toBe('Q4 launch plan (revised)');
  });

  it('rejects missing positional <docId>', () => {
    expect(() =>
      parseArgv(docRenameCommand.inputSchema, {
        name: 'no doc id',
      }),
    ).toThrow(UsageError);
  });

  it('rejects missing --name', () => {
    expect(() =>
      parseArgv(docRenameCommand.inputSchema, {
        docId: '12345678',
      }),
    ).toThrow(UsageError);
  });

  it('rejects empty --name', () => {
    expect(() =>
      parseArgv(docRenameCommand.inputSchema, {
        docId: '12345678',
        name: '',
      }),
    ).toThrow(UsageError);
  });

  it('rejects non-numeric docId via DocId brand', () => {
    expect(() =>
      parseArgv(docRenameCommand.inputSchema, {
        docId: 'not-numeric',
        name: 'foo',
      }),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(docRenameCommand.inputSchema, {
        docId: '12345678',
        name: 'foo',
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(docRenameCommand.name).toBe('doc.rename');
  });

  it('declares idempotent: true (rename converges to a stable name)', () => {
    expect(docRenameCommand.idempotent).toBe(true);
  });
});

describe('docDeleteCommand.inputSchema (M35 delete argv)', () => {
  it('parses a valid argv', () => {
    const parsed = parseArgv(docDeleteCommand.inputSchema, {
      docId: '12345678',
    });
    expect(parsed.docId).toBe('12345678');
  });

  it('rejects missing docId', () => {
    expect(() =>
      parseArgv(docDeleteCommand.inputSchema, {}),
    ).toThrow(UsageError);
  });

  it('rejects non-numeric docId via DocId brand', () => {
    expect(() =>
      parseArgv(docDeleteCommand.inputSchema, {
        docId: 'not-numeric',
      }),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(docDeleteCommand.inputSchema, {
        docId: '12345678',
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(docDeleteCommand.name).toBe('doc.delete');
  });

  it('declares idempotent: false (destructive; re-running surfaces not_found)', () => {
    expect(docDeleteCommand.idempotent).toBe(false);
  });
});

describe('docDuplicateCommand.inputSchema (M35 duplicate argv)', () => {
  it('parses argv with no --with-updates flag', () => {
    const parsed = parseArgv(docDuplicateCommand.inputSchema, {
      docId: '12345678',
    });
    expect(parsed.docId).toBe('12345678');
    expect(parsed.withUpdates).toBeUndefined();
  });

  it('parses argv with --with-updates true', () => {
    const parsed = parseArgv(docDuplicateCommand.inputSchema, {
      docId: '12345678',
      withUpdates: true,
    });
    expect(parsed.withUpdates).toBe(true);
  });

  it('rejects missing docId', () => {
    expect(() =>
      parseArgv(docDuplicateCommand.inputSchema, {}),
    ).toThrow(UsageError);
  });

  it('rejects non-numeric docId via DocId brand', () => {
    expect(() =>
      parseArgv(docDuplicateCommand.inputSchema, {
        docId: 'not-numeric',
      }),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(docDuplicateCommand.inputSchema, {
        docId: '12345678',
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(docDuplicateCommand.name).toBe('doc.duplicate');
  });

  it('declares idempotent: false (each run mints a new DocId)', () => {
    expect(docDuplicateCommand.idempotent).toBe(false);
  });
});

describe('docMutationResultSchema (M35 D9 opaque-JSON projection)', () => {
  it('accepts a valid result', () => {
    const parsed = docMutationResultSchema.parse({
      doc_id: '12345678',
      success: true,
    });
    expect(parsed.doc_id).toBe('12345678');
    expect(parsed.success).toBe(true);
  });

  it('rejects success: false (literal-true pin per D9)', () => {
    expect(() =>
      docMutationResultSchema.parse({
        doc_id: '12345678',
        success: false,
      }),
    ).toThrow();
  });

  it('rejects empty doc_id', () => {
    expect(() =>
      docMutationResultSchema.parse({
        doc_id: '',
        success: true,
      }),
    ).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() =>
      docMutationResultSchema.parse({
        doc_id: '12345678',
        success: true,
        extra: 'rejected',
      }),
    ).toThrow();
  });
});

describe('duplicateTypeSchema (M35 DuplicateType closed enum)', () => {
  it.each(DUPLICATE_TYPE_VALUES)('accepts wire value %s', (value) => {
    const parsed = duplicateTypeSchema.parse(value);
    expect(parsed).toBe(value);
  });

  it('rejects unknown enum values', () => {
    expect(() => duplicateTypeSchema.parse('duplicate_doc')).toThrow();
  });

  it('enumerates the documented 2-value vocabulary', () => {
    expect(DUPLICATE_TYPE_VALUES).toEqual([
      'duplicate_doc_with_content',
      'duplicate_doc_with_content_and_updates',
    ]);
  });
});
