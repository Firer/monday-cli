/**
 * Integration tests for `monday item archive` (M10 Session A).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6). Coverage:
 *
 *   - confirmation gate without `--yes` (exit 1 + `confirmation_required`),
 *   - live archive happy path (`archive_item` mutation + projected item),
 *   - live archive `not_found` (Monday returns null mutation result),
 *   - dry-run reports the source-item state via ItemArchiveRead,
 *   - dry-run `not_found` (source-item read returns empty list),
 *   - non-numeric item ID rejected as `usage_error` at the parse boundary,
 *   - token redaction across all error envelopes.
 *
 * Pyramid placement: integration. The unit-level shape coverage
 * (CommandModule.idempotent: true, the input schema's strict shape)
 * is exercised by the schema/registry walker; this file pins
 * end-to-end behaviour against fixtures.
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
  LEAK_CANARY,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import {
  sampleItem,
  useItemTestEnv,
} from './_item-fixtures.js';

const { drive } = useItemTestEnv();

describe('monday item archive (integration, M10)', () => {
  // Sample item post-archive: state flips to 'archived'. Monday's
  // archive_item mutation returns the same Item shape `item get` reads
  // — ITEM_FIELDS_FRAGMENT is the canonical projection so the response
  // mirrors a normal read with state: 'archived'.
  const archivedItem = {
    ...sampleItem,
    state: 'archived',
  };

  it('rejects without --yes — confirmation_required carries item_id', async () => {
    const out = await drive(
      ['item', 'archive', '12345', '--json'],
      // No interactions queued — the confirmation gate fires before
      // any wire call. The fixture transport asserts on this via
      // `remaining === 0` after the run.
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { item_id?: string; hint?: string };
      };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.item_id).toBe('12345');
    expect(env.error?.details?.hint).toMatch(/30 days/);
  });

  it('live: --yes archives the item and returns the projected envelope', async () => {
    const out = await drive(
      ['item', 'archive', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchive',
            response: { data: { archive_item: archivedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; state: string | null };
    };
    assertEnvelopeContract(env);
    expect(env.data.id).toBe('12345');
    expect(env.data.state).toBe('archived');
    expect(env.meta.source).toBe('live');
  });

  it('live: not_found when archive_item returns null', async () => {
    // Monday's `archive_item` returns null for missing items / items
    // the token can't access. The CLI surfaces this as not_found
    // matching the dry-run path's shape (cli-design §6.5).
    const out = await drive(
      ['item', 'archive', '99999', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchive',
            response: { data: { archive_item: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { item_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.item_id).toBe('99999');
  });

  it('--dry-run: emits §6.4 envelope with item snapshot, no mutation fires', async () => {
    const out = await drive(
      ['item', 'archive', '12345', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchiveRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(1);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        item_id: string;
        item: { id: string };
      }[];
    };
    expect(env.data).toBeNull();
    expect((env.meta as { dry_run?: boolean }).dry_run).toBe(true);
    expect(env.meta.source).toBe('live');
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('archive_item');
    expect(plan?.item_id).toBe('12345');
    expect(plan?.item.id).toBe('12345');
  });

  it('--dry-run: not_found when source-item read returns empty list', async () => {
    const out = await drive(
      ['item', 'archive', '99999', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchiveRead',
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { item_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.item_id).toBe('99999');
  });

  it('--dry-run: not_found when items is null', async () => {
    // Defence-in-depth: Monday rarely emits `items: null`, but the
    // CLI's structural read (`Array.isArray(items)`) needs to handle
    // it to mirror runByIdLookup's null-tolerant pattern.
    const out = await drive(
      ['item', 'archive', '99999', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchiveRead',
            response: { data: { items: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('--dry-run takes precedence over the confirmation gate when --yes is absent', async () => {
    // Mirrors cli-design §10.2: `--dry-run` is a safe preview path
    // and exempts the gate. Same shape `item update --where` uses.
    const out = await drive(
      ['item', 'archive', '12345', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchiveRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('rejects non-numeric item ID as usage_error at the parse boundary', async () => {
    const out = await drive(
      ['item', 'archive', 'not-a-number', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('token never leaks across error envelopes (M10 regression)', async () => {
    // Confirmation-gate path (no wire call): assert the token is
    // absent across both streams. Mirrors the M5b regression test
    // pattern.
    const gateOut = await drive(
      ['item', 'archive', '12345', '--json'],
      { interactions: [] },
    );
    expect(gateOut.stdout).not.toContain(LEAK_CANARY);
    expect(gateOut.stderr).not.toContain(LEAK_CANARY);

    // not_found path (live mutation null result): same assertion
    // across the typed-error envelope shape.
    const notFoundOut = await drive(
      ['item', 'archive', '99999', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchive',
            response: { data: { archive_item: null } },
          },
        ],
      },
    );
    expect(notFoundOut.stdout).not.toContain(LEAK_CANARY);
    expect(notFoundOut.stderr).not.toContain(LEAK_CANARY);
  });

  it('--yes wins over the confirmation gate even with --dry-run absent', async () => {
    // Belt-and-braces: confirms the gate condition is `!dryRun &&
    // !yes`, not `!dryRun || !yes`. A regression here would either
    // gate every call (--yes never works) or never gate (--yes
    // always wins). One assertion pins the conjunction.
    const out = await drive(
      ['item', 'archive', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchive',
            response: { data: { archive_item: archivedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('surfaces internal_error when archive_item returns a malformed item', async () => {
    // Drives the parseRawItem branch — Monday returning a payload
    // that doesn't match `rawItemSchema` is unexpected but possible
    // (schema drift, partial response). The R18 wrap surfaces it as
    // typed `internal_error` rather than letting a ZodError bubble.
    const out = await drive(
      ['item', 'archive', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemArchive',
            // Missing required `column_values` field — rawItemSchema
            // rejects.
            response: {
              data: {
                archive_item: {
                  id: '12345',
                  name: 'Bad item',
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });
});
