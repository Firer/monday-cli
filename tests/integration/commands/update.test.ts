/**
 * Integration tests for `monday update *` (M3 §3 reads only —
 * `update create` ships in M5b).
 */
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  drive,
  parseEnvelope,
  LEAK_CANARY,
  type EnvelopeShape,
} from '../helpers.js';

const sampleUpdate = {
  id: '77',
  body: '<p>Looks good</p>',
  text_body: 'Looks good',
  creator_id: '1',
  creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
  created_at: '2026-04-30T09:00:00Z',
  updated_at: '2026-04-30T09:01:00Z',
  edited_at: '2026-04-30T09:01:00Z',
  replies: [],
};

describe('monday update list — null-data resilience', () => {
  it('emits an empty list when items[0].updates is missing', async () => {
    const out = await drive(
      ['update', 'list', '5001', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            response: { data: { items: [{ id: '5001' }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual([]);
  });
});

describe('monday update list', () => {
  it('returns the projected updates for an item', async () => {
    const out = await drive(
      ['update', 'list', '5001', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            match_variables: { itemIds: ['5001'] },
            response: {
              data: { items: [{ id: '5001', updates: [sampleUpdate] }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual([sampleUpdate]);
    expect(env.meta.total_returned).toBe(1);
  });

  it('not_found when the item itself is missing', async () => {
    const out = await drive(
      ['update', 'list', '9999', '--json'],
      {
        interactions: [
          { operation_name: 'UpdateList', response: { data: { items: [] } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('returns an empty list when item exists with zero updates', async () => {
    const out = await drive(
      ['update', 'list', '5001', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            response: { data: { items: [{ id: '5001', updates: [] }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual([]);
    expect(env.meta.total_returned).toBe(0);
  });

  it('rejects --all + --page', async () => {
    const out = await drive(
      ['update', 'list', '5001', '--all', '--page', '2', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--all walks pages until short page', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => ({
      ...sampleUpdate,
      id: String(100 + i),
    }));
    const shortPage = [{ ...sampleUpdate, id: '200' }];
    const out = await drive(
      ['update', 'list', '5001', '--all', '--limit', '25', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            match_variables: { page: 1 },
            response: { data: { items: [{ id: '5001', updates: fullPage }] } },
          },
          {
            operation_name: 'UpdateList',
            match_variables: { page: 2 },
            response: { data: { items: [{ id: '5001', updates: shortPage }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.total_returned).toBe(26);
  });

  it('--all + --limit-pages emits pagination_cap_reached', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => ({
      ...sampleUpdate,
      id: String(100 + i),
    }));
    const out = await drive(
      ['update', 'list', '5001', '--all', '--limit', '25', '--limit-pages', '2', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            match_variables: { page: 1 },
            response: { data: { items: [{ id: '5001', updates: fullPage }] } },
          },
          {
            operation_name: 'UpdateList',
            match_variables: { page: 2 },
            response: { data: { items: [{ id: '5001', updates: fullPage }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      warnings: readonly { readonly code: string }[];
    };
    expect(env.meta.has_more).toBe(true);
    expect(env.warnings[0]?.code).toBe('pagination_cap_reached');
  });

  it('--api-version reaches error envelope on HTTP 401', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'update', 'list', '5001', '--json'],
      {
        interactions: [
          { operation_name: 'UpdateList', http_status: 401, response: {} },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
  });
});

describe('monday update get', () => {
  it('returns the projected update', async () => {
    const out = await drive(
      ['update', 'get', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateGet',
            match_variables: { ids: ['77'] },
            response: {
              data: {
                updates: [{ ...sampleUpdate, item_id: '5001' }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toMatchObject({ id: '77', item_id: '5001' });
  });

  it('not_found when the update id misses', async () => {
    const out = await drive(
      ['update', 'get', '9999', '--json'],
      {
        interactions: [
          { operation_name: 'UpdateGet', response: { data: { updates: [] } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('rejects non-numeric update id', async () => {
    const out = await drive(['update', 'get', 'abc', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});

describe('monday update create (integration, M5b)', () => {
  const createdUpdate = {
    id: '88',
    body: '<p>Done — moved to QA.</p>',
    text_body: 'Done — moved to QA.',
    creator_id: '1',
    creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
    item_id: '12345',
    created_at: '2026-04-30T11:00:00Z',
    updated_at: '2026-04-30T11:00:00Z',
  };

  it('surfaces internal_error when Monday returns a null create_update payload', async () => {
    // Drives the projectCreatedUpdate null-guard — Monday returning
    // `create_update: null` is unexpected but possible. The guard
    // surfaces it as internal_error rather than a TypeError.
    const out = await drive(
      ['update', 'create', '12345', '--body', 'x', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateCreate',
            response: { data: { create_update: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('live: --body posts the comment and emits the projected update', async () => {
    const out = await drive(
      ['update', 'create', '12345', '--body', 'Done — moved to QA.', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateCreate',
            response: { data: { create_update: createdUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; item_id: string; body: string };
    };
    expect(env.data.id).toBe('88');
    expect(env.data.item_id).toBe('12345');
    expect(env.data.body).toContain('Done');
  });

  it('rejects empty --body as usage_error', async () => {
    const out = await drive(
      ['update', 'create', '12345', '--body', '', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects no --body and no --body-file as usage_error', async () => {
    const out = await drive(
      ['update', 'create', '12345', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric item id as usage_error', async () => {
    const out = await drive(
      ['update', 'create', 'abc', '--body', 'x', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: emits planned_changes with operation create_update; no mutation fires', async () => {
    const out = await drive(
      ['update', 'create', '12345', '--body', 'preview only', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        item_id: string;
        body: string;
        body_length: number;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('create_update');
    expect(plan?.item_id).toBe('12345');
    expect(plan?.body).toBe('preview only');
    expect(plan?.body_length).toBe(12);
  });

  // Codex pass-1 F5: empty-after-trim must reject.
  it('rejects whitespace-only --body as usage_error (F5)', async () => {
    const out = await drive(
      ['update', 'create', '12345', '--body', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  // Codex pass-1 F7: --body-file <path> coverage.
  describe('--body-file', () => {
    let tmpRoot: string;
    beforeEach(async () => {
      tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-update-create-'));
    });
    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('reads --body-file <path> and posts the contents', async () => {
      const path = join(tmpRoot, 'body.md');
      await writeFile(path, 'Body from disk\n', 'utf8');
      const created = {
        id: '88',
        body: '<p>Body from disk</p>',
        text_body: 'Body from disk',
        creator_id: '1',
        creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
        item_id: '12345',
        created_at: '2026-04-30T11:00:00Z',
        updated_at: '2026-04-30T11:00:00Z',
      };
      const out = await drive(
        ['update', 'create', '12345', '--body-file', path, '--json'],
        {
          interactions: [
            {
              operation_name: 'UpdateCreate',
              response: { data: { create_update: created } },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { id: string; text_body: string };
      };
      expect(env.data.id).toBe('88');
    });

    it('reads --body-file - from stdin', async () => {
      const created = {
        id: '99',
        body: '<p>From stdin</p>',
        text_body: 'From stdin',
        creator_id: '1',
        creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
        item_id: '12345',
        created_at: '2026-04-30T11:00:00Z',
        updated_at: '2026-04-30T11:00:00Z',
      };
      const stdin = Readable.from(['From stdin\n']);
      const out = await drive(
        ['update', 'create', '12345', '--body-file', '-', '--json'],
        {
          interactions: [
            {
              operation_name: 'UpdateCreate',
              response: { data: { create_update: created } },
            },
          ],
        },
        { stdin },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { id: string };
      };
      expect(env.data.id).toBe('99');
    });

    it('rejects empty stdin as usage_error', async () => {
      const stdin = Readable.from(['']);
      const out = await drive(
        ['update', 'create', '12345', '--body-file', '-', '--json'],
        { interactions: [] },
        { stdin },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr);
      expect(env.error?.code).toBe('usage_error');
    });

    it('rejects --body and --body-file together as usage_error', async () => {
      const out = await drive(
        ['update', 'create', '12345', '--body', 'inline', '--body-file', 'nonexistent', '--json'],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr);
      expect(env.error?.code).toBe('usage_error');
    });

    it('surfaces a clear usage_error when --body-file path does not exist', async () => {
      const out = await drive(
        ['update', 'create', '12345', '--body-file', join(tmpRoot, 'missing.md'), '--json'],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr);
      expect(env.error?.code).toBe('usage_error');
    });

    it('rejects empty --body-file content as usage_error (after trim)', async () => {
      // Covers create.ts:172 — empty file (or whitespace-only that
      // trims to nothing) surfaces usage_error rather than posting
      // an empty comment Monday would reject anyway.
      const path = join(tmpRoot, 'empty.md');
      await writeFile(path, '   \n\n', 'utf8');
      const out = await drive(
        ['update', 'create', '12345', '--body-file', path, '--json'],
        { interactions: [] },
      );
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr) as EnvelopeShape & {
        error?: { code: string; details?: { body_file?: string } };
      };
      expect(env.error?.code).toBe('usage_error');
      expect(env.error?.details?.body_file).toBe(path);
    });
  });

  it('surfaces typed internal_error for malformed Monday response', async () => {
    const out = await drive(
      ['update', 'create', '12345', '--body', 'x', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateCreate',
            response: { data: { create_update: { id: 'not-numeric-update-id' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('token never leaks in error envelopes (M5b regression)', async () => {
    const out = await drive(
      ['update', 'create', '12345', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });

  it('user-input canary: --body-file path containing the token is redacted on read failure', async () => {
    // Codex M5b finding #4 (P2): coverage proof for the value-
    // scanning redactor on a user-input echo path that landed in
    // M5b. `update create --body-file <path>` echoes the path via
    // `JSON.stringify(bodyFile)` and `details.body_file` when the
    // read fails. Drive a non-existent path whose name LITERALLY
    // CONTAINS the canary bytes and verify the redactor scrubs
    // them before the UsageError envelope is emitted.
    const path = `/tmp/nonexistent-${LEAK_CANARY}.md`;
    const out = await drive(
      ['update', 'create', '12345', '--body-file', path, '--json'],
      { interactions: [] },
    );
    // ENOENT → UsageError, exit 1.
    expect(out.exitCode).toBe(1);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });
});

describe('monday update reply (integration, M13)', () => {
  // create_update with parent_id returns the same Update shape as the
  // top-level create. The CLI projects it + echoes parent_id from
  // argv.
  const createdReply = {
    id: '88',
    body: '<p>Acknowledged — looking now.</p>',
    text_body: 'Acknowledged — looking now.',
    creator_id: '1',
    creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
    item_id: '12345',
    created_at: '2026-04-30T11:30:00Z',
    updated_at: '2026-04-30T11:30:00Z',
  };

  it('live: --body posts the reply via parent_id and emits the projected update', async () => {
    const out = await drive(
      ['update', 'reply', '77', '--body', 'Acknowledged — looking now.', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateReply',
            // Wire shape: `parent_id` (not `item_id`); `body` is the
            // trimmed agent input. Pinned via match_variables so a
            // future drift that sends `item_id: <pid>` (mis-routes
            // top-level) fails loudly.
            match_variables: { parentId: '77', body: 'Acknowledged — looking now.' },
            response: { data: { create_update: createdReply } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; parent_id: string; item_id: string };
    };
    expect(env.data.id).toBe('88');
    expect(env.data.parent_id).toBe('77');
    expect(env.data.item_id).toBe('12345');
  });

  it('rejects empty --body as usage_error', async () => {
    const out = await drive(
      ['update', 'reply', '77', '--body', '', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects no --body and no --body-file as usage_error', async () => {
    const out = await drive(
      ['update', 'reply', '77', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    // The verb-specific hint references "monday update reply" so the
    // agent's recovery instruction is correct for this command.
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric parent id as usage_error', async () => {
    const out = await drive(
      ['update', 'reply', 'abc', '--body', 'x', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: emits planned_changes with operation create_update + parent_id; no mutation fires', async () => {
    const out = await drive(
      ['update', 'reply', '77', '--body', 'preview reply', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        parent_id: string;
        body: string;
        body_length: number;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('create_update');
    expect(plan?.parent_id).toBe('77');
    expect(plan?.body).toBe('preview reply');
    expect(plan?.body_length).toBe(13);
  });

  it('not_found when Monday returns null create_update for an unknown parent_id', async () => {
    // Mirrors `item delete`'s null-wire-result → `not_found` shape
    // (R28 `projectMutationItem({errorCode: 'not_found'})`). Monday
    // returns `create_update: null` when the parent is deleted /
    // hidden; the CLI surfaces it as `not_found` carrying
    // `details.parent_id` so the agent has the lineage handy.
    const out = await drive(
      ['update', 'reply', '99999', '--body', 'x', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateReply',
            response: { data: { create_update: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { parent_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.parent_id).toBe('99999');
  });

  it('surfaces typed internal_error for malformed Monday reply payload', async () => {
    const out = await drive(
      ['update', 'reply', '77', '--body', 'x', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateReply',
            response: { data: { create_update: { id: 'not-numeric-update-id' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('--body-file <path>: reads contents and posts the reply', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-update-reply-'));
    try {
      const path = join(tmpRoot, 'reply.md');
      await writeFile(path, 'Reply from disk\n', 'utf8');
      const out = await drive(
        ['update', 'reply', '77', '--body-file', path, '--json'],
        {
          interactions: [
            {
              operation_name: 'UpdateReply',
              match_variables: { parentId: '77', body: 'Reply from disk' },
              response: {
                data: {
                  create_update: { ...createdReply, body: '<p>Reply from disk</p>', text_body: 'Reply from disk' },
                },
              },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { id: string; parent_id: string };
      };
      expect(env.data.parent_id).toBe('77');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('--body-file - reads from stdin', async () => {
    const stdin = Readable.from(['Reply from stdin\n']);
    const out = await drive(
      ['update', 'reply', '77', '--body-file', '-', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateReply',
            match_variables: { parentId: '77', body: 'Reply from stdin' },
            response: {
              data: {
                create_update: { ...createdReply, body: '<p>Reply from stdin</p>', text_body: 'Reply from stdin' },
              },
            },
          },
        ],
      },
      { stdin },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { parent_id: string };
    };
    expect(env.data.parent_id).toBe('77');
  });

  it('rejects --body and --body-file together as usage_error (shared body-source contract)', async () => {
    const out = await drive(
      ['update', 'reply', '77', '--body', 'inline', '--body-file', 'somewhere', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('token never leaks in error envelopes', async () => {
    const out = await drive(
      ['update', 'reply', '77', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });
});

describe('monday update edit (integration, M13)', () => {
  const editedUpdate = {
    id: '77',
    body: '<p>Updated: actually shipping today.</p>',
    text_body: 'Updated: actually shipping today.',
    creator_id: '1',
    creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
    item_id: '12345',
    created_at: '2026-04-30T09:00:00Z',
    updated_at: '2026-04-30T12:00:00Z',
  };

  it('live: --body replaces the body and emits the projected update', async () => {
    const out = await drive(
      [
        'update',
        'edit',
        '77',
        '--body',
        'Updated: actually shipping today.',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'UpdateEdit',
            // Wire shape: id (not update_id) per Monday's
            // edit_update(id, body) signature. Pinned via
            // match_variables to catch any future drift that swaps
            // the variable name.
            match_variables: { id: '77', body: 'Updated: actually shipping today.' },
            response: { data: { edit_update: editedUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; body: string };
    };
    expect(env.data.id).toBe('77');
    expect(env.data.body).toContain('Updated');
  });

  it('rejects empty --body as usage_error', async () => {
    const out = await drive(
      ['update', 'edit', '77', '--body', '', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects no --body and no --body-file as usage_error', async () => {
    const out = await drive(
      ['update', 'edit', '77', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric update id as usage_error', async () => {
    const out = await drive(
      ['update', 'edit', 'abc', '--body', 'x', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: emits planned_changes with operation edit_update; no mutation fires', async () => {
    const out = await drive(
      ['update', 'edit', '77', '--body', 'preview edit', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        update_id: string;
        body: string;
        body_length: number;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('edit_update');
    expect(plan?.update_id).toBe('77');
    expect(plan?.body).toBe('preview edit');
    expect(plan?.body_length).toBe(12);
  });

  it('not_found when Monday returns null edit_update for an unknown id', async () => {
    const out = await drive(
      ['update', 'edit', '99999', '--body', 'x', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateEdit',
            response: { data: { edit_update: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { update_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.update_id).toBe('99999');
  });

  it('idempotent flag is true (re-edit with same body is a no-op)', async () => {
    // Pin the contract via the schema registry — agents introspect
    // `monday schema update.edit` for the idempotency-knob and act
    // accordingly. The check is structural to prevent silent drift
    // if a future refactor flips the knob.
    const out = await drive(
      ['schema', 'update.edit', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        commands: Readonly<Record<string, { idempotent: boolean }>>;
      };
    };
    expect(env.data.commands['update.edit']?.idempotent).toBe(true);
  });

  it('--body-file <path> reads contents and edits the body', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-update-edit-'));
    try {
      const path = join(tmpRoot, 'edit.md');
      await writeFile(path, 'Body from disk\n', 'utf8');
      const out = await drive(
        ['update', 'edit', '77', '--body-file', path, '--json'],
        {
          interactions: [
            {
              operation_name: 'UpdateEdit',
              match_variables: { id: '77', body: 'Body from disk' },
              response: { data: { edit_update: editedUpdate } },
            },
          ],
        },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { id: string };
      };
      expect(env.data.id).toBe('77');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('token never leaks in error envelopes', async () => {
    const out = await drive(
      ['update', 'edit', '77', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });
});
