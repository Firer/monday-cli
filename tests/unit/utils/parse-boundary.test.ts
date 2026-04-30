/**
 * Unit tests for `src/utils/parse-boundary.ts` (R18 wrap helper).
 *
 * Pin the helper's contract — every failing parse becomes
 * `ApiError(internal_error)` carrying `details.issues` with path +
 * message + zod code per failing field. Plus the `cause` is
 * preserved so stack-trace debuggers see the original ZodError.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../../../src/utils/errors.js';
import { unwrapOrThrow } from '../../../src/utils/parse-boundary.js';

describe('unwrapOrThrow', () => {
  const schema = z.object({ id: z.string(), n: z.number() });

  it('returns the parsed data on success (passthrough)', () => {
    const out = unwrapOrThrow(schema.safeParse({ id: 'x', n: 1 }), {
      context: 'never thrown',
    });
    expect(out).toEqual({ id: 'x', n: 1 });
  });

  it('wraps ZodError into ApiError(internal_error) with issues + path + code', () => {
    let caught: unknown;
    try {
      unwrapOrThrow(
        schema.safeParse({ id: 1, n: 'not-a-number' } as unknown),
        { context: 'parsing user payload' },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.code).toBe('internal_error');
    expect(err.message).toMatch(/parsing user payload/);
    const details = err.details as { issues: readonly { path: string; code: string }[] };
    expect(details.issues.length).toBe(2);
    const paths = details.issues.map((i) => i.path).sort();
    expect(paths).toEqual(['id', 'n']);
    expect(err.cause).toBeDefined();
  });

  it('merges caller-supplied details alongside issues + hint', () => {
    let caught: unknown;
    try {
      unwrapOrThrow(schema.safeParse({} as unknown), {
        context: 'fetching board',
        details: { board_id: '111' },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    const details = err.details as Readonly<Record<string, unknown>>;
    expect(details.board_id).toBe('111');
    expect(details.issues).toBeDefined();
    expect(details.hint).toBeDefined();
  });

  it('falls back to default hint when caller omits one', () => {
    let caught: unknown;
    try {
      unwrapOrThrow(schema.safeParse({} as unknown), { context: 'x' });
    } catch (e) {
      caught = e;
    }
    const err = caught as ApiError;
    const details = err.details as { hint: string };
    expect(details.hint).toMatch(/Monday's response/);
  });

  it('uses the override hint when caller supplies one', () => {
    let caught: unknown;
    try {
      unwrapOrThrow(schema.safeParse({} as unknown), {
        context: 'x',
        hint: 'verify the cassette shape',
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as ApiError;
    const details = err.details as { hint: string };
    expect(details.hint).toBe('verify the cassette shape');
  });

  it('uses singular "issue" when exactly one issue', () => {
    let caught: unknown;
    try {
      unwrapOrThrow(
        schema.safeParse({ id: 'x' /* missing n only */ } as unknown),
        { context: 'one-issue case' },
      );
    } catch (e) {
      caught = e;
    }
    const err = caught as ApiError;
    expect(err.message).toMatch(/1 issue\b/);
    expect(err.message).not.toMatch(/issues/);
  });
});
