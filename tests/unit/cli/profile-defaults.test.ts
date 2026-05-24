/**
 * Unit tests for the Commander application layer
 * (`src/cli/profile-defaults.ts`, v0.12-M55-E). Drives synthetic
 * Commander trees to verify:
 *
 *   1. The applicability registry only injects into commands that
 *      EXPLICITLY appear in the allowlist (Codex consultation's
 *      load-bearing innovation per (c′) — mutually-exclusive and
 *      contextually-gated commands MUST NOT receive defaults).
 *   2. The precondition gate (item.update --concurrency only when
 *      --continue-on-error is true) blocks injection on the bulk-
 *      fail-fast path.
 *   3. Explicit CLI flag always wins (precedence chain (1) in
 *      §7.2.1).
 *   4. Program-level --output injection only fires when ALL of
 *      --json, --table, --output, MONDAY_OUTPUT are absent.
 */
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  applyAllProfileDefaults,
  applyPerCommandProfileDefaults,
  applyProgramOutputDefault,
} from '../../../src/cli/profile-defaults.js';

/**
 * Builds a synthetic Commander tree mirroring the production shape:
 *   monday <noun> <verb>
 * Returns the parent (program), the action command (subcommand),
 * and the noun-level parent. Pre-parses the action with `from: 'user'`
 * to populate Commander's internal state.
 *
 * Supports two option-arity shapes:
 *   - `argName: 'x'` → declares `--flag <x>` (value-bearing).
 *   - `multiple: true` → declares a `--flag <v>` with a collector
 *     that pushes onto a starting `[]`, mirroring the
 *     `item update` / `item clear` `--where` shape that the bulk
 *     precondition reads (`getOptionValue('where').length > 0`).
 *
 * `positionalSpec` declares Commander positionals (e.g. `[itemId]`)
 * so the `update.list` precondition (which reads `cmd.args.length`)
 * can be exercised with + without a positional.
 */
const buildSyntheticTree = (
  noun: string,
  verb: string,
  options: readonly { flag: string; argName?: string; multiple?: boolean }[],
  argv: readonly string[] = [],
  positionalSpec = '',
): { program: Command; actionCommand: Command } => {
  const program = new Command();
  program.exitOverride();
  program.option('--output <fmt>');
  program.option('--json');
  program.option('--table');
  const nounCmd = program.command(noun);
  const verbDecl =
    positionalSpec.length > 0 ? `${verb} ${positionalSpec}` : verb;
  const verbCmd = nounCmd.command(verbDecl);
  for (const opt of options) {
    if (opt.multiple === true) {
      verbCmd.option(
        `${opt.flag} <${opt.argName ?? 'val'}>`,
        '',
        (value: string, prev: string[]) => [...prev, value],
        [] as string[],
      );
      continue;
    }
    const decl =
      opt.argName !== undefined
        ? `${opt.flag} <${opt.argName}>`
        : opt.flag;
    verbCmd.option(decl);
  }
  verbCmd.action(() => {
    // no-op — we apply defaults BEFORE the action.
  });
  program.parse([noun, verb, ...argv], { from: 'user' });
  return { program, actionCommand: verbCmd };
};

