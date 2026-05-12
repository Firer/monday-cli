/**
 * Integration tests for `monday webhook list/create/delete` (M27 IMPL).
 *
 * Drives the runtime bodies via `FixtureTransport` cassettes matched
 * on `operationName` — the M27 verbs each ship a single named
 * operation (`Webhooks` / `CreateWebhook` / `DeleteWebhook`) per the
 * R-NEW-37 W2 audit-point.
 *
 * Coverage axes (per the M27 IMPL handoff):
 *   - happy paths for all 3 verbs
 *   - confirmation gate ordering on `webhook delete`
 *   - `--dry-run` envelope shape for both write verbs (strictly
 *     argv-derived per cli-design §6.4)
 *   - HTTPS-only URL guard at parse boundary
 *   - JSON parse-boundary on `--config`
 *   - `not_found` shapes (missing board / missing webhook)
 *   - schema-drift surface (`internal_error`)
 *   - LEAK_CANARY redaction sanity across multiple paths
 */
import { describe, expect, it } from 'vitest';
import { drive, LEAK_CANARY, parseEnvelope, type EnvelopeShape } from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

const wireWebhook = {
  id: '88001',
  board_id: '12345678',
  event: 'create_item',
  config: null,
} as const;

describe('monday webhook list (M27)', () => {
  it('emits the projected collection envelope (live source)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'Webhooks',
          match_variables: { boardId: '12345678' },
          response: {
            data: {
              webhooks: [
                wireWebhook,
                {
                  id: '88002',
                  board_id: '12345678',
                  event: 'change_status_column_value',
                  config: '{"columnId":"status"}',
                },
              ],
            },
          },
        },
      ],
    };
    const out = await drive(['webhook', 'list', '12345678', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: readonly { id: string; event: string; config: string | null }[];
    };
    expect(env.ok).toBe(true);
    expect(env.data).toHaveLength(2);
    expect(env.data[0]?.id).toBe('88001');
    expect(env.data[1]?.event).toBe('change_status_column_value');
    expect(env.data[1]?.config).toBe('{"columnId":"status"}');
    expect(env.meta.source).toBe('live');
    expect(env.meta.cache_age_seconds).toBeNull();
  });

  it('emits an empty collection envelope when no webhooks are configured', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'Webhooks',
          response: { data: { webhooks: [] } },
        },
      ],
    };
    const out = await drive(['webhook', 'list', '12345678', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: readonly unknown[];
    };
    expect(env.data).toEqual([]);
    expect(env.meta.total_returned).toBe(0);
  });

  it('not_found when Monday returns webhooks: null', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'Webhooks',
          response: { data: { webhooks: null } },
        },
      ],
    };
    const out = await drive(['webhook', 'list', '99999999', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('usage_error rejects non-numeric board ID at parse boundary', async () => {
    const out = await drive(
      ['webhook', 'list', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('internal_error on schema drift in the webhook payload', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'Webhooks',
          response: {
            data: {
              webhooks: [
                {
                  id: '88001',
                  board_id: '12345678',
                  event: 'create_item',
                  // `config` missing entirely — webhookSchema requires the field.
                },
              ],
            },
          },
        },
      ],
    };
    const out = await drive(['webhook', 'list', '12345678', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });
});

describe('monday webhook create (M27)', () => {
  it('live: round-trips the create_webhook mutation and emits the projected record', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateWebhook',
          match_variables: {
            boardId: '12345678',
            url: 'https://example.com/hook',
            event: 'create_item',
          },
          response: {
            data: { create_webhook: wireWebhook },
          },
        },
      ],
    };
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'create_item',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; board_id: string; event: string; config: string | null };
    };
    expect(env.data.id).toBe('88001');
    expect(env.data.event).toBe('create_item');
    expect(env.meta.source).toBe('live');
  });

  it('live: threads parsed --config to the wire as a JS value (not a JSON string)', async () => {
    // The wire variable must be the parsed object, NOT the literal
    // string — otherwise Monday sees a JSON-encoded string and rejects
    // the config server-side.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateWebhook',
          match_variables: {
            boardId: '12345678',
            event: 'change_status_column_value',
            config: { columnId: 'status' },
          },
          response: {
            data: {
              create_webhook: {
                ...wireWebhook,
                event: 'change_status_column_value',
                config: '{"columnId":"status"}',
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'change_status_column_value',
        '--config',
        '{"columnId":"status"}',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
  });

  it('usage_error rejects non-HTTPS URL at parse boundary', async () => {
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'http://example.com/hook',
        '--event',
        'create_item',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('usage_error rejects unknown event type at parse boundary', async () => {
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'not_a_real_event',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('usage_error rejects malformed --config JSON at parse boundary', async () => {
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'create_item',
        '--config',
        '{not-valid-json',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        message: string;
        details?: { board_id?: string; hint?: string };
      };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/--config/);
    expect(env.error?.details?.board_id).toBe('12345678');
  });

  it('--dry-run: emits the §6.4 envelope strictly from argv (no wire call)', async () => {
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'create_item',
        '--config',
        '{"columnId":"status"}',
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
    expect(env.data).toBeNull();
    expect((env.meta as { dry_run?: boolean }).dry_run).toBe(true);
    expect(env.meta.source).toBe('none');
    expect(env.planned_changes).toHaveLength(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('create_webhook');
    expect(plan?.board_id).toBe('12345678');
    expect(plan?.url).toBe('https://example.com/hook');
    expect(plan?.event).toBe('create_item');
    // `config` is the PARSED JS value, not the raw string.
    expect(plan?.config).toEqual({ columnId: 'status' });
  });

  it('--dry-run: planned change carries config: null when --config is omitted', async () => {
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'create_item',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Record<string, unknown>[];
    };
    expect(env.planned_changes[0]?.config).toBeNull();
  });

  it('--dry-run does not validate --config JSON when --config is malformed', async () => {
    // The JSON parse-boundary fires regardless of `--dry-run` —
    // malformed JSON is a usage_error before any envelope work.
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'create_item',
        '--config',
        '{not-json',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('internal_error when create_webhook returns null', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateWebhook',
          response: { data: { create_webhook: null } },
        },
      ],
    };
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'create_item',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('internal_error on root-key drift in CreateWebhook response', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateWebhook',
          // Missing the `create_webhook` key entirely — schema-drift surface.
          response: { data: { something_else: wireWebhook } },
        },
      ],
    };
    const out = await drive(
      [
        'webhook',
        'create',
        '12345678',
        '--url',
        'https://example.com/hook',
        '--event',
        'create_item',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });
});

describe('monday webhook delete (M27)', () => {
  it('rejects without --yes — confirmation_required carries webhook_id + restore-aware hint', async () => {
    const out = await drive(
      ['webhook', 'delete', '88001', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { webhook_id?: string; hint?: string };
      };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.webhook_id).toBe('88001');
    expect(env.error?.details?.hint).toMatch(/no restore mutation/);
    expect(env.meta.source).toBe('none');
  });

  it('confirmation gate fires before resolveClient — missing token still surfaces confirmation_required, not config_error', async () => {
    // M10 round-1 P2 regression pin: cli-design §3.1 #7 makes the
    // gate unconditional. Without a token, the live path would fail
    // `config_error`, but the gate must surface `confirmation_required`
    // first so agents key off the right code.
    const out = await drive(
      ['webhook', 'delete', '88001', '--json'],
      { interactions: [] },
      {
        env: { MONDAY_API_URL: 'https://api.monday.com/v2' },
      },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('confirmation_required');
  });

  it('live: --yes deletes and returns the projected envelope', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteWebhook',
          match_variables: { id: '88001' },
          response: { data: { delete_webhook: wireWebhook } },
        },
      ],
    };
    const out = await drive(
      ['webhook', 'delete', '88001', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('88001');
    expect(env.meta.source).toBe('live');
  });

  it('live: not_found when delete_webhook returns null', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteWebhook',
          response: { data: { delete_webhook: null } },
        },
      ],
    };
    const out = await drive(
      ['webhook', 'delete', '99999', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { webhook_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.webhook_id).toBe('99999');
  });

  it('--dry-run: emits §6.4 envelope strictly argv-derived (no pre-mutation read)', async () => {
    // Round-3 P2-1'' closure: webhook delete's dry-run cannot enrich
    // the planned change with event/config because Monday's
    // `webhooks(board_id:)` is board-scoped and the verb has no
    // board ID in argv. NO wire call should fire.
    const out = await drive(
      ['webhook', 'delete', '88001', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly Record<string, unknown>[];
    };
    expect(env.data).toBeNull();
    expect((env.meta as { dry_run?: boolean }).dry_run).toBe(true);
    expect(env.meta.source).toBe('none');
    expect(env.planned_changes).toHaveLength(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('delete_webhook');
    expect(plan?.webhook_id).toBe('88001');
    // Argv-only — no event / board_id / config keys.
    expect(plan).not.toHaveProperty('event');
    expect(plan).not.toHaveProperty('board_id');
    expect(plan).not.toHaveProperty('config');
  });

  it('--dry-run takes precedence over the confirmation gate when --yes is absent', async () => {
    const out = await drive(
      ['webhook', 'delete', '88001', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
  });

  it('usage_error rejects non-numeric webhook ID at parse boundary', async () => {
    const out = await drive(
      ['webhook', 'delete', 'not-a-number', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('internal_error on root-key drift in DeleteWebhook response', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteWebhook',
          response: { data: { something_else: wireWebhook } },
        },
      ],
    };
    const out = await drive(
      ['webhook', 'delete', '88001', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('token never leaks across error envelopes (M27 regression)', async () => {
    const gateOut = await drive(
      ['webhook', 'delete', '88001', '--json'],
      { interactions: [] },
    );
    expect(gateOut.stdout).not.toContain(LEAK_CANARY);
    expect(gateOut.stderr).not.toContain(LEAK_CANARY);

    const notFoundOut = await drive(
      ['webhook', 'delete', '99999', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'DeleteWebhook',
            response: { data: { delete_webhook: null } },
          },
        ],
      },
    );
    expect(notFoundOut.stdout).not.toContain(LEAK_CANARY);
    expect(notFoundOut.stderr).not.toContain(LEAK_CANARY);
  });
});
