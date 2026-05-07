/**
 * Unit tests for `src/api/board-mutation-invalidation.ts` (R46 lift).
 *
 * Pins the §8 timing contract the helper enforces:
 *
 *   - Single-leg success → perform runs to completion, then
 *     invalidate runs, then return.
 *   - Single-leg error → perform throws, invalidate is NOT called,
 *     error propagates.
 *   - Fan-out whole-call success with ≥1 leg → invalidate runs once.
 *   - Fan-out partial-application failure with ≥1 leg succeeded →
 *     invalidate runs once, error re-thrown.
 *   - Fan-out zero-legs-succeeded failure → invalidate is NOT called,
 *     error re-thrown.
 *   - Fan-out whole-call success with zero legs (defensive) →
 *     invalidate is NOT called.
 *
 * The cache invalidation is exercised through a real `mkdtemp` cache
 * (mirrors `tests/unit/api/cache.test.ts`'s `invalidateBoard`
 * pattern) so the helper's call into `cache.invalidateBoard` is
 * verified end-to-end. Each test seeds an entry, runs the helper,
 * then asserts on the file's presence — `stat` resolves when the
 * file exists, rejects when invalidated.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeEntry } from '../../../src/api/cache.js';
import {
  withBoardInvalidationFanOut,
  withBoardInvalidationSingleLeg,
} from '../../../src/api/board-mutation-invalidation.js';

let xdgRoot: string;
let cacheRoot: string;
let env: NodeJS.ProcessEnv;

const seedBoard = async (boardId: string): Promise<string> => {
  await writeEntry(cacheRoot, { kind: 'board', boardId }, { v: 1 });
  return join(cacheRoot, `boards/${boardId}.json`);
};

beforeEach(async () => {
  xdgRoot = await mkdtemp(join(tmpdir(), 'monday-cli-r46-'));
  cacheRoot = join(xdgRoot, 'monday-cli');
  env = { XDG_CACHE_HOME: xdgRoot };
});

afterEach(async () => {
  await rm(xdgRoot, { recursive: true, force: true });
});

describe('withBoardInvalidationSingleLeg', () => {
  it('runs perform, invalidates, returns the perform result', async () => {
    const path = await seedBoard('111');
    expect((await stat(path)).size).toBeGreaterThan(0);

    const result = await withBoardInvalidationSingleLeg({
      boardId: '111',
      env,
      perform: () =>
        Promise.resolve({ data: { id: 'col1' }, response: { meta: 'ok' } }),
    });

    expect(result).toEqual({ data: { id: 'col1' }, response: { meta: 'ok' } });
    await expect(stat(path)).rejects.toThrow();
  });

  it('orders perform BEFORE invalidate (perform completes before unlink)', async () => {
    // Seed the cache. Inside `perform`, assert the file still
    // exists — this proves the helper does NOT invalidate before
    // running the closure (the §8 ordering invariant). After the
    // helper returns, the file is gone.
    const path = await seedBoard('222');
    let observedDuringPerform: { exists: boolean } | undefined;
    await withBoardInvalidationSingleLeg({
      boardId: '222',
      env,
      perform: async () => {
        const exists = await stat(path).then(
          () => true,
          () => false,
        );
        observedDuringPerform = { exists };
        return 'value';
      },
    });
    expect(observedDuringPerform).toEqual({ exists: true });
    await expect(stat(path)).rejects.toThrow();
  });

  it('skips invalidation when perform throws (error path)', async () => {
    const path = await seedBoard('333');
    const boom = new Error('perform failed');
    await expect(
      withBoardInvalidationSingleLeg({
        boardId: '333',
        env,
        perform: () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
    // Cache entry still present — single-leg error skips
    // invalidation per §8.
    await expect(stat(path)).resolves.toBeDefined();
  });

  it('is a no-op against an absent cache entry (idempotent)', async () => {
    // Helper must not throw when the board was never cached — the
    // §8 contract pins idempotency through invalidateBoard's
    // missing-file no-op semantics.
    const result = await withBoardInvalidationSingleLeg({
      boardId: 'never-seeded',
      env,
      perform: () => Promise.resolve(42),
    });
    expect(result).toBe(42);
  });

  it('preserves the typed value through generic T', async () => {
    interface Shape {
      readonly data: { readonly id: string };
      readonly response: { readonly meta: string };
    }
    await seedBoard('444');
    const result: Shape = await withBoardInvalidationSingleLeg<Shape>({
      boardId: '444',
      env,
      perform: () =>
        Promise.resolve({ data: { id: 'x' }, response: { meta: 'm' } }),
    });
    expect(result.data.id).toBe('x');
    expect(result.response.meta).toBe('m');
  });
});

describe('withBoardInvalidationFanOut', () => {
  it('whole-call success with ≥1 leg → invalidate runs once', async () => {
    const path = await seedBoard('555');
    const result = await withBoardInvalidationFanOut({
      boardId: '555',
      env,
      runFanOut: ({ recordLegSuccess }) => {
        recordLegSuccess();
        recordLegSuccess();
        return Promise.resolve('ok');
      },
    });
    expect(result).toBe('ok');
    await expect(stat(path)).rejects.toThrow();
  });

  it('partial-application failure with ≥1 leg succeeded → invalidate runs, error re-thrown', async () => {
    const path = await seedBoard('666');
    const boom = new Error('leg 2 failed');
    await expect(
      withBoardInvalidationFanOut({
        boardId: '666',
        env,
        runFanOut: ({ recordLegSuccess }) => {
          recordLegSuccess();
          return Promise.reject(boom);
        },
      }),
    ).rejects.toBe(boom);
    // Cache entry removed — partial-application invalidation
    // fires per §8 high-water-mark rule.
    await expect(stat(path)).rejects.toThrow();
  });

  it('zero-legs-succeeded failure → invalidate NOT called, error re-thrown', async () => {
    const path = await seedBoard('777');
    const boom = new Error('first leg failed');
    await expect(
      withBoardInvalidationFanOut({
        boardId: '777',
        env,
        runFanOut: () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
    // Cache entry preserved — zero legs succeeded, server state
    // unchanged.
    await expect(stat(path)).resolves.toBeDefined();
  });

  it('whole-call success with zero recorded legs → invalidate NOT called (defensive)', async () => {
    // Defensive parity with the partial-application rule: if
    // runFanOut returns successfully without recording any legs
    // (an edge case the consumers don't normally produce),
    // skip invalidation. Behaviourally equivalent to the
    // dispatchPlan.length === 0 guard the consumers carry.
    const path = await seedBoard('888');
    const result = await withBoardInvalidationFanOut({
      boardId: '888',
      env,
      runFanOut: () => Promise.resolve('no-legs'),
    });
    expect(result).toBe('no-legs');
    await expect(stat(path)).resolves.toBeDefined();
  });

  it('runFanOut sees the seeded cache entry BEFORE invalidation (ordering invariant)', async () => {
    const path = await seedBoard('999');
    let observedDuringRun: { exists: boolean } | undefined;
    await withBoardInvalidationFanOut({
      boardId: '999',
      env,
      runFanOut: async ({ recordLegSuccess }) => {
        const exists = await stat(path).then(
          () => true,
          () => false,
        );
        observedDuringRun = { exists };
        recordLegSuccess();
        return 'value';
      },
    });
    expect(observedDuringRun).toEqual({ exists: true });
    await expect(stat(path)).rejects.toThrow();
  });

  it('preserves the typed value through generic T', async () => {
    interface FanOutShape {
      readonly data: { readonly count: number };
      readonly response: { readonly id: string };
    }
    await seedBoard('1010');
    const result: FanOutShape = await withBoardInvalidationFanOut<FanOutShape>({
      boardId: '1010',
      env,
      runFanOut: ({ recordLegSuccess }) => {
        recordLegSuccess();
        return Promise.resolve({ data: { count: 3 }, response: { id: 'r1' } });
      },
    });
    expect(result.data.count).toBe(3);
    expect(result.response.id).toBe('r1');
  });

  it('records an arbitrary number of leg successes (high-water-mark stays > 0)', async () => {
    // Pin the high-water-mark logic: 1 leg, 2 legs, 5 legs all
    // route through the same "succeededLegs > 0 → invalidate"
    // branch. The counter is internal to the helper; this test
    // proves the invalidation fires regardless of the count.
    const path = await seedBoard('1111');
    await withBoardInvalidationFanOut({
      boardId: '1111',
      env,
      runFanOut: ({ recordLegSuccess }) => {
        for (let i = 0; i < 5; i++) recordLegSuccess();
        return Promise.resolve('five-legs');
      },
    });
    await expect(stat(path)).rejects.toThrow();
  });
});
