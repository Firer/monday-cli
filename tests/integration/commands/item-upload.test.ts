/**
 * Integration tests for `monday item upload` (v0.4-M31 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` (JSON path —
 * BoardMetadata + ItemBoardLookup) + `MultipartFixtureTransport`
 * (multipart path — `add_file_to_column`). Coverage:
 *   - happy path + multipart wire shape verification
 *   - dry-run shape (no wire calls fire)
 *   - file-not-found + file-empty (file I/O pre-check)
 *   - non-`file` column rejection
 *   - not_found on missing item
 *   - file-too-large rewrap (Monday's FILE_SIZE_LIMIT_EXCEEDED)
 *   - cache invalidation post-upload (board cache file gone)
 */
import {
  chmod,
  mkdtemp,
  rm,
  stat as fsStat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative as relativePath } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../../src/cli/run.js';
import { fixedRequestIdGenerator } from '../../../src/utils/request-id.js';
import { PassThrough } from 'node:stream';
import {
  createInlineFixtureTransport,
  type Interaction,
} from '../../fixtures/load.js';
import {
  createInlineMultipartFixtureTransport,
  type MultipartFixtureTransport,
  type MultipartInteraction,
} from '../../fixtures/multipart-load.js';
import { LEAK_CANARY, parseEnvelope } from '../helpers.js';
import {
  resolveCacheRoot,
  writeEntry,
} from '../../../src/api/cache.js';

interface DriveOpts {
  readonly argv: readonly string[];
  readonly cassette: readonly Interaction[];
  readonly multipartCassette?: readonly MultipartInteraction[];
  readonly xdgRoot: string;
  readonly signal?: AbortSignal;
}

interface DriveResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly multipart: MultipartFixtureTransport;
}

const driveUpload = async ({
  argv,
  cassette,
  multipartCassette,
  xdgRoot,
  signal,
}: DriveOpts): Promise<DriveResult> => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  stderr.on('data', (c: Buffer) => stderrChunks.push(c));
  const multipart = createInlineMultipartFixtureTransport(
    multipartCassette ?? [],
    { assertExhaustive: false },
  );
  const result = await run({
    argv: ['node', 'monday', ...argv],
    env: {
      MONDAY_API_TOKEN: LEAK_CANARY,
      MONDAY_API_URL: 'https://api.monday.com/v2',
      XDG_CACHE_HOME: xdgRoot,
    },
    stdout,
    stderr,
    isTTY: false,
    cliVersion: '0.0.0-test',
    cliDescription: 'CLI under test',
    requestIdGenerator: fixedRequestIdGenerator(['fixed-req-id']),
    clock: () => new Date('2026-04-30T10:00:00Z'),
    transport: createInlineFixtureTransport(cassette, {
      assertExhaustive: false,
    }),
    multipartTransport: multipart,
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    multipart,
  };
};

const sampleBoardMetadata = {
  id: '111',
  name: 'Tasks',
  description: null,
  state: 'active',
  board_kind: 'public',
  board_folder_id: null,
  workspace_id: '5',
  url: null,
  hierarchy_type: null,
  updated_at: null,
  groups: [],
  columns: [
    {
      id: 'files',
      title: 'Attachments',
      type: 'file',
      description: null,
      archived: null,
      settings_str: null,
      width: null,
    },
    {
      id: 'status_1',
      title: 'Status',
      type: 'status',
      description: null,
      archived: null,
      settings_str: '{}',
      width: null,
    },
  ],
};

const itemBoardLookupInteraction: Interaction = {
  operation_name: 'ItemBoardLookup',
  response: { data: { items: [{ id: '12345', board: { id: '111' } }] } },
};

const boardMetadataInteraction: Interaction = {
  operation_name: 'BoardMetadata',
  response: { data: { boards: [sampleBoardMetadata] } },
};

const sampleAsset = {
  id: '555000111',
  name: 'screenshot.png',
  url: 'https://files.monday.com/x/screenshot.png',
  public_url: 'https://share.monday.com/x',
  file_extension: 'png',
  file_size: 12,
  created_at: '2026-05-13T22:55:00Z',
  uploaded_by: { id: '1', name: 'Alice' },
  original_geometry: '40x30',
  url_thumbnail: 'https://files.monday.com/x/screenshot_thumb.png',
};

let xdgRoot: string;
let workdir: string;
let filePath: string;

