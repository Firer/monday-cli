/**
 * Argv parser unit tests for `src/commands/item/watch.ts` (v0.4-M29
 * pre-flight stub). Covers the zod `inputSchema` parse boundary —
 * the only real surface at pre-flight (the action body is c8-ignored
 * until M29 IMPL).
 *
 * Test matrix:
 *
 *   - Happy positional + optional flags.
 *   - `--interval <ms>` range enforcement (1s–1h floor/ceiling per
 *     cli-design §14.4 closure).
 *   - `--since <event-id>` numeric-ID validator (matches Monday's
 *     `ActivityLogType.id` shape).
 *   - `--include <list>` comma-split + per-kind validation against the
 *     M24 closed 9-kind enum + empty-after-trim rejection.
 *   - `--once` mutual-exclusion with `--max-events` / `--max-duration`.
 *   - `--max-events` / `--max-duration` positive-integer coercion.
 *   - Strict-object rejection of unknown flags.
 *
 * The schema is the contract surface; agents key off the
 * `usage_error.details.issues` shape. The action body's runtime
 * behaviour is M29 IMPL's concern.
 */
import { describe, expect, it } from 'vitest';
import { itemWatchCommand } from '../../../src/commands/item/watch.js';
import { UsageError } from '../../../src/utils/errors.js';
import { parseArgv } from '../../../src/commands/parse-argv.js';

const VALID_IID = '1234567890';

