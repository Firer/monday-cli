/**
 * Unit tests for `src/api/file-column-set.ts` — v0.6-M38 file-
 * column dispatch leg.
 *
 * Coverage:
 *   - Envelope schema shape (`fileColumnSetOutputSchema`).
 *   - {@link FileColumnSetEntry} type narrowing.
 *   - {@link enforceSingleFileColumnSet} runtime behaviour:
 *     mutex priority (bulk / create / multi / mixed / clean / no-file),
 *     D2/D5/D6 reason discriminators, callShape gating.
 *
 * `executeFileColumnSet` runtime body is exercised end-to-end via
 * the M38 integration tests at `tests/integration/commands/item-
 * set.test.ts` (file-dispatch happy path) — it's a thin wrapper
 * around M31's `addFileToColumn` and doesn't merit standalone unit
 * coverage above the integration tests' wire-shape assertions.
 */
import { describe, it, expect } from 'vitest';
import {
  enforceSingleFileColumnSet,
  fileColumnSetOutputSchema,
  type FileColumnSetEntry,
} from '../../../src/api/file-column-set.js';
import { ApiError } from '../../../src/utils/errors.js';

const sampleAsset = {
  id: '555000111',
  name: 'report.pdf',
  url: 'https://files.monday.com/.../report.pdf',
  public_url: 'https://share.monday.com/...',
  file_extension: 'pdf',
  file_size: 84210,
  created_at: '2026-06-01T10:30:00Z',
  uploaded_by: { id: '1', name: 'Alice' },
  original_geometry: null,
  url_thumbnail: null,
};

