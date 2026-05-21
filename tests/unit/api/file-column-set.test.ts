/**
 * Unit tests for `src/api/file-column-set.ts` — file-column
 * dispatch leg across v0.6-M38 (single-file) + v0.7-M42 (bulk
 * carve-out fold) + v0.7-M43 (create-time carve-out fold) +
 * v0.8-M46 (multi-file carve-out fold).
 *
 * Coverage:
 *   - Single-file envelope schema (`fileColumnSetOutputSchema`,
 *     v0.6-M38).
 *   - Multi-file envelope schemas (`fileColumnSetMultiOutputSchema`,
 *     v0.8-M46; `bulkFileSetMultiDataSchema`,
 *     `itemCreateWithFilesOutputSchema` co-located in update.ts /
 *     create.ts and parse-tested via dynamic imports below).
 *   - {@link FileColumnSetEntry} type narrowing.
 *   - {@link routeFileColumnDispatch} runtime behaviour:
 *     mutex priority (folded D2 multi-file / D5 bulk / D6 create /
 *     mixed / clean / no-file), `details.reason` discriminators
 *     including the v0.8-M46 `'duplicate_resolved_file_columns'`
 *     guard, callShape gating including the `'item_set'` defensive
 *     unreachable throw.
 *
 * `executeFileColumnSet` runtime body is exercised end-to-end via
 * the M38 integration tests at `tests/integration/commands/item-
 * set.test.ts` (file-dispatch happy path) — it's a thin wrapper
 * around M31's `addFileToColumn` and doesn't merit standalone unit
 * coverage above the integration tests' wire-shape assertions.
 */
import { describe, it, expect } from 'vitest';
import {
  routeFileColumnDispatch,
  fileColumnSetOutputSchema,
  type FileColumnSetEntry,
} from '../../../src/api/file-column-set.js';
import type { ApiError } from '../../../src/utils/errors.js';

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

