/**
 * Integration tests for `monday doc list` (M32 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'ListDocs'` (R-NEW-37 W2 audit-point — the
 * operationName is pinned literally at the fetcher boundary, NOT
 * caller-overridable). Coverage axes (§9 IMPL preconditions + IMPL
 * watch-items):
 *   - empty-account / populated-account happy paths
 *   - pagination via `--page 2`
 *   - `--workspace 12345,67890` comma-list filter
 *   - `--order-by used_at`
 *   - pagination-invariant: `has_more === (returned_count === limit)`
 *   - W4: live source + cache_age_seconds null per D7 closure
 *   - parse-boundary rejections fire BEFORE any wire call (W6)
 *   - schema-drift surfaces `internal_error` with details.issues
 *   - LEAK_CANARY redaction sanity across happy + error envelopes
 */
import { describe, expect, it } from 'vitest';
import { drive, LEAK_CANARY, parseEnvelope, type EnvelopeShape } from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

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
  ...overrides,
});

describe('monday doc list (M32)', () => {
  it('empty account: emits the wrapped record envelope with documents: []', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListDocs',
          response: { data: { docs: [] } },
        },
      ],
    };
    const out = await drive(['doc', 'list', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        documents: readonly unknown[];
        page: number;
        limit: number;
        returned_count: number;
        has_more: boolean;
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.documents).toEqual([]);
    expect(env.data.page).toBe(1);
    expect(env.data.limit).toBe(25);
    expect(env.data.returned_count).toBe(0);
    expect(env.data.has_more).toBe(false);
    expect(env.meta.source).toBe('live');
    expect(env.meta.cache_age_seconds).toBeNull();
  });

  it('populated account: emits the projected list (live source)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListDocs',
          response: {
            data: {
              docs: [
                wireDoc(),
                wireDoc({ id: '88002', name: 'Retro notes', doc_kind: 'private' }),
              ],
            },
          },
        },
      ],
    };
    const out = await drive(['doc', 'list', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        documents: readonly { id: string; name: string; doc_kind: string }[];
        returned_count: number;
        has_more: boolean;
      };
    };
    expect(env.data.documents).toHaveLength(2);
    expect(env.data.documents[0]?.id).toBe('88001');
    expect(env.data.documents[1]?.doc_kind).toBe('private');
    expect(env.data.returned_count).toBe(2);
    // returned_count (2) !== limit (25) → has_more must be false.
    expect(env.data.has_more).toBe(false);
  });

  it('threads --workspace comma-list to the wire as workspace_ids: [ID]', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListDocs',
          match_variables: { workspaceIds: ['12345', '67890'] },
          response: { data: { docs: [wireDoc()] } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'list', '--workspace', '12345,67890', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    expect(parseEnvelope(out.stdout).ok).toBe(true);
  });

  it('threads --order-by used_at to the wire as DocsOrderBy', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListDocs',
          match_variables: { orderBy: 'used_at' },
          response: { data: { docs: [] } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'list', '--order-by', 'used_at', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
  });

  it('pagination: --page 2 --limit 50 echoes inputs and computes has_more=true when returned_count === limit', async () => {
    const docs = Array.from({ length: 50 }, (_, i) =>
      wireDoc({ id: `880${String(i).padStart(2, '0')}`, name: `Doc ${String(i)}` }),
    );
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListDocs',
          match_variables: { page: 2, limit: 50 },
          response: { data: { docs } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'list', '--page', '2', '--limit', '50', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { page: number; limit: number; returned_count: number; has_more: boolean };
    };
    expect(env.data.page).toBe(2);
    expect(env.data.limit).toBe(50);
    expect(env.data.returned_count).toBe(50);
    // Pagination heuristic: returned_count === limit → has_more=true.
    expect(env.data.has_more).toBe(true);
  });

  it('internal_error when ListDocs returns docs: null (wire shape regression)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListDocs',
          response: { data: { docs: null } },
        },
      ],
    };
    const out = await drive(['doc', 'list', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('internal_error on schema drift in a Document row (missing required `settings` key)', async () => {
    const { settings: _settings, ...docWithoutSettings } = wireDoc();
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListDocs',
          response: { data: { docs: [docWithoutSettings] } },
        },
      ],
    };
    const out = await drive(['doc', 'list', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('usage_error rejects --limit 0 at parse boundary (no wire call)', async () => {
    const out = await drive(
      ['doc', 'list', '--limit', '0', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('usage_error rejects --limit 101 at parse boundary (no wire call)', async () => {
    const out = await drive(
      ['doc', 'list', '--limit', '101', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('usage_error rejects non-integer --limit at parse boundary', async () => {
    const out = await drive(
      ['doc', 'list', '--limit', '25.5', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('usage_error rejects --page 0 at parse boundary', async () => {
    const out = await drive(
      ['doc', 'list', '--page', '0', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('usage_error rejects unknown --order-by value at parse boundary', async () => {
    const out = await drive(
      ['doc', 'list', '--order-by', 'name', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('usage_error rejects empty --workspace entry at parse boundary', async () => {
    const out = await drive(
      ['doc', 'list', '--workspace', '12345,', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('usage_error rejects non-numeric --workspace entry at parse boundary', async () => {
    const out = await drive(
      ['doc', 'list', '--workspace', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('token never leaks across happy or error envelopes (M32 redaction regression)', async () => {
    const happy = await drive(
      ['doc', 'list', '--json'],
      {
        interactions: [
          { operation_name: 'ListDocs', response: { data: { docs: [wireDoc()] } } },
        ],
      },
    );
    expect(happy.stdout).not.toContain(LEAK_CANARY);
    expect(happy.stderr).not.toContain(LEAK_CANARY);

    const usage = await drive(
      ['doc', 'list', '--limit', '0', '--json'],
      { interactions: [] },
    );
    expect(usage.stdout).not.toContain(LEAK_CANARY);
    expect(usage.stderr).not.toContain(LEAK_CANARY);
  });
});
