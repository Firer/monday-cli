/**
 * Integration tests for `monday update upload` (v0.4-M31 IMPL).
 *
 * Mirrors `item-upload.test.ts` minus the column-resolution leg + the
 * cache-invalidation leg (Updates aren't part of the §8 cache
 * scope; no per-column type check needed). Drives the runtime body
 * via `MultipartFixtureTransport` (the JSON `FixtureTransport` is
 * empty for `update upload` because the verb makes no preliminary
 * JSON wire calls — Update IDs validate via the brand at parse-
 * boundary, then go straight to the multipart dispatch).
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

interface DriveOpts {
  readonly argv: readonly string[];
  readonly cassette?: readonly Interaction[];
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
    transport: createInlineFixtureTransport(cassette ?? [], {
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
  xdgRoot = await mkdtemp(join(tmpdir(), 'monday-cli-update-upload-int-'));
  workdir = await mkdtemp(join(tmpdir(), 'monday-cli-update-upload-files-'));
  filePath = join(workdir, 'screenshot.png');
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

describe('monday update upload (integration, M31 IMPL)', () => {
  it('happy path uploads the file + emits the success envelope with the wire Asset', async () => {
    const out = await driveUpload({
      argv: ['update', 'upload', '987654321', filePath, '--json'],
      multipartCassette: [
        {
          operation_name: 'AddFileToUpdate',
          match_filename: 'screenshot.png',
          response: { data: { add_file_to_update: sampleAsset } },
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
        update_id: string;
        filename: string;
        file_size_bytes: number;
        asset: { id: string };
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      operation: 'add_file_to_update',
      update_id: '987654321',
      filename: 'screenshot.png',
      file_size_bytes: 12,
      asset: { id: '555000111' },
    });
    // No column_id on the update upload data shape.
    expect(env.data).not.toHaveProperty('column_id');
  });

  it('verifies the multipart wire shape (operationName + variables + filename + bytes)', async () => {
    const out = await driveUpload({
      argv: ['update', 'upload', '987654321', filePath, '--json'],
      multipartCassette: [
        {
          operation_name: 'AddFileToUpdate',
          response: { data: { add_file_to_update: sampleAsset } },
        },
      ],
      xdgRoot,
    });
    expect(out.exitCode).toBe(0);
    expect(out.multipart.requests).toHaveLength(1);
    const req = out.multipart.requests[0]!;
    expect(req.operationName).toBe('AddFileToUpdate');
    expect(req.fileVariableName).toBe('file');
    expect(req.filename).toBe('screenshot.png');
    expect(req.fileSize).toBe(12);
    expect(req.variables).toMatchObject({
      updateId: '987654321',
      file: null,
    });
    expect(req.variables).not.toHaveProperty('columnId');
  });

  it('--dry-run emits the planned-change envelope with update_id (no column_id)', async () => {
    const out = await driveUpload({
      argv: ['update', 'upload', '987654321', filePath, '--dry-run', '--json'],
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
      operation: 'add_file_to_update',
      update_id: '987654321',
      // file_path is argv-derived per cli-design §6.4 (round-2 P3-2
      // mirror with item upload).
      file_path: filePath,
      filename: 'screenshot.png',
      file_size_bytes: 12,
    });
    expect(env.planned_changes[0]).not.toHaveProperty('column_id');
  });

  it('rejects a missing file path with usage_error file_not_readable BEFORE any wire call', async () => {
    const out = await driveUpload({
      argv: [
        'update',
        'upload',
        '987654321',
        join(workdir, 'does-not-exist.png'),
        '--json',
      ],
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
      argv: ['update', 'upload', '987654321', workdir, '--json'],
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

  it('rejects an unreadable file with usage_error file_not_readable (round-1 P2-2)', async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const noReadPath = join(workdir, 'noread.png');
    await writeFile(noReadPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await chmod(noReadPath, 0o000);
    try {
      const out = await driveUpload({
        argv: ['update', 'upload', '987654321', noReadPath, '--json'],
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
      await chmod(noReadPath, 0o600).catch(() => undefined);
    }
  });

  it('rejects a 0-byte file with usage_error file_empty', async () => {
    const emptyPath = join(workdir, 'empty.bin');
    await writeFile(emptyPath, Buffer.alloc(0));
    const out = await driveUpload({
      argv: ['update', 'upload', '987654321', emptyPath, '--json'],
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

  it('surfaces not_found when add_file_to_update returns null', async () => {
    const out = await driveUpload({
      argv: ['update', 'upload', '987654321', filePath, '--json'],
      multipartCassette: [
        {
          operation_name: 'AddFileToUpdate',
          response: { data: { add_file_to_update: null } },
        },
      ],
      xdgRoot,
    });
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
    expect(env.error).toMatchObject({
      details: { update_id: '987654321' },
    });
  });

  it('rewraps Monday FILE_SIZE_LIMIT_EXCEEDED as usage_error file_too_large', async () => {
    const out = await driveUpload({
      argv: ['update', 'upload', '987654321', filePath, '--json'],
      multipartCassette: [
        {
          operation_name: 'AddFileToUpdate',
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

  it('SIGINT mid-upload aborts cleanly (exit 130, no envelope on stderr)', async () => {
    const ctrl = new AbortController();
    const promise = driveUpload({
      argv: ['update', 'upload', '987654321', filePath, '--json'],
      multipartCassette: [
        {
          operation_name: 'AddFileToUpdate',
          delay_ms: 200,
          response: { data: { add_file_to_update: sampleAsset } },
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

  it('rejects bad <updateId> argv at parse boundary as usage_error', async () => {
    const out = await driveUpload({
      argv: ['update', 'upload', 'not-a-number', filePath, '--json'],
      multipartCassette: [],
      xdgRoot,
    });
    expect(out.exitCode).toBe(1);
    expect(out.multipart.requests).toHaveLength(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});