describe('fileColumnSetMultiOutputSchema (v0.8-M46 single-item multi-file envelope)', () => {
  // v0.8-M46 Codex R1 P2-2 fix: the schema pins the multi-file
  // envelope's contract surface at pre-flight. Runtime emit lifts
  // at IMPL; the schema is the contract IMPL builds against.
  it("accepts a full multi-file envelope shape — operation literal 'add_files_to_columns' (plural) + assets array + applied_file_columns echo", async () => {
    const { fileColumnSetMultiOutputSchema } = await import(
      '../../../src/api/file-column-set.js'
    );
    const valid = {
      operation: 'add_files_to_columns' as const,
      item_id: '12345',
      assets: [
        {
          column_id: 'attachments',
          filename: 'a.pdf',
          file_size_bytes: 1024,
          asset: sampleAsset,
        },
        {
          column_id: 'attachments_2',
          filename: 'b.png',
          file_size_bytes: 2048,
          asset: { ...sampleAsset, id: 'asset-2' },
        },
      ],
      applied_file_columns: ['attachments', 'attachments_2'],
    };
    const result = fileColumnSetMultiOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects a single-element assets array — length ≥ 2 invariant pins the multi-file shape (N=1 routes to single-file fileColumnSetOutputSchema instead)', async () => {
    const { fileColumnSetMultiOutputSchema } = await import(
      '../../../src/api/file-column-set.js'
    );
    const invalid = {
      operation: 'add_files_to_columns' as const,
      item_id: '12345',
      assets: [
        {
          column_id: 'attachments',
          filename: 'a.pdf',
          file_size_bytes: 1024,
          asset: sampleAsset,
        },
      ],
      applied_file_columns: ['attachments'],
    };
    const result = fileColumnSetMultiOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects the single-file `add_file_to_column` operation literal (multi-file envelope discriminator is the PLURAL `add_files_to_columns`)', async () => {
    const { fileColumnSetMultiOutputSchema } = await import(
      '../../../src/api/file-column-set.js'
    );
    const invalid = {
      operation: 'add_file_to_column' as const,
      item_id: '12345',
      assets: [
        {
          column_id: 'attachments',
          filename: 'a.pdf',
          file_size_bytes: 1024,
          asset: sampleAsset,
        },
        {
          column_id: 'attachments_2',
          filename: 'b.png',
          file_size_bytes: 2048,
          asset: sampleAsset,
        },
      ],
      applied_file_columns: ['attachments', 'attachments_2'],
    };
    const result = fileColumnSetMultiOutputSchema.safeParse(invalid);
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

describe('routeFileColumnDispatch (M38 IMPL mutex check)', () => {
  it("returns kind: 'json' when no setEntries are file-typed (standard JSON translator path applies)", () => {
    const result = routeFileColumnDispatch({
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
    const result = routeFileColumnDispatch({
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
    const result = routeFileColumnDispatch({
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

  it("returns kind: 'file_bulk' on item_update_bulk callShape for a clean single-file dispatch (v0.7-M42 D5 carve-out fold; was 'file_set_on_bulk_unsupported' at v0.6-M38)", () => {
    // v0.7-M42 pre-flight contract diff: the v0.6-M38 D5 bulk-file
    // rejection is carved out. Clean bulk-file dispatch returns the
    // new `kind: 'file_bulk'` variant for the action body's per-item
    // multipart fan-out. The `'file_set_on_bulk_unsupported'`
    // discriminator literal stays RESERVED (no test should assert
    // its surfacing on the clean path); multi-file + mixed gates
    // STILL apply on bulk per the universal mutex rules.
    const result = routeFileColumnDispatch({
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
    expect(result).toEqual({
      kind: 'file_bulk',
      columnId: 'attachments',
      rawValue: './report.pdf',
    });
  });

  it("returns kind: 'file_create' on item_create callShape (v0.7-M43 D6 carve-out fold; was 'file_set_on_create_unsupported' usage_error at v0.6-M38)", () => {
    // v0.7-M43 pre-flight: the v0.6-M38 D6 rejection
    // (`'file_set_on_create_unsupported'`) folded — clean single-file
    // create-time dispatch now returns `kind: 'file_create'` for the
    // action body's two-leg `create_item` then `add_file_to_column`
    // helper {@link runItemCreateFileDispatch}. `--name` is allowed
    // here (required on create); the mixed-rule suppression on
    // `'item_create'` callShape lets the clean path through. The
    // `'file_set_on_create_unsupported'` literal stays RESERVED in
    // docstrings (a separate test below regression-guards that it
    // never appears in the runtime throw path).
    const result = routeFileColumnDispatch({
      callShape: 'item_create',
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
    expect(result).toEqual({
      kind: 'file_create',
      columnId: 'attachments',
      rawValue: './report.pdf',
    });
  });

  it("v0.7-M43 mixed-rule asymmetry: item_create + file --set + non-file value --set + --name returns kind: 'file_create' (mixed gate SUPPRESSED on create per D6)", () => {
    // The mixed-rule suppression on `'item_create'` callShape
    // (v0.7-M43 D6 asymmetry) lets non-file value --set entries
    // through because `create_item` natively bundles them into
    // leg-1's `column_values` atomically. The action body splits
    // entries into file (routes to leg-2) vs non-file (bundles
    // into leg-1) — the enforcement layer just signals the dispatch
    // kind here.
    const result = routeFileColumnDispatch({
      callShape: 'item_create',
      setEntries: [
        {
          columnId: 'attachments',
          columnType: 'file',
          rawValue: './report.pdf',
        },
        { columnId: 'status_1', columnType: 'status', rawValue: 'Done' },
      ],
      setRawEntries: [],
      hasName: true,
    });
    expect(result).toEqual({
      kind: 'file_create',
      columnId: 'attachments',
      rawValue: './report.pdf',
    });
  });

  it("v0.7-M43 regression-guard: 'file_set_on_create_unsupported' literal NEVER appears in enforcement throws (literal RESERVED post-D6 fold)", () => {
    // R-v0.7-NEW-4 contract-term checklist (graduated v0.7-M42 IMPL):
    // pre-IMPL framing literals stay reserved post-fold so future
    // contract drift can't silently re-introduce them. Assert across
    // the clean single-file path (`file_create` return), the mixed-
    // suppressed path (still `file_create`), AND the multi-file
    // path (`file_create_multi` return — v0.8-M46 D2 carve-out fold
    // flipped the universal multi-file rejection to a clean
    // dispatch kind on the 3 reachable callShapes including
    // `'item_create'`).
    const clean = routeFileColumnDispatch({
      callShape: 'item_create',
      setEntries: [
        { columnId: 'attachments', columnType: 'file', rawValue: './a.pdf' },
      ],
      setRawEntries: [],
      hasName: true,
    });
    expect(JSON.stringify(clean)).not.toContain(
      'file_set_on_create_unsupported',
    );
    // v0.8-M46 D2 carve-out fold: multi-file on `'item_create'`
    // callShape no longer throws `'multi_file_set_unsupported'`;
    // returns `kind: 'file_create_multi'` for the action body's
    // two-leg-group multi-file dispatch helper. Regression-guard
    // both the M38 reserved literal AND the v0.6 reserved
    // `'file_set_on_create_unsupported'` literal stay absent.
    const multi = routeFileColumnDispatch({
      callShape: 'item_create',
      setEntries: [
        { columnId: 'a', columnType: 'file', rawValue: './a.pdf' },
        { columnId: 'b', columnType: 'file', rawValue: './b.pdf' },
      ],
      setRawEntries: [],
      hasName: true,
    });
    expect(multi.kind).toBe('file_create_multi');
    expect(JSON.stringify(multi)).not.toContain(
      'file_set_on_create_unsupported',
    );
    expect(JSON.stringify(multi)).not.toContain(
      'multi_file_set_unsupported',
    );
  });

  it("v0.8-M46 D2 carve-out fold: returns kind: 'file_multi' on item_update_single callShape for 2+ file --set entries (was 'multi_file_set_unsupported' throw at v0.6-M38)", () => {
    // v0.8-M46 pre-flight contract diff: the v0.6-M38 D2 universal
    // multi-file rejection is carved out for the 3 reachable
    // callShapes (`'item_update_single'` / `'item_update_bulk'` /
    // `'item_create'`). Clean multi-file dispatch returns the new
    // `kind: 'file_multi'` variant carrying the resolved entries
    // (length ≥ 2, argv order). The action body branches into
    // `runItemUpdateSingleFileMultiDispatch` for the per-leg fan-
    // out helper. The `'multi_file_set_unsupported'` literal stays
    // RESERVED across the codebase (no test should assert its
    // surfacing on the clean path for these 3 callShapes).
    const result = routeFileColumnDispatch({
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
    expect(result.kind).toBe('file_multi');
    expect(JSON.stringify(result)).not.toContain('multi_file_set_unsupported');
    if (result.kind === 'file_multi') {
      expect(result.entries).toEqual([
        { columnId: 'attachments', rawValue: './a.pdf' },
        { columnId: 'other_files', rawValue: './b.png' },
      ]);
    }
  });

  it("v0.8-M46 D2 carve-out fold: returns kind: 'file_bulk_multi' on item_update_bulk callShape for 2+ file --set entries", () => {
    const result = routeFileColumnDispatch({
      callShape: 'item_update_bulk',
      setEntries: [
        { columnId: 'a', columnType: 'file', rawValue: './a.pdf' },
        { columnId: 'b', columnType: 'file', rawValue: './b.pdf' },
      ],
      setRawEntries: [],
      hasName: false,
    });
    expect(result.kind).toBe('file_bulk_multi');
    if (result.kind === 'file_bulk_multi') {
      expect(result.entries.length).toBe(2);
      expect(result.entries[0]).toEqual({
        columnId: 'a',
        rawValue: './a.pdf',
      });
    }
  });

  it("v0.8-M46 D2 carve-out fold: returns kind: 'file_create_multi' on item_create callShape for 2+ file --set entries (mixed-rule still suppressed on create)", () => {
    const result = routeFileColumnDispatch({
      callShape: 'item_create',
      setEntries: [
        { columnId: 'a', columnType: 'file', rawValue: './a.pdf' },
        { columnId: 'b', columnType: 'file', rawValue: './b.pdf' },
      ],
      setRawEntries: [],
      hasName: true,
    });
    expect(result.kind).toBe('file_create_multi');
    if (result.kind === 'file_create_multi') {
      expect(result.entries.length).toBe(2);
    }
  });

  it("v0.8-M46 Codex R1 P2-1 fix: rejects duplicate resolved file-column IDs across multi-file entries with 'duplicate_resolved_file_columns' (mirrors JSON path's cross-token duplicate-resolved-ID contract)", () => {
    // v0.8-M46 Codex round-1 P2-1 fix: without this guard, two
    // distinct argv tokens resolving to the same file column would
    // silently dispatch two `add_file_to_column` legs against the
    // same column (the second wire-side replaces the first) AND
    // bypass the JSON path's existing cross-token duplicate-
    // resolved-ID rejection. Mirrors the v0.7-M42 + v0.7-M43
    // partial-failure-envelope discipline by failing fast at the
    // enforcement layer.
    try {
      routeFileColumnDispatch({
        callShape: 'item_update_single',
        setEntries: [
          {
            columnId: 'attachments',
            columnType: 'file',
            rawValue: './a.pdf',
          },
          {
            columnId: 'attachments',
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
      expect(ae.details?.reason).toBe('duplicate_resolved_file_columns');
      expect(ae.details?.column_id).toBe('attachments');
      expect(ae.details?.file_count).toBe(2);
      expect(ae.details?.file_column_ids).toEqual([
        'attachments',
        'attachments',
      ]);
      // Regression-guard: the v0.6 reserved literal stays absent
      // (this is the duplicate-column gate, NOT the multi-file
      // unsupported gate).
      expect(JSON.stringify(ae.details)).not.toContain(
        'multi_file_set_unsupported',
      );
    }
  });

  it("v0.8-M46 defensive: item_set callShape STILL throws 'multi_file_set_unsupported' on 2+ file --set entries (argv-unreachable; kept as type-system ceiling)", () => {
    // `monday item set <iid> <col>=<value>` is single-positional;
    // argv cannot express 2+ file `--set` entries. The throw is
    // unreachable from production argv but kept as defense-in-
    // depth + type-system ceiling. v0.8-M46 carve-out fold lifts
    // the gate on the 3 OTHER callShapes (item_update_single +
    // item_update_bulk + item_create); item_set stays defensive.
    try {
      routeFileColumnDispatch({
        callShape: 'item_set',
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
      expect(ae.details?.call_shape).toBe('item_set');
    }
  });

  it("throws usage_error.details.reason: 'mixed_file_and_value_sets' for file --set + value --set (D2 mixed leg)", () => {
    try {
      routeFileColumnDispatch({
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
      routeFileColumnDispatch({
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
      routeFileColumnDispatch({
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

  it('multi-file gate fires on item_update_bulk callShape (universal rule survives v0.7-M42 D5 carve-out fold; was bulk-gate-first at v0.6-M38)', () => {
    // v0.7-M42 pre-flight: with the D5 bulk-file rejection carved
    // v0.8-M46 D2 carve-out fold: the universal multi-file
    // rejection lifts on `'item_update_bulk'` — clean multi-file
    // dispatch returns `kind: 'file_bulk_multi'` for the per-item
    // multi-leg fan-out helper. The `'multi_file_set_unsupported'`
    // literal stays RESERVED; no test should assert its surfacing
    // on the 3 reachable callShapes post-fold.
    const result = routeFileColumnDispatch({
      callShape: 'item_update_bulk',
      setEntries: [
        { columnId: 'a', columnType: 'file', rawValue: './a.pdf' },
        { columnId: 'b', columnType: 'file', rawValue: './b.pdf' },
      ],
      setRawEntries: [],
      hasName: false,
    });
    expect(result.kind).toBe('file_bulk_multi');
    expect(JSON.stringify(result)).not.toContain('multi_file_set_unsupported');
  });

  it('v0.8-M46: mixed gate STILL fires on item_update_single multi-file + value --set (multi-file carve-out does NOT lift mixed-rule)', () => {
    // v0.8-M46 D5 closure: NO CHANGE to mixed-rule semantics.
    // Multi-file + value --set on `'item_update_single'` STILL
    // rejects with `'mixed_file_and_value_sets'` (multi-file
    // carve-out lifts ONLY the multi-file gate; mixed-rule stays
    // in force on non-create callShapes).
    try {
      routeFileColumnDispatch({
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
      expect(ae.details?.reason).toBe('mixed_file_and_value_sets');
      // v0.8-M46 regression-guard: multi-file rejection literal
      // stays absent (the multi-file gate folded; only the mixed
      // gate fires here).
      expect(JSON.stringify(ae.details)).not.toContain(
        'multi_file_set_unsupported',
      );
    }
  });

  it("throws usage_error.details.reason: 'mixed_file_and_value_sets' on item_update_bulk callShape with file + value --set (v0.7-M42 — mixed mutex stays universal on bulk)", () => {
    // v0.7-M42 carve-out fold flips the BULK-FILE rejection ONLY;
    // the universal mixed-leg mutex still rejects mixing file
    // `--set` with value `--set` / `--set-raw` / `--name` on bulk
    // shapes. Verifies the mutex is a universal rule, not single-
    // item-only.
    try {
      routeFileColumnDispatch({
        callShape: 'item_update_bulk',
        setEntries: [
          { columnId: 'attachments', columnType: 'file', rawValue: './a.pdf' },
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
    }
  });

  it("throws usage_error.details.reason: 'mixed_file_and_value_sets' on item_update_bulk callShape with file --set + --name (v0.7-M42 — mixed mutex stays universal on bulk)", () => {
    // Bulk + file + --name combo: same universal mixed-leg rule.
    try {
      routeFileColumnDispatch({
        callShape: 'item_update_bulk',
        setEntries: [
          { columnId: 'attachments', columnType: 'file', rawValue: './a.pdf' },
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

  it("returns kind: 'json' on item_update_bulk callShape when no file --set entries present (v0.7-M42 — pre-check passes through to JSON path)", () => {
    // Bulk + value-only --set: pre-check returns `kind: 'json'`
    // and the standard JSON translator path continues. No carve-
    // out fold visible — JSON bulk is unchanged from v0.6.
    const result = routeFileColumnDispatch({
      callShape: 'item_update_bulk',
      setEntries: [
        { columnId: 'status_1', columnType: 'status', rawValue: 'Done' },
      ],
      setRawEntries: [],
      hasName: false,
    });
    expect(result).toEqual({ kind: 'json' });
  });
});

describe('routeFileColumnDispatch — v0.8-M47 stdin `<file-col>=-` scope gate (D7 fold)', () => {
  // The stdin sentinel `-` sources the file body from stdin. stdin is a
  // single non-replayable stream, so the contract scopes it to single-
  // file, single-target dispatch: exactly one `=-` per call, as the
  // sole file entry, on `item_update_single` / `item_create`. The three
  // violations reject with `usage_error` + a reserved `details.reason`
  // (no new ERROR_CODE). A clean stdin source routes through the SAME
  // single-file `kind: 'file'` / `'file_create'` as a path source — the
  // rawValue carries `-` and the action body sources from stdin.

  it("returns kind: 'file' for a clean stdin source on item_update_single (rawValue '-')", () => {
    const result = routeFileColumnDispatch({
      callShape: 'item_update_single',
      setEntries: [
        { columnId: 'attachments', columnType: 'file', rawValue: '-' },
      ],
      setRawEntries: [],
      hasName: false,
    });
    expect(result).toEqual({
      kind: 'file',
      columnId: 'attachments',
      rawValue: '-',
    });
  });

  it("returns kind: 'file_create' for a clean stdin source on item_create (rawValue '-')", () => {
    const result = routeFileColumnDispatch({
      callShape: 'item_create',
      setEntries: [
        { columnId: 'attachments', columnType: 'file', rawValue: '-' },
      ],
      setRawEntries: [],
      hasName: false,
    });
    expect(result).toEqual({
      kind: 'file_create',
      columnId: 'attachments',
      rawValue: '-',
    });
  });

  it("throws usage_error.details.reason: 'multiple_stdin_file_sets' for 2+ `=-` entries", () => {
    try {
      routeFileColumnDispatch({
        callShape: 'item_update_single',
        setEntries: [
          { columnId: 'attachments', columnType: 'file', rawValue: '-' },
          { columnId: 'docs', columnType: 'file', rawValue: '-' },
        ],
        setRawEntries: [],
        hasName: false,
      });
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('usage_error');
      expect(ae.details?.reason).toBe('multiple_stdin_file_sets');
      expect(ae.details?.stdin_file_count).toBe(2);
    }
  });

  it("throws usage_error.details.reason: 'stdin_file_set_not_sole_file' for stdin `=-` + a path file --set", () => {
    try {
      routeFileColumnDispatch({
        callShape: 'item_update_single',
        setEntries: [
          { columnId: 'attachments', columnType: 'file', rawValue: '-' },
          { columnId: 'docs', columnType: 'file', rawValue: './b.pdf' },
        ],
        setRawEntries: [],
        hasName: false,
      });
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('usage_error');
      expect(ae.details?.reason).toBe('stdin_file_set_not_sole_file');
      expect(ae.details?.file_count).toBe(2);
      expect(ae.details?.stdin_file_column_id).toBe('attachments');
    }
  });

  it("throws usage_error.details.reason: 'stdin_file_set_on_bulk_unsupported' for `=-` on the bulk callShape", () => {
    try {
      routeFileColumnDispatch({
        callShape: 'item_update_bulk',
        setEntries: [
          { columnId: 'attachments', columnType: 'file', rawValue: '-' },
        ],
        setRawEntries: [],
        hasName: false,
      });
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('usage_error');
      expect(ae.details?.reason).toBe('stdin_file_set_on_bulk_unsupported');
      expect(ae.details?.call_shape).toBe('item_update_bulk');
    }
  });

  it("still applies the mixed mutex to a stdin source: `=-` + value --set rejects 'mixed_file_and_value_sets'", () => {
    // stdin only changes the file SOURCE, not the mutex surface — a
    // clean stdin source falls through to the same mixed/duplicate
    // gates as a path source.
    try {
      routeFileColumnDispatch({
        callShape: 'item_update_single',
        setEntries: [
          { columnId: 'attachments', columnType: 'file', rawValue: '-' },
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
    }
  });
});

describe('bulkFileSetMultiDataSchema (v0.8-M46 bulk multi-file envelope)', () => {
  // v0.8-M46 Codex R2 P3-3 fix: schema parse tests for bulk
  // multi-file envelope (mirrors R1 P2-2 fix pattern from
  // fileColumnSetMultiOutputSchema tests above).
  const buildBulkAsset = (
    columnId: string,
    assetId: string,
  ): {
    column_id: string;
    filename: string;
    file_size_bytes: number;
    asset: { id: string; name: string };
  } => ({
    column_id: columnId,
    filename: 'report.pdf',
    file_size_bytes: 1024,
    asset: { id: assetId, name: 'report.pdf' },
  });

  it("accepts a full bulk multi-file envelope shape — operation literal 'item_update_bulk_file_set_multi' + per-item results + aggregate summary", async () => {
    const { bulkFileSetMultiDataSchema } = await import(
      '../../../src/commands/item/update.js'
    );
    const valid = {
      operation: 'item_update_bulk_file_set_multi' as const,
      summary: {
        matched_count: 2,
        applied_count: 2,
        failed_count: 0,
        board_id: '111',
        file_count: 2,
        file_column_ids: ['attachments', 'attachments_2'],
      },
      results: [
        {
          item_id: '12345',
          ok: true,
          assets: [
            buildBulkAsset('attachments', 'asset-1'),
            buildBulkAsset('attachments_2', 'asset-2'),
          ],
          applied_file_columns: ['attachments', 'attachments_2'],
        },
        {
          item_id: '23456',
          ok: true,
          assets: [
            buildBulkAsset('attachments', 'asset-3'),
            buildBulkAsset('attachments_2', 'asset-4'),
          ],
          applied_file_columns: ['attachments', 'attachments_2'],
        },
      ],
    };
    const result = bulkFileSetMultiDataSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects the single-file 'item_update_bulk_file_set' operation literal (multi shape discriminator is the _multi suffix)", async () => {
    const { bulkFileSetMultiDataSchema } = await import(
      '../../../src/commands/item/update.js'
    );
    const invalid = {
      operation: 'item_update_bulk_file_set' as const,
      summary: {
        matched_count: 1,
        applied_count: 1,
        failed_count: 0,
        board_id: '111',
        file_count: 2,
        file_column_ids: ['attachments', 'attachments_2'],
      },
      results: [],
    };
    const result = bulkFileSetMultiDataSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects file_count < 2 — multi-file invariant pins N ≥ 2 (N=1 routes through M42 single-file bulkFileSetDataSchema instead)', async () => {
    const { bulkFileSetMultiDataSchema } = await import(
      '../../../src/commands/item/update.js'
    );
    const invalid = {
      operation: 'item_update_bulk_file_set_multi' as const,
      summary: {
        matched_count: 1,
        applied_count: 1,
        failed_count: 0,
        board_id: '111',
        file_count: 1,
        file_column_ids: ['attachments'],
      },
      results: [],
    };
    const result = bulkFileSetMultiDataSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('accepts a per-item partial-failure shape (ok: false with applied_file_columns length 0..N-1 + failed_file_column + error)', async () => {
    const { bulkFileSetMultiDataSchema } = await import(
      '../../../src/commands/item/update.js'
    );
    const valid = {
      operation: 'item_update_bulk_file_set_multi' as const,
      summary: {
        matched_count: 1,
        applied_count: 0,
        failed_count: 1,
        board_id: '111',
        file_count: 2,
        file_column_ids: ['attachments', 'attachments_2'],
      },
      results: [
        {
          item_id: '12345',
          ok: false,
          assets: [buildBulkAsset('attachments', 'asset-1')],
          applied_file_columns: ['attachments'],
          failed_file_column: 'attachments_2',
          error: {
            code: 'file_too_large',
            message: 'leg-2 failed: file exceeds the per-asset size cap',
          },
        },
      ],
    };
    const result = bulkFileSetMultiDataSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });
});

describe('itemCreateWithFilesOutputSchema (v0.8-M46 create-time multi-file envelope)', () => {
  // v0.8-M46 Codex R2 P3-3 fix: schema parse tests for create-time
  // multi-file envelope. Codex R2 P2-1 prose mismatch fix: the
  // envelope's `item` slot inlines M43's `ItemCreateOutput` shape
  // (full item projection, NOT a scalar `item_id`).
  it("accepts a full create-time multi-file envelope — operation literal 'item_create_with_files' + item shape + assets array", async () => {
    const { itemCreateWithFilesOutputSchema } = await import(
      '../../../src/commands/item/create.js'
    );
    const valid = {
      operation: 'item_create_with_files' as const,
      item: {
        id: '12345',
        name: 'multi-file create item',
        board_id: '111',
        group_id: 'topics',
      },
      assets: [
        {
          column_id: 'attachments',
          filename: 'a.pdf',
          file_size_bytes: 1024,
          asset: { id: 'asset-1', name: 'a.pdf' },
        },
        {
          column_id: 'attachments_2',
          filename: 'b.png',
          file_size_bytes: 2048,
          asset: { id: 'asset-2', name: 'b.png' },
        },
      ],
      applied_file_columns: ['attachments', 'attachments_2'],
    };
    const result = itemCreateWithFilesOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('v0.8-M46 Codex R2 P2-1 regression-guard: rejects a scalar `item_id` slot in place of the inlined `item` shape — the envelope pins the M43 ItemCreateOutput projection, NOT just the ID', async () => {
    const { itemCreateWithFilesOutputSchema } = await import(
      '../../../src/commands/item/create.js'
    );
    const invalid = {
      operation: 'item_create_with_files' as const,
      item_id: '12345',
      assets: [
        {
          column_id: 'attachments',
          filename: 'a.pdf',
          file_size_bytes: 1024,
          asset: { id: 'asset-1', name: 'a.pdf' },
        },
        {
          column_id: 'attachments_2',
          filename: 'b.png',
          file_size_bytes: 2048,
          asset: { id: 'asset-2', name: 'b.png' },
        },
      ],
      applied_file_columns: ['attachments', 'attachments_2'],
    };
    const result = itemCreateWithFilesOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects the single-file 'item_create' operation literal — multi shape discriminator is the dedicated 'item_create_with_files' literal", async () => {
    const { itemCreateWithFilesOutputSchema } = await import(
      '../../../src/commands/item/create.js'
    );
    const invalid = {
      operation: 'item_create' as const,
      item: {
        id: '12345',
        name: 'x',
        board_id: '111',
        group_id: null,
      },
      assets: [
        {
          column_id: 'attachments',
          filename: 'a.pdf',
          file_size_bytes: 1024,
          asset: { id: 'asset-1', name: 'a.pdf' },
        },
        {
          column_id: 'attachments_2',
          filename: 'b.png',
          file_size_bytes: 2048,
          asset: { id: 'asset-2', name: 'b.png' },
        },
      ],
      applied_file_columns: ['attachments', 'attachments_2'],
    };
    const result = itemCreateWithFilesOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects a single-element assets array — multi-file shape invariant pins N ≥ 2', async () => {
    const { itemCreateWithFilesOutputSchema } = await import(
      '../../../src/commands/item/create.js'
    );
    const invalid = {
      operation: 'item_create_with_files' as const,
      item: {
        id: '12345',
        name: 'x',
        board_id: '111',
        group_id: null,
      },
      assets: [
        {
          column_id: 'attachments',
          filename: 'a.pdf',
          file_size_bytes: 1024,
          asset: { id: 'asset-1', name: 'a.pdf' },
        },
      ],
      applied_file_columns: ['attachments'],
    };
    const result = itemCreateWithFilesOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
