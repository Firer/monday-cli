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
  it('returns the projected updates for an item (default: replies omitted)', async () => {
    // v0.2 breaking change: the wire variable is now `ids: [<iid>]`
    // (was `itemIds`), shared across the per-item + per-board
    // routing modes. Default projection emits `replies: []`.
    //
    // Codex M13 F2 (P2): pin the GraphQL query shape via
    // `match_query` so a future regression that always requests
    // replies (silently reintroducing the v0.1 complexity charge)
    // fails loud. The fixture's response carries POPULATED replies
    // to prove the projection's `normaliseReplies` empties them
    // even when Monday hands them back — defense in depth covering
    // both the wire-side query AND the client-side projection.
    const updateWithPopulatedReplies = {
      ...sampleUpdate,
      replies: [
        {
          id: '88',
          body: 'reply body',
          text_body: 'reply body',
          creator_id: '2',
          created_at: '2026-04-30T09:30:00Z',
        },
      ],
    };
    const out = await drive(
      ['update', 'list', '5001', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            match_variables: { ids: ['5001'] },
            // Default GraphQL must NOT include the `replies` selection.
            // RegExp negative-lookahead via `match_query` (substring
            // miss) — assertions in `tests/fixtures/load.ts` enforce
            // present-substring; the `repliesAbsentRegex` matches the
            // full query body and asserts the `replies {` substring
            // doesn't appear.
            match_query: /^(?:(?!replies \{).)*$/s,
            response: {
              data: { items: [{ id: '5001', updates: [updateWithPopulatedReplies] }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    // Projection forces `replies: []` regardless of wire response —
    // proves the F2 contract holds at both layers.
    expect(env.data).toEqual([{ ...sampleUpdate, replies: [] }]);
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

  it('--with-replies populates replies AND requests them on the wire (v0.2 opt-in flag)', async () => {
    // The breaking change: pre-v0.2, replies were ALWAYS populated
    // on every `update list` call (Monday's nested selection). v0.2
    // makes the second leg opt-in via `--with-replies`. This test
    // pins the behaviour at both layers (Codex M13 F2):
    //   1. Wire-side: `match_query` asserts the `replies {` selection
    //      IS present in the GraphQL query.
    //   2. Projection: replies survive the `normaliseReplies` pass.
    const updateWithReplies = {
      ...sampleUpdate,
      replies: [
        {
          id: '88',
          body: 'reply body',
          text_body: 'reply body',
          creator_id: '2',
          created_at: '2026-04-30T09:30:00Z',
        },
      ],
    };
    const out = await drive(
      ['update', 'list', '5001', '--with-replies', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            match_variables: { ids: ['5001'] },
            // The opt-in path MUST include the replies selection.
            match_query: /replies \{/,
            response: {
              data: { items: [{ id: '5001', updates: [updateWithReplies] }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: readonly { replies: readonly unknown[] }[];
    };
    expect(env.data[0]?.replies).toHaveLength(1);
  });

  it('--board <bid> routes through boards(ids:).updates and projects the same shape', async () => {
    // Codex round-2 F1 (P2): same query-shape pin the per-item route
    // got. The board variant uses a SEPARATE GraphQL string
    // (`UpdateListByBoard`); without `match_query` here, a board-only
    // regression could silently re-introduce `replies {` and burn
    // complexity on large board scans. The fixture also returns
    // populated replies to prove the projection still empties them.
    const updateWithPopulatedReplies = {
      ...sampleUpdate,
      replies: [
        {
          id: '88',
          body: 'reply body',
          text_body: 'reply body',
          creator_id: '2',
          created_at: '2026-04-30T09:30:00Z',
        },
      ],
    };
    const out = await drive(
      ['update', 'list', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateListByBoard',
            match_variables: { ids: ['111'] },
            // Default board path must NOT include `replies {` either.
            match_query: /^(?:(?!replies \{).)*$/s,
            response: {
              data: { boards: [{ id: '111', updates: [updateWithPopulatedReplies] }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual([{ ...sampleUpdate, replies: [] }]);
  });

  it('--board --with-replies populates replies AND requests them on the wire', async () => {
    // Codex round-2 F1 (P2) cont. — opt-in path on the board variant
    // mirrors the per-item assertion. `match_query` confirms the
    // `replies {` selection is present in `buildBoardQuery(true)`'s
    // output, so a regression that drops the nested selection from
    // the board path while leaving the item path intact fails loud.
    const boardUpdateWithReplies = {
      ...sampleUpdate,
      replies: [
        {
          id: '88',
          body: 'board reply body',
          text_body: 'board reply body',
          creator_id: '2',
          created_at: '2026-04-30T09:30:00Z',
        },
      ],
    };
    const out = await drive(
      ['update', 'list', '--board', '111', '--with-replies', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateListByBoard',
            match_variables: { ids: ['111'] },
            match_query: /replies \{/,
            response: {
              data: { boards: [{ id: '111', updates: [boardUpdateWithReplies] }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: readonly { replies: readonly unknown[] }[];
    };
    expect(env.data[0]?.replies).toHaveLength(1);
  });

  it('--board with non-existent id surfaces not_found with details.board_id', async () => {
    const out = await drive(
      ['update', 'list', '--board', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateListByBoard',
            response: { data: { boards: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { board_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.board_id).toBe('99999');
  });

  it('rejects passing both <iid> and --board as usage_error (mutually exclusive)', async () => {
    const out = await drive(
      ['update', 'list', '5001', '--board', '111', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects passing neither <iid> nor --board as usage_error', async () => {
    const out = await drive(
      ['update', 'list', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
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
        error?: { code: string; details?: { file_path?: string } };
      };
      expect(env.error?.code).toBe('usage_error');
      // Post-R-v0.5-NEW-18 lift: the generic `readSourceContent` helper
      // surfaces the path under `details.file_path` (universal naming
      // across M13 update verbs + M37 doc-content imports), replacing
      // M13's `details.body_file`.
      expect(env.error?.details?.file_path).toBe(path);
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
    // `JSON.stringify(file)` and `details.file_path` when the
    // read fails (post-R-v0.5-NEW-18 lift; was `details.body_file`
    // pre-lift). Drive a non-existent path whose name LITERALLY
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

describe('monday update delete (integration, M13)', () => {
  const deletedUpdate = {
    id: '77',
    body: '<p>Looks good</p>',
    text_body: 'Looks good',
    creator_id: '1',
    creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
    item_id: '12345',
    created_at: '2026-04-30T09:00:00Z',
    updated_at: '2026-04-30T09:01:00Z',
  };

  it('rejects without --yes as confirmation_required (exit 1)', async () => {
    const out = await drive(
      ['update', 'delete', '77', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { update_id?: string } };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.update_id).toBe('77');
    // Gate fired before any wire call. `meta.source` reflects the
    // runner's pre-resolve default (`'none'`) — same shape M10's
    // archive / delete tests pin.
    expect(env.meta.source).toBe('none');
  });

  it('confirmation gate fires even with no token configured (M10 round-1 P2 ordering)', async () => {
    // Drives the gate-before-resolveClient ordering invariant: drop
    // the token from env so a config_error WOULD fire if the gate
    // ran second. Pre-fix shape was config_error / exit 3; post-fix
    // is confirmation_required / exit 1.
    const out = await drive(
      ['update', 'delete', '77', '--json'],
      { interactions: [] },
      { env: { MONDAY_API_URL: 'https://api.monday.com/v2' } },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('confirmation_required');
  });

  it('live: --yes deletes the update and emits the projected envelope', async () => {
    const out = await drive(
      ['update', 'delete', '77', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateDelete',
            match_variables: { id: '77' },
            response: { data: { delete_update: deletedUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('77');
  });

  it('live: not_found when delete_update returns null', async () => {
    const out = await drive(
      ['update', 'delete', '99999', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateDelete',
            response: { data: { delete_update: null } },
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

  it('--dry-run: emits minimal planned_changes; no mutation fires', async () => {
    const out = await drive(
      ['update', 'delete', '77', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly { operation: string; update_id: string }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('delete_update');
    expect(plan?.update_id).toBe('77');
    // Minimal shape — no preflight read leg, source stays 'none'.
    expect(env.meta.source).toBe('none');
  });

  it('rejects non-numeric update id as usage_error', async () => {
    const out = await drive(
      ['update', 'delete', 'abc', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('token never leaks across the destructive path', async () => {
    const out = await drive(
      ['update', 'delete', '77', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });
});

describe('monday update like / unlike (integration, M13)', () => {
  // SDK shape: `like_update(update_id: ID!) → Update`. Likewise
  // `unlike_update(update_id: ID!) → Update`. The toggle helper sends
  // the variable as `update_id` (vs `id` for pin / unpin).
  const likedUpdate = {
    id: '77',
    body: '<p>Looks good</p>',
    text_body: 'Looks good',
    creator_id: '1',
    creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
    item_id: '12345',
    created_at: '2026-04-30T09:00:00Z',
    updated_at: '2026-04-30T09:01:00Z',
  };

  it('live: like — wires update_id to like_update and emits the projected update', async () => {
    const out = await drive(
      ['update', 'like', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateLike',
            // Pin the variable name (`update_id` vs `id`) — Monday's
            // SDK has a per-mutation divergence the toggle helper
            // captures via `idVariable: 'update_id' | 'id'`.
            match_variables: { update_id: '77' },
            response: { data: { like_update: likedUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('77');
  });

  it('live: unlike — wires update_id to unlike_update and emits the projected update', async () => {
    const out = await drive(
      ['update', 'unlike', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateUnlike',
            match_variables: { update_id: '77' },
            response: { data: { unlike_update: likedUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('77');
  });

  it('--dry-run for like emits {operation: like_update, update_id} with source=none', async () => {
    const out = await drive(
      ['update', 'like', '77', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly { operation: string; update_id: string }[];
    };
    expect(env.data).toBeNull();
    expect(env.planned_changes[0]?.operation).toBe('like_update');
    expect(env.planned_changes[0]?.update_id).toBe('77');
    expect(env.meta.source).toBe('none');
  });

  it('--dry-run for unlike emits {operation: unlike_update, update_id}', async () => {
    const out = await drive(
      ['update', 'unlike', '77', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly { operation: string }[];
    };
    expect(env.planned_changes[0]?.operation).toBe('unlike_update');
  });

  it('not_found when like_update returns null (M10 R28 lifecycle pattern)', async () => {
    const out = await drive(
      ['update', 'like', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateLike',
            response: { data: { like_update: null } },
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

  it('rejects non-numeric update id as usage_error (toggle parser shared)', async () => {
    const out = await drive(
      ['update', 'like', 'abc', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('idempotent flag is true for both like and unlike (re-running is a server-side no-op)', async () => {
    const out = await drive(
      ['schema', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        commands: Readonly<Record<string, { idempotent: boolean }>>;
      };
    };
    expect(env.data.commands['update.like']?.idempotent).toBe(true);
    expect(env.data.commands['update.unlike']?.idempotent).toBe(true);
  });

  it('surfaces typed internal_error for malformed Monday like_update payload', async () => {
    const out = await drive(
      ['update', 'like', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateLike',
            response: { data: { like_update: { id: 'not-numeric' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });
});

describe('monday update pin / unpin (integration, M13)', () => {
  // SDK shape: `pin_to_top(id: ID!) → Update`, `unpin_from_top(id:
  // ID!) → Update`. The toggle helper sends the variable as `id` (vs
  // `update_id` for like / unlike) — pin / unpin specifically diverge
  // here on Monday's side.
  const pinnedUpdate = {
    id: '77',
    body: '<p>Looks good</p>',
    text_body: 'Looks good',
    creator_id: '1',
    creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
    item_id: '12345',
    created_at: '2026-04-30T09:00:00Z',
    updated_at: '2026-04-30T09:01:00Z',
  };

  it('live: pin — wires id (NOT update_id) to pin_to_top and emits the projected update', async () => {
    const out = await drive(
      ['update', 'pin', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdatePin',
            // The variable-name divergence is the load-bearing
            // pin: pin / unpin take `id`; like / unlike take
            // `update_id`. A future regression that collapses
            // them would fail here.
            match_variables: { id: '77' },
            response: { data: { pin_to_top: pinnedUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('77');
  });

  it('live: unpin — wires id to unpin_from_top and emits the projected update', async () => {
    const out = await drive(
      ['update', 'unpin', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateUnpin',
            match_variables: { id: '77' },
            response: { data: { unpin_from_top: pinnedUpdate } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('77');
  });

  it('--dry-run for pin emits {operation: pin_to_top, update_id} with source=none', async () => {
    const out = await drive(
      ['update', 'pin', '77', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly { operation: string; update_id: string }[];
    };
    expect(env.planned_changes[0]?.operation).toBe('pin_to_top');
    expect(env.planned_changes[0]?.update_id).toBe('77');
    expect(env.meta.source).toBe('none');
  });

  it('--dry-run for unpin emits {operation: unpin_from_top}', async () => {
    const out = await drive(
      ['update', 'unpin', '77', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly { operation: string }[];
    };
    expect(env.planned_changes[0]?.operation).toBe('unpin_from_top');
  });

  it('not_found when pin_to_top returns null', async () => {
    const out = await drive(
      ['update', 'pin', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdatePin',
            response: { data: { pin_to_top: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('idempotent flag is true for both pin and unpin', async () => {
    const out = await drive(
      ['schema', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        commands: Readonly<Record<string, { idempotent: boolean }>>;
      };
    };
    expect(env.data.commands['update.pin']?.idempotent).toBe(true);
    expect(env.data.commands['update.unpin']?.idempotent).toBe(true);
  });
});

describe('monday update clear-all (integration, M13 — partial-success envelope)', () => {
  it('rejects without --yes as confirmation_required (exit 1)', async () => {
    const out = await drive(
      ['update', 'clear-all', '12345', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { item_id?: string } };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.item_id).toBe('12345');
  });

  it('confirmation gate fires before resolveClient (M10 round-1 P2 ordering)', async () => {
    const out = await drive(
      ['update', 'clear-all', '12345', '--json'],
      { interactions: [] },
      { env: { MONDAY_API_URL: 'https://api.monday.com/v2' } },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('confirmation_required');
  });

  it('--dry-run: surfaces not_found when Monday returns items: [] on the first page', async () => {
    // Per `clear-all.ts:166-176` (mirrors `update list`'s rule at
    // list.ts:158): only the first page can hand a not_found.
    // Empty items[] from page 1 means the item ID itself is unknown
    // — distinct from "item exists with zero updates" (which returns
    // `[{...}]` with empty `updates`) and from "later pages return
    // empty" (a normal page-walk terminator).
    const out = await drive(
      ['update', 'clear-all', '99999', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateClearAllRead',
            match_variables: { itemIds: ['99999'], page: 1 },
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

  it('--dry-run: page-walks then emits {operation: clear_all_updates, item_id, update_ids}; no delete fires', async () => {
    const out = await drive(
      ['update', 'clear-all', '12345', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateClearAllRead',
            match_variables: { itemIds: ['12345'], page: 1 },
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    updates: [{ id: '77' }, { id: '78' }, { id: '82' }],
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        item_id: string;
        update_ids: readonly string[];
      }[];
    };
    expect(env.data).toBeNull();
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('clear_all_updates');
    expect(plan?.item_id).toBe('12345');
    expect(plan?.update_ids).toEqual(['77', '78', '82']);
    // Page-walk fired real reads; meta.source: 'live'.
    expect(env.meta.source).toBe('live');
  });

  it('live: page-walks + sequential delete; emits ok:true with per-update results', async () => {
    const updateOk = (id: string) => ({ id });
    const out = await drive(
      ['update', 'clear-all', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateClearAllRead',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    updates: [{ id: '77' }, { id: '78' }],
                  },
                ],
              },
            },
          },
          {
            operation_name: 'UpdateClearAllDelete',
            match_variables: { id: '77' },
            response: { data: { delete_update: updateOk('77') } },
          },
          {
            operation_name: 'UpdateClearAllDelete',
            match_variables: { id: '78' },
            response: { data: { delete_update: updateOk('78') } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        results: readonly { update_id: string; ok: boolean }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.results).toEqual([
      { update_id: '77', ok: true },
      { update_id: '78', ok: true },
    ]);
  });

  it('live: empty thread (zero updates) → ok:true with empty results', async () => {
    // Idempotency proof: re-running on an already-cleared item is a
    // valid outcome — the dispatch loop ran zero times, the envelope
    // still emits ok:true with results: [].
    const out = await drive(
      ['update', 'clear-all', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateClearAllRead',
            response: {
              data: { items: [{ id: '12345', updates: [] }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { results: readonly unknown[] };
    };
    expect(env.ok).toBe(true);
    expect(env.data.results).toEqual([]);
  });

  it('live: per-update failure decorates the result record but envelope stays ok:true (universal partial-success rule)', async () => {
    const out = await drive(
      ['update', 'clear-all', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateClearAllRead',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    updates: [{ id: '77' }, { id: '78' }, { id: '82' }],
                  },
                ],
              },
            },
          },
          {
            operation_name: 'UpdateClearAllDelete',
            match_variables: { id: '77' },
            response: { data: { delete_update: { id: '77' } } },
          },
          // Second delete fails (Monday says forbidden mid-loop).
          {
            operation_name: 'UpdateClearAllDelete',
            match_variables: { id: '78' },
            response: {
              errors: [
                {
                  message: 'Permission denied',
                  extensions: { code: 'PERMISSION_DENIED' },
                },
              ],
            },
          },
          // Third delete recovers (loop didn't abort on the failure).
          {
            operation_name: 'UpdateClearAllDelete',
            match_variables: { id: '82' },
            response: { data: { delete_update: { id: '82' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        results: readonly {
          update_id: string;
          ok: boolean;
          error?: { code: string; message: string };
        }[];
      };
    };
    // Per the §1 universal rule: dispatch ran → envelope is ok:true
    // even when a per-target call inside the loop failed.
    expect(env.ok).toBe(true);
    expect(env.data.results.length).toBe(3);
    expect(env.data.results[0]).toEqual({ update_id: '77', ok: true });
    expect(env.data.results[1]?.update_id).toBe('78');
    expect(env.data.results[1]?.ok).toBe(false);
    expect(env.data.results[1]?.error?.code).toBe('forbidden');
    expect(env.data.results[2]).toEqual({ update_id: '82', ok: true });
  });

  it('live: every per-update delete fails — envelope stays ok:true (whole-call success means dispatch ran)', async () => {
    const out = await drive(
      ['update', 'clear-all', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateClearAllRead',
            response: {
              data: {
                items: [
                  { id: '12345', updates: [{ id: '77' }, { id: '78' }] },
                ],
              },
            },
          },
          {
            operation_name: 'UpdateClearAllDelete',
            match_variables: { id: '77' },
            response: { data: { delete_update: null } },
          },
          {
            operation_name: 'UpdateClearAllDelete',
            match_variables: { id: '78' },
            response: { data: { delete_update: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        results: readonly {
          update_id: string;
          ok: boolean;
          error?: { code: string };
        }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.results[0]?.ok).toBe(false);
    expect(env.data.results[0]?.error?.code).toBe('not_found');
    expect(env.data.results[1]?.ok).toBe(false);
    expect(env.data.results[1]?.error?.code).toBe('not_found');
  });

  it('not_found surfaces at the WHOLE-CALL boundary when the item itself is missing', async () => {
    // Page-walk's first page returns no items → not_found before
    // any delete fires. This is the whole-call-failure exception
    // to the partial-success rule (top-level `ok: false`).
    const out = await drive(
      ['update', 'clear-all', '99999', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateClearAllRead',
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

  it('rejects non-numeric item id as usage_error', async () => {
    const out = await drive(
      ['update', 'clear-all', 'abc', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('idempotent flag is true (zero-update re-run is a valid outcome)', async () => {
    const out = await drive(
      ['schema', 'update.clear-all', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        commands: Readonly<Record<string, { idempotent: boolean }>>;
      };
    };
    expect(env.data.commands['update.clear-all']?.idempotent).toBe(true);
  });

  it('truncated page-walk surfaces pagination_cap_reached warning + dispatch covers the prefix only', async () => {
    // Codex M13 F1 (P2) regression. With --limit-pages 2 and a thread
    // bigger than 2 × 100 updates, the walker stops at the cap with
    // `hasMore: true`. The CLI surfaces `pagination_cap_reached`
    // (mirroring update list / item list) so the agent knows the
    // partial-success envelope's `data.results` only covers the
    // collected prefix — re-run to clear the rest.
    const fullPage = (start: number) =>
      Array.from({ length: 100 }, (_, i) => ({ id: String(start + i) }));
    const out = await drive(
      [
        'update',
        'clear-all',
        '12345',
        '--yes',
        '--limit-pages',
        '2',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'UpdateClearAllRead',
            match_variables: { page: 1 },
            response: {
              data: {
                items: [{ id: '12345', updates: fullPage(1) }],
              },
            },
          },
          {
            operation_name: 'UpdateClearAllRead',
            match_variables: { page: 2 },
            response: {
              data: {
                items: [{ id: '12345', updates: fullPage(101) }],
              },
            },
          },
          // Per-update deletes for the 200 collected updates. `repeat`
          // lets one canned response satisfy the loop without bloating
          // the cassette.
          {
            operation_name: 'UpdateClearAllDelete',
            response: { data: { delete_update: { id: '0' } } },
            repeat: 200,
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { results: readonly { ok: boolean }[] };
      warnings: readonly { code: string }[];
    };
    expect(env.ok).toBe(true);
    expect(env.data.results.length).toBe(200);
    expect(env.warnings[0]?.code).toBe('pagination_cap_reached');
  });

  it('--dry-run also surfaces pagination_cap_reached when the page-walk truncates', async () => {
    // Same regression — dry-run paths must inherit the warning too,
    // otherwise an agent previewing a too-big thread sees an
    // incomplete `update_ids` list with no signal that more exist.
    const fullPage = (start: number) =>
      Array.from({ length: 100 }, (_, i) => ({ id: String(start + i) }));
    const out = await drive(
      [
        'update',
        'clear-all',
        '12345',
        '--dry-run',
        '--limit-pages',
        '2',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'UpdateClearAllRead',
            match_variables: { page: 1 },
            response: {
              data: { items: [{ id: '12345', updates: fullPage(1) }] },
            },
          },
          {
            operation_name: 'UpdateClearAllRead',
            match_variables: { page: 2 },
            response: {
              data: { items: [{ id: '12345', updates: fullPage(101) }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly { update_ids: readonly string[] }[];
      warnings: readonly { code: string }[];
    };
    expect(env.warnings[0]?.code).toBe('pagination_cap_reached');
    expect(env.planned_changes[0]?.update_ids.length).toBe(200);
  });
});

describe('monday update list — NDJSON streaming (M18)', () => {
  // Mirrors item list / item search M18 streaming tests but
  // exercises the page-walked variant via `walkPages.onItem`
  // (not `paginate.onItem`). Two variants: per-item routing
  // (positional <iid>) and per-board routing (--board <bid>);
  // both stream through the same lifted `startNdjsonStream`
  // helper (R52). Per-update zod parse runs in the project
  // callback for parity with JSON mode (Codex P3-2).
  //
  // Trailer-side per-noun divergence vs item list/search:
  // update list omits `meta.columns` (updates aren't column-
  // bearing) and `meta.next_cursor` (page-walked, not cursor-
  // walked). Other slots (has_more, total_returned, complexity)
  // match.

  it('per-item: streams NDJSON one update per line + trailer', async () => {
    const out = await drive(
      ['update', 'list', '5001', '--output', 'ndjson'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            response: {
              data: {
                items: [
                  {
                    id: '5001',
                    updates: [
                      sampleUpdate,
                      { ...sampleUpdate, id: '78', text_body: 'Second' },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines).toHaveLength(3); // 2 updates + trailer
    const u1 = JSON.parse(lines[0] ?? '') as { id: string };
    const u2 = JSON.parse(lines[1] ?? '') as { id: string };
    expect(u1.id).toBe('77');
    expect(u2.id).toBe('78');
    const trailer = JSON.parse(lines[2] ?? '') as {
      _meta: { has_more: boolean; total_returned: number };
    };
    expect(trailer._meta.has_more).toBe(false);
    expect(trailer._meta.total_returned).toBe(2);
  });

  it('per-board: streams NDJSON aggregated updates one per line + trailer', async () => {
    const out = await drive(
      ['update', 'list', '--board', '111', '--output', 'ndjson'],
      {
        interactions: [
          {
            operation_name: 'UpdateListByBoard',
            response: {
              data: {
                boards: [
                  {
                    id: '111',
                    updates: [sampleUpdate],
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines).toHaveLength(2); // 1 update + trailer
    const u = JSON.parse(lines[0] ?? '') as { id: string };
    expect(u.id).toBe('77');
    const trailer = JSON.parse(lines[1] ?? '') as {
      _meta: { has_more: boolean; total_returned: number };
    };
    expect(trailer._meta.has_more).toBe(false);
    expect(trailer._meta.total_returned).toBe(1);
  });

  it('streams NDJSON across pages with --all (walkPages.onItem fires per page)', async () => {
    // Pin walkPages.onItem ordering across pages — items arrive
    // in the wire order Monday returns; the streaming hook fires
    // per-item-per-page sequentially.
    const out = await drive(
      ['update', 'list', '5001', '--all', '--limit', '2', '--output', 'ndjson'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            match_variables: { ids: ['5001'], limit: 2, page: 1 },
            response: {
              data: {
                items: [
                  {
                    id: '5001',
                    updates: [
                      { ...sampleUpdate, id: '1' },
                      { ...sampleUpdate, id: '2' },
                    ],
                  },
                ],
              },
            },
          },
          {
            operation_name: 'UpdateList',
            match_variables: { ids: ['5001'], limit: 2, page: 2 },
            response: {
              data: {
                items: [
                  {
                    id: '5001',
                    updates: [
                      { ...sampleUpdate, id: '3' },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines).toHaveLength(4); // 3 updates + trailer
    const ids = lines.slice(0, 3).map((l) => (JSON.parse(l) as { id: string }).id);
    expect(ids).toEqual(['1', '2', '3']);
    const trailer = JSON.parse(lines[3] ?? '') as {
      _meta: { has_more: boolean; total_returned: number };
    };
    expect(trailer._meta.has_more).toBe(false);
    expect(trailer._meta.total_returned).toBe(3);
  });

  it('NDJSON projection runs normaliseReplies (default replies omitted matches JSON mode)', async () => {
    // Codex M18 pre-flight P3-2: NDJSON path must run through
    // the same `normaliseReplies` boundary as JSON mode so the
    // default `replies: []` shape matches. This pins the
    // post-`normaliseReplies` zod parse in the streaming
    // branch's project callback.
    const updateWithPopulatedReplies = {
      ...sampleUpdate,
      replies: [
        {
          id: '88',
          body: 'reply body',
          text_body: 'reply body',
          creator_id: '2',
          created_at: '2026-04-30T09:30:00Z',
        },
      ],
    };
    const out = await drive(
      ['update', 'list', '5001', '--output', 'ndjson'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            // Default GraphQL must NOT include the `replies` selection.
            match_query: /^(?:(?!replies \{).)*$/s,
            response: {
              data: {
                items: [
                  { id: '5001', updates: [updateWithPopulatedReplies] },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trim().split('\n');
    const update = JSON.parse(lines[0] ?? '') as { replies: readonly unknown[] };
    // normaliseReplies emptied the replies array — NDJSON output
    // matches JSON-mode default (empty array, regardless of what
    // Monday returned).
    expect(update.replies).toEqual([]);
  });

  it('NDJSON --with-replies populates replies (parity with JSON mode opt-in)', async () => {
    const updateWithReplies = {
      ...sampleUpdate,
      replies: [
        {
          id: '88',
          body: 'reply',
          text_body: 'reply',
          creator_id: '2',
          created_at: '2026-04-30T09:30:00Z',
        },
      ],
    };
    const out = await drive(
      ['update', 'list', '5001', '--with-replies', '--output', 'ndjson'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            response: {
              data: {
                items: [{ id: '5001', updates: [updateWithReplies] }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trim().split('\n');
    const update = JSON.parse(lines[0] ?? '') as { replies: readonly { id: string }[] };
    expect(update.replies).toHaveLength(1);
    expect(update.replies[0]?.id).toBe('88');
  });

  it('NDJSON trailer has only the `_meta` key (§6.3 contract pin)', async () => {
    const out = await drive(
      ['update', 'list', '5001', '--output', 'ndjson'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            response: {
              data: { items: [{ id: '5001', updates: [sampleUpdate] }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trim().split('\n');
    const trailer = JSON.parse(lines[lines.length - 1] ?? '') as Record<
      string,
      unknown
    >;
    expect(Object.keys(trailer)).toEqual(['_meta']);
  });

  it('not_found error surfaces on stderr (envelope on error path, no NDJSON output)', async () => {
    // Streaming applies on success only — a not_found before any
    // item arrives goes through the runner's error envelope on
    // stderr, exit 2. stdout stays empty (no half-stream).
    const out = await drive(
      ['update', 'list', '99999', '--output', 'ndjson'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe('');
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });
});