describe('applyPerCommandProfileDefaults — applicability registry', () => {
  it('injects --board on item.list when profile carries board + flag absent', () => {
    const { program, actionCommand } = buildSyntheticTree('item', 'list', [
      { flag: '--board', argName: 'bid' },
    ]);
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBe('987654');
    expect(actionCommand.getOptionValueSource('board')).toBe('config');
  });

  it('explicit --board flag wins over profile default (precedence chain (1))', () => {
    const { program, actionCommand } = buildSyntheticTree(
      'item',
      'list',
      [{ flag: '--board', argName: 'bid' }],
      ['--board', '11111'],
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBe('11111');
    expect(actionCommand.getOptionValueSource('board')).toBe('cli');
  });

  it('item.create — injects --board when --parent is absent (regular item path)', () => {
    const { program, actionCommand } = buildSyntheticTree(
      'item',
      'create',
      [
        { flag: '--board', argName: 'bid' },
        { flag: '--parent', argName: 'iid' },
      ],
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBe('987654');
  });

  it('item.create — SKIPS --board injection when --parent is present (mutex with subitem path)', () => {
    // item.create's --parent / --board mutual exclusion is enforced
    // at the verb level (item/create.ts:432-438). Blind injection
    // would break subitem creation by adding --board to the parent
    // dispatch. The precondition guards against this.
    const { program, actionCommand } = buildSyntheticTree(
      'item',
      'create',
      [
        { flag: '--board', argName: 'bid' },
        { flag: '--parent', argName: 'iid' },
      ],
      ['--parent', '99'],
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBeUndefined();
  });

  it('item.update bulk shape — injects --board when --where is non-empty', () => {
    const { program, actionCommand } = buildSyntheticTree(
      'item',
      'update',
      [
        { flag: '--board', argName: 'bid' },
        { flag: '--where', argName: 'expr', multiple: true },
        { flag: '--filter-json', argName: 'json' },
      ],
      ['--where', 'status=Done'],
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBe('987654');
  });

  it('item.update single-item shape — SKIPS --board injection (avoids silently overriding item-derived board)', () => {
    // Without --where / --filter-json, the verb is in single-item
    // shape (item.board derived from item lookup). Injecting a
    // profile board would silently change resolution. Precondition
    // mirrors item/update.ts:303 hasFilter detection.
    const { program, actionCommand } = buildSyntheticTree(
      'item',
      'update',
      [
        { flag: '--board', argName: 'bid' },
        { flag: '--where', argName: 'expr', multiple: true },
        { flag: '--filter-json', argName: 'json' },
      ],
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBeUndefined();
  });

  it('item.update bulk shape — injects --board when --filter-json is set', () => {
    const { program, actionCommand } = buildSyntheticTree(
      'item',
      'update',
      [
        { flag: '--board', argName: 'bid' },
        { flag: '--where', argName: 'expr', multiple: true },
        { flag: '--filter-json', argName: 'json' },
      ],
      ['--filter-json', '{"rules":[]}'],
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBe('987654');
  });

  it('item.clear bulk shape — injects --board on --where', () => {
    const { program, actionCommand } = buildSyntheticTree(
      'item',
      'clear',
      [
        { flag: '--board', argName: 'bid' },
        { flag: '--where', argName: 'expr', multiple: true },
        { flag: '--filter-json', argName: 'json' },
      ],
      ['--where', 'status=Done'],
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBe('987654');
  });

  it('item.clear single-item shape — SKIPS --board injection', () => {
    const { program, actionCommand } = buildSyntheticTree(
      'item',
      'clear',
      [
        { flag: '--board', argName: 'bid' },
        { flag: '--where', argName: 'expr', multiple: true },
        { flag: '--filter-json', argName: 'json' },
      ],
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBeUndefined();
  });

  it('update.list board-scan shape — injects --board when no positional itemId', () => {
    const { program, actionCommand } = buildSyntheticTree(
      'update',
      'list',
      [{ flag: '--board', argName: 'bid' }],
      [],
      '[itemId]',
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBe('987654');
  });

  it('update.list single-item shape — SKIPS --board injection (XOR with itemId positional)', () => {
    const { program, actionCommand } = buildSyntheticTree(
      'update',
      'list',
      [{ flag: '--board', argName: 'bid' }],
      ['5001'],
      '[itemId]',
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654' },
    });
    expect(actionCommand.getOptionValue('board')).toBeUndefined();
  });

  it('item.update --concurrency injects ONLY when --continue-on-error is true (precondition gate)', () => {
    // Without --continue-on-error: precondition false → no injection.
    {
      const { program, actionCommand } = buildSyntheticTree(
        'item',
        'update',
        [
          { flag: '--concurrency', argName: 'n' },
          { flag: '--continue-on-error' },
        ],
      );
      applyPerCommandProfileDefaults({
        program,
        actionCommand,
        env: {},
        profileDefaults: { concurrency: 4 },
      });
      expect(actionCommand.getOptionValue('concurrency')).toBeUndefined();
    }
    // With --continue-on-error: precondition true → injection fires.
    {
      const { program, actionCommand } = buildSyntheticTree(
        'item',
        'update',
        [
          { flag: '--concurrency', argName: 'n' },
          { flag: '--continue-on-error' },
        ],
        ['--continue-on-error'],
      );
      applyPerCommandProfileDefaults({
        program,
        actionCommand,
        env: {},
        profileDefaults: { concurrency: 4 },
      });
      expect(actionCommand.getOptionValue('concurrency')).toBe(4);
    }
  });

  it('injects --workspace on doc.create-in-workspace', () => {
    const { program, actionCommand } = buildSyntheticTree(
      'doc',
      'create-in-workspace',
      [{ flag: '--workspace', argName: 'wid' }],
    );
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { workspace: '7777' },
    });
    expect(actionCommand.getOptionValue('workspace')).toBe('7777');
  });

  it('env var still wins over profile default (precedence chain (2))', () => {
    const { program, actionCommand } = buildSyntheticTree('item', 'list', [
      { flag: '--board', argName: 'bid' },
    ]);
    applyPerCommandProfileDefaults({
      program,
      actionCommand,
      env: { MONDAY_BOARD: '99999' },
      profileDefaults: { board: '12345' },
    });
    expect(actionCommand.getOptionValue('board')).toBe('99999');
  });

  it('skips injection cleanly on a top-level command (no noun parent)', () => {
    const program = new Command();
    program.exitOverride();
    const topLevel = program.command('schema');
    topLevel.option('--board <bid>');
    topLevel.action(() => {
      // no-op — we don't drive the action body in this test.
    });
    program.parse(['schema'], { from: 'user' });
    expect(() =>
      { applyPerCommandProfileDefaults({
        program,
        actionCommand: topLevel,
        env: {},
        profileDefaults: { board: '987654' },
      }); },
    ).not.toThrow();
    expect(topLevel.getOptionValue('board')).toBeUndefined();
  });
});

describe('applyProgramOutputDefault — global --output injection gate', () => {
  const buildProgram = (argv: readonly string[]): Command => {
    const prog = new Command();
    prog.exitOverride();
    prog.option('--output <fmt>');
    prog.option('--json');
    prog.option('--table');
    prog.command('noop').action(() => {
      // no-op.
    });
    prog.parse([...argv, 'noop'], { from: 'user' });
    return prog;
  };

  it('injects profile output when no shorthand / no flag / no env', () => {
    const prog = buildProgram([]);
    applyProgramOutputDefault(prog, {}, { output: 'table' });
    expect(prog.opts().output).toBe('table');
  });

  it('does NOT override --json shorthand (select.ts priority preserved)', () => {
    const prog = buildProgram(['--json']);
    applyProgramOutputDefault(prog, {}, { output: 'table' });
    expect(prog.opts().output).toBeUndefined();
  });

  it('does NOT override --table shorthand', () => {
    const prog = buildProgram(['--table']);
    applyProgramOutputDefault(prog, {}, { output: 'json' });
    expect(prog.opts().output).toBeUndefined();
  });

  it('does NOT override explicit --output flag', () => {
    const prog = buildProgram(['--output', 'ndjson']);
    applyProgramOutputDefault(prog, {}, { output: 'table' });
    expect(prog.opts().output).toBe('ndjson');
  });

  it('does NOT override MONDAY_OUTPUT env (env wins per env > profile precedence)', () => {
    const prog = buildProgram([]);
    applyProgramOutputDefault(
      prog,
      { MONDAY_OUTPUT: 'text' },
      { output: 'table' },
    );
    // The output flag itself stays unset on program.opts() — the
    // env-level resolution still happens downstream in select.ts.
    // The gate just prevents profile from overriding env.
    expect(prog.opts().output).toBeUndefined();
  });

  it('no-op when profileDefaults.output is unset', () => {
    const prog = buildProgram([]);
    applyProgramOutputDefault(prog, {}, undefined);
    expect(prog.opts().output).toBeUndefined();
  });
});

describe('lazy env-validation (Codex IMPL R1 P1 regression guard)', () => {
  it('per-command: malformed MONDAY_BOARD does NOT crash a command outside the board registry (e.g. doc.import-html)', () => {
    // applyPerCommandProfileDefaults must NOT validate every env
    // binding eagerly. doc.import-html only needs `workspace` from
    // the registry; the malformed `MONDAY_BOARD` env should not
    // surface a config_error here.
    const { program, actionCommand } = buildSyntheticTree(
      'doc',
      'import-html',
      [{ flag: '--workspace', argName: 'wid' }],
    );
    expect(() =>
      { applyPerCommandProfileDefaults({
        program,
        actionCommand,
        env: { MONDAY_BOARD: 'not-numeric' },
        profileDefaults: { workspace: '7777' },
      }); },
    ).not.toThrow();
    expect(actionCommand.getOptionValue('workspace')).toBe('7777');
  });

  it('per-command: malformed MONDAY_CONCURRENCY does NOT crash item.list (only board is in its registry slot)', () => {
    const { program, actionCommand } = buildSyntheticTree('item', 'list', [
      { flag: '--board', argName: 'bid' },
    ]);
    expect(() =>
      { applyPerCommandProfileDefaults({
        program,
        actionCommand,
        env: { MONDAY_CONCURRENCY: 'foo' },
        profileDefaults: { board: '12345' },
      }); },
    ).not.toThrow();
    expect(actionCommand.getOptionValue('board')).toBe('12345');
  });

  it('program-level output gate: malformed MONDAY_BOARD does NOT crash output-default resolution', () => {
    const prog = new Command();
    prog.exitOverride();
    prog.option('--output <fmt>');
    prog.option('--json');
    prog.option('--table');
    prog.command('noop').action(() => {
      // no-op.
    });
    prog.parse(['noop'], { from: 'user' });
    expect(() =>
      { applyProgramOutputDefault(
        prog,
        { MONDAY_BOARD: 'bad' },
        { output: 'table' },
      ); },
    ).not.toThrow();
    expect(prog.opts().output).toBe('table');
  });

  it('per-command: a malformed env for the registry-relevant key STILL surfaces (e.g. MONDAY_BOARD=bad on item.list)', () => {
    // The lazy fix doesn't suppress errors on the key being
    // resolved — only avoids touching unrelated keys.
    const { program, actionCommand } = buildSyntheticTree('item', 'list', [
      { flag: '--board', argName: 'bid' },
    ]);
    expect(() =>
      { applyPerCommandProfileDefaults({
        program,
        actionCommand,
        env: { MONDAY_BOARD: 'not-numeric' },
        profileDefaults: { board: '12345' },
      }); },
    ).toThrow();
  });
});

describe('applyAllProfileDefaults — composed entry point', () => {
  it('runs both per-command + program-level injection in one call', () => {
    const { program, actionCommand } = buildSyntheticTree('item', 'list', [
      { flag: '--board', argName: 'bid' },
    ]);
    applyAllProfileDefaults({
      program,
      actionCommand,
      env: {},
      profileDefaults: { board: '987654', output: 'ndjson' },
    });
    expect(actionCommand.getOptionValue('board')).toBe('987654');
    expect(program.opts().output).toBe('ndjson');
  });
});
