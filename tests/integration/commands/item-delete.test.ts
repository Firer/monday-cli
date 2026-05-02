/**
 * Integration tests for `monday item delete` (M10 Session A).
 *
 * Sibling of `tests/integration/commands/item-archive.test.ts` — same
 * shape, same fixtures, one knob different (`idempotent: false`).
 * Coverage parity with archive plus a delete-specific assertion that
 * the `confirmation_required` hint anchors at Monday's trash window
 * + cli-design §5.4 (the "no restore" rule).
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

describe('monday item delete (integration, M10)', () => {
  // Sample item post-delete. Monday's `delete_item` returns the
  // deleted Item shape (state='deleted'); ITEM_FIELDS_FRAGMENT is the
  // canonical projection so the response mirrors a normal read with
  // the state flip.
  const deletedItem = {
    ...sampleItem,
    state: 'deleted',
  };

  it('rejects without --yes — confirmation_required carries item_id + restore-aware hint', async () => {
    const out = await drive(
      ['item', 'delete', '12345', '--json'],
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
    // The hint anchors at the §5.4 "no restore" rule so agents
    // reading the gate know recovery is best-effort.
    expect(env.error?.details?.hint).toMatch(/no.*restore mutation/);
    expect(env.error?.details?.hint).toMatch(/30 days/);
    // Gate-error envelope reports source: 'none' (no wire call
    // fired). Same regression archive pins.
    expect(env.meta.source).toBe('none');
  });

  it('confirmation gate fires before resolveClient — missing token still surfaces confirmation_required, not config_error', async () => {
    // Codex M10 round-1 P2 regression pin. Same shape archive's
    // mirror test — verifies the gate is unconditional regardless
    // of token configuration (cli-design §3.1 #7). See the archive
    // test's full rationale for the pre-fix behaviour.
    const out = await drive(
      ['item', 'delete', '12345', '--json'],
      { interactions: [] },
      {
        env: {
          MONDAY_API_URL: 'https://api.monday.com/v2',
        },
      },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('confirmation_required');
  });

  it('live: --yes deletes the item and returns the projected envelope', async () => {
    const out = await drive(
      ['item', 'delete', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDelete',
            response: { data: { delete_item: deletedItem } },
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
    expect(env.data.state).toBe('deleted');
    expect(env.meta.source).toBe('live');
  });

  it('live: not_found when delete_item returns null', async () => {
    const out = await drive(
      ['item', 'delete', '99999', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDelete',
            response: { data: { delete_item: null } },
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
      ['item', 'delete', '12345', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDeleteRead',
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
    expect(plan?.operation).toBe('delete_item');
    expect(plan?.item_id).toBe('12345');
    expect(plan?.item.id).toBe('12345');
  });

  it('--dry-run: not_found when source-item read returns empty list', async () => {
    const out = await drive(
      ['item', 'delete', '99999', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDeleteRead',
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
    const out = await drive(
      ['item', 'delete', '99999', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDeleteRead',
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
    // cli-design §10.2: dry-run is the safe preview path. Same
    // shape archive's gate exempts.
    const out = await drive(
      ['item', 'delete', '12345', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDeleteRead',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('rejects non-numeric item ID as usage_error at the parse boundary', async () => {
    const out = await drive(
      ['item', 'delete', 'not-a-number', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('token never leaks across error envelopes (M10 regression)', async () => {
    // Confirmation-gate path (no wire call).
    const gateOut = await drive(
      ['item', 'delete', '12345', '--json'],
      { interactions: [] },
    );
    expect(gateOut.stdout).not.toContain(LEAK_CANARY);
    expect(gateOut.stderr).not.toContain(LEAK_CANARY);

    // not_found path (live mutation null result).
    const notFoundOut = await drive(
      ['item', 'delete', '99999', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDelete',
            response: { data: { delete_item: null } },
          },
        ],
      },
    );
    expect(notFoundOut.stdout).not.toContain(LEAK_CANARY);
    expect(notFoundOut.stderr).not.toContain(LEAK_CANARY);
  });

  it('--yes wins over the confirmation gate even with --dry-run absent', async () => {
    const out = await drive(
      ['item', 'delete', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDelete',
            response: { data: { delete_item: deletedItem } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('surfaces internal_error when delete_item returns a malformed item', async () => {
    // R18 parse-boundary wrap on parseRawItem — same regression
    // pattern archive pins.
    const out = await drive(
      ['item', 'delete', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemDelete',
            response: {
              data: {
                delete_item: {
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

  it('CommandModule.idempotent is false — the archive sibling flips this knob', async () => {
    // Pinned at the registry walker layer too, but the per-verb
    // idempotency contract is the one knob that distinguishes
    // delete from archive. A future refactor that copy-pastes
    // archive's CommandModule shape over delete's would silently
    // break this; the assertion catches it pre-merge.
    const { itemDeleteCommand } = await import(
      '../../../src/commands/item/delete.js'
    );
    const { itemArchiveCommand } = await import(
      '../../../src/commands/item/archive.js'
    );
    expect(itemDeleteCommand.idempotent).toBe(false);
    expect(itemArchiveCommand.idempotent).toBe(true);
  });
});
