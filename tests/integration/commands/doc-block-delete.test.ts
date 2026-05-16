/**
 * Integration tests for `monday doc block-delete <block-id> --yes
 * [--dry-run]` (v0.5-M36 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'DeleteDocBlock'`. Coverage axes:
 *   - destructive-gate fire: `--yes` missing → `confirmation_required`
 *     (exit 1) — fires BEFORE `resolveClient` per M10 round-1 P2
 *   - gate-before-resolveClient invariant: `confirmation_required`
 *     surfaces even when no token is configured
 *   - dry-run shape: minimal `{operation, block_id}` with no wire call
 *   - happy path: direct unwrap of `data: <DocumentBlockIdOnly>` —
 *     `{ id }` projection narrower than the create/update full-block
 *     envelopes (Monday's wire only returns the deleted id)
 *   - null `delete_doc_block` payload → `not_found` (per R-v0.5-NEW-11)
 *   - missing `delete_doc_block` key → `internal_error` (schema drift)
 *   - schema drift in returned DocumentBlockIdOnly → `internal_error`
 *   - usage_error: empty `<blockId>` at parse boundary
 */
import { describe, expect, it } from 'vitest';
import {
  drive,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

describe('monday doc block-delete (M36)', () => {
  it('confirmation_required: --yes missing fires the destructive gate before any wire call', async () => {
    const out = await drive(
      ['doc', 'block-delete', 'blk_abc123', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { block_id?: string } };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.block_id).toBe('blk_abc123');
    expect(out.requests).toBe(0);
  });

  it('confirmation_required precedes config_error when no token is set (gate-before-resolveClient invariant)', async () => {
    // M10 round-1 P2 invariant: `confirmation_required` must surface
    // even when the runner can't reach the config layer. The gate
    // ordering prevents `config_error` from masking the agent-
    // observable destructive-gate signal — same shape as M14 /
    // M34 / M35 destructive verbs.
    const out = await drive(
      ['doc', 'block-delete', 'blk_abc123', '--json'],
      { interactions: [] },
      { env: { MONDAY_API_URL: 'https://api.monday.com/v2' } },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('confirmation_required');
    expect(out.requests).toBe(0);
  });

  it('dry-run: emits minimal planned changes with no wire call (source: none)', async () => {
    const out = await drive(
      ['doc', 'block-delete', 'blk_abc123', '--dry-run', '--json'],
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
      { operation: 'delete_doc_block', block_id: 'blk_abc123' },
    ]);
    expect(env.meta.source).toBe('none');
  });

  it('happy path: --yes deletes the block and projects to {id}', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteDocBlock',
          match_variables: { blockId: 'blk_abc123' },
          response: { data: { delete_doc_block: { id: 'blk_abc123' } } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'block-delete', 'blk_abc123', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('blk_abc123');
    // Envelope is intentionally narrower than create/update — Monday's
    // wire return is DocumentBlockIdOnly ({id: String!} only).
    expect(env.data).not.toHaveProperty('type');
    expect(env.data).not.toHaveProperty('content');
    expect(env.meta.source).toBe('live');
  });

  it('not_found when delete_doc_block payload is null (id bogus / already deleted)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteDocBlock',
          response: { data: { delete_doc_block: null } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'block-delete', 'blk_bogus', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { block_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.block_id).toBe('blk_bogus');
  });

  it('internal_error when delete_doc_block key is absent (schema drift)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteDocBlock',
          response: { data: { other_root: 'unexpected' } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'block-delete', 'blk_abc123', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: Record<string, unknown> };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.block_id).toBe('blk_abc123');
  });

  it('internal_error on schema drift in returned DocumentBlockIdOnly', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteDocBlock',
          response: { data: { delete_doc_block: { not_id: 'oops' } } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'block-delete', 'blk_abc123', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: Record<string, unknown> };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.block_id).toBe('blk_abc123');
  });

  it('usage_error rejects empty <blockId> at parse boundary (no gate / wire call)', async () => {
    const out = await drive(
      ['doc', 'block-delete', '', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });
});
