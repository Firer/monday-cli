/**
 * Surface tests for `src/api/usage.ts` — the M22 pre-flight contract
 * diff (cli-design §11.5.3 / §13 v0.3 entry).
 *
 * Scope: the pure helpers + schemas pinned at pre-flight. The
 * `fetchUsage` runtime body is a stub (rejects with `internal_error`)
 * and is exercised at M22 implementation alongside the wire layer.
 */
import { describe, it, expect } from 'vitest';
import {
  USAGE_QUERY,
  sumUsageForDay,
  projectUsageOutput,
  rawDailyLimitSchema,
  rawDailyAnalyticsByDaySchema,
  rawDailyAnalyticsSchema,
  usageQueryResponseSchema,
  fetchUsage,
  type RawDailyAnalyticsByDay,
  type UsageQueryResponse,
} from '../../../src/api/usage.js';
import { ApiError } from '../../../src/utils/errors.js';
import type { Transport } from '../../../src/api/transport.js';

describe('USAGE_QUERY', () => {
  it('requests only daily_limit + by_day (no by_app/by_user)', () => {
    // Pre-flight contract: the query stays cheap by only requesting
    // the v0.3-surfaced fields. by_app + by_user are v0.4 surface.
    expect(USAGE_QUERY).toContain('platform_api');
    expect(USAGE_QUERY).toContain('daily_limit { base total }');
    expect(USAGE_QUERY).toContain('by_day { day usage }');
    expect(USAGE_QUERY).not.toContain('by_app');
    expect(USAGE_QUERY).not.toContain('by_user');
  });

  it('queries account.complexity is NOT used (probe found field missing)', () => {
    // Load-bearing empirical-probe finding (2026-05-10): `account
    // { complexity }` doesn't exist. The query must use platform_api
    // instead.
    expect(USAGE_QUERY).not.toContain('account {');
    expect(USAGE_QUERY).not.toContain('complexity {');
  });
});

describe('sumUsageForDay', () => {
  it('returns 0 on empty list (free-tier no-activity case)', () => {
    expect(sumUsageForDay([], '2026-05-10')).toBe(0);
  });

  it('returns sum of entries matching today', () => {
    const byDay: RawDailyAnalyticsByDay[] = [
      { day: '2026-05-08', usage: 5 },
      { day: '2026-05-09', usage: 12 },
      { day: '2026-05-10', usage: 17 },
    ];
    expect(sumUsageForDay(byDay, '2026-05-10')).toBe(17);
  });

  it('sums multiple same-day entries (defensive: monday may split per-app)', () => {
    const byDay: RawDailyAnalyticsByDay[] = [
      { day: '2026-05-10', usage: 7 },
      { day: '2026-05-10', usage: 3 },
      { day: '2026-05-10', usage: 12 },
    ];
    expect(sumUsageForDay(byDay, '2026-05-10')).toBe(22);
  });

  it('returns 0 when no entry matches today', () => {
    const byDay: RawDailyAnalyticsByDay[] = [
      { day: '2026-05-08', usage: 5 },
      { day: '2026-05-09', usage: 12 },
    ];
    expect(sumUsageForDay(byDay, '2026-05-10')).toBe(0);
  });
});

