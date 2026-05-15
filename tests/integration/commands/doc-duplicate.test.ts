/**
 * Integration tests for `monday doc duplicate <doc-id> [--with-updates]
 * [--dry-run]` (v0.5-M35 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'DuplicateDoc'`. Coverage axes:
 *   - happy path: opaque JSON returns the NEW doc id; envelope projects
 *     to `{doc_id: <NEW>, success: true}` (D9 + D8 closures)
 *   - argv threads `--with-updates` to wire `duplicateType` (omit-vs-
 *     null discipline mirrors team-create's `is_guest_team`)
 *   - dry-run shape: minimal `{operation, doc_id: <SOURCE>}` +
 *     `duplicate_type` only when --with-updates is supplied
 *   - new-id extraction tolerates multiple wire shapes — bare string,
 *     `{id: <new>}`, `{doc_id: <new>}`, `{new_doc_id: <new>}` (defensive
 *     because the IMPL probe is read-only; Monday's exact JSON shape
 *     for duplicate_doc isn't pinned until a live cassette captures it)
 *   - unrecognised JSON shape → `internal_error` with re-probe hint
 *   - null `duplicate_doc` payload → `not_found`
 *   - missing `duplicate_doc` key → `internal_error` (schema drift)
 *   - usage_error: non-numeric `<docId>` at parse boundary
 */
import { describe, expect, it } from 'vitest';
import {
  drive,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

describe('monday doc duplicate (M35)', () => {
  it('happy path: extracts the new doc id from wire-side {id: ...} JSON', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DuplicateDoc',
          match_variables: { docId: '88010' },
          response: { data: { duplicate_doc: { id: '88099' } } },
        },
      ],
    };
    const out = await drive(['doc', 'duplicate', '88010', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { doc_id: string; success: boolean };
    };
    expect(env.ok).toBe(true);
    // doc_id is the NEW duplicate's id, NOT the source positional.
    expect(env.data.doc_id).toBe('88099');
    expect(env.data.success).toBe(true);
    expect(env.meta.source).toBe('live');
  });

  it('threads --with-updates to wire duplicateType', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DuplicateDoc',
          match_variables: {
            docId: '88010',
            duplicateType: 'duplicate_doc_with_content_and_updates',
          },
          response: { data: { duplicate_doc: { id: '88100' } } },
        },
      ],
    };
    const out = await drive(
      ['doc', 'duplicate', '88010', '--with-updates', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { doc_id: string };
    };
    expect(env.data.doc_id).toBe('88100');
  });

  it('extracts new id from wire-side {doc_id: ...} JSON variant', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DuplicateDoc',
          response: { data: { duplicate_doc: { doc_id: '88200' } } },
        },
      ],
    };
    const out = await drive(['doc', 'duplicate', '88010', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { doc_id: string };
    };
    expect(env.data.doc_id).toBe('88200');
  });

  it('extracts new id from wire-side {new_doc_id: ...} JSON variant', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DuplicateDoc',
          response: { data: { duplicate_doc: { new_doc_id: '88300' } } },
        },
      ],
    };
    const out = await drive(['doc', 'duplicate', '88010', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    expect(
      (parseEnvelope(out.stdout) as EnvelopeShape & { data: { doc_id: string } })
        .data.doc_id,
    ).toBe('88300');
  });

  it('extracts new id from a bare-string wire return', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DuplicateDoc',
          response: { data: { duplicate_doc: '88400' } },
        },
      ],
    };
    const out = await drive(['doc', 'duplicate', '88010', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    expect(
      (parseEnvelope(out.stdout) as EnvelopeShape & { data: { doc_id: string } })
        .data.doc_id,
    ).toBe('88400');
  });

  it('extracts new id from a numeric wire return (stringifies)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DuplicateDoc',
          response: { data: { duplicate_doc: 88500 } },
        },
      ],
    };
    const out = await drive(['doc', 'duplicate', '88010', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    expect(
      (parseEnvelope(out.stdout) as EnvelopeShape & { data: { doc_id: string } })
        .data.doc_id,
    ).toBe('88500');
  });

  it('extracts new id from a record with a numeric id slot (stringifies)', async () => {
    // Defensive coverage — Monday's `id` scalars are `ID!` typed but
    // some upstream wire shapes mix `id: <number>` (e.g. coerced
    // before JSON serialisation). `extractDuplicateDocId` handles
    // both nested string + number cases; this pins the number leg.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DuplicateDoc',
          response: { data: { duplicate_doc: { id: 88600 } } },
        },
      ],
    };
    const out = await drive(['doc', 'duplicate', '88010', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    expect(
      (parseEnvelope(out.stdout) as EnvelopeShape & { data: { doc_id: string } })
        .data.doc_id,
    ).toBe('88600');
  });

  it('internal_error when wire JSON shape carries no recognisable id slot (re-probe hint)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DuplicateDoc',
          response: { data: { duplicate_doc: { unrelated: 'value' } } },
        },
      ],
    };
    const out = await drive(['doc', 'duplicate', '88010', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { doc_id?: string; hint?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.doc_id).toBe('88010');
    expect(env.error?.details?.hint).toMatch(/re-probe/);
  });

  it('dry-run: emits minimal planned changes echoing SOURCE doc_id (no wire call)', async () => {
    const out = await drive(
      ['doc', 'duplicate', '88010', '--dry-run', '--json'],
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
    // Dry-run echoes the SOURCE id (only Monday's wire can mint the
    // NEW id at duplicate-time).
    expect(env.planned_changes).toEqual([
      { operation: 'duplicate_doc', doc_id: '88010' },
    ]);
    expect(env.meta.source).toBe('none');
  });

  it('dry-run with --with-updates: planned includes duplicate_type slot', async () => {
    const out = await drive(
      ['doc', 'duplicate', '88010', '--with-updates', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Record<string, unknown>[];
    };
    expect(env.planned_changes).toEqual([
      {
        operation: 'duplicate_doc',
        doc_id: '88010',
        duplicate_type: 'duplicate_doc_with_content_and_updates',
      },
    ]);
  });

  it('not_found when duplicate_doc payload is null (source id bogus)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DuplicateDoc',
          response: { data: { duplicate_doc: null } },
        },
      ],
    };
    const out = await drive(['doc', 'duplicate', '88010', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { doc_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.doc_id).toBe('88010');
  });

  it('internal_error when duplicate_doc key is absent (schema drift)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DuplicateDoc',
          response: { data: { other_root: 'unexpected' } },
        },
      ],
    };
    const out = await drive(['doc', 'duplicate', '88010', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: Record<string, unknown> };
    };
    expect(env.error?.code).toBe('internal_error');
    // Detail-slot contract — agents key off `doc_id` to scope retries.
    // Round-1 P3-2 closure. Note: duplicate's `details.doc_id` is the
    // SOURCE id (the new id never minted on this error path).
    expect(env.error?.details?.doc_id).toBe('88010');
  });

  it('usage_error rejects non-numeric <docId> at parse boundary', async () => {
    const out = await drive(
      ['doc', 'duplicate', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });
});
