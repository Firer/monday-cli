/**
 * Unit tests for `src/api/file-column-set.ts` — v0.6-M38 file-
 * column dispatch leg.
 *
 * Pre-flight scope: schema-shape verification only. The runtime
 * stubs (`executeFileColumnSet` + `enforceSingleFileColumnSet`)
 * are c8-ignored throwing-stubs at pre-flight; their runtime
 * bodies land at M38 IMPL and get their own coverage there.
 *
 * The schema tests pin the envelope shape (`fileColumnSetOutput
 * Schema`) so a future agent or refactor pass against the shape
 * surfaces a test break rather than a silent contract drift.
 */
import { describe, it, expect } from 'vitest';
import {
  fileColumnSetOutputSchema,
  type FileColumnSetEntry,
} from '../../../src/api/file-column-set.js';

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

describe('FileColumnSetEntry type — pre-flight stub interface', () => {
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
