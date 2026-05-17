/**
 * Integration tests for `monday doc import-html --workspace <wid>
 * (--html <file|-> | --html-string <s>) [--folder <fid>] [--kind
 * public|private|share] [--title <t>] [--dry-run]` (v0.5-M37 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'ImportDocFromHtml'`. Coverage axes (D12 5-branch
 * matrix per R-v0.5-NEW-11 per-fetcher null-payload discipline):
 *
 *   - happy path: inline `--html-string` → success envelope `{doc_id,
 *     success: true}`.
 *   - happy path: file `--html <path>` reads + dispatches the payload.
 *   - happy path: stdin `--html -` reads to EOF + dispatches.
 *   - happy path: all optional slots (`--folder` / `--kind` / `--title`)
 *     thread into camelCase wire variables (`folderId` / `kind` /
 *     `title`).
 *   - dry-run: inline / file / stdin variants land the correct
 *     `html_source` descriptor in `planned_changes[0]`.
 *   - usage_error: missing source file (file-read failure wrapped).
 *   - usage_error: file payload exceeds MAX_DOC_IMPORT_PAYLOAD_BYTES
 *     (runtime size guard via lifted `readSourceContent.maxBytes`).
 *   - validation_failed: wire `success: false + error` populated.
 *   - internal_error: wire `success: false + empty error` (regression).
 *   - internal_error: wire `success: true + null doc_id` (per-fetcher
 *     null-payload contract per R-v0.5-NEW-11).
 *   - internal_error: missing root `import_doc_from_html` key
 *     (`assertResponseFieldPresent`).
 *   - internal_error: inner OBJECT drift (unknown key — `.strict()`
 *     mode on `importDocFromHtmlResultSchema`).
 *
 * Per-source wire-side `error` string content (R-v0.5-NEW-15 deferral)
 * is exercised here via realistic cassette fixtures — fills the
 * `docs/output-shapes.md` "Doc-content import error messages"
 * reference table at close-docs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  drive,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

const wireSuccess = (
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  success: true,
  doc_id: '88010',
  error: null,
  ...overrides,
});

describe('monday doc import-html (M37 IMPL)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-import-html-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe('happy path', () => {
    it('inline --html-string: dispatches + emits flat doc envelope', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            match_variables: {
              html: '<h1>Plan</h1>',
              workspaceId: '5555',
            },
            response: { data: { import_doc_from_html: wireSuccess() } },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<h1>Plan</h1>',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { doc_id: string; success: true };
      };
      expect(env.ok).toBe(true);
      expect(env.data.doc_id).toBe('88010');
      expect(env.data.success).toBe(true);
      expect(env.meta.source).toBe('live');
    });

    it('file --html <path>: reads file + dispatches the payload', async () => {
      const path = join(tmpRoot, 'plan.html');
      const payload = '<h1>Plan</h1><p>From disk.</p>';
      await writeFile(path, `${payload}\n`, 'utf8');
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            match_variables: {
              html: payload,
              workspaceId: '5555',
            },
            response: { data: { import_doc_from_html: wireSuccess() } },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html',
          path,
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(0);
    });

    it('stdin --html -: reads to EOF + dispatches', async () => {
      const stdin = Readable.from(['<h1>Plan</h1>', '<p>From stdin</p>\n']);
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            match_variables: {
              html: '<h1>Plan</h1><p>From stdin</p>',
              workspaceId: '5555',
            },
            response: { data: { import_doc_from_html: wireSuccess() } },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html',
          '-',
          '--json',
        ],
        cassette,
        { stdin },
      );
      expect(out.exitCode).toBe(0);
    });

    it('threads --folder + --kind + --title into camelCase wire variables', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            match_variables: {
              html: '<h1>Confidential</h1>',
              workspaceId: '5555',
              folderId: '12345',
              kind: 'private',
              title: 'Q4 plan',
            },
            response: {
              data: {
                import_doc_from_html: wireSuccess({ doc_id: '88011' }),
              },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<h1>Confidential</h1>',
          '--folder',
          '12345',
          '--kind',
          'private',
          '--title',
          'Q4 plan',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { doc_id: string };
      };
      expect(env.data.doc_id).toBe('88011');
    });
  });

  describe('dry-run', () => {
    it('inline source: planned_changes carries html_source: "(inline)"', async () => {
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<h1>x</h1>',
          '--dry-run',
          '--json',
        ],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(0);
      expect(out.requests).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        planned_changes: readonly Record<string, unknown>[];
      };
      expect(env.planned_changes[0]).toEqual({
        operation: 'import_doc_from_html',
        workspace_id: '5555',
        html_source: '(inline)',
      });
      expect(env.meta.source).toBe('none');
    });

    it('file source: planned_changes carries html_source: <path>', async () => {
      const path = join(tmpRoot, 'plan.html');
      // File doesn't need to exist for dry-run — the path is reported
      // as-is from argv without reading.
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html',
          path,
          '--dry-run',
          '--json',
        ],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        planned_changes: readonly Record<string, unknown>[];
      };
      expect(env.planned_changes[0]?.html_source).toBe(path);
    });

    it('stdin source: planned_changes carries html_source: "(stdin)"', async () => {
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html',
          '-',
          '--dry-run',
          '--json',
        ],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        planned_changes: readonly Record<string, unknown>[];
      };
      expect(env.planned_changes[0]?.html_source).toBe('(stdin)');
    });

    it('threads optional --folder/--kind/--title into planned shape', async () => {
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<h1>x</h1>',
          '--folder',
          '12345',
          '--kind',
          'private',
          '--title',
          'Q4 plan',
          '--dry-run',
          '--json',
        ],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        planned_changes: readonly Record<string, unknown>[];
      };
      expect(env.planned_changes[0]).toEqual({
        operation: 'import_doc_from_html',
        workspace_id: '5555',
        html_source: '(inline)',
        folder_id: '12345',
        kind: 'private',
        title: 'Q4 plan',
      });
    });
  });

  describe('source-read failures (usage_error)', () => {
    it('surfaces usage_error when --html file does not exist', async () => {
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html',
          join(tmpRoot, 'missing.html'),
          '--json',
        ],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr);
      expect(env.error?.code).toBe('usage_error');
      expect(out.requests).toBe(0);
    });

    it('surfaces usage_error when --html file exceeds the runtime size guard', async () => {
      // 256_001 bytes — one byte over MAX_DOC_IMPORT_PAYLOAD_BYTES.
      // Schema's `.refine()` only checks inline; the file path's
      // runtime guard via `readSourceContent.maxBytes` is the
      // defense-in-depth check.
      const path = join(tmpRoot, 'too-big.html');
      await writeFile(path, 'x'.repeat(256_001), 'utf8');
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html',
          path,
          '--json',
        ],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: Record<string, unknown> };
      };
      expect(env.error?.code).toBe('usage_error');
      expect(env.error?.details?.source).toBe('file');
      expect(env.error?.details?.size_bytes).toBe(256_001);
      expect(env.error?.details?.limit_bytes).toBe(256_000);
      expect(out.requests).toBe(0);
    });
  });

  describe('wire failure projection (D12 5-branch matrix)', () => {
    it('validation_failed when wire success: false + populated error', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            response: {
              data: {
                import_doc_from_html: {
                  success: false,
                  doc_id: null,
                  error: 'invalid HTML structure at line 12',
                },
              },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<unclosed',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: Record<string, unknown> };
      };
      expect(env.error?.code).toBe('validation_failed');
      expect(env.error?.details?.workspace_id).toBe('5555');
      expect(env.error?.details?.error).toBe('invalid HTML structure at line 12');
    });

    it('internal_error when wire success: false + null error (regression)', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            response: {
              data: {
                import_doc_from_html: {
                  success: false,
                  doc_id: null,
                  error: null,
                },
              },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<h1>x</h1>',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: Record<string, unknown> };
      };
      expect(env.error?.code).toBe('internal_error');
      expect(env.error?.details?.workspace_id).toBe('5555');
    });

    it('internal_error when wire success: false + empty error string (regression)', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            response: {
              data: {
                import_doc_from_html: {
                  success: false,
                  doc_id: null,
                  error: '',
                },
              },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<h1>x</h1>',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string };
      };
      expect(env.error?.code).toBe('internal_error');
    });

    it('internal_error when wire success: true + null doc_id (per-fetcher null-payload contract)', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            response: {
              data: {
                import_doc_from_html: {
                  success: true,
                  doc_id: null,
                  error: null,
                },
              },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<h1>x</h1>',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: Record<string, unknown> };
      };
      expect(env.error?.code).toBe('internal_error');
      expect(env.error?.details?.workspace_id).toBe('5555');
    });
  });

  describe('schema-drift internal_error', () => {
    it('internal_error when import_doc_from_html root key is missing', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            response: { data: { other_root: 'unexpected' } },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<h1>x</h1>',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
    });

    it('internal_error when inner OBJECT carries an unknown key (.strict() drift)', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            response: {
              data: {
                import_doc_from_html: {
                  success: true,
                  doc_id: '88010',
                  error: null,
                  unexpected_extra_key: 'wire drifted',
                },
              },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<h1>x</h1>',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
    });

    it('internal_error when import_doc_from_html payload is null', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'ImportDocFromHtml',
            response: { data: { import_doc_from_html: null } },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'import-html',
          '--workspace',
          '5555',
          '--html-string',
          '<h1>x</h1>',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: Record<string, unknown> };
      };
      expect(env.error?.code).toBe('internal_error');
      expect(env.error?.details?.workspace_id).toBe('5555');
    });
  });
});
