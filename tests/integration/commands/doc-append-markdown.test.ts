/**
 * Integration tests for `monday doc append-markdown <doc-id>
 * (--markdown <file|-> | --markdown-string <s>) [--after <bid>]
 * [--dry-run]` (v0.5-M37 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'AddContentToDocFromMarkdown'`. Coverage axes
 * mirror `doc-import-html.test.ts` 5-branch D12 matrix +
 * `append-markdown`-specific cases:
 *
 *   - happy path: inline / file / stdin sources.
 *   - happy path: echoed input `doc_id` in envelope (NOT extracted
 *     from wire payload — agents key off the parent doc context).
 *   - happy path: `--after <bid>` threads into wire `afterBlockId`.
 *   - happy path: empty `block_ids: []` on `success: true` IS a valid
 *     success shape (markdown with zero convertible blocks; CLI does
 *     NOT rewrap as failure).
 *   - dry-run: inline / file / stdin variants land the correct
 *     `markdown_source` descriptor + optional `after_block_id`.
 *   - usage_error: missing source file / oversized file payload.
 *   - validation_failed / internal_error 5-branch matrix per D12.
 *   - schema drift on inner OBJECT + missing root key.
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
  block_ids: ['blk_001', 'blk_002'],
  error: null,
  ...overrides,
});

describe('monday doc append-markdown (M37 IMPL)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-append-markdown-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe('happy path', () => {
    it('inline --markdown-string: dispatches + emits echoed-doc-id envelope with block_ids', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            match_variables: {
              docId: '88010',
              markdown: '# Heading\n\nBody.',
            },
            response: {
              data: { add_content_to_doc_from_markdown: wireSuccess() },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown-string',
          '# Heading\n\nBody.',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: {
          doc_id: string;
          block_ids: readonly string[];
          success: true;
        };
      };
      expect(env.ok).toBe(true);
      // Doc id is echoed from input — NOT extracted from wire.
      expect(env.data.doc_id).toBe('88010');
      expect(env.data.block_ids).toEqual(['blk_001', 'blk_002']);
      expect(env.data.success).toBe(true);
      expect(env.meta.source).toBe('live');
    });

    it('file --markdown <path>: reads + dispatches', async () => {
      const path = join(tmpRoot, 'notes.md');
      await writeFile(path, '# Notes\n\nLine.\n', 'utf8');
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            match_variables: {
              docId: '88010',
              markdown: '# Notes\n\nLine.',
            },
            response: {
              data: { add_content_to_doc_from_markdown: wireSuccess() },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown',
          path,
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(0);
    });

    it('stdin --markdown -: reads to EOF + dispatches', async () => {
      const stdin = Readable.from(['# From\n\n', 'stdin.\n']);
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            match_variables: {
              docId: '88010',
              markdown: '# From\n\nstdin.',
            },
            response: {
              data: { add_content_to_doc_from_markdown: wireSuccess() },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown',
          '-',
          '--json',
        ],
        cassette,
        { stdin },
      );
      expect(out.exitCode).toBe(0);
    });

    it('threads --after <bid> into camelCase wire variable afterBlockId', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            match_variables: {
              docId: '88010',
              markdown: '# x',
              afterBlockId: 'blk_anchor',
            },
            response: {
              data: {
                add_content_to_doc_from_markdown: wireSuccess({
                  block_ids: ['blk_new'],
                }),
              },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown-string',
          '# x',
          '--after',
          'blk_anchor',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { block_ids: readonly string[] };
      };
      expect(env.data.block_ids).toEqual(['blk_new']);
    });

    it('whitespace-only --markdown-string rejects at parse boundary (usage_error)', async () => {
      // The schema's `.refine((s) => s.trim().length > 0, ...)` (added
      // at Codex IMPL round-1 P2-1) rejects whitespace-only inline
      // payloads at the parse boundary BEFORE dry-run early return,
      // so dry-run + live agree (dry-run can't accept content the
      // live path would reject downstream). No wire dispatch fires.
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown-string',
          '   ',
          '--json',
        ],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr);
      expect(env.error?.code).toBe('usage_error');
      expect(out.requests).toBe(0);
    });

    it('non-empty markdown that Monday parses to zero blocks: success WITH empty block_ids', async () => {
      // Force the empty-blocks success path with a non-empty payload
      // that parses to zero convertible structure on Monday's side
      // (e.g. HTML/markdown comments only). The CLI accepts the
      // wire's `block_ids: []` on `success: true` as a valid success
      // shape per R-v0.5-NEW-11 per-fetcher null-payload discipline:
      // null `block_ids` = wire-regression (`internal_error`); empty
      // array = "no convertible blocks" success path.
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            response: {
              data: {
                add_content_to_doc_from_markdown: wireSuccess({
                  block_ids: [],
                }),
              },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown-string',
          '<!-- comment-only markdown -->',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { doc_id: string; block_ids: readonly string[] };
      };
      expect(env.data.doc_id).toBe('88010');
      expect(env.data.block_ids).toEqual([]);
    });
  });

  describe('dry-run', () => {
    it('inline source: planned_changes carries markdown_source: "(inline)"', async () => {
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown-string',
          '# Heading\n\nBody',
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
        operation: 'add_content_to_doc_from_markdown',
        doc_id: '88010',
        markdown_source: '(inline)',
      });
      expect(env.meta.source).toBe('none');
    });

    it('file source: planned_changes carries markdown_source: <path>', async () => {
      const path = join(tmpRoot, 'notes.md');
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown',
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
      expect(env.planned_changes[0]?.markdown_source).toBe(path);
    });

    it('stdin source: planned_changes carries markdown_source: "(stdin)"', async () => {
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown',
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
      expect(env.planned_changes[0]?.markdown_source).toBe('(stdin)');
    });

    it('threads --after <bid> into planned after_block_id', async () => {
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown-string',
          '# x',
          '--after',
          'blk_anchor',
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
        operation: 'add_content_to_doc_from_markdown',
        doc_id: '88010',
        markdown_source: '(inline)',
        after_block_id: 'blk_anchor',
      });
    });
  });

  describe('source-read failures (usage_error)', () => {
    it('surfaces usage_error when --markdown file does not exist', async () => {
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown',
          join(tmpRoot, 'missing.md'),
          '--json',
        ],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr);
      expect(env.error?.code).toBe('usage_error');
      expect(out.requests).toBe(0);
    });

    it('surfaces usage_error when --markdown file exceeds the runtime size guard', async () => {
      const path = join(tmpRoot, 'too-big.md');
      await writeFile(path, 'x'.repeat(256_001), 'utf8');
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown',
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
      expect(out.requests).toBe(0);
    });
  });

  describe('wire failure projection (D12 5-branch matrix)', () => {
    it('validation_failed when wire success: false + populated error', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            response: {
              data: {
                add_content_to_doc_from_markdown: {
                  success: false,
                  block_ids: null,
                  error: 'markdown parse failure: unmatched fence at line 3',
                },
              },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown-string',
          '```\nunclosed',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: Record<string, unknown> };
      };
      expect(env.error?.code).toBe('validation_failed');
      expect(env.error?.details?.doc_id).toBe('88010');
      expect(env.error?.details?.error).toBe(
        'markdown parse failure: unmatched fence at line 3',
      );
    });

    it('internal_error when wire success: false + null error (regression)', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            response: {
              data: {
                add_content_to_doc_from_markdown: {
                  success: false,
                  block_ids: null,
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
          'append-markdown',
          '88010',
          '--markdown-string',
          '# x',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: Record<string, unknown> };
      };
      expect(env.error?.code).toBe('internal_error');
      expect(env.error?.details?.doc_id).toBe('88010');
    });

    it('internal_error when wire success: false + empty error string (regression)', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            response: {
              data: {
                add_content_to_doc_from_markdown: {
                  success: false,
                  block_ids: null,
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
          'append-markdown',
          '88010',
          '--markdown-string',
          '# x',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
    });

    it('internal_error when wire success: true + null block_ids (per-fetcher null-payload contract)', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            response: {
              data: {
                add_content_to_doc_from_markdown: {
                  success: true,
                  block_ids: null,
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
          'append-markdown',
          '88010',
          '--markdown-string',
          '# x',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: Record<string, unknown> };
      };
      expect(env.error?.code).toBe('internal_error');
      expect(env.error?.details?.doc_id).toBe('88010');
    });
  });

  describe('schema-drift internal_error', () => {
    it('internal_error when add_content_to_doc_from_markdown root key is missing', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            response: { data: { other_root: 'unexpected' } },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown-string',
          '# x',
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
            operation_name: 'AddContentToDocFromMarkdown',
            response: {
              data: {
                add_content_to_doc_from_markdown: {
                  success: true,
                  block_ids: ['blk_001'],
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
          'append-markdown',
          '88010',
          '--markdown-string',
          '# x',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
    });

    it('internal_error when add_content_to_doc_from_markdown payload is null', async () => {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'AddContentToDocFromMarkdown',
            response: {
              data: { add_content_to_doc_from_markdown: null },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'append-markdown',
          '88010',
          '--markdown-string',
          '# x',
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(2);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: Record<string, unknown> };
      };
      expect(env.error?.code).toBe('internal_error');
      expect(env.error?.details?.doc_id).toBe('88010');
    });
  });
});
