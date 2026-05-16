/**
 * Integration tests for `monday doc block-create <doc-id> --type
 * <DocBlockContentType> --content <json> [--after <bid>] [--parent
 * <bid>] [--dry-run]` (v0.5-M36 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'CreateDocBlock'`. Coverage axes:
 *   - happy path: direct unwrap of `data: <DocumentBlock>` (9-field
 *     OBJECT — id / type / content / position / parent_block_id /
 *     doc_id / created_at / created_by / updated_at)
 *   - per-`DocBlockContentType` content cassettes (4 sampled of 16 per
 *     D11) — agents see the per-type content payload structure
 *   - argv threads `--after` + `--parent` into wire `after_block_id` /
 *     `parent_block_id`; omitted when unset (no `null` on the wire)
 *   - dry-run: minimal `{operation, doc_id, type, content, ?after_block_id, ?parent_block_id}`
 *     with no wire call (`meta.source: 'none'`)
 *   - usage_error: unknown `--type` at parse boundary (D10)
 *   - usage_error: empty `--content` at parse boundary
 *   - usage_error: malformed `--content` JSON at parse boundary
 *   - usage_error: non-numeric `<docId>` at parse boundary
 *   - missing `create_doc_block` key → `internal_error` (schema drift)
 *   - null `create_doc_block` payload → `internal_error` (per
 *     R-v0.5-NEW-11; a successful create must return the block)
 *   - schema drift in returned DocumentBlock → `internal_error`
 */
import { describe, expect, it } from 'vitest';
import {
  drive,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

const wireBlock = (
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: 'blk_abc123',
  type: 'normal_text',
  content: { alignment: 'left', content: 'Hello' },
  position: 1,
  parent_block_id: null,
  doc_id: '88010',
  created_at: '2026-05-16T12:00:00Z',
  created_by: { id: '7', name: 'Nick Webster' },
  updated_at: '2026-05-16T12:00:00Z',
  ...overrides,
});

