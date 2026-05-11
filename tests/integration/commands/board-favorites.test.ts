/**
 * Integration tests for `monday board favorites` — drives the runtime
 * 2-stage resolver via `FixtureTransport` cassettes (cli-design §13
 * v0.3 entry; v0.3-plan §3 M23).
 *
 * Tests confirm:
 *
 *   - Stage-1 happy path → Stage-2 hydrate → success envelope with
 *     boards sorted by `position` ascending.
 *   - Stage-1 empty-list short-circuit emits success with `data: []`
 *     and never issues Stage 2.
 *   - Stage-1 with no Board-typed entries short-circuits identically.
 *   - Stage-1/Stage-2 count delta surfaces a
 *     `board_favorites_stale` warning (board deleted / access
 *     revoked since being favorited).
 *   - Polymorphic non-Board entries are dropped at the filter step.
 *   - `meta.source` is `live`; `meta.cache_age_seconds` is `null`.
 *
 * Cassettes are inline `Interaction[]` so the wire shape stays close
 * to each test's assertions; the favorites surface is too small to
 * justify shared fixture files.
 */
import { describe, expect, it } from 'vitest';
import { drive } from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

describe('monday board favorites — Stage-1 short-circuit', () => {
  it('emits empty data + skips Stage 2 when favorites is empty', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: { data: { favorites: [] } },
        },
      ],
    };
    const result = await drive(['board', 'favorites', '--json'], cassette);
    expect(result.exitCode).toBe(0);
    expect(result.requests).toBe(1);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data: unknown;
      meta: { source: string; cache_age_seconds: number | null };
      warnings?: readonly unknown[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual([]);
    expect(envelope.meta.source).toBe('live');
    expect(envelope.meta.cache_age_seconds).toBe(null);
    expect(envelope.warnings ?? []).toEqual([]);
  });

  it('skips Stage 2 when favorites has only non-Board entries', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: {
            data: {
              favorites: [
                { id: '1', object: { id: '100', type: 'Folder' }, position: 1 },
                { id: '2', object: { id: '200', type: 'Dashboard' }, position: 2 },
                { id: '3', object: { id: '300', type: 'Workspace' }, position: 3 },
              ],
            },
          },
        },
      ],
    };
    const result = await drive(['board', 'favorites', '--json'], cassette);
    expect(result.exitCode).toBe(0);
    expect(result.requests).toBe(1);
    const envelope = JSON.parse(result.stdout) as { data: unknown };
    expect(envelope.data).toEqual([]);
  });
});

describe('monday board favorites — happy path', () => {
  it('runs both stages and emits the hydrated rows sorted by position', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: {
            data: {
              favorites: [
                // Out-of-order to confirm sort-by-position.
                { id: 'c', object: { id: '300', type: 'Board' }, position: 3 },
                { id: 'a', object: { id: '100', type: 'Board' }, position: 1.5 },
                // Non-Board entry to confirm filter step drops it.
                { id: 'f', object: { id: '900', type: 'Folder' }, position: 2 },
                { id: 'b', object: { id: '200', type: 'Board' }, position: 2.5 },
              ],
            },
          },
        },
        {
          operation_name: 'BoardFavoritesStage2',
          match_variables: { ids: ['100', '200', '300'] },
          response: {
            data: {
              boards: [
                {
                  id: '100',
                  name: 'Tasks',
                  state: 'active',
                  workspace_id: '50',
                  url: 'https://x.monday.com/boards/100',
                },
                {
                  id: '200',
                  name: 'Sprint',
                  state: 'active',
                  workspace_id: '50',
                  url: 'https://x.monday.com/boards/200',
                },
                {
                  id: '300',
                  name: 'Archive',
                  state: 'archived',
                  workspace_id: null,
                  url: null,
                },
              ],
            },
          },
        },
      ],
    };
    const result = await drive(['board', 'favorites', '--json'], cassette);
    expect(result.exitCode).toBe(0);
    expect(result.requests).toBe(2);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data: readonly {
        id: string;
        name: string;
        position: number;
      }[];
      meta: { source: string; total_returned?: number };
      warnings?: readonly unknown[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.map((b) => ({ id: b.id, position: b.position }))).toEqual([
      { id: '100', position: 1.5 },
      { id: '200', position: 2.5 },
      { id: '300', position: 3 },
    ]);
    expect(envelope.meta.total_returned).toBe(3);
    expect(envelope.meta.source).toBe('live');
    expect(envelope.warnings ?? []).toEqual([]);
  });

  it('emits the full row shape (id + name + state + workspace_id + url + position)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: {
            data: {
              favorites: [
                { id: 'a', object: { id: '100', type: 'Board' }, position: 1 },
              ],
            },
          },
        },
        {
          operation_name: 'BoardFavoritesStage2',
          response: {
            data: {
              boards: [
                {
                  id: '100',
                  name: 'Tasks',
                  state: 'active',
                  workspace_id: '50',
                  url: 'https://x.monday.com/boards/100',
                },
              ],
            },
          },
        },
      ],
    };
    const result = await drive(['board', 'favorites', '--json'], cassette);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as { data: readonly Record<string, unknown>[] };
    expect(envelope.data[0]).toEqual({
      id: '100',
      name: 'Tasks',
      state: 'active',
      workspace_id: '50',
      url: 'https://x.monday.com/boards/100',
      position: 1,
    });
  });
});

