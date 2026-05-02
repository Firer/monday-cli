/**
 * `meta.source` + `meta.cache_age_seconds` merge rules per cli-design
 * §6.1 — first leg seeds; `mixed` is contagious; `cache + live → mixed`;
 * for cache age the aggregate is the OLDEST cache age across legs (the
 * worst-case staleness).
 *
 * Lifted from four sites — see v0.2-plan §12 R21:
 *   - `api/dry-run.ts` (`mergeSource` + `mergeCacheAge`, private)
 *   - `commands/item/update.ts` (`mergeSourceForRemap`)
 *   - `commands/item/create.ts` (`mergeSourceLeg` +
 *     `mergeSourceWithPreflight` + `mergeCacheAgeWithPreflight`)
 *   - inline `Math.max` cache-age folds
 *
 * The local copies all left a "If a third consumer arrives, lift to
 * a shared module then" comment; create.ts was the third+fourth, so
 * the lift fired post-M9.
 */

export type EnvelopeSource = 'live' | 'cache' | 'mixed';
/**
 * Planner/mutation surfaces that may claim `'none'` (no API call
 * fired). The dry-run engine + create.ts surface this; once any
 * leg fires it collapses to a real source via
 * `mergeSourceWithPreflight`.
 */
export type EnvelopeSourceOrNone = EnvelopeSource | 'none';

/**
 * Merges a new leg's source into the running aggregate. First leg
 * seeds (`undefined → next`); any `mixed` is contagious; otherwise
 * `cache + live → mixed`; otherwise the unanimous value.
 */
export const mergeSource = (
  current: EnvelopeSource | undefined,
  next: EnvelopeSource,
): EnvelopeSource => {
  if (current === undefined) return next;
  if (current === 'mixed' || next === 'mixed') return 'mixed';
  if (current === next) return current;
  return 'mixed';
};

/**
 * Folds a pre-planner preflight source ('live' / 'cache' / 'mixed' /
 * `undefined` when no preflight leg fired) into a planner source
 * ('live' / 'cache' / 'mixed' / 'none'). Used by create.ts's dry-run
 * + live envelopes so `meta.source` reflects every wire leg that
 * fired (Codex M9 P2 #1). When the planner is `'none'` and any
 * preflight leg fired, the preflight source wins; otherwise the
 * `mergeSource` rule applies.
 */
export const mergeSourceWithPreflight = (
  planner: EnvelopeSourceOrNone,
  preflight: EnvelopeSource | undefined,
): EnvelopeSourceOrNone => {
  if (preflight === undefined) return planner;
  if (planner === 'none') return preflight;
  return mergeSource(planner, preflight);
};

/**
 * Merges a new leg's `cacheAgeSeconds` into the running aggregate.
 * Per cli-design §6.1, the envelope's `cache_age_seconds` is the
 * **oldest** age across legs that hit cache — worst-case staleness.
 * `null` legs (live fetches) don't update; if all legs are live the
 * aggregate stays `null`.
 */
export const mergeCacheAge = (
  current: number | null,
  next: number | null,
): number | null => {
  if (next === null) return current;
  if (current === null) return next;
  return Math.max(current, next);
};

/**
 * Stateful accumulator wrapping `mergeSource` + `mergeCacheAge` for
 * the multi-leg orchestrators in `commands/item/*` that fold per-leg
 * `meta.source` / `cacheAgeSeconds` contributions into one aggregate
 * before emitting the envelope. Lifted post-M11 (§16 R30) — five
 * sites duplicated the same `let aggregate; record(source, cacheAge)`
 * closure pattern (move's `runCrossBoardMove`, create's live path,
 * update single, update bulk dry-run + live).
 *
 * The standalone `mergeSource` / `mergeCacheAge` exports stay — the
 * `mergeSourceWithPreflight` shape in `create.ts` dry-run doesn't
 * collapse cleanly into the class (it folds a `'none'`-claiming
 * planner source against a preflight `EnvelopeSource | undefined`,
 * not the class's per-leg `EnvelopeSource` shape).
 */
export class SourceAggregator {
  private source: EnvelopeSource | undefined;
  private cacheAge: number | null;

  /**
   * Optional seed for callers that already have a first leg's source
   * + cacheAge in hand (e.g. update bulk's metadata leg). Equivalent
   * to `new SourceAggregator()` followed by `.record(seed.source,
   * seed.cacheAgeSeconds)`, but keeps the call site one line.
   */
  constructor(
    seed?: {
      readonly source: EnvelopeSource;
      readonly cacheAgeSeconds: number | null;
    },
  ) {
    this.source = seed?.source;
    this.cacheAge = seed?.cacheAgeSeconds ?? null;
  }

  /**
   * Folds a leg's `source` + `cacheAgeSeconds` into the running
   * aggregate. First call seeds; subsequent calls apply the
   * `mergeSource` / `mergeCacheAge` rules.
   */
  record(source: EnvelopeSource, cacheAgeSeconds: number | null): void {
    this.source = mergeSource(this.source, source);
    this.cacheAge = mergeCacheAge(this.cacheAge, cacheAgeSeconds);
  }

  /**
   * Snapshot of the current aggregate. `fallback` (default `'live'`)
   * is returned when no leg has been recorded — matches the
   * `aggregate ?? 'live'` pattern every call site used pre-lift.
   */
  result(fallback: EnvelopeSource = 'live'): {
    readonly source: EnvelopeSource;
    readonly cacheAgeSeconds: number | null;
  } {
    return {
      source: this.source ?? fallback,
      cacheAgeSeconds: this.cacheAge,
    };
  }
}
