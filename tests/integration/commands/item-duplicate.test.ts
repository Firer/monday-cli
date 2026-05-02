/**
 * Integration tests for `monday item duplicate` (M10 Session B).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6). Coverage parity with `item-archive.test.ts` +
 * `item-delete.test.ts` plus duplicate-specific assertions:
 *
 *   - live happy path (`ItemBoardLookup` + `ItemDuplicate` two-leg
 *     wire path; envelope `data.duplicated_from_id` echoes source ID),
 *   - `--with-updates` plumbs through to the mutation variables,
 *   - live `not_found` on the lookup leg (source item missing),
 *   - live `not_found` on the mutation leg (duplicate_item null —
 *     defence-in-depth for permission edge cases),
 *   - `--dry-run` reports source-item snapshot via ItemDuplicateRead
 *     with `with_updates` echoed in the planned change,
 *   - `--dry-run` not_found (empty list / null items),
 *   - non-numeric item ID rejected as `usage_error` at the parse
 *     boundary,
 *   - `parseRawItem` drift surfaces as `internal_error` (R18 wrap),
 *   - token redaction across error envelopes,
 *   - `idempotent: false` knob (parallel to delete's pin; archive is
 *     the inverse to keep all three M10 verbs covered).
 *
 * Pyramid placement: integration. Unit-level shape coverage
 * (`CommandModule.idempotent: false`, the input schema's strict shape)
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

describe('monday item duplicate (integration, M10)', () => {
  // The lookup-leg fixture: returns the source item's board id so the
  // mutation can be issued. Same shape archive's lookup pattern would
  // use if archive needed a board id (which it doesn't).
  const lookupInteraction = {
    operation_name: 'ItemBoardLookup',
    response: {
      data: { items: [{ id: '12345', board: { id: '111' } }] },
    },
  };

  // The duplicated item Monday returns: a fresh id (`67890`) on the
  // same board (`111`) — Monday duplicates onto the source's board.
  // Same shape `item get` reads via `ITEM_FIELDS_FRAGMENT` so the
  // projection mirrors a normal read.
  const duplicatedItem = {
    ...sampleItem,
    id: '67890',
    name: 'Refactor login (copy)',
  };

  it('live: duplicates the item and returns the projected envelope with duplicated_from_id', async () => {
    const out = await drive(
      ['item', 'duplicate', '12345', '--json'],
      {
        interactions: [
          lookupInteraction,
          {
            operation_name: 'ItemDuplicate',
            response: { data: { duplicate_item: duplicatedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(2);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; duplicated_from_id: string; board_id: string };
    };
    assertEnvelopeContract(env);
    expect(env.data.id).toBe('67890');
    // The lineage echo — v0.2-plan §3 M10's binding requirement
    // ("Returns the new item's ID + the source item's ID"). Mirrors
    // upsert's `data.created` flag pattern (cli-design §6.4 line
    // 1827-1831): per-verb business signals extend `data`.
    expect(env.data.duplicated_from_id).toBe('12345');
    // Monday duplicates onto the source's board, so board_id should
    // match the looked-up source board.
    expect(env.data.board_id).toBe('111');
    expect(env.meta.source).toBe('live');
  });

  it('live: --with-updates plumbs through to the mutation variables', async () => {
    // Monday's `duplicate_item(with_updates: Boolean)` controls
    // whether the source item's updates (comments) get copied. The
    // CLI passes the flag as a GraphQL variable; `match_variables`
    // pins the wire shape — the cassette throws `internal_error` if
    // the request's variables don't match the expected map. Stronger
    // than asserting on a recorded-request list because it fails the
    // wire call rather than the test reader.
    const out = await drive(
      ['item', 'duplicate', '12345', '--with-updates', '--json'],
      {
        interactions: [
          lookupInteraction,
          {
            operation_name: 'ItemDuplicate',
            match_variables: {
              itemId: '12345',
              boardId: '111',
              withUpdates: true,
            },
            response: { data: { duplicate_item: duplicatedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('live: --with-updates defaults to false when the flag is absent', async () => {
    // Pin the default — schema applies `.default(false)` so the wire
    // variable is always a defined boolean (no Monday-side default
    // ambiguity). A regression where commander's `undefined` leaked
    // through would surface here as a cassette-mismatch on
    // `withUpdates`. Same `match_variables` pattern the with-updates
    // test uses.
    const out = await drive(
      ['item', 'duplicate', '12345', '--json'],
      {
        interactions: [
          lookupInteraction,
          {
            operation_name: 'ItemDuplicate',
            match_variables: {
              itemId: '12345',
              boardId: '111',
              withUpdates: false,
            },
            response: { data: { duplicate_item: duplicatedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('live: not_found when the lookup leg returns no item (source missing)', async () => {
    // Pre-mutation lookup fails — the source item doesn't exist or
    // the token has no read access. lookupItemBoard throws not_found
    // with item_id details; the duplicate mutation never fires.
    const out = await drive(
      ['item', 'duplicate', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    expect(out.requests).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { item_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.item_id).toBe('99999');
  });

  it('live: not_found when duplicate_item returns null (mutation-leg edge case)', async () => {
    // Defence-in-depth: lookup says the item exists but the mutation
    // returns null. Permission edge cases (token can read but not
    // duplicate) or transient Monday-side rejections land here. The
    // CLI surfaces this as `not_found` matching the lookup-leg path's
    // shape so agents key off one stable code regardless of which
    // leg failed.
    const out = await drive(
      ['item', 'duplicate', '12345', '--json'],
      {
        interactions: [
          lookupInteraction,
          {
            operation_name: 'ItemDuplicate',
            response: { data: { duplicate_item: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    expect(out.requests).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { item_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.item_id).toBe('12345');
  });

  it('--dry-run: emits §6.4 envelope with item snapshot + with_updates, no mutation fires', async () => {
    const out = await drive(
      ['item', 'duplicate', '12345', '--with-updates', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDuplicateRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    // Single-leg dry-run: the source-item read is the only wire call;
    // no board lookup, no mutation. Mirrors archive + delete.
    expect(out.requests).toBe(1);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        item_id: string;
        with_updates: boolean;
        item: { id: string };
      }[];
    };
    expect(env.data).toBeNull();
    expect((env.meta as { dry_run?: boolean }).dry_run).toBe(true);
    expect(env.meta.source).toBe('live');
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('duplicate_item');
    expect(plan?.item_id).toBe('12345');
    // `with_updates` echo: agents reading the dry-run know whether
    // they'd be copying the source's updates if they re-ran without
    // --dry-run. The dry-run shape diverges from archive's only by
    // this slot.
    expect(plan?.with_updates).toBe(true);
    expect(plan?.item.id).toBe('12345');
  });

  it('--dry-run: with_updates defaults to false when --with-updates is absent', async () => {
    const out = await drive(
      ['item', 'duplicate', '12345', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDuplicateRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly { with_updates: boolean }[];
    };
    expect(env.planned_changes[0]?.with_updates).toBe(false);
  });

  it('--dry-run: not_found when source-item read returns empty list', async () => {
    const out = await drive(
      ['item', 'duplicate', '99999', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDuplicateRead',
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
    // it to mirror archive + delete's null-tolerant pattern.
    const out = await drive(
      ['item', 'duplicate', '99999', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDuplicateRead',
            response: { data: { items: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('rejects non-numeric item ID as usage_error at the parse boundary', async () => {
    const out = await drive(
      ['item', 'duplicate', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('surfaces internal_error when duplicate_item returns a malformed item', async () => {
    // Drives the parseRawItem branch — Monday returning a payload
    // that doesn't match `rawItemSchema` is unexpected but possible
    // (schema drift, partial response). The R18 wrap surfaces it as
    // typed `internal_error` rather than letting a ZodError bubble.
    // Same regression archive + delete pin.
    const out = await drive(
      ['item', 'duplicate', '12345', '--json'],
      {
        interactions: [
          lookupInteraction,
          {
            operation_name: 'ItemDuplicate',
            // Missing required `column_values` field — rawItemSchema
            // rejects.
            response: {
              data: {
                duplicate_item: {
                  id: '67890',
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

  it('surfaces internal_error when ItemDuplicateRead returns a malformed item (dry-run)', async () => {
    // Dry-run leg of the parseRawItem regression. The dry-run path
    // reads via ItemDuplicateRead and projects through the same
    // `parseRawItem` boundary, so a malformed item there also
    // surfaces as `internal_error`. Pinning both legs keeps the
    // R18 wrap honest across the verb.
    const out = await drive(
      ['item', 'duplicate', '12345', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDuplicateRead',
            response: {
              data: {
                items: [{ id: '12345', name: 'Bad item' }],
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

  it('token never leaks across error envelopes (M10 regression)', async () => {
    // Lookup-leg not_found path (one wire call). Mirrors the M5b
    // redaction regression test pattern — we assert the literal
    // canary is absent from every emitted byte.
    const lookupOut = await drive(
      ['item', 'duplicate', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(lookupOut.stdout).not.toContain(LEAK_CANARY);
    expect(lookupOut.stderr).not.toContain(LEAK_CANARY);

    // Mutation-leg not_found path (two wire calls). Same assertion
    // across the typed-error envelope shape.
    const mutationOut = await drive(
      ['item', 'duplicate', '12345', '--json'],
      {
        interactions: [
          lookupInteraction,
          {
            operation_name: 'ItemDuplicate',
            response: { data: { duplicate_item: null } },
          },
        ],
      },
    );
    expect(mutationOut.stdout).not.toContain(LEAK_CANARY);
    expect(mutationOut.stderr).not.toContain(LEAK_CANARY);

    // Parse-boundary path (usage_error before any wire call).
    const usageOut = await drive(
      ['item', 'duplicate', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(usageOut.stdout).not.toContain(LEAK_CANARY);
    expect(usageOut.stderr).not.toContain(LEAK_CANARY);
  });

  it('CommandModule.idempotent is false — the M10 lifecycle siblings cover both knobs', async () => {
    // Pinned at the registry walker layer too, but the per-verb
    // idempotency contract is the one knob that distinguishes
    // duplicate from archive. M10 ships both: archive is `true`
    // (re-archive is a wire-level no-op), delete is `false`
    // (re-delete after interim create would target the new item),
    // duplicate is `false` (every call creates a new item, mirroring
    // create_item per cli-design §9.1).
    const { itemDuplicateCommand } = await import(
      '../../../src/commands/item/duplicate.js'
    );
    const { itemCreateCommand } = await import(
      '../../../src/commands/item/create.js'
    );
    expect(itemDuplicateCommand.idempotent).toBe(false);
    // Sanity: create + duplicate share the "every call creates new"
    // semantics. A regression where one flipped without the other
    // would mean the contract drifted.
    expect(itemCreateCommand.idempotent).toBe(false);
  });
});
