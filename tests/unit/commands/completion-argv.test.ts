/**
 * Argv parser unit tests for `src/commands/completion.ts` v0.4-M33
 * (cli-design §4.3 COMPLETION section + §13 v0.4 entry).
 *
 * Test matrix scope: schema-level parse-boundary surface only — the
 * closed 3-value `shell` enum + strict schema rejection of extra keys
 * + command-module metadata pins. Downstream behaviour (raw-script
 * emit on stdout, `--json` envelope wrap, format-flag rejection,
 * `MONDAY_OUTPUT` env opt-in, per-shell script content sanity) lives
 * at the action body and is covered by the integration suite at
 * `tests/integration/commands/completion.test.ts`.
 *
 * The argv schema shipped byte-identical pre-flight → IMPL (only
 * the action body changed at IMPL — the schema, the
 * `CommandModule` metadata, and the strict-extras rejection are
 * stable across the milestone). These tests cover that stable
 * surface independent of the IMPL feat.
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
      // the contract surface is tight (the IMPL doesn't carry
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
