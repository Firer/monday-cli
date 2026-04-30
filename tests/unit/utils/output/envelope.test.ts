import { describe, expect, it } from 'vitest';
import { ApiError, ConfigError } from '../../../../src/utils/errors.js';
import {
  buildDryRun,
  buildError,
  buildMeta,
  buildMutation,
  buildSuccess,
  CURRENT_SCHEMA_VERSION,
  type MetaInput,
} from '../../../../src/utils/output/envelope.js';

const baseMetaInput: MetaInput = {
  api_version: '2026-01',
  cli_version: '0.0.0',
  request_id: 'req-1',
  source: 'live',
  retrieved_at: '2026-04-29T10:00:00Z',
};

describe('buildMeta', () => {
  it('emits the canonical meta skeleton in stable key order', () => {
    const meta = buildMeta(baseMetaInput);
    expect(Object.keys(meta)).toEqual([
      'schema_version',
      'api_version',
      'cli_version',
      'request_id',
      'source',
      'cache_age_seconds',
      'retrieved_at',
      'complexity',
    ]);
    expect(meta.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('defaults cache_age_seconds to null when omitted', () => {
    expect(buildMeta(baseMetaInput).cache_age_seconds).toBeNull();
  });

  it('preserves a numeric cache_age_seconds', () => {
    expect(
      buildMeta({ ...baseMetaInput, cache_age_seconds: 42 }).cache_age_seconds,
    ).toBe(42);
  });

  it('always emits complexity (null without --verbose, object with)', () => {
    // §6.1 contract: "Always null without --verbose to avoid an
    // extra GraphQL field on every query." Field is always present.
    expect(buildMeta(baseMetaInput).complexity).toBeNull();
    const withComp = buildMeta({
      ...baseMetaInput,
      complexity: { used: 1, remaining: 2, reset_in_seconds: 3 },
    });
    expect(withComp.complexity).toEqual({
      used: 1,
      remaining: 2,
      reset_in_seconds: 3,
    });
  });

  it('inserts collection fields in the canonical position after complexity', () => {
    const meta = buildMeta({
      ...baseMetaInput,
      complexity: { used: 1, remaining: 2, reset_in_seconds: 3 },
      next_cursor: 'abc',
      has_more: true,
      total_returned: 500,
      columns: { status_4: { id: 'status_4', type: 'status', title: 'Status' } },
    });
    expect(Object.keys(meta)).toEqual([
      'schema_version',
      'api_version',
      'cli_version',
      'request_id',
      'source',
      'cache_age_seconds',
      'retrieved_at',
      'complexity',
      'next_cursor',
      'has_more',
      'total_returned',
      'columns',
    ]);
  });

  it('sets dry_run=true only when requested', () => {
    expect('dry_run' in buildMeta(baseMetaInput)).toBe(false);
    expect(buildMeta({ ...baseMetaInput, dry_run: true }).dry_run).toBe(true);
  });
});

describe('buildSuccess', () => {
  it('wraps data with the envelope skeleton', () => {
    const env = buildSuccess({ id: '1', name: 'A' }, buildMeta(baseMetaInput));
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ id: '1', name: 'A' });
    expect(env.warnings).toEqual([]);
  });

  it('emits keys in stable order: ok, data, meta, warnings', () => {
    const env = buildSuccess(null, buildMeta(baseMetaInput));
    expect(Object.keys(env)).toEqual(['ok', 'data', 'meta', 'warnings']);
  });

  it('includes provided warnings', () => {
    const env = buildSuccess(null, buildMeta(baseMetaInput), [
      { code: 'stale_cache', message: 'served from cache' },
    ]);
    expect(env.warnings).toEqual([
      { code: 'stale_cache', message: 'served from cache' },
    ]);
  });
});

describe('buildMutation', () => {
  it('omits side_effects + resolved_ids when there are none', () => {
    const env = buildMutation({
      data: { id: '1' },
      meta: buildMeta(baseMetaInput),
    });
    expect('side_effects' in env).toBe(false);
    expect('resolved_ids' in env).toBe(false);
  });

  it('includes side_effects when present', () => {
    const env = buildMutation({
      data: { id: '1' },
      meta: buildMeta(baseMetaInput),
      sideEffects: [{ kind: 'update_created', id: 'u_1' }],
    });
    expect(env.side_effects).toEqual([
      { kind: 'update_created', id: 'u_1' },
    ]);
  });

  it('includes resolved_ids when supplied (cli-design §5.3 step 2)', () => {
    const env = buildMutation({
      data: { id: '1' },
      meta: buildMeta(baseMetaInput),
      resolvedIds: { status: 'status_4' },
    });
    expect(env.resolved_ids).toEqual({ status: 'status_4' });
  });

  it('emits keys in stable order with side_effects + resolved_ids appended', () => {
    const env = buildMutation({
      data: { id: '1' },
      meta: buildMeta(baseMetaInput),
      sideEffects: [{ kind: 'x' }],
      resolvedIds: { status: 'status_4' },
    });
    expect(Object.keys(env)).toEqual([
      'ok',
      'data',
      'meta',
      'warnings',
      'side_effects',
      'resolved_ids',
    ]);
  });
});

describe('buildDryRun', () => {
  it('forces data to null and dry_run flag in meta', () => {
    const env = buildDryRun(
      [{ operation: 'change_simple_column_value', item_id: '1' }],
      buildMeta(baseMetaInput),
    );
    expect(env.data).toBeNull();
    expect(env.meta.dry_run).toBe(true);
  });

  it('does not double-add dry_run when meta already has it', () => {
    const meta = buildMeta({ ...baseMetaInput, dry_run: true });
    const env = buildDryRun([], meta);
    // Same reference (no rebuild) when the flag was already set.
    expect(env.meta).toBe(meta);
  });

  it('emits keys in stable order: ok, data, meta, planned_changes, warnings', () => {
    const env = buildDryRun([], buildMeta(baseMetaInput));
    expect(Object.keys(env)).toEqual([
      'ok',
      'data',
      'meta',
      'planned_changes',
      'warnings',
    ]);
  });

  it('preserves the planned_changes payload verbatim', () => {
    const planned = [
      { operation: 'change_simple_column_value', diff: { x: { from: 1, to: 2 } } },
    ];
    expect(buildDryRun(planned, buildMeta(baseMetaInput)).planned_changes).toBe(
      planned,
    );
  });

  it('preserves collection extras (next_cursor / has_more / total_returned / columns) when rebuilding meta with dry_run', () => {
    const meta = buildMeta({
      ...baseMetaInput,
      next_cursor: 'cur-abc',
      has_more: true,
      total_returned: 42,
      columns: { status_4: { id: 'status_4', type: 'status', title: 'Status' } },
    });
    const env = buildDryRun([], meta);
    expect(env.meta.next_cursor).toBe('cur-abc');
    expect(env.meta.has_more).toBe(true);
    expect(env.meta.total_returned).toBe(42);
    expect(env.meta.columns).toEqual({
      status_4: { id: 'status_4', type: 'status', title: 'Status' },
    });
    expect(env.meta.dry_run).toBe(true);
  });
});

describe('buildError', () => {
  it('builds the §6.5 error body in stable key order', () => {
    const err = new ApiError('rate_limited', 'slow down', {
      httpStatus: 429,
      mondayCode: 'RateLimit',
      retryAfterSeconds: 30,
      details: { limit: 'per_minute' },
    });
    const env = buildError(err, buildMeta(baseMetaInput));
    expect(Object.keys(env)).toEqual(['ok', 'error', 'meta']);
    expect(Object.keys(env.error)).toEqual([
      'code',
      'message',
      'http_status',
      'monday_code',
      'request_id',
      'retryable',
      'retry_after_seconds',
      'details',
    ]);
    expect(env.error.code).toBe('rate_limited');
    expect(env.error.message).toBe('slow down');
    expect(env.error.http_status).toBe(429);
    expect(env.error.monday_code).toBe('RateLimit');
    expect(env.error.retry_after_seconds).toBe(30);
    expect(env.error.retryable).toBe(true);
    expect(env.error.details).toEqual({ limit: 'per_minute' });
  });

  it('falls back to meta.request_id when the error has no request_id', () => {
    const err = new ConfigError('missing token');
    const env = buildError(err, buildMeta(baseMetaInput));
    expect(env.error.request_id).toBe('req-1');
  });

  it('uses the error.requestId when present', () => {
    const err = new ApiError('not_found', 'gone', { requestId: 'req-other' });
    const env = buildError(err, buildMeta(baseMetaInput));
    expect(env.error.request_id).toBe('req-other');
  });

  it('coerces undefined optional fields to null in the wire shape', () => {
    const env = buildError(new ConfigError('x'), buildMeta(baseMetaInput));
    expect(env.error.http_status).toBeNull();
    expect(env.error.monday_code).toBeNull();
    expect(env.error.retry_after_seconds).toBeNull();
    expect(env.error.details).toBeNull();
  });
});
