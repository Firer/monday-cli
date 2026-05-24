/**
 * Unit tests for the parse-boundary helpers shared by the 3
 * defaults companion verbs (`src/commands/config/_shared.ts`,
 * v0.12-M55-E):
 *
 *   - `validateProfileDefaultsKey` — allowlist check that lands as
 *     `config_error` (exit 3) per D3 case (a) + D5, NOT
 *     `usage_error` (exit 1) the way `parseArgv` would otherwise
 *     wrap a ZodError. The split is load-bearing for the spec.
 *   - `coerceValueForKey` — per-key coercion that throws
 *     `config_error.wrong_defaults_type` per D3 case (b) + D5.
 */
import { describe, expect, it } from 'vitest';
import {
  coerceValueForKey,
  validateProfileDefaultsKey,
} from '../../../../src/commands/config/_shared.js';
import { ConfigError } from '../../../../src/utils/errors.js';

describe('validateProfileDefaultsKey', () => {
  it('accepts each of the 4 allowlist keys', () => {
    expect(validateProfileDefaultsKey('board')).toBe('board');
    expect(validateProfileDefaultsKey('workspace')).toBe('workspace');
    expect(validateProfileDefaultsKey('output')).toBe('output');
    expect(validateProfileDefaultsKey('concurrency')).toBe('concurrency');
  });

  it('rejects non-allowlist keys with config_error.unknown_defaults_key', () => {
    try {
      validateProfileDefaultsKey('api_token_env');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const cfg = err as ConfigError;
      expect(cfg.details?.reason).toBe('unknown_defaults_key');
      expect(cfg.details?.key).toBe('api_token_env');
      expect(cfg.details?.allowed_keys).toEqual([
        'board',
        'workspace',
        'output',
        'concurrency',
      ]);
    }
  });

  it('rejects an empty-string key with config_error (still unknown)', () => {
    expect(() => validateProfileDefaultsKey('')).toThrow(ConfigError);
  });

  it('the rejection hint nudges agents toward TOML hand-edit / auth login (NOT pasting tokens into `monday config set`)', () => {
    try {
      validateProfileDefaultsKey('api_token');
      throw new Error('expected throw');
    } catch (err) {
      const cfg = err as ConfigError;
      // Token-storage discipline preserved in user-facing prose.
      expect(cfg.details?.hint).toMatch(/auth login|hand-TOML/);
    }
  });
});

describe('coerceValueForKey — per-key shape rules', () => {
  it('board: passes a numeric ID through as string', () => {
    expect(coerceValueForKey('board', '12345')).toBe('12345');
  });

  it('board: rejects non-numeric with config_error.wrong_defaults_type', () => {
    try {
      coerceValueForKey('board', 'abc');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).details?.reason).toBe('wrong_defaults_type');
    }
  });

  it('workspace: passes numeric through, rejects non-numeric', () => {
    expect(coerceValueForKey('workspace', '7777')).toBe('7777');
    expect(() => coerceValueForKey('workspace', 'wsp')).toThrow(ConfigError);
  });

  it('output: accepts each OUTPUT_FORMAT, rejects others', () => {
    for (const v of ['json', 'table', 'text', 'ndjson']) {
      expect(coerceValueForKey('output', v)).toBe(v);
    }
    expect(() => coerceValueForKey('output', 'yaml')).toThrow(ConfigError);
  });

  it('concurrency: coerces a numeric string to a positive integer', () => {
    expect(coerceValueForKey('concurrency', '4')).toBe(4);
    expect(coerceValueForKey('concurrency', '1')).toBe(1);
  });

  it('concurrency: rejects zero / negative / float / non-numeric', () => {
    expect(() => coerceValueForKey('concurrency', '0')).toThrow(ConfigError);
    expect(() => coerceValueForKey('concurrency', '-1')).toThrow(ConfigError);
    expect(() => coerceValueForKey('concurrency', '1.5')).toThrow(ConfigError);
    expect(() => coerceValueForKey('concurrency', 'four')).toThrow(ConfigError);
  });
});
