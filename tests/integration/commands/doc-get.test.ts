/**
 * Integration tests for `monday doc get <did>` (M32 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'GetDoc'` (R-NEW-37 W2 audit-point). Coverage axes
 * (§9 IMPL preconditions + IMPL watch-items):
 *   - happy path with `blocks` hydrated
 *   - empty `docs: []` → `not_found` with `details.doc_id` (D8 closure)
 *   - null `docs` root → `not_found`
 *   - multi-element response → defensive `internal_error`
 *   - schema drift → `internal_error`
 *   - W4: live source + cache_age_seconds null per D7 closure
 *   - parse-boundary rejection on non-numeric doc ID (W6)
 *   - LEAK_CANARY redaction sanity
 */
import { describe, expect, it } from 'vitest';
import { drive, LEAK_CANARY, parseEnvelope, type EnvelopeShape } from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

const wireBlock = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 'block-a',
  type: 'text',
  content: { ops: [{ insert: 'hello world' }] },
  position: 1,
  parent_block_id: null,
  doc_id: '88001',
  created_at: '2026-05-01T12:00:00Z',
  created_by: { id: '7', name: 'Nick Webster' },
  updated_at: '2026-05-01T12:00:00Z',
  ...overrides,
});

const wireDoc = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: '88001',
  object_id: '99001',
  name: 'Sprint planning notes',
  doc_kind: 'public',
  url: 'https://example.monday.com/docs/88001',
  relative_url: '/docs/88001',
  workspace_id: '12345',
  workspace: { id: '12345', name: 'Engineering' },
  doc_folder_id: null,
  created_at: '2026-05-01T12:00:00Z',
  created_by: { id: '7', name: 'Nick Webster' },
  updated_at: '2026-05-13T14:00:00Z',
  settings: { theme: 'default' },
  blocks: [wireBlock(), wireBlock({ id: 'block-b', position: 2 })],
  ...overrides,
});

describe('monday doc get (M32)', () => {
  it('happy path: emits the Document with blocks hydrated (live source)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetDoc',
          match_variables: { ids: ['88001'] },
          response: { data: { docs: [wireDoc()] } },
        },
      ],
    };
    const out = await drive(['doc', 'get', '88001', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        id: string;
        name: string;
        doc_kind: string;
        blocks: readonly { id: string; type: string | null }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('88001');
    expect(env.data.name).toBe('Sprint planning notes');
    expect(env.data.doc_kind).toBe('public');
    expect(env.data.blocks).toHaveLength(2);
    expect(env.data.blocks[0]?.id).toBe('block-a');
    expect(env.data.blocks[1]?.id).toBe('block-b');
    expect(env.meta.source).toBe('live');
    expect(env.meta.cache_age_seconds).toBeNull();
  });

  it('happy path: empty blocks array surfaces as `blocks: []` (not null)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetDoc',
          response: { data: { docs: [wireDoc({ blocks: [] })] } },
        },
      ],
    };
    const out = await drive(['doc', 'get', '88001', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { blocks: readonly unknown[] };
    };
    expect(env.data.blocks).toEqual([]);
  });

  it('not_found when GetDoc returns docs: [] (D8 — doesn\'t exist OR inaccessible)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetDoc',
          response: { data: { docs: [] } },
        },
      ],
    };
    const out = await drive(['doc', 'get', '99999', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { doc_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.doc_id).toBe('99999');
  });

  it('not_found when GetDoc returns docs: null', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetDoc',
          response: { data: { docs: null } },
        },
      ],
    };
    const out = await drive(['doc', 'get', '99999', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('not_found');
  });

  it('internal_error on multi-element response (defensive: wire shape regression)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetDoc',
          response: {
            data: { docs: [wireDoc(), wireDoc({ id: '88002' })] },
          },
        },
      ],
    };
    const out = await drive(['doc', 'get', '88001', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('internal_error on schema drift in the Document payload', async () => {
    const { settings: _settings, ...docWithoutSettings } = wireDoc();
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetDoc',
          response: { data: { docs: [docWithoutSettings] } },
        },
      ],
    };
    const out = await drive(['doc', 'get', '88001', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('internal_error on schema drift in a DocumentBlock (missing required `content`)', async () => {
    const { content: _content, ...blockWithoutContent } = wireBlock();
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetDoc',
          response: {
            data: { docs: [wireDoc({ blocks: [blockWithoutContent] })] },
          },
        },
      ],
    };
    const out = await drive(['doc', 'get', '88001', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('usage_error rejects non-numeric doc ID at parse boundary (no wire call)', async () => {
    const out = await drive(
      ['doc', 'get', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('token never leaks across happy or error envelopes (M32 redaction regression)', async () => {
    const happy = await drive(
      ['doc', 'get', '88001', '--json'],
      {
        interactions: [
          { operation_name: 'GetDoc', response: { data: { docs: [wireDoc()] } } },
        ],
      },
    );
    expect(happy.stdout).not.toContain(LEAK_CANARY);
    expect(happy.stderr).not.toContain(LEAK_CANARY);

    const notFound = await drive(
      ['doc', 'get', '99999', '--json'],
      {
        interactions: [
          { operation_name: 'GetDoc', response: { data: { docs: [] } } },
        ],
      },
    );
    expect(notFound.stdout).not.toContain(LEAK_CANARY);
    expect(notFound.stderr).not.toContain(LEAK_CANARY);
  });
});