describe('projectUsageOutput', () => {
  const today = '2026-05-10';

  it('projects probe-empirical shape onto v0.3 envelope', () => {
    // Mirrors the empirical-probe response shape verbatim (2026-05-10):
    // free-tier account → `daily_limit: { base: 200, total: 200 }`,
    // empty `by_day` list → `usage_today: 0`, `usage_remaining_today: 200`.
    const parsed: UsageQueryResponse = {
      platform_api: {
        daily_limit: { base: 200, total: 200 },
        daily_analytics: {
          last_updated: '2026-05-10T22:01:26.377Z',
          by_day: [],
        },
      },
    };
    expect(projectUsageOutput(parsed, today)).toEqual({
      daily_limit: { base: 200, total: 200 },
      usage_today: 0,
      usage_remaining_today: 200,
      last_updated: '2026-05-10T22:01:26.377Z',
    });
  });

  it('clamps usage_remaining_today at zero when usage exceeds total', () => {
    // Monday's reported `usage` is best-effort and may briefly exceed
    // `total` on a near-cap account; surfacing a negative remaining
    // would mislead agents — clamp instead per §11.5.3.
    const parsed: UsageQueryResponse = {
      platform_api: {
        daily_limit: { base: 200, total: 200 },
        daily_analytics: {
          last_updated: '2026-05-10T22:01:26.377Z',
          by_day: [{ day: today, usage: 250 }],
        },
      },
    };
    expect(projectUsageOutput(parsed, today).usage_remaining_today).toBe(0);
    expect(projectUsageOutput(parsed, today).usage_today).toBe(250);
  });

  it('surfaces base AND total verbatim (paid-tier overage offset case)', () => {
    // For a paid tier with overage, `total > base` is possible per the
    // §11.5.3 field semantics. Both fields surface verbatim.
    const parsed: UsageQueryResponse = {
      platform_api: {
        daily_limit: { base: 1000, total: 1500 },
        daily_analytics: {
          last_updated: '2026-05-10T22:01:26.377Z',
          by_day: [{ day: today, usage: 100 }],
        },
      },
    };
    const out = projectUsageOutput(parsed, today);
    expect(out.daily_limit).toEqual({ base: 1000, total: 1500 });
    expect(out.usage_remaining_today).toBe(1400);
  });
});

describe('schemas', () => {
  it('rawDailyLimitSchema accepts the probe-empirical shape', () => {
    expect(() =>
      rawDailyLimitSchema.parse({ base: 200, total: 200 }),
    ).not.toThrow();
  });

  it('rawDailyLimitSchema rejects negative values', () => {
    expect(() => rawDailyLimitSchema.parse({ base: -1, total: 200 })).toThrow();
  });

  it('rawDailyLimitSchema accepts loose extension fields (forward-compat)', () => {
    // `.loose()` mode — Monday adding an extension field must not
    // break the parse.
    expect(() =>
      rawDailyLimitSchema.parse({
        base: 200,
        total: 200,
        future_field: 'forward-compat',
      }),
    ).not.toThrow();
  });

  it('rawDailyAnalyticsByDaySchema enforces non-empty day + non-negative usage', () => {
    expect(() => rawDailyAnalyticsByDaySchema.parse({ day: '', usage: 5 })).toThrow();
    expect(() =>
      rawDailyAnalyticsByDaySchema.parse({ day: '2026-05-10', usage: -1 }),
    ).toThrow();
  });

  it('rawDailyAnalyticsSchema requires last_updated + by_day', () => {
    expect(() =>
      rawDailyAnalyticsSchema.parse({
        last_updated: '2026-05-10T22:01:26.377Z',
        by_day: [],
      }),
    ).not.toThrow();
    expect(() => rawDailyAnalyticsSchema.parse({ last_updated: '', by_day: [] })).toThrow();
  });

  it('usageQueryResponseSchema validates the probe-empirical wire shape', () => {
    const parsed = usageQueryResponseSchema.parse({
      platform_api: {
        daily_limit: { base: 200, total: 200 },
        daily_analytics: {
          last_updated: '2026-05-10T22:01:26.377Z',
          by_day: [{ day: '2026-05-10', usage: 17 }],
        },
      },
    });
    expect(parsed.platform_api.daily_limit.total).toBe(200);
  });
});

describe('fetchUsage (pre-flight stub)', () => {
  it('rejects with ApiError("internal_error") carrying the stub hint', async () => {
    // Pre-flight stub — every invocation rejects. M22 implementation
    // replaces this with the real fetch+project body. The reject is
    // covered indirectly via the integration test for `monday usage`,
    // but we assert the shape directly here for the surface contract.
    const fakeTransport = {} as unknown as Transport;
    await expect(
      fetchUsage({ transport: fakeTransport, today: '2026-05-10' }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      fetchUsage({ transport: fakeTransport, today: '2026-05-10' }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