describe('fileColumnSetOutputSchema (v0.6-M38 file-column dispatch envelope)', () => {
  it('accepts a full envelope shape mirroring M31 item upload', () => {
    const valid = {
      operation: 'add_file_to_column' as const,
      item_id: '12345',
      column_id: 'files',
      filename: 'report.pdf',
      file_size_bytes: 84210,
      asset: sampleAsset,
    };
    const result = fileColumnSetOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects an envelope with wrong operation literal — the slot is pinned `add_file_to_column` (mirrors M31 item upload envelope discriminator)', () => {
    const invalid = {
      operation: 'change_column_value',
      item_id: '12345',
      column_id: 'files',
      filename: 'report.pdf',
      file_size_bytes: 84210,
      asset: sampleAsset,
    };
    const result = fileColumnSetOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects an envelope missing the asset slot — agent needs the wire Asset for downstream reads (Item.assets, etc.)', () => {
    const invalid = {
      operation: 'add_file_to_column' as const,
      item_id: '12345',
      column_id: 'files',
      filename: 'report.pdf',
      file_size_bytes: 84210,
    };
    const result = fileColumnSetOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects a negative file_size_bytes (defensive — fs.stat() never returns negative but the schema pin makes the invariant explicit)', () => {
    const invalid = {
      operation: 'add_file_to_column' as const,
      item_id: '12345',
      column_id: 'files',
      filename: 'report.pdf',
      file_size_bytes: -1,
      asset: sampleAsset,
    };
    const result = fileColumnSetOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects empty strings on item_id / column_id / filename — non-empty is part of the contract pin', () => {
    const invalid = {
      operation: 'add_file_to_column' as const,
      item_id: '',
      column_id: 'files',
      filename: 'report.pdf',
      file_size_bytes: 84210,
      asset: sampleAsset,
    };
    const result = fileColumnSetOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe('FileColumnSetEntry type — interface shape', () => {
  it('compiles with the contract-pinned shape (columnType literal: "file"; rawValue: argv-derived path; filename: basename derived; fileSizeBytes: fs.stat() size)', () => {
    // Compile-time check via type narrowing on the literal slot.
    const entry: FileColumnSetEntry = {
      columnId: 'files',
      columnType: 'file',
      rawValue: './report.pdf',
      filePath: '/home/agent/cwd/report.pdf',
      filename: 'report.pdf',
      fileSizeBytes: 84210,
    };
    expect(entry.columnType).toBe('file');
    expect(entry.rawValue).toBe('./report.pdf');
    expect(entry.filename).toBe('report.pdf');
    expect(entry.fileSizeBytes).toBe(84210);
  });
});

describe('enforceSingleFileColumnSet (M38 IMPL mutex check)', () => {
  it("returns kind: 'json' when no setEntries are file-typed (standard JSON translator path applies)", () => {
    const result = enforceSingleFileColumnSet({
      callShape: 'item_update_single',
      setEntries: [
        { columnId: 'status_1', columnType: 'status', rawValue: 'Done' },
        { columnId: 'text_2', columnType: 'text', rawValue: 'Hello' },
      ],
      setRawEntries: [],
      hasName: false,
    });
    expect(result).toEqual({ kind: 'json' });
  });

  it("returns kind: 'file' for a clean single-file dispatch path on item_update_single (1 file --set, no other flags)", () => {
    const result = enforceSingleFileColumnSet({
      callShape: 'item_update_single',
      setEntries: [
        {
          columnId: 'attachments',
          columnType: 'file',
          rawValue: './report.pdf',
        },
      ],
      setRawEntries: [],
      hasName: false,
    });
    expect(result).toEqual({
      kind: 'file',
      columnId: 'attachments',
      rawValue: './report.pdf',
    });
  });

  it("returns kind: 'file' for a clean dispatch on item_set callShape (single positional)", () => {
    const result = enforceSingleFileColumnSet({
      callShape: 'item_set',
      setEntries: [
        {
          columnId: 'attachments',
          columnType: 'file',
          rawValue: './photo.png',
        },
      ],
      setRawEntries: [],
      hasName: false,
    });
    expect(result).toEqual({
      kind: 'file',
      columnId: 'attachments',
      rawValue: './photo.png',
    });
  });

  it("throws usage_error.details.reason: 'file_set_on_bulk_unsupported' on item_update_bulk callShape (D5 closure)", () => {
    expect(() =>
      enforceSingleFileColumnSet({
        callShape: 'item_update_bulk',
        setEntries: [
          {
            columnId: 'attachments',
            columnType: 'file',
            rawValue: './report.pdf',
          },
        ],
        setRawEntries: [],
        hasName: false,
      }),
    ).toThrow(ApiError);
    try {
      enforceSingleFileColumnSet({
        callShape: 'item_update_bulk',
        setEntries: [
          {
            columnId: 'attachments',
            columnType: 'file',
            rawValue: './report.pdf',
          },
        ],
        setRawEntries: [],
        hasName: false,
      });
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('usage_error');
      expect(ae.details?.reason).toBe('file_set_on_bulk_unsupported');
      expect(ae.details?.column_id).toBe('attachments');
      expect(ae.details?.deferred_to).toBe('v0.6.x');
    }
  });

  it("throws usage_error.details.reason: 'file_set_on_create_unsupported' on item_create callShape (D6 closure)", () => {
    try {
      enforceSingleFileColumnSet({
        callShape: 'item_create',
        setEntries: [
          {
            columnId: 'attachments',
            columnType: 'file',
            rawValue: './report.pdf',
          },
        ],
        setRawEntries: [],
        hasName: false,
      });
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('usage_error');
      expect(ae.details?.reason).toBe('file_set_on_create_unsupported');
      expect(ae.details?.column_id).toBe('attachments');
    }
  });

  it("throws usage_error.details.reason: 'multi_file_set_unsupported' for 2+ file --set entries (D2 multi leg)", () => {
    try {
      enforceSingleFileColumnSet({
        callShape: 'item_update_single',
        setEntries: [
          {
            columnId: 'attachments',
            columnType: 'file',
            rawValue: './a.pdf',
          },
          {
            columnId: 'other_files',
            columnType: 'file',
            rawValue: './b.png',
          },
        ],
        setRawEntries: [],
        hasName: false,
      });
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('usage_error');
      expect(ae.details?.reason).toBe('multi_file_set_unsupported');
      expect(ae.details?.file_count).toBe(2);
      expect(ae.details?.file_column_ids).toEqual(['attachments', 'other_files']);
    }
  });

  it("throws usage_error.details.reason: 'mixed_file_and_value_sets' for file --set + value --set (D2 mixed leg)", () => {
    try {
      enforceSingleFileColumnSet({
        callShape: 'item_update_single',
        setEntries: [
          {
            columnId: 'attachments',
            columnType: 'file',
            rawValue: './report.pdf',
          },
          { columnId: 'status_1', columnType: 'status', rawValue: 'Done' },
        ],
        setRawEntries: [],
        hasName: false,
      });
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('usage_error');
      expect(ae.details?.reason).toBe('mixed_file_and_value_sets');
      expect(ae.details?.non_file_set_count).toBe(1);
      expect(ae.details?.set_raw_count).toBe(0);
      expect(ae.details?.has_name).toBe(false);
    }
  });

  it("throws usage_error.details.reason: 'mixed_file_and_value_sets' for file --set + --set-raw (D2 mixed leg)", () => {
    try {
      enforceSingleFileColumnSet({
        callShape: 'item_update_single',
        setEntries: [
          {
            columnId: 'attachments',
            columnType: 'file',
            rawValue: './report.pdf',
          },
        ],
        setRawEntries: [{ columnId: 'status_1', columnType: 'status' }],
        hasName: false,
      });
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('usage_error');
      expect(ae.details?.reason).toBe('mixed_file_and_value_sets');
      expect(ae.details?.set_raw_count).toBe(1);
    }
  });

  it("throws usage_error.details.reason: 'mixed_file_and_value_sets' for file --set + --name (D2 mixed leg)", () => {
    try {
      enforceSingleFileColumnSet({
        callShape: 'item_update_single',
        setEntries: [
          {
            columnId: 'attachments',
            columnType: 'file',
            rawValue: './report.pdf',
          },
        ],
        setRawEntries: [],
        hasName: true,
      });
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('usage_error');
      expect(ae.details?.reason).toBe('mixed_file_and_value_sets');
      expect(ae.details?.has_name).toBe(true);
    }
  });

  it('bulk gate fires BEFORE multi-file gate (priority: callShape → multi → mixed)', () => {
    try {
      enforceSingleFileColumnSet({
        callShape: 'item_update_bulk',
        setEntries: [
          { columnId: 'a', columnType: 'file', rawValue: './a.pdf' },
          { columnId: 'b', columnType: 'file', rawValue: './b.pdf' },
        ],
        setRawEntries: [],
        hasName: false,
      });
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.details?.reason).toBe('file_set_on_bulk_unsupported');
    }
  });

  it('multi-file gate fires BEFORE mixed gate (priority: multi → mixed)', () => {
    try {
      enforceSingleFileColumnSet({
        callShape: 'item_update_single',
        setEntries: [
          { columnId: 'a', columnType: 'file', rawValue: './a.pdf' },
          { columnId: 'b', columnType: 'file', rawValue: './b.pdf' },
          { columnId: 'status_1', columnType: 'status', rawValue: 'Done' },
        ],
        setRawEntries: [],
        hasName: false,
      });
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.details?.reason).toBe('multi_file_set_unsupported');
    }
  });
});
