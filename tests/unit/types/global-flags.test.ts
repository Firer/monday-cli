import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  globalFlagsRawSchema,
  parseGlobalFlags,
  type GlobalFlags,
} from '../../../src/types/global-flags.js';
import { UsageError } from '../../../src/utils/errors.js';

/**
 * Build a commander `program` with the same option surface as
 * `cli/run.ts`. The schema/normaliser must consume *real* commander
 * output (the bug Codex caught was hand-shaping objects that never
 * matched what commander actually emits), so every flag test runs
 * argv → commander → schema → normalised flags.
 */
const buildProgram = (): Command => {
  const program = new Command()
    .name('monday')
    .exitOverride()
    .option('--output <fmt>')
    .option('--json')
    .option('--table')
    .option('--full')
    .option('--width <n>')
    .option('--columns <list>')
    .option('--minimal')
    .option('-q, --quiet')
    .option('-v, --verbose')
    .option('--no-color')
    .option('--no-cache')
    .option('--profile <name>')
    .option('--api-version <v>')
    .option('--timeout <ms>')
    .option('--retry <n>')
    .option('--dry-run')
    .option('-y, --yes')
    .option('--body-file <path>');
  return program;
};

const runArgv = (argv: readonly string[]): GlobalFlags => {
  const program = buildProgram();
  program.parse([...argv], { from: 'user' });
  return parseGlobalFlags(program.opts(), {});
};

describe('parseGlobalFlags — defaults from a bare argv', () => {
  it('all flags default to off / unset / sane numbers', () => {
    const flags = runArgv([]);
    expect(flags).toMatchObject({
      json: false,
      table: false,
      full: false,
      minimal: false,
      quiet: false,
      verbose: false,
      noColor: false,
      noCache: false,
      dryRun: false,
      yes: false,
      retry: 3,
    });
    expect(flags.output).toBeUndefined();
    expect(flags.width).toBeUndefined();
    expect(flags.columns).toBeUndefined();
    expect(flags.profile).toBeUndefined();
    expect(flags.apiVersion).toBeUndefined();
    expect(flags.timeout).toBeUndefined();
    expect(flags.bodyFile).toBeUndefined();
  });
});

describe('parseGlobalFlags — output format', () => {
  it.each(['json', 'table', 'text', 'ndjson'] as const)(
    'accepts --output %s',
    (fmt) => {
      expect(runArgv(['--output', fmt]).output).toBe(fmt);
    },
  );

  it('rejects an unknown --output value', () => {
    expect(() => runArgv(['--output', 'yaml'])).toThrow(UsageError);
  });

  it('--json sets json:true', () => {
    expect(runArgv(['--json']).json).toBe(true);
  });

  it('--json and --table mutually exclusive', () => {
    expect(() => runArgv(['--json', '--table'])).toThrow(/mutually exclusive/u);
  });

  it('--full + --json flagged as a usage error', () => {
    expect(() => runArgv(['--full', '--json'])).toThrow(/--full/u);
  });
});

describe('parseGlobalFlags — verbosity', () => {
  it('--quiet and --verbose mutually exclusive', () => {
    expect(() => runArgv(['--quiet', '--verbose'])).toThrow(
      /mutually exclusive/u,
    );
  });

  it('--minimal flips minimal', () => {
    expect(runArgv(['--minimal']).minimal).toBe(true);
  });

  it('--quiet flips quiet', () => {
    expect(runArgv(['--quiet']).quiet).toBe(true);
  });

  it('--verbose flips verbose', () => {
    expect(runArgv(['--verbose']).verbose).toBe(true);
  });
});

describe('parseGlobalFlags — colour and cache (commander negation)', () => {
  it('default: noColor=false, noCache=false', () => {
    const flags = runArgv([]);
    expect(flags.noColor).toBe(false);
    expect(flags.noCache).toBe(false);
  });

  it('--no-color → noColor:true', () => {
    expect(runArgv(['--no-color']).noColor).toBe(true);
  });

  it('--no-cache → noCache:true', () => {
    expect(runArgv(['--no-cache']).noCache).toBe(true);
  });
});

describe('parseGlobalFlags — columns split', () => {
  it('splits --columns id,name,status on commas', () => {
    expect(runArgv(['--columns', 'id,name,status']).columns).toEqual([
      'id',
      'name',
      'status',
    ]);
  });

  it('trims whitespace and drops empty entries', () => {
    expect(runArgv(['--columns', ' id , , name ']).columns).toEqual([
      'id',
      'name',
    ]);
  });

  it('a single column is a single-element array, not a bare string', () => {
    expect(runArgv(['--columns', 'id']).columns).toEqual(['id']);
  });
});

