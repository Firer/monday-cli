/**
 * Unit tests for the v0.3-M20 documentation-only `time-tracking.ts`
 * primitives. Both verbs reject every invocation with `usage_error`
 * pointing at the API limitation; the four exported `*Inputs` /
 * `*Result` interfaces are kept verbatim from the pre-flight so when
 * Monday ships the wire mutation, the runtime swap is one-sided.
 *
 * Coverage:
 *
 *  - Type-level surface (interfaces compile + can be constructed
 *    against the documented future shape).
 *  - Reject body — `usage_error` code, message naming the verb,
 *    `details.{board_id, item_id, column_id, hint}`, hint contains
 *    the empirical-probe context (date / API version / Monday's
 *    error codes).
 *  - Input echo — `inputs.boardId / itemId / columnId` flow into
 *    `error.details` so agents inspecting the envelope can confirm
 *    the call site they intended.
 *  - Symmetry — `start` and `stop` reject the same way and only
 *    differ in the verb name.
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

const baseInputs = {
  client: stubClient,
  boardId,
  itemId,
  columnId: 'time_tracking_x',
};

describe('time-tracking — type-level surface (forward-compatibility markers)', () => {
  it('StartTimeTrackingInputs accepts client + branded ids + columnId', () => {
    const inputs: StartTimeTrackingInputs = baseInputs;
    expect(inputs.boardId).toBe(boardId);
    expect(inputs.itemId).toBe(itemId);
    expect(inputs.columnId).toBe('time_tracking_x');
  });

  it('StopTimeTrackingInputs has the same shape as StartTimeTrackingInputs', () => {
    const inputs: StopTimeTrackingInputs = baseInputs;
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

describe('startTimeTracking — documentation-only rejection', () => {
  it('rejects with an ApiError carrying code usage_error', async () => {
    await expect(startTimeTracking(baseInputs)).rejects.toBeInstanceOf(ApiError);
    await expect(startTimeTracking(baseInputs)).rejects.toMatchObject({
      code: 'usage_error',
    });
  });

  it("the error message names the start verb so agents grepping `error.message` can disambiguate", async () => {
    await expect(startTimeTracking(baseInputs)).rejects.toMatchObject({
      message: expect.stringContaining(
        'monday item time-track start',
      ) as string,
    });
  });

  it('echoes board_id / item_id / column_id from the inputs into details', async () => {
    await expect(startTimeTracking(baseInputs)).rejects.toMatchObject({
      details: {
        board_id: boardId,
        item_id: itemId,
        column_id: 'time_tracking_x',
        hint: expect.any(String) as string,
      },
    });
  });

  it("the hint cites the empirical probe (date + API version + Monday's error codes)", async () => {
    const expectedSubstrings = [
      '2026-05-10',
      '2026-01',
      'change_simple_column_value',
      'change_column_value',
      'CorrectedValueException',
      'InvalidColumnTypeException',
      "Monday's UI",
    ];
    for (const substr of expectedSubstrings) {
      await expect(startTimeTracking(baseInputs)).rejects.toMatchObject({
        details: expect.objectContaining({
          hint: expect.stringContaining(substr) as string,
        }) as Record<string, unknown>,
      });
    }
  });

  it('echoes a different columnId verbatim — no hard-coded value', async () => {
    await expect(
      startTimeTracking({ ...baseInputs, columnId: 'duration_xyz' }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        column_id: 'duration_xyz',
      }) as Record<string, unknown>,
    });
  });

  it('echoes a different boardId / itemId verbatim', async () => {
    const otherBoard = BoardIdSchema.parse('999');
    const otherItem = ItemIdSchema.parse('888');
    await expect(
      startTimeTracking({
        ...baseInputs,
        boardId: otherBoard,
        itemId: otherItem,
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        board_id: otherBoard,
        item_id: otherItem,
      }) as Record<string, unknown>,
    });
  });

  it('accepts an empty columnId (command file passes "" when --column omitted) and echoes it', async () => {
    await expect(
      startTimeTracking({ ...baseInputs, columnId: '' }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ column_id: '' }) as Record<
        string,
        unknown
      >,
    });
  });
});

describe('stopTimeTracking — documentation-only rejection', () => {
  it('rejects with an ApiError carrying code usage_error', async () => {
    await expect(stopTimeTracking(baseInputs)).rejects.toBeInstanceOf(ApiError);
    await expect(stopTimeTracking(baseInputs)).rejects.toMatchObject({
      code: 'usage_error',
    });
  });

  it("the error message names the stop verb (not start) so agents grepping `error.message` can disambiguate", async () => {
    await expect(stopTimeTracking(baseInputs)).rejects.toMatchObject({
      message: expect.stringContaining('monday item time-track stop') as string,
    });
    await expect(stopTimeTracking(baseInputs)).rejects.not.toMatchObject({
      message: expect.stringContaining('time-track start') as string,
    });
  });

  it('echoes board_id / item_id / column_id from the inputs into details', async () => {
    await expect(stopTimeTracking(baseInputs)).rejects.toMatchObject({
      details: {
        board_id: boardId,
        item_id: itemId,
        column_id: 'time_tracking_x',
        hint: expect.any(String) as string,
      },
    });
  });

  it("ships the same API_UNSUPPORTED_HINT as start (single source-of-truth)", async () => {
    let startHint = '';
    try {
      await startTimeTracking(baseInputs);
    } catch (err) {
      startHint = (err as ApiError).details?.hint as string;
    }
    let stopHint = '';
    try {
      await stopTimeTracking(baseInputs);
    } catch (err) {
      stopHint = (err as ApiError).details?.hint as string;
    }
    expect(startHint).not.toBe('');
    expect(stopHint).toBe(startHint);
  });
});
