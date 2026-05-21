import { describe, expect, it } from 'vitest';
import {
  projectCauseForEnvelope,
  reThrowDecorated,
} from '../../../src/api/error-decoration.js';
import {
  ApiError,
  MondayCliError,
  UsageError,
} from '../../../src/utils/errors.js';

/**
 * Direct unit coverage for the mutation-path catch-arm decoration
 * helpers (R-v0.7-NEW-5 `reThrowDecorated` + R-v0.8-NEW-6
 * `projectCauseForEnvelope`). Before this lift the typed split + the
 * conditional wire-metadata spreads lived inline across 4 bulk/
 * fail-fast paths (clear / JSON-bulk / M42 file-bulk / M46
 * file-bulk-multi); the per-Monday-error metadata permutations
 * (`httpStatus` / `mondayCode` / `requestId` / `retryAfterSeconds`
 * set-or-unset) were never all exercised by a single call site and
 * dragged `item/update.ts` to ~80% branch coverage. Driving the helper
 * directly hits every spread arm present-AND-absent once; the command
 * tests still assert the integration wiring at each delegating site.
 *
 * Inputs are real `MondayCliError` instances (a typed error class, not
 * a hand-shaped wire payload) per testing.md's "no hand-shaped inputs"
 * rule.
 */

// `reThrowDecorated` always throws; capture the thrown value. `fn` is
// typed `() => void` (not `never`) so the trailing guard stays
// reachable for no-unreachable / control-flow analysis.
const captureThrown = (fn: () => void): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected reThrowDecorated to throw but it returned');
};

describe('reThrowDecorated', () => {
  describe('usage_error arm → UsageError', () => {
    it('rebuilds a usage_error as UsageError preserving cause + details', () => {
      const cause = new Error('translator mismatch');
      const remapped = new MondayCliError('usage_error', 'bad --set', {
        cause,
      });
      const details = { applied_count: 2, failed_at_item: '42' };
      const thrown = captureThrown(() => {
        reThrowDecorated(remapped, details);
      });
      expect(thrown).toBeInstanceOf(UsageError);
      const err = thrown as UsageError;
      expect(err.code).toBe('usage_error');
      expect(err.message).toBe('bad --set');
      expect(err.cause).toBe(cause);
      expect(err.details).toEqual(details);
    });

    it('omits cause on the UsageError arm when the source error has none', () => {
      const remapped = new MondayCliError('usage_error', 'bad --set');
      const thrown = captureThrown(() => {
        reThrowDecorated(remapped, { applied_count: 0 });
      });
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).cause).toBeUndefined();
    });
  });

  describe('non-usage_error arm → ApiError', () => {
    it('preserves the remapped code + all five wire-metadata fields when present', () => {
      const cause = new Error('wire failure');
      const remapped = new MondayCliError('rate_limited', 'slow down', {
        cause,
        httpStatus: 429,
        mondayCode: 'RATE_LIMITED',
        requestId: 'req-7',
        retryable: true,
        retryAfterSeconds: 30,
      });
      const details = { applied_count: 3, matched_count: 5 };
      const thrown = captureThrown(() => {
        reThrowDecorated(remapped, details);
      });
      expect(thrown).toBeInstanceOf(ApiError);
      const err = thrown as ApiError;
      expect(err.code).toBe('rate_limited');
      expect(err.message).toBe('slow down');
      expect(err.cause).toBe(cause);
      expect(err.httpStatus).toBe(429);
      expect(err.mondayCode).toBe('RATE_LIMITED');
      expect(err.requestId).toBe('req-7');
      expect(err.retryable).toBe(true);
      expect(err.retryAfterSeconds).toBe(30);
      expect(err.details).toEqual(details);
    });

    it('omits every optional wire-metadata field when the source error carries none', () => {
      // `column_archived` defaults `retryable: false`. This drives the
      // absent arm of all five conditional spreads — including the
      // ApiError arm's OWN `cause` spread, which is distinct from the
      // UsageError arm's (Codex pre-flight R1 P3-1: testing `cause`
      // only on the UsageError side leaves this branch uncovered).
      const remapped = new MondayCliError('column_archived', 'archived');
      const thrown = captureThrown(() => {
        reThrowDecorated(remapped, { applied_count: 1 });
      });
      expect(thrown).toBeInstanceOf(ApiError);
      const err = thrown as ApiError;
      expect(err.code).toBe('column_archived');
      expect(err.cause).toBeUndefined();
      expect(err.httpStatus).toBeUndefined();
      expect(err.mondayCode).toBeUndefined();
      expect(err.requestId).toBeUndefined();
      expect(err.retryAfterSeconds).toBeUndefined();
    });

    it('passes retryable through verbatim rather than re-deriving the code default', () => {
      // `column_archived`'s table default is false; an explicit `true`
      // on the source must survive the rebuild — proves the helper
      // forwards `remapped.retryable`, not a fresh per-code lookup.
      const remapped = new MondayCliError('column_archived', 'archived', {
        retryable: true,
      });
      const thrown = captureThrown(() => {
        reThrowDecorated(remapped, {});
      });
      expect((thrown as ApiError).retryable).toBe(true);
    });

    it('attaches the caller-assembled details verbatim on the ApiError arm', () => {
      const remapped = new MondayCliError('validation_failed', 'nope');
      const details = {
        applied_count: 4,
        applied_to: ['1', '2', '3', '4'],
        failed_at_item: '5',
        matched_count: 6,
      };
      const thrown = captureThrown(() => {
        reThrowDecorated(remapped, details);
      });
      expect((thrown as ApiError).details).toEqual(details);
    });
  });
});

describe('projectCauseForEnvelope', () => {
  it('copies code + message and carries details when the source error has them', () => {
    const err = new MondayCliError('column_archived', 'column is archived', {
      details: { reason: 'archived', column_id: 'status' },
    });
    expect(projectCauseForEnvelope(err)).toEqual({
      code: 'column_archived',
      message: 'column is archived',
      details: { reason: 'archived', column_id: 'status' },
    });
  });

  it('omits the details key entirely when the source error has none', () => {
    const err = new MondayCliError('network_error', 'connection refused');
    const projection = projectCauseForEnvelope(err);
    expect(projection).toEqual({
      code: 'network_error',
      message: 'connection refused',
    });
    expect(projection).not.toHaveProperty('details');
  });
});
