/**
 * Integration tests for the v0.3-M23 cross-board `monday item search`
 * + `monday board favorites` pre-flight stubs.
 *
 * Both surfaces stub-reject until M23 implementation lands the
 * runtime fan-out walker (`src/api/cross-board-search.ts`) + 2-stage
 * favorites resolver (`src/api/board-favorites.ts`). The tests
 * confirm:
 *
 *   - `monday item search` mutual-exclusion: at most one of
 *     `--board` / `--workspace` / `--favorites` is accepted; supplying
 *     two surfaces a `usage_error` at the input-schema layer (exit 1).
 *   - The v0.1 single-board path remains UNCHANGED — `--board` set
 *     keeps the existing v0.1 success-envelope shape (covered by the
 *     existing `tests/integration/commands/item-search.test.ts`
 *     suite; this file doesn't duplicate those assertions).
 *   - The cross-board paths (no `--board`, with one of `--workspace`
 *     / `--favorites` / none) stub-reject with `internal_error` +
 *     M23-pending hint.
 *   - `monday board favorites` stub-rejects with `internal_error`.
 *   - `--max-boards` validation pin: above-cap surfaces `usage_error`
 *     at the parse boundary per Decision 5 closure.
 *
 * M23 implementation replaces the cross-board stub-rejection tests
 * with the real success-envelope shape assertions per cli-design
 * §13 v0.3 entry; the favorites verb's tests similarly flip to the
 * 2-stage hydrate success shape.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../../../src/cli/run.js';
import { baseOptions, parseEnvelope } from '../helpers.js';
import { HARD_CAP_MAX_BOARDS } from '../../../src/api/cross-board-search.js';

const driveM23 = async (
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    isTTY: false,
  });
  const result = await run(options);
  return {
    exitCode: result.exitCode,
    stdout: captured.stdout(),
    stderr: captured.stderr(),
  };
};

describe('monday item search cross-board (M23 pre-flight stub)', () => {
  it('all-accessible-boards mode (no scoping lever) stub-rejects with internal_error', async () => {
    const { exitCode, stderr } = await driveM23([
      'item',
      'search',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('internal_error');
    expect(envelope.error.message).toMatch(/M23 pre-flight stub/);
    const details = envelope.error.details as { scoping_lever: string };
    expect(details.scoping_lever).toBe('all-accessible-boards');
  });

  it('--workspace mode stub-rejects with scoping_lever:workspace', async () => {
    const { exitCode, stderr } = await driveM23([
      'item',
      'search',
      '--workspace',
      '999',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('internal_error');
    const details = envelope.error.details as { scoping_lever: string };
    expect(details.scoping_lever).toBe('workspace');
  });

  it('--favorites mode stub-rejects with scoping_lever:favorites', async () => {
    const { exitCode, stderr } = await driveM23([
      'item',
      'search',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('internal_error');
    const details = envelope.error.details as { scoping_lever: string };
    expect(details.scoping_lever).toBe('favorites');
  });

  it('rejection details carry max_boards (default) + hard_cap', async () => {
    const { stderr } = await driveM23([
      'item',
      'search',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    const details = envelope.error.details as {
      max_boards: number;
      hard_cap: number;
    };
    expect(details.max_boards).toBe(25);
    expect(details.hard_cap).toBe(HARD_CAP_MAX_BOARDS);
  });

  it('rejection details carry --max-boards override', async () => {
    const { stderr } = await driveM23([
      'item',
      'search',
      '--favorites',
      '--max-boards',
      '50',
      '--where',
      'status=Done',
      '--json',
    ]);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    const details = envelope.error.details as { max_boards: number };
    expect(details.max_boards).toBe(50);
  });

  it('rejection hint points at the M23 implementation surface', async () => {
    const { stderr } = await driveM23([
      'item',
      'search',
      '--where',
      'status=Done',
      '--json',
    ]);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    const details = envelope.error.details as { hint: string };
    expect(details.hint).toMatch(/M23 implementation|fan-out walker|cross-board-search\.ts/);
  });

  it('rejection details carry cap_rationale referencing wall-clock latency (Codex P3-1)', async () => {
    const { stderr } = await driveM23([
      'item',
      'search',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    const details = envelope.error.details as { cap_rationale: string };
    expect(details.cap_rationale).toMatch(/wall-clock|latency/);
    expect(details.cap_rationale).toMatch(/MONDAY_REQUEST_TIMEOUT_MS|30s/);
  });
});

describe('monday item search --max-boards validation', () => {
  it('--max-boards above hard cap surfaces usage_error on the cross-board path', async () => {
    const { exitCode, stderr } = await driveM23([
      'item',
      'search',
      '--favorites',
      '--max-boards',
      String(HARD_CAP_MAX_BOARDS + 1),
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1); // usage_error
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
    expect(envelope.error.message).toMatch(/hard cap|wall-clock|--workspace|--favorites/);
  });

  it('--max-boards = hard cap accepted (boundary)', async () => {
    const { exitCode, stderr } = await driveM23([
      'item',
      'search',
      '--favorites',
      '--max-boards',
      String(HARD_CAP_MAX_BOARDS),
      '--where',
      'status=Done',
      '--json',
    ]);
    // Boundary value accepted → not usage_error. Stub-reject at the
    // M23 cross-board path (internal_error / exit 2).
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('internal_error');
  });

  it('--max-boards = 0 rejected at the parse boundary', async () => {
    const { exitCode } = await driveM23([
      'item',
      'search',
      '--favorites',
      '--max-boards',
      '0',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
  });

  it('--max-boards > hard cap accepted on the single-board path (Codex P2-2: flag ignored)', async () => {
    // The schema-level cap enforcement is CONDITIONAL — only the
    // cross-board path (--board absent) rejects above-cap values.
    // On the single-board path, the user-facing contract documents
    // the flag as ignored; rejecting would punish agents who supply
    // it harmlessly. The single-board v0.1 path still runs, so the
    // failure here is whatever the v0.1 search produces (the
    // fixture-less transport in this test will error at the network
    // boundary — exitCode != 1 confirms the parse layer accepted
    // the call).
    const { exitCode } = await driveM23([
      'item',
      'search',
      '--board',
      '111',
      '--max-boards',
      String(HARD_CAP_MAX_BOARDS + 100),
      '--where',
      'status=Done',
      '--json',
    ]);
    // Not usage_error (would be 1) — the schema accepted the
    // above-cap value on the single-board path. The runtime path
    // fails at the network boundary (no fixture) → exit 2.
    expect(exitCode).not.toBe(1);
  });
});

describe('monday item search scoping-lever mutual exclusion', () => {
  it('--board + --workspace surfaces usage_error', async () => {
    const { exitCode, stderr } = await driveM23([
      'item',
      'search',
      '--board',
      '111',
      '--workspace',
      '999',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
    expect(envelope.error.message).toMatch(/at most one of --board.*--workspace.*--favorites/);
  });

  it('--board + --favorites surfaces usage_error', async () => {
    const { exitCode, stderr } = await driveM23([
      'item',
      'search',
      '--board',
      '111',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
  });

  it('--workspace + --favorites surfaces usage_error', async () => {
    const { exitCode, stderr } = await driveM23([
      'item',
      'search',
      '--workspace',
      '999',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
  });

  it('all three scoping levers surfaces usage_error', async () => {
    const { exitCode, stderr } = await driveM23([
      'item',
      'search',
      '--board',
      '111',
      '--workspace',
      '999',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('usage_error');
    expect(envelope.error.message).toMatch(/board, workspace, favorites/);
  });

  it('mutual-exclusion issue path is empty (Codex P2-3: error is about the combination)', async () => {
    // The .superRefine guard reports `path: []` on the issue so
    // the error envelope's `details.issues[].path` doesn't point
    // agents at one specific field — the conflict is about the
    // combination of scoping levers, not one of them.
    const { stderr } = await driveM23([
      'item',
      'search',
      '--workspace',
      '999',
      '--favorites',
      '--where',
      'status=Done',
      '--json',
    ]);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    const details = envelope.error.details as {
      issues: readonly { path: string; message: string }[];
    };
    const conflictIssue = details.issues.find((i) =>
      i.message.includes('at most one of --board'),
    );
    expect(conflictIssue).toBeDefined();
    expect(conflictIssue?.path).toBe('');
  });
});

describe('monday board favorites (M23 pre-flight stub)', () => {
  it('rejects every invocation with internal_error + M23-pending hint', async () => {
    const { exitCode, stderr } = await driveM23([
      'board',
      'favorites',
      '--json',
    ]);
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('internal_error');
    expect(envelope.error.message).toMatch(/pre-flight stub/);
    const details = envelope.error.details as { hint: string };
    expect(details.hint).toMatch(/M23 implementation|2-stage|favorites/);
  });

  it('rejects unknown flags via the input-schema strict-parse layer', async () => {
    const { exitCode } = await driveM23([
      'board',
      'favorites',
      '--unknown-flag',
      '--json',
    ]);
    // Commander rejects unknown options with a non-zero exit before
    // our envelope can wrap; the runner maps commander's exit shape
    // to exit 1 (usage error class).
    expect(exitCode).toBeGreaterThan(0);
  });

  it('error envelope carries the standard §6.5 fields (request_id, retrieved_at)', async () => {
    const { stderr } = await driveM23(['board', 'favorites', '--json']);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.meta.schema_version).toBe('1');
    expect(envelope.meta.request_id).toBeTruthy();
    expect(envelope.meta.retrieved_at).toBeTruthy();
  });
});
