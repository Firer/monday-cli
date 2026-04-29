import { describe, expect, it } from 'vitest';
import { globalFlagsInputSchema } from '../../../src/types/global-flags.js';

const ok = (input: unknown): ReturnType<typeof globalFlagsInputSchema.parse> =>
  globalFlagsInputSchema.parse(input);

describe('globalFlagsInputSchema — defaults', () => {
  it('all flags default to off / unset / sane numbers', () => {
    const out = ok({});
    expect(out).toMatchObject({
      json: false,
      table: false,
      full: false,
      minimal: false,
      quiet: false,
      verbose: false,
      color: true,
      noCache: false,
      dryRun: false,
      yes: false,
      retry: 3,
    });
    expect(out.output).toBeUndefined();
    expect(out.width).toBeUndefined();
    expect(out.columns).toBeUndefined();
    expect(out.profile).toBeUndefined();
    expect(out.apiVersion).toBeUndefined();
    expect(out.timeout).toBeUndefined();
  });
});

describe('globalFlagsInputSchema — output format', () => {
  it.each(['json', 'table', 'text', 'ndjson'] as const)(
    'accepts --output %s',
    (fmt) => {
      expect(ok({ output: fmt }).output).toBe(fmt);
    },
  );

  it('rejects an unknown --output value', () => {
    expect(() => ok({ output: 'yaml' })).toThrow();
  });

  it('--json and --table are mutually exclusive', () => {
    expect(() => ok({ json: true, table: true })).toThrow(
      /mutually exclusive/u,
    );
  });

  it('--full has no effect with --json — flagged as a usage error', () => {
    expect(() => ok({ full: true, json: true })).toThrow(/--full.*--json/u);
  });
});

describe('globalFlagsInputSchema — verbosity', () => {
  it('--quiet and --verbose are mutually exclusive', () => {
    expect(() => ok({ quiet: true, verbose: true })).toThrow(
      /mutually exclusive/u,
    );
  });

  it('--minimal flips the minimal field', () => {
    expect(ok({ minimal: true }).minimal).toBe(true);
  });
});

describe('globalFlagsInputSchema — colour', () => {
  it('color defaults true (commander --no-color flips it false)', () => {
    expect(ok({}).color).toBe(true);
    expect(ok({ color: false }).color).toBe(false);
  });
});

describe('globalFlagsInputSchema — caching', () => {
  it('--no-cache sets noCache true', () => {
    expect(ok({ noCache: true }).noCache).toBe(true);
  });
});

describe('globalFlagsInputSchema — profile (v0.3 deferral)', () => {
  it('accepts absent', () => {
    expect(ok({}).profile).toBeUndefined();
  });

  it('accepts the literal "default"', () => {
    expect(ok({ profile: 'default' }).profile).toBe('default');
  });

  it('rejects any other profile name with the v0.3 hint', () => {
    try {
      ok({ profile: 'work' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(String(err)).toMatch(/v0\.3/u);
    }
  });
});

describe('globalFlagsInputSchema — api version', () => {
  it('accepts a YYYY-MM date', () => {
    expect(ok({ apiVersion: '2026-01' }).apiVersion).toBe('2026-01');
  });

  it('rejects malformed values', () => {
    expect(() => ok({ apiVersion: 'spring-2026' })).toThrow();
    expect(() => ok({ apiVersion: '2026' })).toThrow();
    expect(() => ok({ apiVersion: '2026-1' })).toThrow();
  });
});

describe('globalFlagsInputSchema — numeric coercion', () => {
  it('coerces --timeout from string', () => {
    expect(ok({ timeout: '5000' }).timeout).toBe(5000);
  });

  it('rejects non-positive timeouts', () => {
    expect(() => ok({ timeout: '0' })).toThrow();
    expect(() => ok({ timeout: '-1' })).toThrow();
  });

  it('coerces --retry from string', () => {
    expect(ok({ retry: '5' }).retry).toBe(5);
  });

  it('accepts retry=0 (caller opts out)', () => {
    expect(ok({ retry: 0 }).retry).toBe(0);
  });

  it('rejects negative --retry', () => {
    expect(() => ok({ retry: '-1' })).toThrow();
  });

  it('coerces --width from string', () => {
    expect(ok({ width: '120' }).width).toBe(120);
  });

  it('rejects non-positive --width', () => {
    expect(() => ok({ width: '0' })).toThrow();
  });
});

describe('globalFlagsInputSchema — columns', () => {
  it('accepts a string array', () => {
    expect(ok({ columns: ['id', 'name'] }).columns).toEqual(['id', 'name']);
  });

  it('rejects empty-string entries', () => {
    expect(() => ok({ columns: ['id', ''] })).toThrow();
  });
});

describe('globalFlagsInputSchema — destructive flags', () => {
  it('--dry-run flips dryRun', () => {
    expect(ok({ dryRun: true }).dryRun).toBe(true);
  });

  it('--yes flips yes', () => {
    expect(ok({ yes: true }).yes).toBe(true);
  });
});

describe('globalFlagsInputSchema — strictness', () => {
  it("rejects unknown keys (catches typo'd flags before they reach commands)", () => {
    expect(() => ok({ verbosee: true })).toThrow();
  });
});
