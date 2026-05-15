/**
 * Integration tests for `monday doc rename <doc-id> --name <n>
 * [--dry-run]` (v0.5-M35 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'UpdateDocName'`. Coverage axes:
 *   - happy path: opaque JSON projects to `{doc_id, success: true}`
 *     envelope per D9 (input doc_id echoed)
 *   - dry-run: minimal `{operation, doc_id, name}` with no wire call
 *   - usage_error: empty `--name` at parse boundary
 *   - usage_error: non-numeric `<docId>` at parse boundary
 *   - **present-but-null payload → success envelope** (round-1 P2-1
 *     closure: Monday's `update_doc_name` probe description carries no
 *     "returns X" prose, so null is plausibly empty-success — distinct
 *     from `delete_doc` + `duplicate_doc` which DO promise a non-null
 *     payload on success and so treat null as `not_found`)
 *   - missing `update_doc_name` key → `internal_error` (schema drift)
 *   - opaque-JSON shape variations (record / empty record) all project
 *     to the same {doc_id, success: true} envelope
 */
import { describe, expect, it } from 'vitest';
import {
  drive,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

describe('monday doc rename (M35)', () => {
  it('happy path: projects opaque JSON to {doc_id, success: true} envelope (live)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'UpdateDocName',
          match_variables: { docId: '88010', name: 'Revised plan' },
          response: { data: { update_doc_name: {} } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'rename', '88010', '--name', 'Revised plan', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { doc_id: string; success: boolean };
    };
    expect(env.ok).toBe(true);
    expect(env.data.doc_id).toBe('88010');
    expect(env.data.success).toBe(true);
    expect(env.meta.source).toBe('live');
  });

  it('happy path: opaque-JSON variants (boolean true / record / empty record) all project uniformly', async () => {
    for (const payload of [{ success: true }, {}, { result: 'updated' }]) {
      const cassette: Cassette = {
        interactions: [
          {
            operation_name: 'UpdateDocName',
            response: { data: { update_doc_name: payload } },
          },
        ],
      };
      const out = await drive(
        ['doc', 'rename', '88010', '--name', 'Revised plan', '--json'],
        cassette,
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { doc_id: string; success: boolean };
      };
      expect(env.data.doc_id).toBe('88010');
      expect(env.data.success).toBe(true);
    }
  });

  it('dry-run: emits minimal planned changes with no wire call (source: none)', async () => {
    const out = await drive(
      ['doc', 'rename', '88010', '--name', 'Revised plan', '--dry-run', '--json'],
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
      { operation: 'update_doc_name', doc_id: '88010', name: 'Revised plan' },
    ]);
    expect(env.meta.source).toBe('none');
  });

  it('present-but-null payload projects to success envelope (NOT not_found — round-1 P2-1)', async () => {
    // Distinct from delete_doc + duplicate_doc which DO promise a
    // non-null payload on success; `update_doc_name`'s probe
    // description makes no return-shape promise so null is a
    // plausible empty-success indicator. Typed Monday errors for
    // non-existent doc IDs would bubble via GraphQL `errors[]`
    // (mapped to typed ApiError at the transport layer), NOT
    // via this projection path.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'UpdateDocName',
          response: { data: { update_doc_name: null } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'rename', '88010', '--name', 'Revised plan', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { doc_id: string; success: boolean };
    };
    expect(env.ok).toBe(true);
    expect(env.data.doc_id).toBe('88010');
    expect(env.data.success).toBe(true);
  });

  it('internal_error when update_doc_name key is absent (schema drift)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'UpdateDocName',
          response: { data: { other_root: 'unexpected' } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'rename', '88010', '--name', 'X', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: Record<string, unknown> };
    };
    expect(env.error?.code).toBe('internal_error');
    // Detail-slot contract — round-1 P3-2 closure.
    expect(env.error?.details?.doc_id).toBe('88010');
  });

  it('usage_error rejects empty --name at parse boundary (no wire call)', async () => {
    const out = await drive(
      ['doc', 'rename', '88010', '--name', '', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('usage_error rejects non-numeric <docId> at parse boundary', async () => {
    const out = await drive(
      ['doc', 'rename', 'not-a-number', '--name', 'X', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });
});