describe('monday doc block-create (M36)', () => {
  it('happy path: emits the created DocumentBlock (live source)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocBlock',
          match_variables: {
            docId: '88010',
            type: 'normal_text',
            content: { alignment: 'left', content: 'Hello' },
          },
          response: { data: { create_doc_block: wireBlock() } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'normal_text',
        '--content',
        '{"alignment":"left","content":"Hello"}',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        id: string;
        type: string;
        content: Record<string, unknown>;
        doc_id: string;
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('blk_abc123');
    expect(env.data.type).toBe('normal_text');
    expect(env.data.content).toEqual({ alignment: 'left', content: 'Hello' });
    expect(env.data.doc_id).toBe('88010');
    expect(env.meta.source).toBe('live');
  });

  it('threads --after into wire after_block_id', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocBlock',
          match_variables: {
            docId: '88010',
            type: 'code',
            content: { language: 'ts', code: 'console.log(1)' },
            afterBlockId: 'blk_anchor',
          },
          response: {
            data: {
              create_doc_block: wireBlock({
                id: 'blk_code1',
                type: 'code',
                content: { language: 'ts', code: 'console.log(1)' },
                position: 2,
              }),
            },
          },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'code',
        '--content',
        '{"language":"ts","code":"console.log(1)"}',
        '--after',
        'blk_anchor',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
  });

  it('threads --parent into wire parent_block_id', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocBlock',
          match_variables: {
            docId: '88010',
            type: 'bulleted_list',
            content: { items: ['a', 'b'] },
            parentBlockId: 'blk_layout1',
          },
          response: {
            data: {
              create_doc_block: wireBlock({
                id: 'blk_list1',
                type: 'bulleted_list',
                content: { items: ['a', 'b'] },
                parent_block_id: 'blk_layout1',
              }),
            },
          },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'bulleted_list',
        '--content',
        '{"items":["a","b"]}',
        '--parent',
        'blk_layout1',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
  });

  it('per-type content cassettes — sampled 4 of 16 DocBlockContentType variants (D11)', async () => {
    // Per-block content payload shapes vary across the 16
    // DocBlockContentType enum values. The CLI passes Monday's wire
    // `JSON` scalar through unmodified; the per-type structure stays
    // Monday's source-of-truth, not enforced CLI-side. These cassettes
    // pin the documented shapes for `output-shapes.md` (M36 IMPL
    // landing point per D11). Sample covers a representative breadth
    // (text / structured / nested / empty); the remaining 12 variants
    // follow the same opaque-JSON pass-through cadence.
    const samples: readonly {
      type: string;
      content: Record<string, unknown>;
    }[] = [
      { type: 'large_title', content: { alignment: 'left', content: 'Title' } },
      {
        type: 'check_list',
        content: { items: [{ text: 'a', checked: false }, { text: 'b', checked: true }] },
      },
      { type: 'divider', content: {} },
      { type: 'quote', content: { content: 'A quotation.' } },
    ];
    for (const sample of samples) {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'CreateDocBlock',
            response: {
              data: {
                create_doc_block: wireBlock({
                  id: `blk_${sample.type}`,
                  type: sample.type,
                  content: sample.content,
                }),
              },
            },
          },
        ],
      };
      const out = await drive(
        [
          'doc',
          'block-create',
          '88010',
          '--type',
          sample.type,
          '--content',
          JSON.stringify(sample.content),
          '--json',
        ],
        cassette,
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { type: string; content: Record<string, unknown> };
      };
      expect(env.data.type).toBe(sample.type);
      expect(env.data.content).toEqual(sample.content);
    }
  });

  it('dry-run: emits minimal planned changes with no wire call (source: none)', async () => {
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'normal_text',
        '--content',
        '{"alignment":"left","content":"Hi"}',
        '--after',
        'blk_anchor',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly Record<string, unknown>[];
    };
    expect(env.ok).toBe(true);
    expect(env.data).toBeNull();
    const planned = env.planned_changes[0];
    expect(planned?.operation).toBe('create_doc_block');
    expect(planned?.doc_id).toBe('88010');
    expect(planned?.type).toBe('normal_text');
    expect(planned?.content).toEqual({ alignment: 'left', content: 'Hi' });
    expect(planned?.after_block_id).toBe('blk_anchor');
    expect(planned).not.toHaveProperty('parent_block_id');
    expect(env.meta.source).toBe('none');
  });

  it('dry-run threads --parent into planned payload', async () => {
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'bulleted_list',
        '--content',
        '{"items":["a"]}',
        '--parent',
        'blk_layout1',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Record<string, unknown>[];
    };
    expect(env.planned_changes[0]?.parent_block_id).toBe('blk_layout1');
    expect(env.planned_changes[0]).not.toHaveProperty('after_block_id');
  });

  it('dry-run with --type + --content only: planned omits every optional slot', async () => {
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'divider',
        '--content',
        '{}',
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
      operation: 'create_doc_block',
      doc_id: '88010',
      type: 'divider',
      content: {},
    });
  });

  it('usage_error rejects unknown --type at parse boundary (D10)', async () => {
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'not-a-block-type',
        '--content',
        '{}',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('usage_error rejects empty --content at parse boundary', async () => {
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'normal_text',
        '--content',
        '',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('usage_error rejects malformed --content JSON at parse boundary', async () => {
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'normal_text',
        '--content',
        '{not valid json',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { doc_id?: string; type?: string } };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.details?.doc_id).toBe('88010');
    expect(env.error?.details?.type).toBe('normal_text');
    expect(out.requests).toBe(0);
  });

  it('usage_error rejects non-numeric <docId> at parse boundary', async () => {
    const out = await drive(
      [
        'doc',
        'block-create',
        'not-a-number',
        '--type',
        'normal_text',
        '--content',
        '{}',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('internal_error when create_doc_block key is absent (schema drift)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocBlock',
          response: { data: { other_root: 'unexpected' } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'normal_text',
        '--content',
        '{"alignment":"left","content":"Hi"}',
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
    expect(env.error?.details?.type).toBe('normal_text');
  });

  it('internal_error when create_doc_block payload is null (R-v0.5-NEW-11 — successful create must return block)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocBlock',
          response: { data: { create_doc_block: null } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'normal_text',
        '--content',
        '{"alignment":"left","content":"Hi"}',
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
    expect(env.error?.details?.type).toBe('normal_text');
  });

  it('internal_error on schema drift in returned DocumentBlock', async () => {
    const { type: _type, ...badBlock } = wireBlock();
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocBlock',
          response: { data: { create_doc_block: badBlock } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'block-create',
        '88010',
        '--type',
        'normal_text',
        '--content',
        '{"alignment":"left","content":"Hi"}',
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
    expect(env.error?.details?.type).toBe('normal_text');
  });
});