describe('monday board favorites — stale-favorites warning', () => {
  it('surfaces board_favorites_stale on the Stage-1/Stage-2 count delta', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: {
            data: {
              favorites: [
                { id: 'a', object: { id: '100', type: 'Board' }, position: 1 },
                { id: 'b', object: { id: '200', type: 'Board' }, position: 2 },
                { id: 'c', object: { id: '300', type: 'Board' }, position: 3 },
              ],
            },
          },
        },
        {
          operation_name: 'BoardFavoritesStage2',
          response: {
            data: {
              boards: [
                { id: '100', name: 'A', state: 'active', workspace_id: null, url: null },
                { id: '300', name: 'C', state: 'active', workspace_id: null, url: null },
              ],
            },
          },
        },
      ],
    };
    const result = await drive(['board', 'favorites', '--json'], cassette);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      data: readonly { id: string }[];
      warnings: readonly {
        code: string;
        message: string;
        details: {
          favorited_count: number;
          hydrated_count: number;
          missing_board_ids: readonly string[];
          hint: string;
        };
      }[];
    };
    expect(envelope.data.map((b) => b.id)).toEqual(['100', '300']);
    expect(envelope.warnings).toHaveLength(1);
    const warning = envelope.warnings[0];
    expect(warning?.code).toBe('board_favorites_stale');
    expect(warning?.details.favorited_count).toBe(3);
    expect(warning?.details.hydrated_count).toBe(2);
    expect(warning?.details.missing_board_ids).toEqual(['200']);
    expect(warning?.details.hint).toMatch(/deleted|access revoked|archived/);
  });
});

describe('monday board favorites — parse-failure surface', () => {
  it('emits internal_error when Stage 1 shape drifts', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: { data: { favorites: 'not-an-array' } },
        },
      ],
    };
    const result = await drive(['board', 'favorites', '--json'], cassette);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as {
      ok: boolean;
      error: { code: string; message: string; details: { hint: string } };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('internal_error');
    expect(envelope.error.message).toMatch(/Query\.favorites/);
  });

  it('emits internal_error when Stage 2 shape drifts', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: {
            data: {
              favorites: [
                { id: 'a', object: { id: '100', type: 'Board' }, position: 1 },
              ],
            },
          },
        },
        {
          operation_name: 'BoardFavoritesStage2',
          response: { data: { boards: [{ id: '100' }] } },
        },
      ],
    };
    const result = await drive(['board', 'favorites', '--json'], cassette);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe('internal_error');
    expect(envelope.error.message).toMatch(/boards\(ids:\)/);
  });
});

describe('monday board favorites — envelope contract', () => {
  it('emits the standard §6.1 meta keys', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'BoardFavoritesStage1',
          response: { data: { favorites: [] } },
        },
      ],
    };
    const result = await drive(['board', 'favorites', '--json'], cassette);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      meta: {
        schema_version: string;
        api_version: string;
        request_id: string;
        source: string;
        cache_age_seconds: number | null;
        retrieved_at: string;
        complexity: unknown;
      };
    };
    expect(envelope.meta.schema_version).toBe('1');
    expect(envelope.meta.api_version).toBe('2026-01');
    expect(envelope.meta.request_id).toBeTruthy();
    expect(envelope.meta.source).toBe('live');
    expect(envelope.meta.cache_age_seconds).toBe(null);
    expect(envelope.meta.retrieved_at).toBeTruthy();
    expect(envelope.meta).toHaveProperty('complexity');
  });

  it('rejects unknown flags via commander argv parse', async () => {
    const cassette: Cassette = { interactions: [] };
    const result = await drive(
      ['board', 'favorites', '--unknown-flag', '--json'],
      cassette,
    );
    expect(result.exitCode).toBeGreaterThan(0);
  });
});
