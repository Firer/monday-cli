/**
 * Integration tests for `monday notification send` (M27 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched
 * on `operationName: 'CreateNotification'` per the R-NEW-37 W2
 * audit-point. The CLI's 2-value `--target-type` enum collapses to
 * wire `Project` at the fetcher boundary — every cassette below
 * matches `targetType: 'Project'` regardless of which CLI value the
 * test passes.
 */
import { describe, expect, it } from 'vitest';
import { drive, LEAK_CANARY, parseEnvelope, type EnvelopeShape } from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

const wireNotification = {
  id: 'n-100',
  text: 'Please review',
} as const;

describe('monday notification send (M27)', () => {
  it('live: --target-type item collapses to wire Project and echoes inputs in the envelope', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateNotification',
          match_variables: {
            userId: '12345',
            targetId: '67890',
            targetType: 'Project',
            text: 'Please review',
          },
          response: { data: { create_notification: wireNotification } },
        },
      ],
    };
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        '67890',
        '--target-type',
        'item',
        '--text',
        'Please review',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        id: string;
        text: string | null;
        user_id: string;
        target_id: string;
        target_type: string;
      };
    };
    expect(env.data.id).toBe('n-100');
    expect(env.data.text).toBe('Please review');
    expect(env.data.user_id).toBe('12345');
    expect(env.data.target_id).toBe('67890');
    // CLI's argv-side type is preserved in the envelope echo even
    // though the wire enum collapsed to Project.
    expect(env.data.target_type).toBe('item');
    expect(env.meta.source).toBe('live');
  });

  it('live: --target-type board also collapses to wire Project', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateNotification',
          match_variables: {
            userId: '12345',
            targetId: '67890',
            targetType: 'Project',
            text: 'Board ownership updated',
          },
          response: {
            data: {
              create_notification: { id: 'n-101', text: 'Board ownership updated' },
            },
          },
        },
      ],
    };
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        '67890',
        '--target-type',
        'board',
        '--text',
        'Board ownership updated',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { target_type: string };
    };
    expect(env.data.target_type).toBe('board');
  });

  it('--dry-run: emits §6.4 envelope strictly argv-derived (no wire call)', async () => {
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        '67890',
        '--target-type',
        'item',
        '--text',
        'Please review',
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
    expect(plan?.operation).toBe('create_notification');
    expect(plan?.user_id).toBe('12345');
    expect(plan?.target_id).toBe('67890');
    // Dry-run carries the CLI-side argv value, not the wire-side
    // 'Project' — that translation is the runtime body's concern.
    expect(plan?.target_type).toBe('item');
    expect(plan?.text).toBe('Please review');
  });

  it('usage_error rejects unknown --target-type at parse boundary', async () => {
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        '67890',
        '--target-type',
        'update',
        '--text',
        'Please review',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('usage_error rejects empty --text at parse boundary', async () => {
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        '67890',
        '--target-type',
        'item',
        '--text',
        '',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('usage_error rejects non-numeric --target at parse boundary', async () => {
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        'not-a-number',
        '--target-type',
        'item',
        '--text',
        'Please review',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
  });

  it('not_found when create_notification returns null', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateNotification',
          response: { data: { create_notification: null } },
        },
      ],
    };
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        '67890',
        '--target-type',
        'item',
        '--text',
        'Please review',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { user_id?: string; target_id?: string; target_type?: string };
      };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.user_id).toBe('12345');
    expect(env.error?.details?.target_id).toBe('67890');
    expect(env.error?.details?.target_type).toBe('item');
  });

  it('internal_error on root-key drift in CreateNotification response', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateNotification',
          response: { data: { something_else: wireNotification } },
        },
      ],
    };
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        '67890',
        '--target-type',
        'item',
        '--text',
        'Please review',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('internal_error on schema drift in the notification payload', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateNotification',
          response: {
            data: {
              create_notification: {
                // Missing `id` — wireNotificationSchema requires it.
                text: 'Please review',
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        '67890',
        '--target-type',
        'item',
        '--text',
        'Please review',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('token never leaks across error envelopes (M27 regression)', async () => {
    const usageOut = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        '67890',
        '--target-type',
        'update',
        '--text',
        'Please review',
        '--json',
      ],
      { interactions: [] },
    );
    expect(usageOut.stdout).not.toContain(LEAK_CANARY);
    expect(usageOut.stderr).not.toContain(LEAK_CANARY);

    const notFoundOut = await drive(
      [
        'notification',
        'send',
        '--user',
        '12345',
        '--target',
        '67890',
        '--target-type',
        'item',
        '--text',
        'Please review',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'CreateNotification',
            response: { data: { create_notification: null } },
          },
        ],
      },
    );
    expect(notFoundOut.stdout).not.toContain(LEAK_CANARY);
    expect(notFoundOut.stderr).not.toContain(LEAK_CANARY);
  });
});
