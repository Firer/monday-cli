/**
 * Surface-level tests for the v0.3-M19 pre-flight
 * `board-relation-validation.ts` stub. The full batched
 * `items(ids: ...)` + per-item allowed-boards membership-check
 * tests land at M19 implementation alongside the `board_relation`
 * + `dependency` friendly translators; this suite pins the
 * type-level surface (so the exports compile + are reachable) and
 * confirms the stub body throws the documented pre-flight error
 * shape.
 */

import { describe, expect, it } from 'vitest';
import {
  BOARD_RELATION_MAX_ITEMS,
  validateBoardRelationItems,
  type BoardRelationMismatch,
  type BoardRelationValidationInputs,
  type BoardRelationValidationResult,
} from '../../../src/api/board-relation-validation.js';
import type { MondayClient } from '../../../src/api/client.js';
import { ApiError } from '../../../src/utils/errors.js';

const stubClient = {} as unknown as MondayClient;

describe('board-relation-validation pre-flight surface', () => {
  it('exposes Monday\'s documented per-call cap (25 items)', () => {
    expect(BOARD_RELATION_MAX_ITEMS).toBe(25);
  });

  it('exports the BoardRelationValidationInputs shape with context discriminant', () => {
    const inputs: BoardRelationValidationInputs = {
      client: stubClient,
      itemIds: [1, 2],
      allowedBoards: [10, 20],
      context: 'board_relation',
    };
    expect(inputs.context).toBe('board_relation');

    const dependencyInputs: BoardRelationValidationInputs = {
      client: stubClient,
      itemIds: [1],
      allowedBoards: [30],
      context: 'dependency',
    };
    expect(dependencyInputs.context).toBe('dependency');
  });

  it('exports the BoardRelationValidationResult discriminated union', () => {
    const ok: BoardRelationValidationResult = { ok: true };
    expect(ok.ok).toBe(true);

    const mismatch: BoardRelationMismatch = {
      itemId: 7,
      actualBoard: 99,
    };
    const fail: BoardRelationValidationResult = {
      ok: false,
      mismatches: [mismatch],
    };
    expect(fail.ok).toBe(false);
    // Direct access — TypeScript narrows from the literal `ok: false`
    // initialiser; no runtime narrowing branch needed.
    const firstMismatch = (fail as { ok: false; mismatches: readonly BoardRelationMismatch[] })
      .mismatches[0];
    expect(firstMismatch?.itemId).toBe(7);
  });
});

describe('validateBoardRelationItems (stub)', () => {
  it('throws an internal_error ApiError until M19 implementation lands', async () => {
    await expect(
      validateBoardRelationItems({
        client: stubClient,
        itemIds: [1],
        allowedBoards: [10],
        context: 'board_relation',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      validateBoardRelationItems({
        client: stubClient,
        itemIds: [1],
        allowedBoards: [10],
        context: 'board_relation',
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('carries a hint pointing at the M19 implementation session', async () => {
    await expect(
      validateBoardRelationItems({
        client: stubClient,
        itemIds: [1],
        allowedBoards: [10],
        context: 'dependency',
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        hint: expect.stringContaining('M19') as string,
      }) as Record<string, unknown>,
    });
  });
});
