/**
 * Integration tests for `monday doc block-update <block-id> --content
 * <json> [--dry-run]` (v0.5-M36 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'UpdateDocBlock'`. Coverage axes:
 *   - happy path: direct unwrap of `data: <DocumentBlock>` (9-field
 *     OBJECT — post-update block with content reflecting the change)
 *   - per-`DocBlockContentType` content cassettes (2 sampled — wire
 *     accepts opaque JSON unmodified; type stays fixed at create time)
 *   - dry-run: minimal `{operation, block_id, content}` with no wire
 *     call (`meta.source: 'none'`)
 *   - usage_error: empty `--content` at parse boundary
 *   - usage_error: malformed `--content` JSON at parse boundary
 *   - usage_error: empty `<blockId>` at parse boundary (brand requires
 *     non-empty)
 *   - missing `update_doc_block` key → `internal_error` (schema drift)
 *   - null `update_doc_block` payload → `not_found` (per
 *     R-v0.5-NEW-11; probe description promises updated block)
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
  content: { alignment: 'center', content: 'Hi' },
  position: 1,
  parent_block_id: null,
  doc_id: '88010',
  created_at: '2026-05-16T12:00:00Z',
  created_by: { id: '7', name: 'Nick Webster' },
  updated_at: '2026-05-16T13:30:00Z',
  ...overrides,
});

describe('monday doc block-update (M36)', () => {
  it('happy path: emits the updated DocumentBlock (live source)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'UpdateDocBlock',
          match_variables: {
            blockId: 'blk_abc123',
            content: { alignment: 'center', content: 'Hi' },
          },
          response: { data: { update_doc_block: wireBlock() } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'block-update',
        'blk_abc123',
        '--content',
        '{"alignment":"center","content":"Hi"}',
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
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('blk_abc123');
    expect(env.data.content).toEqual({ alignment: 'center', content: 'Hi' });
    expect(env.meta.source).toBe('live');
  });

  it('per-type content cassettes — Monday accepts opaque JSON unmodified', async () => {
    const samples: readonly {
      type: string;
      content: Record<string, unknown>;
    }[] = [
      { type: 'bulleted_list', content: { items: ['x', 'y', 'z'] } },
      { type: 'code', content: { language: 'py', code: 'print(2)' } },
    ];
    for (const sample of samples) {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'UpdateDocBlock',
            response: {
              data: {
                update_doc_block: wireBlock({
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
          'block-update',
          `blk_${sample.type}`,
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
        'block-update',
        'blk_abc123',
        '--content',
        '{"items":["x","y","z"]}',
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
    expect(env.planned_changes[0]).toEqual({
      operation: 'update_doc_block',
      block_id: 'blk_abc123',
      content: { items: ['x', 'y', 'z'] },
    });
    expect(env.meta.source).toBe('none');
  });

  it('usage_error rejects empty --content at parse boundary', async () => {
    const out = await drive(
      ['doc', 'block-update', 'blk_abc123', '--content', '', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('usage_error rejects malformed --content JSON at parse boundary', async () => {
    const out = await drive(
      ['doc', 'block-update', 'blk_abc123', '--content', '{not valid json', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { block_id?: string } };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.details?.block_id).toBe('blk_abc123');
    expect(out.requests).toBe(0);
  });

  it('usage_error rejects empty <blockId> at parse boundary', async () => {
    const out = await drive(
      ['doc', 'block-update', '', '--content', '{}', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('internal_error when update_doc_block key is absent (schema drift)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'UpdateDocBlock',
          response: { data: { other_root: 'unexpected' } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'block-update', 'blk_abc123', '--content', '{}', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: Record<string, unknown> };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.block_id).toBe('blk_abc123');
  });

  it('not_found when update_doc_block payload is null (R-v0.5-NEW-11 — probe promises updated block)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'UpdateDocBlock',
          response: { data: { update_doc_block: null } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'block-update', 'blk_bogus', '--content', '{}', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { block_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.block_id).toBe('blk_bogus');
  });

  it('internal_error on schema drift in returned DocumentBlock', async () => {
    const { id: _id, ...badBlock } = wireBlock();
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'UpdateDocBlock',
          response: { data: { update_doc_block: badBlock } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'block-update', 'blk_abc123', '--content', '{}', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: Record<string, unknown> };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.block_id).toBe('blk_abc123');
  });
});
