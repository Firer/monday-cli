/**
 * Integration tests for `monday doc create-in-workspace --workspace <wid>
 * --name <n> [--folder <fid>] [--kind public|private|share] [--dry-run]`
 * (v0.5-M35 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'CreateDocInWorkspace'`. Coverage axes:
 *   - happy path: direct unwrap of `data: <Document>` (blocks omitted
 *     per the D6 create-projection)
 *   - argv threads `--folder` + `--kind` into wire `location.workspace.
 *     folder_id` / `kind`
 *   - dry-run: minimal `{operation, workspace_id, name}` + only-supplied
 *     optional fields surface in the planned payload (`meta.source: 'none'`)
 *   - usage_error: empty `--name` at parse boundary (no wire call)
 *   - missing `create_doc` key → `internal_error` (schema drift)
 *   - null `create_doc` payload → `internal_error` (a successful
 *     create_doc must return the created Document)
 *   - schema drift in returned Document → `internal_error`
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
  id: '88010',
  object_id: '99010',
  name: 'Q4 launch plan',
  doc_kind: 'public',
  url: 'https://example.monday.com/docs/88010',
  relative_url: '/docs/88010',
  workspace_id: '5555',
  workspace: { id: '5555', name: 'Engineering' },
  doc_folder_id: null,
  created_at: '2026-05-15T12:00:00Z',
  created_by: { id: '7', name: 'Nick Webster' },
  updated_at: '2026-05-15T12:00:00Z',
  settings: null,
  ...overrides,
});

describe('monday doc create-in-workspace (M35)', () => {
  it('happy path: emits the created Document (live source)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocInWorkspace',
          match_variables: {
            input: { workspace: { workspace_id: '5555', name: 'Q4 launch plan' } },
          },
          response: { data: { create_doc: wireDoc() } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        'Q4 launch plan',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string; doc_kind: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('88010');
    expect(env.data.name).toBe('Q4 launch plan');
    expect(env.data.doc_kind).toBe('public');
    expect(env.meta.source).toBe('live');
    // create envelope OMITS the wire's blocks slot per D6.
    expect(env.data).not.toHaveProperty('blocks');
  });

  it('threads --folder + --kind through to wire location.workspace', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocInWorkspace',
          match_variables: {
            input: {
              workspace: {
                workspace_id: '5555',
                name: 'Confidential plan',
                folder_id: '12345',
                kind: 'private',
              },
            },
          },
          response: {
            data: {
              create_doc: wireDoc({
                id: '88011',
                name: 'Confidential plan',
                doc_kind: 'private',
                doc_folder_id: '12345',
              }),
            },
          },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        'Confidential plan',
        '--folder',
        '12345',
        '--kind',
        'private',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
  });

  it('dry-run: emits minimal planned changes with no wire call (source: none)', async () => {
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        'Q4 launch plan',
        '--folder',
        '12345',
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
    expect(planned?.operation).toBe('create_doc');
    expect(planned?.workspace_id).toBe('5555');
    expect(planned?.name).toBe('Q4 launch plan');
    expect(planned?.folder_id).toBe('12345');
    expect(planned).not.toHaveProperty('kind');
    expect(env.meta.source).toBe('none');
  });

  it('dry-run with --name only: planned omits every optional slot', async () => {
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        'Plain',
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
      operation: 'create_doc',
      workspace_id: '5555',
      name: 'Plain',
    });
  });

  it('usage_error rejects empty --name at parse boundary (no wire call)', async () => {
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        '',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('usage_error rejects unknown --kind value at parse boundary', async () => {
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        'X',
        '--kind',
        'bogus',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('internal_error when create_doc key is absent (schema drift via R42 helper)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocInWorkspace',
          response: { data: { other_root: 'unexpected' } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        'X',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('internal_error when create_doc payload is null (no doc returned post-mutation)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocInWorkspace',
          response: { data: { create_doc: null } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        'X',
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

  it('internal_error on schema drift in returned Document', async () => {
    const { settings: _settings, ...badDoc } = wireDoc();
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateDocInWorkspace',
          response: { data: { create_doc: badDoc } },
        },
      ],
    };
    const out = await drive(
      [
        'doc',
        'create-in-workspace',
        '--workspace',
        '5555',
        '--name',
        'X',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });
});
