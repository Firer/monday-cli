/**
 * Integration tests for `monday doc create-on-column --item <iid>
 * --column <cid> [--dry-run]` (v0.5-M35 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'CreateDocOnColumn'`. Coverage axes:
 *   - happy path: direct unwrap of `data: <Document>` (blocks omitted
 *     per the D6 create-projection)
 *   - argv threads `--item` + `--column` into wire `location.board`
 *   - dry-run: minimal `{operation, item_id, column_id}` (no wire call)
 *   - usage_error: non-numeric `--item` at parse boundary
 *   - missing `create_doc` key → `internal_error`
 *   - null `create_doc` payload → `internal_error`
 */
import { describe, expect, it } from 'vitest';
import {
  drive,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

const wireDoc = (
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: '88020',
  object_id: '99020',
  name: 'Doc on column',
  doc_kind: 'public',
  url: 'https://example.monday.com/docs/88020',
  relative_url: '/docs/88020',
  workspace_id: '5555',
  workspace: { id: '5555', name: 'Engineering' },
  doc_folder_id: null,
  created_at: '2026-05-15T12:00:00Z',
  created_by: { id: '7', name: 'Nick Webster' },
  updated_at: '2026-05-15T12:00:00Z',
  settings: null,
  ...overrides,
});

describe('monday doc create-on-column (M35)', () => {
  it('happy path: emits the created Document (live source)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocOnColumn',
          match_variables: {
            input: { board: { item_id: '12345', column_id: 'doc_column_1' } },
          },
          response: { data: { create_doc: wireDoc() } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'create-on-column',
        '--item',
        '12345',
        '--column',
        'doc_column_1',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('88020');
    expect(env.data.name).toBe('Doc on column');
    expect(env.meta.source).toBe('live');
    expect(env.data).not.toHaveProperty('blocks');
  });

  it('dry-run: emits minimal planned changes with no wire call', async () => {
    const out = await drive(
      [
        'doc',
        'create-on-column',
        '--item',
        '12345',
        '--column',
        'doc_column_1',
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
    expect(env.planned_changes).toEqual([
      {
        operation: 'create_doc',
        item_id: '12345',
        column_id: 'doc_column_1',
      },
    ]);
    expect(env.meta.source).toBe('none');
  });

  it('usage_error rejects non-numeric --item at parse boundary (no wire call)', async () => {
    const out = await drive(
      [
        'doc',
        'create-on-column',
        '--item',
        'not-a-number',
        '--column',
        'doc_column_1',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('internal_error when create_doc key is absent (schema drift)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocOnColumn',
          response: { data: { other_root: 'unexpected' } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'create-on-column',
        '--item',
        '12345',
        '--column',
        'doc_column_1',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('internal_error when create_doc payload is null', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocOnColumn',
          response: { data: { create_doc: null } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'create-on-column',
        '--item',
        '12345',
        '--column',
        'doc_column_1',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: Record<string, unknown> };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.item_id).toBe('12345');
    expect(env.error?.details?.column_id).toBe('doc_column_1');
  });
});