beforeEach(async () => {
  xdgRoot = await mkdtemp(join(tmpdir(), 'monday-cli-item-upload-int-'));
  workdir = await mkdtemp(join(tmpdir(), 'monday-cli-item-upload-files-'));
  filePath = join(workdir, 'screenshot.png');
  // 12-byte fake PNG header — non-empty so the file_empty pre-check
  // passes; not a real image but enough for the wire fixture.
  await writeFile(
    filePath,
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]),
  );
});

afterEach(async () => {
  await rm(xdgRoot, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

describe('monday item upload (integration, M31 IMPL)', () => {
  it('happy path uploads the file + emits the success envelope with the wire Asset', async () => {
    const out = await driveUpload({
      argv: ['item', 'upload', '12345', '--column', 'files', filePath, '--json'],
      cassette: [itemBoardLookupInteraction, boardMetadataInteraction],
      multipartCassette: [
        {
          operation_name: 'AddFileToColumn',
          match_filename: 'screenshot.png',
          response: { data: { add_file_to_column: sampleAsset } },
        },
      ],
      xdgRoot,
    });
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as ReturnType<
      typeof parseEnvelope
    > & {
      data: {
        operation: string;
        item_id: string;
        column_id: string;
        filename: string;
        file_size_bytes: number;
        asset: { id: string; name: string };
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      operation: 'add_file_to_column',
      item_id: '12345',
      column_id: 'files',
      filename: 'screenshot.png',
      file_size_bytes: 12,
      asset: { id: '555000111', name: 'screenshot.png' },
    });
    expect(env.meta.source).toBe('live');
  });

  it('verifies the multipart wire shape (operationName + variables + filename + bytes)', async () => {
    const out = await driveUpload({
      argv: ['item', 'upload', '12345', '--column', 'files', filePath, '--json'],
      cassette: [itemBoardLookupInteraction, boardMetadataInteraction],
      multipartCassette: [
        {
          operation_name: 'AddFileToColumn',
          response: { data: { add_file_to_column: sampleAsset } },
        },
      ],
      xdgRoot,
    });
    expect(out.exitCode).toBe(0);
    expect(out.multipart.requests).toHaveLength(1);
    const req = out.multipart.requests[0]!;
    expect(req.operationName).toBe('AddFileToColumn');
    expect(req.fileVariableName).toBe('file');
    expect(req.filename).toBe('screenshot.png');
    expect(req.fileSize).toBe(12);
    expect(req.fileType).toBe('image/png');
    expect(req.variables).toMatchObject({
      itemId: '12345',
      columnId: 'files',
      file: null,
    });
    // Bytes round-trip identically (Blob.stream() multi-readability
    // contract — round-7 closure).
    expect(req.fileBytes[0]).toBe(0x89);
    expect(req.fileBytes[1]).toBe(0x50);
  });

  it('--dry-run emits the planned-change envelope without firing wire calls', async () => {
    // Pass the file path as an argv-relative form so the regression
    // test catches a revert from `parsed.file` to `filePath` (round-3
    // P3-1 fix — pre-fix the test fed an absolute path that
    // happened to be both `parsed.file` and the resolved
    // absolute, masking the contract).
    const argvFile = relativePath(process.cwd(), filePath);
    const out = await driveUpload({
      argv: [
        'item',
        'upload',
        '12345',
        '--column',
        'files',
        argvFile,
        '--dry-run',
        '--json',
      ],
      cassette: [],
      multipartCassette: [],
      xdgRoot,
    });
    expect(out.exitCode).toBe(0);
    expect(out.multipart.requests).toHaveLength(0);
    const env = JSON.parse(out.stdout) as {
      ok: boolean;
      data: null;
      meta: { dry_run: boolean; source: string };
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    expect(env.ok).toBe(true);
    expect(env.data).toBeNull();
    expect(env.meta.dry_run).toBe(true);
    expect(env.meta.source).toBe('none');
    expect(env.planned_changes).toHaveLength(1);
    expect(env.planned_changes[0]).toMatchObject({
      operation: 'add_file_to_column',
      item_id: '12345',
      column_id: 'files',
      // file_path is the argv-derived RELATIVE path verbatim, NOT the
      // resolved absolute. cli-design §6.4 + output-shapes sample
      // `"./screenshot.png"` — round-2 P3-2 + round-3 P3-1.
      file_path: argvFile,
      filename: 'screenshot.png',
      file_size_bytes: 12,
    });
    // The argv path WAS relative — pin it so a revert to absolute
    // wouldn't pass.
    expect(argvFile).not.toBe(filePath);
  });

  it('rejects a missing file path with usage_error file_not_readable BEFORE any wire call', async () => {
    const out = await driveUpload({
      argv: [
        'item',
        'upload',
        '12345',
        '--column',
        'files',
        join(workdir, 'does-not-exist.png'),
        '--json',
      ],
      cassette: [],
      multipartCassette: [],
      xdgRoot,
    });
    expect(out.exitCode).toBe(1);
    expect(out.multipart.requests).toHaveLength(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error).toMatchObject({
      details: { reason: 'file_not_readable' },
    });
  });

  it('rejects a directory at the file path with usage_error file_not_readable', async () => {
    const out = await driveUpload({
      argv: ['item', 'upload', '12345', '--column', 'files', workdir, '--json'],
      cassette: [],
      multipartCassette: [],
      xdgRoot,
    });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error).toMatchObject({
      details: { reason: 'file_not_readable' },
    });
  });

  it('rejects an unreadable file with usage_error file_not_readable BEFORE any wire call (round-1 P2-2)', async () => {
    // chmod 000 → fs.access(..., R_OK) rejects with EACCES BEFORE
    // any wire call fires. This catches the round-1 P2-2 case where
    // fs.stat() alone would have passed the pre-check and the
    // failure would have surfaced AFTER lookupItemBoard +
    // resolveColumnWithRefresh wire calls.
    if (process.getuid?.() === 0) {
      // Root bypasses POSIX permission checks; skip in that case so
      // the test stays meaningful in a normal-user shell.
      return;
    }
    const noReadPath = join(workdir, 'noread.png');
    await writeFile(noReadPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await chmod(noReadPath, 0o000);
    try {
      const out = await driveUpload({
        argv: [
          'item',
          'upload',
          '12345',
          '--column',
          'files',
          noReadPath,
          '--json',
        ],
        cassette: [],
        multipartCassette: [],
        xdgRoot,
      });
      expect(out.exitCode).toBe(1);
      expect(out.multipart.requests).toHaveLength(0);
      const env = parseEnvelope(out.stderr);
      expect(env.error?.code).toBe('usage_error');
      expect(env.error).toMatchObject({
        details: { reason: 'file_not_readable' },
      });
    } finally {
      // Restore permissions so afterEach's `rm` can clean up.
      await chmod(noReadPath, 0o600).catch(() => undefined);
    }
  });

  it('rejects a 0-byte file with usage_error file_empty', async () => {
    const emptyPath = join(workdir, 'empty.bin');
    await writeFile(emptyPath, Buffer.alloc(0));
    const out = await driveUpload({
      argv: [
        'item',
        'upload',
        '12345',
        '--column',
        'files',
        emptyPath,
        '--json',
      ],
      cassette: [],
      multipartCassette: [],
      xdgRoot,
    });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error).toMatchObject({
      details: { reason: 'file_empty', file_size_bytes: 0 },
    });
  });

  it('rejects a non-`file` column with unsupported_column_type', async () => {
    const out = await driveUpload({
      argv: [
        'item',
        'upload',
        '12345',
        '--column',
        'status_1',
        filePath,
        '--json',
      ],
      cassette: [itemBoardLookupInteraction, boardMetadataInteraction],
      multipartCassette: [],
      xdgRoot,
    });
    expect(out.exitCode).toBe(2);
    expect(out.multipart.requests).toHaveLength(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unsupported_column_type');
  });

  it('surfaces not_found when the item lookup returns no matching item', async () => {
    const out = await driveUpload({
      argv: ['item', 'upload', '99999', '--column', 'files', filePath, '--json'],
      cassette: [
        {
          operation_name: 'ItemBoardLookup',
          response: { data: { items: [] } },
        },
      ],
      multipartCassette: [],
      xdgRoot,
    });
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('rewraps Monday FILE_SIZE_LIMIT_EXCEEDED as usage_error file_too_large with local file size', async () => {
    const out = await driveUpload({
      argv: ['item', 'upload', '12345', '--column', 'files', filePath, '--json'],
      cassette: [itemBoardLookupInteraction, boardMetadataInteraction],
      multipartCassette: [
        {
          operation_name: 'AddFileToColumn',
          response: {
            errors: [
              {
                message: 'File size limit exceeded',
                extensions: { code: 'FILE_SIZE_LIMIT_EXCEEDED' },
              },
            ],
          },
        },
      ],
      xdgRoot,
    });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error).toMatchObject({
      details: {
        reason: 'file_too_large',
        file_size_bytes: 12,
        filename: 'screenshot.png',
      },
    });
  });

  it('invalidates the parent board cache after a successful upload (single-leg per §8)', async () => {
    // Pre-seed the board cache so we can assert post-upload removal.
    const root = resolveCacheRoot({ env: { XDG_CACHE_HOME: xdgRoot } });
    await writeEntry(root, { kind: 'board', boardId: '111' }, {
      schema_version: 1,
      board: sampleBoardMetadata,
    });
    const cachePath = join(root, 'boards', '111.json');
    await expect(fsStat(cachePath)).resolves.toBeDefined();
    const out = await driveUpload({
      argv: ['item', 'upload', '12345', '--column', 'files', filePath, '--json'],
      cassette: [itemBoardLookupInteraction, boardMetadataInteraction],
      multipartCassette: [
        {
          operation_name: 'AddFileToColumn',
          response: { data: { add_file_to_column: sampleAsset } },
        },
      ],
      xdgRoot,
    });
    expect(out.exitCode).toBe(0);
    await expect(fsStat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an archived column with column_archived (column metadata branch)', async () => {
    const archivedBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          ...sampleBoardMetadata.columns[0],
          id: 'files',
          type: 'file',
          archived: true,
        },
      ],
    };
    const out = await driveUpload({
      argv: ['item', 'upload', '12345', '--column', 'files', filePath, '--json'],
      cassette: [
        itemBoardLookupInteraction,
        {
          operation_name: 'BoardMetadata',
          response: { data: { boards: [archivedBoard] } },
        },
      ],
      multipartCassette: [],
      xdgRoot,
    });
    expect(out.exitCode).toBe(2);
    expect(out.multipart.requests).toHaveLength(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('column_archived');
  });

  it('echoes resolver warnings into the success envelope (column_token_collision branch via id↔title collision)', async () => {
    // Column id `files` collides with another column whose title is
    // `files` (case-folded match). Resolving the token `files` by id
    // wins (id is exact-match) but `detectCollision` surfaces the
    // title-side candidate as a `column_token_collision` warning the
    // action body folds into the envelope. Exercises the
    // `warnings.map(...)` branch in the live emitMutation call.
    const collidingBoard = {
      ...sampleBoardMetadata,
      columns: [
        {
          id: 'files',
          title: 'Attachments',
          type: 'file',
          description: null,
          archived: null,
          settings_str: null,
          width: null,
        },
        {
          id: 'attachments_2',
          title: 'Files',
          type: 'status',
          description: null,
          archived: null,
          settings_str: '{}',
          width: null,
        },
      ],
    };
    const out = await driveUpload({
      argv: ['item', 'upload', '12345', '--column', 'files', filePath, '--json'],
      cassette: [
        itemBoardLookupInteraction,
        {
          operation_name: 'BoardMetadata',
          response: { data: { boards: [collidingBoard] } },
        },
      ],
      multipartCassette: [
        {
          operation_name: 'AddFileToColumn',
          response: { data: { add_file_to_column: sampleAsset } },
        },
      ],
      xdgRoot,
    });
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.warnings).toBeDefined();
    expect(env.warnings?.some((w) => w.code === 'column_token_collision')).toBe(
      true,
    );
  });

  it('SIGINT mid-upload aborts cleanly (exit 130, no envelope on stderr)', async () => {
    // The fixture's delay_ms holds the response open; the test
    // aborts the runner's signal mid-flight via a tagged
    // {kind:'sigint'} reason — the runner short-circuits to exit 130.
    const ctrl = new AbortController();
    const promise = driveUpload({
      argv: ['item', 'upload', '12345', '--column', 'files', filePath, '--json'],
      cassette: [itemBoardLookupInteraction, boardMetadataInteraction],
      multipartCassette: [
        {
          operation_name: 'AddFileToColumn',
          delay_ms: 200,
          response: { data: { add_file_to_column: sampleAsset } },
        },
      ],
      xdgRoot,
      signal: ctrl.signal,
    });
    setTimeout(() => {
      ctrl.abort({ kind: 'sigint' });
    }, 60);
    const out = await promise;
    expect(out.exitCode).toBe(130);
    expect(out.stderr).toBe('');
  }, 5_000);
});
