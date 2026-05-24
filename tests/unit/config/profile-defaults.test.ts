/**
 * Unit tests for the pure profile-defaults resolver
 * (`src/config/profile-defaults.ts`, v0.12-M55-E). The resolver is
 * the load-bearing helper that drives both the Commander
 * application layer + `monday config get` — it pins the precedence
 * chain (env > profile_default > unset) and the `source`
 * discriminator semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  PROFILE_DEFAULT_ENV_BINDINGS,
  outputResultToFormat,
  resolveAllProfileDefaults,
  resolveProfileDefault,
} from '../../../src/config/profile-defaults.js';
import { ConfigError } from '../../../src/utils/errors.js';

describe('PROFILE_DEFAULT_ENV_BINDINGS', () => {
  it('maps each allowlist key to its documented env-var name (§7.2.1)', () => {
    expect(PROFILE_DEFAULT_ENV_BINDINGS).toEqual({
      board: 'MONDAY_BOARD',
      workspace: 'MONDAY_WORKSPACE',
      output: 'MONDAY_OUTPUT',
      concurrency: 'MONDAY_CONCURRENCY',
    });
  });
});

describe('resolveProfileDefault — precedence chain', () => {
  it('returns env_var source when MONDAY_<KEY> is set (env beats profile)', () => {
    const result = resolveProfileDefault('board', {
      env: { MONDAY_BOARD: '99999' },
      profileDefaults: { board: '12345' },
    });
    expect(result).toEqual({ source: 'env_var', value: '99999' });
  });

  it('returns profile_default source when env is unset but profile carries the key', () => {
    const result = resolveProfileDefault('board', {
      env: {},
      profileDefaults: { board: '12345' },
    });
    expect(result).toEqual({ source: 'profile_default', value: '12345' });
  });

  it('returns unset when neither env nor profile carries the key', () => {
    const result = resolveProfileDefault('board', {
      env: {},
      profileDefaults: {},
    });
    expect(result).toEqual({ source: 'unset' });
  });

  it('treats an empty-string env value as unset (length > 0 check, mirrors §7.2 selectProfile)', () => {
    const result = resolveProfileDefault('board', {
      env: { MONDAY_BOARD: '' },
      profileDefaults: { board: '12345' },
    });
    expect(result).toEqual({ source: 'profile_default', value: '12345' });
  });

  it('handles undefined profileDefaults (implicit-v1 path) — env still wins', () => {
    const result = resolveProfileDefault('board', {
      env: { MONDAY_BOARD: '99999' },
      profileDefaults: undefined,
    });
    expect(result).toEqual({ source: 'env_var', value: '99999' });
  });

  it('returns unset under implicit-v1 with no env (every consumer gets `null` resolved)', () => {
    const result = resolveProfileDefault('workspace', {
      env: {},
      profileDefaults: undefined,
    });
    expect(result).toEqual({ source: 'unset' });
  });
});

describe('resolveProfileDefault — env-var validation per key', () => {
  it('rejects malformed MONDAY_BOARD with config_error.wrong_defaults_type', () => {
    expect(() =>
      resolveProfileDefault('board', {
        env: { MONDAY_BOARD: 'not-numeric' },
        profileDefaults: undefined,
      }),
    ).toThrow(ConfigError);
  });

  it('rejects malformed MONDAY_CONCURRENCY (non-integer) with config_error', () => {
    expect(() =>
      resolveProfileDefault('concurrency', {
        env: { MONDAY_CONCURRENCY: 'foo' },
        profileDefaults: undefined,
      }),
    ).toThrow(ConfigError);
  });

  it('coerces a valid MONDAY_CONCURRENCY string to a number', () => {
    const result = resolveProfileDefault('concurrency', {
      env: { MONDAY_CONCURRENCY: '4' },
      profileDefaults: undefined,
    });
    expect(result).toEqual({ source: 'env_var', value: 4 });
  });

  it('rejects MONDAY_OUTPUT outside OUTPUT_FORMATS', () => {
    expect(() =>
      resolveProfileDefault('output', {
        env: { MONDAY_OUTPUT: 'yaml' },
        profileDefaults: undefined,
      }),
    ).toThrow(ConfigError);
  });

  it('accepts each of json|table|text|ndjson for MONDAY_OUTPUT', () => {
    for (const value of ['json', 'table', 'text', 'ndjson'] as const) {
      const result = resolveProfileDefault('output', {
        env: { MONDAY_OUTPUT: value },
        profileDefaults: undefined,
      });
      expect(result).toEqual({ source: 'env_var', value });
    }
  });

  it('error.details carries the `wrong_defaults_type` reason discriminator + env_var binding', () => {
    try {
      resolveProfileDefault('board', {
        env: { MONDAY_BOARD: 'bad' },
        profileDefaults: undefined,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const cfg = err as ConfigError;
      expect(cfg.details?.reason).toBe('wrong_defaults_type');
      expect(cfg.details?.env_var).toBe('MONDAY_BOARD');
    }
  });
});

describe('resolveAllProfileDefaults — convenience walker', () => {
  it('walks all 4 keys, producing a per-key result map', () => {
    const map = resolveAllProfileDefaults({
      env: { MONDAY_OUTPUT: 'table' },
      profileDefaults: { board: '12345', workspace: '7777' },
    });
    expect(map.board).toEqual({ source: 'profile_default', value: '12345' });
    expect(map.workspace).toEqual({
      source: 'profile_default',
      value: '7777',
    });
    expect(map.output).toEqual({ source: 'env_var', value: 'table' });
    expect(map.concurrency).toEqual({ source: 'unset' });
  });

  it('returns all-unset when env empty and profile undefined (pure implicit-v1)', () => {
    const map = resolveAllProfileDefaults({
      env: {},
      profileDefaults: undefined,
    });
    expect(map.board.source).toBe('unset');
    expect(map.workspace.source).toBe('unset');
    expect(map.output.source).toBe('unset');
    expect(map.concurrency.source).toBe('unset');
  });
});

describe('outputResultToFormat — narrowing helper for the program-level output gate', () => {
  it('returns undefined for unset results', () => {
    expect(outputResultToFormat({ source: 'unset' })).toBeUndefined();
  });

  it('returns the OutputFormat for env_var / profile_default results', () => {
    expect(
      outputResultToFormat({ source: 'env_var', value: 'table' }),
    ).toBe('table');
    expect(
      outputResultToFormat({ source: 'profile_default', value: 'json' }),
    ).toBe('json');
  });
});