describe('itemWatchCommand.inputSchema (M29 argv)', () => {
  describe('happy paths', () => {
    it('parses bare `iid` with no options', () => {
      const parsed = parseArgv(itemWatchCommand.inputSchema, { iid: VALID_IID });
      expect(parsed.iid).toBe(VALID_IID);
      expect(parsed.interval).toBeUndefined();
      expect(parsed.since).toBeUndefined();
      expect(parsed.once).toBeUndefined();
      expect(parsed.maxEvents).toBeUndefined();
      expect(parsed.maxDuration).toBeUndefined();
      expect(parsed.include).toBeUndefined();
    });

    it('parses every option together', () => {
      const parsed = parseArgv(itemWatchCommand.inputSchema, {
        iid: VALID_IID,
        interval: '30000',
        since: '987654',
        maxEvents: '10',
        maxDuration: '3600',
        include: 'update_column_value,update_posted',
      });
      expect(parsed.interval).toBe(30_000);
      expect(parsed.since).toBe('987654');
      expect(parsed.maxEvents).toBe(10);
      expect(parsed.maxDuration).toBe(3600);
      expect(parsed.include).toEqual(['update_column_value', 'update_posted']);
    });

    it('parses `--once` standalone', () => {
      const parsed = parseArgv(itemWatchCommand.inputSchema, {
        iid: VALID_IID,
        once: true,
      });
      expect(parsed.once).toBe(true);
    });
  });

  describe('--interval', () => {
    it('accepts the documented floor (1000ms / 1s)', () => {
      const parsed = parseArgv(itemWatchCommand.inputSchema, {
        iid: VALID_IID,
        interval: '1000',
      });
      expect(parsed.interval).toBe(1000);
    });

    it('accepts the documented ceiling (3600000ms / 1h)', () => {
      const parsed = parseArgv(itemWatchCommand.inputSchema, {
        iid: VALID_IID,
        interval: '3600000',
      });
      expect(parsed.interval).toBe(3_600_000);
    });

    it('rejects intervals below 1000ms', () => {
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, { iid: VALID_IID, interval: '999' }),
      ).toThrow(UsageError);
    });

    it('rejects intervals above 3600000ms', () => {
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          interval: '3600001',
        }),
      ).toThrow(UsageError);
    });

    it('rejects non-integer intervals', () => {
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          interval: '30000.5',
        }),
      ).toThrow(UsageError);
    });
  });

  describe('--since', () => {
    it('accepts numeric event IDs', () => {
      const parsed = parseArgv(itemWatchCommand.inputSchema, {
        iid: VALID_IID,
        since: '1234567890123',
      });
      expect(parsed.since).toBe('1234567890123');
    });

    it('rejects non-numeric strings', () => {
      let caught: UsageError | undefined;
      try {
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          since: '2026-05-13',
        });
      } catch (e) {
        caught = e as UsageError;
      }
      expect(caught).toBeInstanceOf(UsageError);
      const issues = (caught?.details?.issues ?? []) as readonly { path: string }[];
      expect(issues.some((i) => i.path === 'since')).toBe(true);
    });

    it('rejects empty string', () => {
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, { iid: VALID_IID, since: '' }),
      ).toThrow(UsageError);
    });
  });

  describe('--include', () => {
    it('parses single kind', () => {
      const parsed = parseArgv(itemWatchCommand.inputSchema, {
        iid: VALID_IID,
        include: 'update_column_value',
      });
      expect(parsed.include).toEqual(['update_column_value']);
    });

    it('parses multiple kinds via comma split', () => {
      const parsed = parseArgv(itemWatchCommand.inputSchema, {
        iid: VALID_IID,
        include: 'update_column_value,update_posted,update_replied',
      });
      expect(parsed.include).toEqual([
        'update_column_value',
        'update_posted',
        'update_replied',
      ]);
    });

    it('trims whitespace + drops trailing empty entries', () => {
      const parsed = parseArgv(itemWatchCommand.inputSchema, {
        iid: VALID_IID,
        include: 'update_column_value, update_posted ,',
      });
      expect(parsed.include).toEqual(['update_column_value', 'update_posted']);
    });

    it('accepts all 9 M24 kinds (forward-compat for v0.5+ comment-polling)', () => {
      // v0.4-M29 polls activity_logs only — `update_posted` /
      // `update_replied` are valid argv values but emit no events at
      // v0.4. Argv accepts them so v0.5+ extension doesn't break.
      const parsed = parseArgv(itemWatchCommand.inputSchema, {
        iid: VALID_IID,
        include:
          'update_column_value,create_column,create_group,update_board_name,update_board_nickname,board_workspace_id_changed,update_posted,update_replied,unknown',
      });
      expect(parsed.include).toHaveLength(9);
    });

    it('rejects unknown kinds', () => {
      let caught: UsageError | undefined;
      try {
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          include: 'update_column_value,not_a_real_kind',
        });
      } catch (e) {
        caught = e as UsageError;
      }
      expect(caught).toBeInstanceOf(UsageError);
    });

    it('rejects all-empty (e.g., `--include ,,`)', () => {
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, { iid: VALID_IID, include: ',,' }),
      ).toThrow(UsageError);
    });
  });

  describe('mutual exclusion via superRefine', () => {
    it('rejects --once with --max-events', () => {
      let caught: UsageError | undefined;
      try {
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          once: true,
          maxEvents: '5',
        });
      } catch (e) {
        caught = e as UsageError;
      }
      expect(caught).toBeInstanceOf(UsageError);
      expect(caught?.message).toContain('--once');
    });

    it('rejects --once with --max-duration', () => {
      let caught: UsageError | undefined;
      try {
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          once: true,
          maxDuration: '60',
        });
      } catch (e) {
        caught = e as UsageError;
      }
      expect(caught).toBeInstanceOf(UsageError);
      expect(caught?.message).toContain('--once');
    });

    it('allows --max-events with --max-duration (both ceilings)', () => {
      const parsed = parseArgv(itemWatchCommand.inputSchema, {
        iid: VALID_IID,
        maxEvents: '10',
        maxDuration: '300',
      });
      expect(parsed.maxEvents).toBe(10);
      expect(parsed.maxDuration).toBe(300);
    });
  });

  describe('integer-coercion guards', () => {
    it('rejects --max-events <= 0', () => {
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          maxEvents: '0',
        }),
      ).toThrow(UsageError);
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          maxEvents: '-1',
        }),
      ).toThrow(UsageError);
    });

    it('rejects --max-duration <= 0', () => {
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          maxDuration: '0',
        }),
      ).toThrow(UsageError);
    });

    it('rejects non-integer --max-events / --max-duration', () => {
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          maxEvents: '3.5',
        }),
      ).toThrow(UsageError);
    });
  });

  describe('strict-object rejection', () => {
    it('rejects unknown flags', () => {
      let caught: UsageError | undefined;
      try {
        parseArgv(itemWatchCommand.inputSchema, {
          iid: VALID_IID,
          // M29 v0.4 doesn't ship --until-status; the older forward-decked
          // cli-design row carried it but the §14.4 closure dropped it
          // in favour of the broader --max-events / --max-duration /
          // --include surface. Strict-object rejection catches the
          // stale flag.
          untilStatus: 'Done',
        });
      } catch (e) {
        caught = e as UsageError;
      }
      expect(caught).toBeInstanceOf(UsageError);
    });
  });

  describe('iid (ItemIdSchema brand)', () => {
    it('rejects non-numeric iid', () => {
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, { iid: 'not-an-id' }),
      ).toThrow(UsageError);
    });

    it('rejects empty iid', () => {
      expect(() =>
        parseArgv(itemWatchCommand.inputSchema, { iid: '' }),
      ).toThrow(UsageError);
    });
  });
});
