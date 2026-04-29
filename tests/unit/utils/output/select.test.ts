import { describe, expect, it } from 'vitest';
import { UsageError } from '../../../../src/utils/errors.js';
import { selectOutput } from '../../../../src/utils/output/select.js';

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
