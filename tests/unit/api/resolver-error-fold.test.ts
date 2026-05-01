/**
 * Unit tests for `src/api/resolver-error-fold.ts` (R19 lift).
 *
 * Covers both helpers with happy-path + every branch:
 *   - `foldResolverWarningsIntoError` — empty warnings no-op, ApiError
 *     fold, UsageError fold, MondayCliError-base fold (config_error /
 *     cache_error), `details` merging, error-options preservation.
 *   - `maybeRemapValidationFailedToArchived` — non-`validation_failed`
 *     no-op, live-source no-op, refresh-failure no-op, refresh-still-
 *     active no-op, archived-confirmed remap path, resolver_warnings
 *     preservation across remap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  foldResolverWarningsIntoError,
  maybeRemapValidationFailedToArchived,
} from '../../../src/api/resolver-error-fold.js';
import type { ResolverWarning } from '../../../src/api/columns.js';
import {
  ApiError,
  CacheError,
  ConfigError,
  MondayCliError,
  UsageError,
} from '../../../src/utils/errors.js';
import type { MondayClient, MondayResponse } from '../../../src/api/client.js';

let tmpRoot: string;
const xdgEnv = (): NodeJS.ProcessEnv => ({ XDG_CACHE_HOME: tmpRoot });

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-fold-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

interface Stats {
  calls: number;
  operations: string[];
}

const buildClient = (
  responses: readonly unknown[],
  stats: Stats,
): MondayClient => {
  let cursor = 0;
  const fake = {
    raw: <T>(
      _query: string,
      _vars: unknown,
      opts?: { operationName?: string },
    ): Promise<MondayResponse<T>> => {
      stats.calls++;
      stats.operations.push(opts?.operationName ?? '<unknown>');
      const next = responses[cursor];
      cursor = Math.min(cursor + 1, responses.length - 1);
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve({
        data: next as T,
        complexity: null,
        stats: { attempts: 1, totalSleepMs: 0 },
      });
    },
  };
  return fake as unknown as MondayClient;
};

const collisionWarning: ResolverWarning = {
  code: 'column_token_collision',
  message: 'Token matched both an ID and a title.',
  details: { resolved_id: 'status_4' },
};

const refreshedWarning: ResolverWarning = {
  code: 'stale_cache_refreshed',
  message: 'Cache miss for token; refreshed board metadata.',
  details: { token: 'NewCol' },
};

describe('foldResolverWarningsIntoError', () => {
  it('returns the original error unchanged when warnings is empty', () => {
    const original = new ApiError('column_not_found', 'msg', {
      details: { token: 'X' },
    });
    const folded = foldResolverWarningsIntoError(original, []);
    expect(folded).toBe(original);
  });

  it('folds resolver warnings into an ApiError as a NEW ApiError of the same code', () => {
    const original = new ApiError('column_archived', 'archived', {
      details: { board_id: '111' },
    });
    const folded = foldResolverWarningsIntoError(original, [collisionWarning]);
    expect(folded).toBeInstanceOf(ApiError);
    expect(folded).not.toBe(original);
    expect(folded.code).toBe('column_archived');
    expect(folded.message).toBe('archived');
    expect(folded.details?.board_id).toBe('111');
    expect(folded.details?.resolver_warnings).toEqual([
      {
        code: 'column_token_collision',
        message: 'Token matched both an ID and a title.',
        details: { resolved_id: 'status_4' },
      },
    ]);
  });

  it('folds into a UsageError as a NEW UsageError', () => {
    const original = new UsageError('bad input', {
      details: { raw_input: 'tags=' },
    });
    const folded = foldResolverWarningsIntoError(original, [refreshedWarning]);
    expect(folded).toBeInstanceOf(UsageError);
    expect(folded.code).toBe('usage_error');
    expect(folded.details?.raw_input).toBe('tags=');
    expect(folded.details?.resolver_warnings).toEqual([
      {
        code: 'stale_cache_refreshed',
        message: 'Cache miss for token; refreshed board metadata.',
        details: { token: 'NewCol' },
      },
    ]);
  });

  it('folds two warnings into one resolver_warnings array preserving order', () => {
    const original = new ApiError('user_not_found', 'unknown email');
    const folded = foldResolverWarningsIntoError(original, [
      refreshedWarning,
      collisionWarning,
    ]);
    expect(folded.details?.resolver_warnings).toEqual([
      {
        code: 'stale_cache_refreshed',
        message: 'Cache miss for token; refreshed board metadata.',
        details: { token: 'NewCol' },
      },
      {
        code: 'column_token_collision',
        message: 'Token matched both an ID and a title.',
        details: { resolved_id: 'status_4' },
      },
    ]);
  });

  it('preserves cause / httpStatus / mondayCode / requestId / retryAfterSeconds across the fold', () => {
    const cause = new Error('upstream');
    const original = new ApiError('rate_limited', 'too fast', {
      cause,
      httpStatus: 429,
      mondayCode: 'RATE_LIMIT_EXCEEDED',
      requestId: 'req-123',
      retryAfterSeconds: 30,
    });
    const folded = foldResolverWarningsIntoError(original, [collisionWarning]);
    expect(folded.cause).toBe(cause);
    expect(folded.httpStatus).toBe(429);
    expect(folded.mondayCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(folded.requestId).toBe('req-123');
    expect(folded.retryAfterSeconds).toBe(30);
  });

  it('preserves the retryable flag when fed back through the constructor', () => {
    // A `rate_limited` ApiError defaults to retryable: true; a fold
    // mustn't flip the flag back to the per-code default.
    const original = new ApiError('rate_limited', 'msg', {
      retryable: false,
    });
    const folded = foldResolverWarningsIntoError(original, [collisionWarning]);
    expect(folded.retryable).toBe(false);
  });

  it('falls back to the MondayCliError base class for config_error', () => {
    const original = new ConfigError('bad config');
    const folded = foldResolverWarningsIntoError(original, [collisionWarning]);
    // The base class is reconstructed (not a ConfigError) because
    // R19's helper isn't tied to the typed-error subclass for codes
    // outside the ApiError / UsageError pair. Verify the code is
    // preserved via the base-class instance.
    expect(folded).toBeInstanceOf(MondayCliError);
    expect(folded.code).toBe('config_error');
  });

  it('falls back to the MondayCliError base class for cache_error', () => {
    const original = new CacheError('cache write failed');
    const folded = foldResolverWarningsIntoError(original, [collisionWarning]);
    expect(folded).toBeInstanceOf(MondayCliError);
    expect(folded.code).toBe('cache_error');
  });

  it('preserves an empty existing details object (returns one with only resolver_warnings)', () => {
    const original = new ApiError('column_not_found', 'msg');
    expect(original.details).toBeUndefined();
    const folded = foldResolverWarningsIntoError(original, [collisionWarning]);
    expect(folded.details).toEqual({
      resolver_warnings: [
        {
          code: 'column_token_collision',
          message: 'Token matched both an ID and a title.',
          details: { resolved_id: 'status_4' },
        },
      ],
    });
  });
});

const archivedBoardResponse = (): { boards: unknown[] } => ({
  boards: [
    {
      id: '111',
      name: 'Sprint',
      description: null,
      state: 'active',
      board_kind: 'public',
      board_folder_id: null,
      workspace_id: null,
      url: null,
      hierarchy_type: null,
      is_leaf: true,
      updated_at: null,
      groups: [],
      columns: [
        {
          id: 'status_4',
          title: 'Status',
          type: 'status',
          description: null,
          archived: true,
          settings_str: '{}',
          width: null,
        },
      ],
    },
  ],
});

const activeBoardResponse = (): { boards: unknown[] } => ({
  boards: [
    {
      id: '111',
      name: 'Sprint',
      description: null,
      state: 'active',
      board_kind: 'public',
      board_folder_id: null,
      workspace_id: null,
      url: null,
      hierarchy_type: null,
      is_leaf: true,
      updated_at: null,
      groups: [],
      columns: [
        {
          id: 'status_4',
          title: 'Status',
          type: 'status',
          description: null,
          archived: false,
          settings_str: '{}',
          width: null,
        },
      ],
    },
  ],
});

describe('maybeRemapValidationFailedToArchived', () => {
  it('returns the original error unchanged when code is not validation_failed', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([], stats);
    const original = new ApiError('column_not_found', 'msg');
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      columnIds: ['status_4'],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'cache',
    });
    expect(out).toBe(original);
    expect(stats.calls).toBe(0);
  });

  it('returns the original error unchanged when resolutionSource is "live"', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([], stats);
    const original = new ApiError('validation_failed', 'invalid');
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      columnIds: ['status_4'],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'live',
    });
    expect(out).toBe(original);
    expect(stats.calls).toBe(0);
  });

  it('returns the original error unchanged when refresh fetch throws', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([new Error('network down')], stats);
    const original = new ApiError('validation_failed', 'invalid');
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      columnIds: ['status_4'],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'cache',
    });
    expect(out).toBe(original);
    expect(stats.calls).toBe(1);
  });

  it('returns the original error unchanged when post-refresh column is still active', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([activeBoardResponse()], stats);
    const original = new ApiError('validation_failed', 'invalid');
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      columnIds: ['status_4'],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'cache',
    });
    expect(out).toBe(original);
    expect(stats.calls).toBe(1);
  });

  it('returns the original error unchanged when post-refresh column is missing', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([
      {
        boards: [
          {
            id: '111',
            name: 'Sprint',
            description: null,
            state: 'active',
            board_kind: 'public',
            board_folder_id: null,
            workspace_id: null,
            url: null,
            hierarchy_type: null,
            is_leaf: true,
            updated_at: null,
            groups: [],
            columns: [],
          },
        ],
      },
    ], stats);
    const original = new ApiError('validation_failed', 'invalid');
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      columnIds: ['status_4'],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'cache',
    });
    expect(out).toBe(original);
  });

  it('remaps to column_archived when post-refresh column is archived', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([archivedBoardResponse()], stats);
    const original = new ApiError('validation_failed', 'invalid');
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      columnIds: ['status_4'],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'cache',
    });
    expect(out).not.toBe(original);
    expect(out).toBeInstanceOf(ApiError);
    expect(out.code).toBe('column_archived');
    expect(out.details?.column_id).toBe('status_4');
    expect(out.details?.column_title).toBe('Status');
    expect(out.details?.column_type).toBe('status');
    expect(out.details?.board_id).toBe('111');
    expect(out.details?.remapped_from).toBe('validation_failed');
    expect(out.cause).toBe(original);
  });

  it('preserves resolver_warnings details across the remap', async () => {
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([archivedBoardResponse()], stats);
    // Original error has resolver_warnings folded in already (the
    // typical chain: foldResolverWarningsIntoError + then the remap).
    const original = new ApiError('validation_failed', 'invalid', {
      details: {
        resolver_warnings: [
          {
            code: 'stale_cache_refreshed',
            message: 'Cache miss for token; refreshed board metadata.',
            details: { token: 'Status' },
          },
        ],
      },
    });
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      columnIds: ['status_4'],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'mixed',
    });
    expect(out.code).toBe('column_archived');
    expect(out.details?.resolver_warnings).toEqual([
      {
        code: 'stale_cache_refreshed',
        message: 'Cache miss for token; refreshed board metadata.',
        details: { token: 'Status' },
      },
    ]);
  });

  it('returns the original error unchanged when columnIds is empty', async () => {
    // Codex M5b finding #3: the array-form helper must no-op on
    // empty input (preserves the previous "no remap target → bail"
    // semantics single-column callers relied on).
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([archivedBoardResponse()], stats);
    const original = new ApiError('validation_failed', 'invalid');
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      columnIds: [],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'cache',
    });
    expect(out).toBe(original);
    expect(stats.calls).toBe(0);
  });

  it('multi-column: first active + second archived → remaps to second column', async () => {
    // Codex M5b finding #3: pre-fix, the helper only probed the
    // first column. A multi-column update where the first target
    // stayed active and a LATER target was archived after a stale
    // cache read still surfaced `validation_failed`. The fix walks
    // every column in input order and remaps to the first archived
    // match.
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([
      {
        boards: [
          {
            id: '111',
            name: 'Sprint',
            description: null,
            state: 'active',
            board_kind: 'public',
            board_folder_id: null,
            workspace_id: null,
            url: null,
            hierarchy_type: null,
            is_leaf: true,
            updated_at: null,
            groups: [],
            columns: [
              {
                id: 'status_4',
                title: 'Status',
                type: 'status',
                description: null,
                archived: false,
                settings_str: '{}',
                width: null,
              },
              {
                id: 'date4',
                title: 'Due date',
                type: 'date',
                description: null,
                archived: true,
                settings_str: null,
                width: null,
              },
            ],
          },
        ],
      },
    ], stats);
    const original = new ApiError('validation_failed', 'invalid');
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      // Input order: status_4 first (active), date4 second (archived).
      columnIds: ['status_4', 'date4'],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'cache',
    });
    expect(out).not.toBe(original);
    expect(out.code).toBe('column_archived');
    // The remap surfaces the LATER archived column, not the first
    // one — pre-fix this would have returned the original error
    // unchanged because the helper only checked status_4.
    expect(out.details?.column_id).toBe('date4');
    expect(out.details?.column_title).toBe('Due date');
    expect(out.details?.column_type).toBe('date');
    expect(out.details?.remapped_from).toBe('validation_failed');
  });

  it('multi-column: first archived + second active → remaps to first column (deterministic)', async () => {
    // Mirror of the above: when the FIRST column is archived, the
    // helper picks it (input order wins). Pinned so a future
    // refactor can't silently pick a different column.
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([
      {
        boards: [
          {
            id: '111',
            name: 'Sprint',
            description: null,
            state: 'active',
            board_kind: 'public',
            board_folder_id: null,
            workspace_id: null,
            url: null,
            hierarchy_type: null,
            is_leaf: true,
            updated_at: null,
            groups: [],
            columns: [
              {
                id: 'status_4',
                title: 'Status',
                type: 'status',
                description: null,
                archived: true,
                settings_str: '{}',
                width: null,
              },
              {
                id: 'date4',
                title: 'Due date',
                type: 'date',
                description: null,
                archived: false,
                settings_str: null,
                width: null,
              },
            ],
          },
        ],
      },
    ], stats);
    const original = new ApiError('validation_failed', 'invalid');
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      columnIds: ['status_4', 'date4'],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'cache',
    });
    expect(out.code).toBe('column_archived');
    expect(out.details?.column_id).toBe('status_4');
  });

  it('multi-column: all active → no remap', async () => {
    // Sanity: when no column is archived post-refresh, the original
    // validation_failed bubbles through unchanged.
    const stats: Stats = { calls: 0, operations: [] };
    const client = buildClient([
      {
        boards: [
          {
            id: '111',
            name: 'Sprint',
            description: null,
            state: 'active',
            board_kind: 'public',
            board_folder_id: null,
            workspace_id: null,
            url: null,
            hierarchy_type: null,
            is_leaf: true,
            updated_at: null,
            groups: [],
            columns: [
              {
                id: 'status_4',
                title: 'Status',
                type: 'status',
                description: null,
                archived: false,
                settings_str: '{}',
                width: null,
              },
              {
                id: 'date4',
                title: 'Due date',
                type: 'date',
                description: null,
                archived: false,
                settings_str: null,
                width: null,
              },
            ],
          },
        ],
      },
    ], stats);
    const original = new ApiError('validation_failed', 'invalid');
    const out = await maybeRemapValidationFailedToArchived(original, {
      client,
      boardId: '111',
      columnIds: ['status_4', 'date4'],
      env: xdgEnv(),
      noCache: true,
      resolutionSource: 'cache',
    });
    expect(out).toBe(original);
  });
});
