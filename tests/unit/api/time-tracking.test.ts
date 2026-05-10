/**
 * Surface-level tests for the v0.3-M20 pre-flight `time-tracking.ts`
 * stub. The full runtime + state-conflict + happy-path tests land at
 * M20 implementation alongside the `monday item time-track start /
 * stop` command files; this suite pins the type-level surface (so
 * the exports compile + are reachable) and confirms the stub bodies
 * throw the documented pre-flight error shape.
 *
 * Mirrors the M19 pre-flight precedent (`tests/unit/api/tag-
 * directory.test.ts` at `d822982`): type-imports + stub-throw
 * assertions that cover the public surface without re-implementing
 * what the M20 implementation will own.
 */

import { describe, expect, it } from 'vitest';
import {
  startTimeTracking,
  stopTimeTracking,
  type StartTimeTrackingInputs,
  type StartTimeTrackingResult,
  type StopTimeTrackingInputs,
  type StopTimeTrackingResult,
} from '../../../src/api/time-tracking.js';
import type { MondayClient } from '../../../src/api/client.js';
import { BoardIdSchema, ItemIdSchema } from '../../../src/types/ids.js';
import { ApiError } from '../../../src/utils/errors.js';

const stubClient = {} as unknown as MondayClient;
const boardId = BoardIdSchema.parse('111');
const itemId = ItemIdSchema.parse('222');

const stubInputs: StartTimeTrackingInputs = {
  client: stubClient,
  boardId,
  itemId,
  columnId: 'time_tracking_x',
};

describe('time-tracking pre-flight surface', () => {
  it('exports StartTimeTrackingInputs with client + branded ids + columnId', () => {
    const inputs: StartTimeTrackingInputs = {
      client: stubClient,
      boardId,
      itemId,
      columnId: 'time_tracking_x',
    };
    expect(inputs.columnId).toBe('time_tracking_x');
    expect(inputs.boardId).toBe(boardId);
    expect(inputs.itemId).toBe(itemId);
  });

  it('exports StopTimeTrackingInputs with the same shape as Start', () => {
    const inputs: StopTimeTrackingInputs = {
      client: stubClient,
      boardId,
      itemId,
      columnId: 'time_tracking_x',
    };
    expect(inputs.columnId).toBe('time_tracking_x');
  });

  it('StartTimeTrackingResult literals running:true + carries startedAt', () => {
    const result: StartTimeTrackingResult = {
      itemId: '222',
      columnId: 'time_tracking_x',
      running: true,
      startedAt: '2026-05-10T12:00:00Z',
    };
    expect(result.running).toBe(true);
    expect(result.startedAt).toBe('2026-05-10T12:00:00Z');
  });

  it('StopTimeTrackingResult literals running:false + carries startedAt/endedAt/durationSeconds', () => {
    const result: StopTimeTrackingResult = {
      itemId: '222',
      columnId: 'time_tracking_x',
      running: false,
      startedAt: '2026-05-10T12:00:00Z',
      endedAt: '2026-05-10T12:30:00Z',
      durationSeconds: 1800,
    };
    expect(result.running).toBe(false);
    expect(result.durationSeconds).toBe(1800);
  });

  it('StopTimeTrackingResult.startedAt + durationSeconds are nullable (Monday omits started_at on automation-added sessions; duration is uncomputable then)', () => {
    const result: StopTimeTrackingResult = {
      itemId: '222',
      columnId: 'time_tracking_x',
      running: false,
      startedAt: null,
      endedAt: '2026-05-10T12:30:00Z',
      durationSeconds: null,
    };
    expect(result.startedAt).toBeNull();
    expect(result.durationSeconds).toBeNull();
  });
});

describe('startTimeTracking (stub)', () => {
  it('throws an internal_error ApiError until M20 implementation lands', async () => {
    await expect(startTimeTracking(stubInputs)).rejects.toBeInstanceOf(ApiError);
    await expect(startTimeTracking(stubInputs)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('carries a hint pointing at the M20 implementation session', async () => {
    await expect(startTimeTracking(stubInputs)).rejects.toMatchObject({
      details: expect.objectContaining({
        hint: expect.stringContaining('M20') as string,
      }) as Record<string, unknown>,
    });
  });
});

describe('stopTimeTracking (stub)', () => {
  it('throws an internal_error ApiError until M20 implementation lands', async () => {
    await expect(stopTimeTracking(stubInputs)).rejects.toBeInstanceOf(ApiError);
    await expect(stopTimeTracking(stubInputs)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('carries a hint pointing at the M20 implementation session', async () => {
    await expect(stopTimeTracking(stubInputs)).rejects.toMatchObject({
      details: expect.objectContaining({
        hint: expect.stringContaining('M20') as string,
      }) as Record<string, unknown>,
    });
  });
});
