/**
 * Argv parser unit tests for `src/commands/completion.ts` v0.4-M33
 * pre-flight surface (cli-design §4.3 COMPLETION section + §13 v0.4
 * entry).
 *
 * Test matrix scope: schema-level parse-boundary surface only — the
 * closed 3-value `shell` enum + strict schema rejection of extra keys
 * + command-module metadata pins. Downstream behaviour (raw-script
 * emit on stdout, `--json` envelope wrap, format-flag rejection)
 * lives at the action body and ships at M33 IMPL via integration
 * tests.
 *
 * The argv schema is the ONLY shipped runtime surface at M33
 * pre-flight — the action body is c8-ignored and throws
 * `internal_error` with `details.deferred_to: 'v0.4-M33 IMPL'`
 * post-parse. The c8-ignored throw is NOT exercised by these tests
 * (per the M31/M32 pre-flight cadence — stub action bodies are
 * out-of-scope for pre-flight test coverage).
 */
import { describe, expect, it } from 'vitest';
import {
  COMPLETION_SHELLS,
  completionCommand,
} from '../../../src/commands/completion.js';
import { UsageError } from '../../../src/utils/errors.js';
import { parseArgv } from '../../../src/commands/parse-argv.js';

describe('completionCommand.inputSchema (M33 completion argv)', () => {
  describe('happy paths — closed 3-value shell enum', () => {
    it('parses shell: bash', () => {
      const parsed = parseArgv(completionCommand.inputSchema, {
        shell: 'bash',
      });
      expect(parsed.shell).toBe('bash');
    });

    it('parses shell: zsh', () => {
      const parsed = parseArgv(completionCommand.inputSchema, {
        shell: 'zsh',
      });
      expect(parsed.shell).toBe('zsh');
    });

    it('parses shell: fish', () => {
      const parsed = parseArgv(completionCommand.inputSchema, {
        shell: 'fish',
      });
      expect(parsed.shell).toBe('fish');
    });
  });

  describe('schema-level rejections', () => {
    it('rejects an unknown shell flavour', () => {
      expect(() =>
        parseArgv(completionCommand.inputSchema, { shell: 'powershell' }),
      ).toThrow(UsageError);
    });

    it('rejects an empty shell value', () => {
      expect(() =>
        parseArgv(completionCommand.inputSchema, { shell: '' }),
      ).toThrow(UsageError);
    });

    it('rejects a case-mismatched shell (Bash vs bash)', () => {
      // The closed enum is lowercase-only; the validator does NOT
      // case-fold. Mixed-case input is a parse-boundary rejection so
      // the contract surface is tight (M33 IMPL needn't carry
      // case-insensitive matching).
      expect(() =>
        parseArgv(completionCommand.inputSchema, { shell: 'Bash' }),
      ).toThrow(UsageError);
    });

    it('rejects a missing shell positional', () => {
      expect(() => parseArgv(completionCommand.inputSchema, {})).toThrow(
        UsageError,
      );
    });

    it('rejects a non-string shell value', () => {
      expect(() =>
        // @ts-expect-error — testing runtime type rejection
        parseArgv(completionCommand.inputSchema, { shell: 42 }),
      ).toThrow(UsageError);
    });

    it('rejects unknown keys (strict schema)', () => {
      expect(() =>
        parseArgv(completionCommand.inputSchema, {
          shell: 'bash',
          // @ts-expect-error — testing strict-mode rejection
          extra: 'oops',
        }),
      ).toThrow(UsageError);
    });
  });

  describe('command module metadata', () => {
    it('declares the canonical command name', () => {
      expect(completionCommand.name).toBe('completion');
    });

    it('marks itself idempotent (deterministic per shell flavour)', () => {
      expect(completionCommand.idempotent).toBe(true);
    });

    it('ships at least one example per shell flavour + a --json example', () => {
      // Three install examples (one per shell) + one --json example.
      expect(completionCommand.examples.length).toBeGreaterThanOrEqual(4);
    });

    it('exports the closed 3-value shell enum', () => {
      expect([...COMPLETION_SHELLS]).toEqual(['bash', 'zsh', 'fish']);
    });
  });
});
