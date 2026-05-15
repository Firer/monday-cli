/**
 * Integration tests for `monday doc delete <doc-id> --yes [--dry-run]`
 * (v0.5-M35 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'DeleteDoc'`. Coverage axes:
 *   - destructive-gate fire: `--yes` missing → `confirmation_required`
 *     (exit 1) — fires BEFORE `resolveClient` per M10 round-1 P2
 *   - gate-before-resolveClient invariant: `confirmation_required`
 *     surfaces even when no token is configured
 *   - dry-run shape: minimal `{operation, doc_id}` with no wire call
 *   - happy path: opaque JSON projects to `{doc_id, success: true}`
 *   - null `delete_doc` payload → `not_found`
 *   - missing `delete_doc` key → `internal_error` (schema drift)
 *   - usage_error: non-numeric `<docId>` at parse boundary
 */
import { describe, expect, it } from 'vitest';
import {
  drive,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

describe('monday doc delete (M35)', () => {
  it('confirmation_required: --yes missing fires the destructive gate before any wire call', async () => {
    const out = await drive(
      ['doc', 'delete', '88010', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { doc_id?: string } };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.doc_id).toBe('88010');
    expect(out.requests).toBe(0);
  });

  it('confirmation_required precedes config_error when no token is set (gate-before-resolveClient invariant)', async () => {
    // M10 round-1 P2 invariant: `confirmation_required` must surface
    // even when the runner can't reach the config layer. The gate
    // ordering prevents `config_error` from masking the agent-
    // observable destructive-gate signal.
    const out = await drive(
      ['doc', 'delete', '88010', '--json'],
      { interactions: [] },
      { env: { MONDAY_API_URL: 'https://api.monday.com/v2' } },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('confirmation_required');
    expect(out.requests).toBe(0);
  });

  it('dry-run: emits minimal planned changes with no wire call (source: none)', async () => {
    const out = await drive(
      ['doc', 'delete', '88010', '--dry-run', '--json'],
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
      { operation: 'delete_doc', doc_id: '88010' },
    ]);
    expect(env.meta.source).toBe('none');
  });

  it('happy path: --yes deletes the doc and projects to {doc_id, success: true}', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteDoc',
          match_variables: { docId: '88010' },
          response: { data: { delete_doc: { success: true } } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'delete', '88010', '--yes', '--json'],
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

  it('not_found when delete_doc payload is null (id bogus / already deleted)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteDoc',
          response: { data: { delete_doc: null } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'delete', '88010', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { doc_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.doc_id).toBe('88010');
  });

  it('internal_error when delete_doc key is absent (schema drift)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteDoc',
          response: { data: { other_root: 'unexpected' } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'delete', '88010', '--yes', '--json'],
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

  it('usage_error rejects non-numeric <docId> at parse boundary (no gate / wire call)', async () => {
    const out = await drive(
      ['doc', 'delete', 'not-a-number', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });
});