describe('parseGlobalFlags — numeric coercion', () => {
  it('coerces --timeout from commander string', () => {
    expect(runArgv(['--timeout', '5000']).timeout).toBe(5000);
  });

  it('rejects non-positive --timeout', () => {
    expect(() => runArgv(['--timeout', '0'])).toThrow(UsageError);
    expect(() => runArgv(['--timeout', '-1'])).toThrow(UsageError);
  });

  it('coerces --retry from commander string', () => {
    expect(runArgv(['--retry', '5']).retry).toBe(5);
  });

  it('--retry 0 (caller opts out)', () => {
    expect(runArgv(['--retry', '0']).retry).toBe(0);
  });

  it('rejects negative --retry', () => {
    expect(() => runArgv(['--retry', '-1'])).toThrow(UsageError);
  });

  it('coerces --width from commander string', () => {
    expect(runArgv(['--width', '120']).width).toBe(120);
  });

  it('rejects non-positive --width', () => {
    expect(() => runArgv(['--width', '0'])).toThrow(UsageError);
  });
});

describe('parseGlobalFlags — api version', () => {
  it('accepts a YYYY-MM date', () => {
    expect(runArgv(['--api-version', '2026-01']).apiVersion).toBe('2026-01');
  });

  it('rejects malformed values', () => {
    expect(() => runArgv(['--api-version', 'spring-2026'])).toThrow();
    expect(() => runArgv(['--api-version', '2026'])).toThrow();
    expect(() => runArgv(['--api-version', '2026-1'])).toThrow();
  });
});

describe('parseGlobalFlags — profile (v0.3 deferral)', () => {
  it('absent profile → undefined', () => {
    expect(runArgv([]).profile).toBeUndefined();
  });

  it('--profile default → "default"', () => {
    expect(runArgv(['--profile', 'default']).profile).toBe('default');
  });

  it('--profile work → UsageError with v0.3 hint', () => {
    try {
      runArgv(['--profile', 'work']);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const ue = err as UsageError;
      expect(String(ue.details?.hint)).toMatch(/v0\.3/u);
    }
  });

  it('reads MONDAY_PROFILE env when --profile not set', () => {
    const program = buildProgram();
    program.parse([], { from: 'user' });
    expect(parseGlobalFlags(program.opts(), { MONDAY_PROFILE: 'default' }).profile)
      .toBe('default');
  });

  it('rejects MONDAY_PROFILE=work even without --profile', () => {
    const program = buildProgram();
    program.parse([], { from: 'user' });
    try {
      parseGlobalFlags(program.opts(), { MONDAY_PROFILE: 'work' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const ue = err as UsageError;
      expect(ue.message).toMatch(/profile "work"/u);
      expect(String(ue.details?.hint)).toMatch(/v0\.3/u);
    }
  });

  it('accepts agreement between --profile and MONDAY_PROFILE', () => {
    const program = buildProgram();
    program.parse(['--profile', 'default'], { from: 'user' });
    expect(parseGlobalFlags(program.opts(), { MONDAY_PROFILE: 'default' }).profile)
      .toBe('default');
  });

  it('rejects disagreement between --profile and MONDAY_PROFILE', () => {
    const program = buildProgram();
    program.parse(['--profile', 'default'], { from: 'user' });
    expect(() =>
      parseGlobalFlags(program.opts(), { MONDAY_PROFILE: 'other' }),
    ).toThrow(/conflicts/u);
  });
});

describe('parseGlobalFlags — file inputs (§4.4)', () => {
  it('--body-file', () => {
    expect(runArgv(['--body-file', '/tmp/body.md']).bodyFile).toBe(
      '/tmp/body.md',
    );
  });

  it('--body-file accepts the - sentinel for stdin', () => {
    expect(runArgv(['--body-file', '-']).bodyFile).toBe('-');
  });
});

describe('parseGlobalFlags — destructive flags', () => {
  it('--dry-run flips dryRun', () => {
    expect(runArgv(['--dry-run']).dryRun).toBe(true);
  });

  it('--yes / -y flip yes', () => {
    expect(runArgv(['--yes']).yes).toBe(true);
    expect(runArgv(['-y']).yes).toBe(true);
  });
});

describe('globalFlagsRawSchema — strictness', () => {
  it("rejects unknown keys (catches typo'd or out-of-band fields)", () => {
    expect(() =>
      globalFlagsRawSchema.parse({ verbosee: true }),
    ).toThrow();
  });
});
