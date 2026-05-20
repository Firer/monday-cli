import { describe, expect, it } from 'vitest';
import { UsageError } from '../../../../src/utils/errors.js';
import {
  resolveColorEnabled,
  selectOutput,
} from '../../../../src/utils/output/select.js';

describe('selectOutput — defaults from TTY', () => {
  it('defaults to table when stdout is a TTY', () => {
    expect(selectOutput({ isTTY: true })).toBe('table');
  });

  it('defaults to json when stdout is not a TTY (pipe-safe)', () => {
    expect(selectOutput({ isTTY: false })).toBe('json');
  });
});

describe('selectOutput — shorthand flags', () => {
  it('--json wins over the TTY default', () => {
    expect(selectOutput({ isTTY: true, json: true })).toBe('json');
  });

  it('--table wins over the non-TTY default', () => {
    expect(selectOutput({ isTTY: false, table: true })).toBe('table');
  });

  it('rejects --json + --table', () => {
    expect(() =>
      selectOutput({ isTTY: false, json: true, table: true }),
    ).toThrow(UsageError);
  });
});

describe('selectOutput — --output', () => {
  it.each(['json', 'table', 'text', 'ndjson'] as const)(
    'accepts --output %s',
    (fmt) => {
      expect(selectOutput({ isTTY: false, output: fmt })).toBe(fmt);
    },
  );

  it('rejects an unknown --output value', () => {
    expect(() => selectOutput({ isTTY: false, output: 'yaml' })).toThrow(
      /yaml/u,
    );
  });

  it('rejects --json + --output table', () => {
    expect(() =>
      selectOutput({ isTTY: false, json: true, output: 'table' }),
    ).toThrow(UsageError);
  });

  it('rejects --table + --output ndjson', () => {
    expect(() =>
      selectOutput({ isTTY: true, table: true, output: 'ndjson' }),
    ).toThrow(UsageError);
  });

  it('accepts --json + --output json (redundant but consistent)', () => {
    expect(selectOutput({ isTTY: false, json: true, output: 'json' })).toBe(
      'json',
    );
  });
});

describe('selectOutput — MONDAY_OUTPUT env', () => {
  it('honours MONDAY_OUTPUT when no flag is set', () => {
    expect(
      selectOutput({ isTTY: true, env: { MONDAY_OUTPUT: 'ndjson' } }),
    ).toBe('ndjson');
  });

  it('flag wins over env', () => {
    expect(
      selectOutput({
        isTTY: false,
        json: true,
        env: { MONDAY_OUTPUT: 'table' },
      }),
    ).toBe('json');
  });

  it('ignores empty MONDAY_OUTPUT', () => {
    expect(
      selectOutput({ isTTY: true, env: { MONDAY_OUTPUT: '' } }),
    ).toBe('table');
  });

  it('rejects an unknown MONDAY_OUTPUT value', () => {
    expect(() =>
      selectOutput({ isTTY: true, env: { MONDAY_OUTPUT: 'yaml' } }),
    ).toThrow(/yaml/u);
  });
});

describe('selectOutput — error type', () => {
  it('mutual-exclusion errors are UsageError instances', () => {
    try {
      selectOutput({ isTTY: false, json: true, table: true });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe('usage_error');
    }
  });
});

describe('resolveColorEnabled', () => {
  it('enables colour on a TTY with no opposing signal', () => {
    expect(resolveColorEnabled({ noColor: false, isTTY: true })).toBe(true);
  });

  it('disables colour off a TTY (pipe-safe default)', () => {
    expect(resolveColorEnabled({ noColor: false, isTTY: false })).toBe(false);
  });

  it('--no-color wins over a TTY', () => {
    expect(resolveColorEnabled({ noColor: true, isTTY: true })).toBe(false);
  });

  it('--no-color wins even with FORCE_COLOR set', () => {
    expect(
      resolveColorEnabled({
        noColor: true,
        isTTY: true,
        env: { FORCE_COLOR: '1' },
      }),
    ).toBe(false);
  });

  it('FORCE_COLOR forces colour even off a TTY', () => {
    expect(
      resolveColorEnabled({
        noColor: false,
        isTTY: false,
        env: { FORCE_COLOR: '1' },
      }),
    ).toBe(true);
  });

  it('FORCE_COLOR=0 does not force colour (falls through to TTY)', () => {
    expect(
      resolveColorEnabled({
        noColor: false,
        isTTY: false,
        env: { FORCE_COLOR: '0' },
      }),
    ).toBe(false);
  });

  it('FORCE_COLOR=false does not force colour', () => {
    expect(
      resolveColorEnabled({
        noColor: false,
        isTTY: false,
        env: { FORCE_COLOR: 'false' },
      }),
    ).toBe(false);
  });

  it('empty FORCE_COLOR does not force colour', () => {
    expect(
      resolveColorEnabled({
        noColor: false,
        isTTY: true,
        env: { FORCE_COLOR: '', NO_COLOR: '1' },
      }),
    ).toBe(false);
  });

  it('NO_COLOR disables colour on a TTY', () => {
    expect(
      resolveColorEnabled({
        noColor: false,
        isTTY: true,
        env: { NO_COLOR: '1' },
      }),
    ).toBe(false);
  });

  it('empty NO_COLOR is ignored (falls through to TTY)', () => {
    expect(
      resolveColorEnabled({ noColor: false, isTTY: true, env: { NO_COLOR: '' } }),
    ).toBe(true);
  });

  it('FORCE_COLOR takes precedence over NO_COLOR', () => {
    expect(
      resolveColorEnabled({
        noColor: false,
        isTTY: false,
        env: { FORCE_COLOR: '1', NO_COLOR: '1' },
      }),
    ).toBe(true);
  });
});
