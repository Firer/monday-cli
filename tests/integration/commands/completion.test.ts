/**
 * Integration tests for `monday completion <bash|zsh|fish>` (v0.4-M33
 * IMPL). The command is CLI-internal — no Monday API call, no
 * fixture transport, no env probe. The tests drive `run({argv, env,
 * stdout, stderr, ...})` exactly as the production binary does and
 * assert on the captured streams.
 *
 * Coverage axes (per v0.4-plan §9 M33 IMPL preconditions test-plan
 * bullet + the session prompt's §4.D enumeration):
 *
 *   (a) Default raw-bytes happy paths (3 — one per shell) — NO
 *       envelope on stdout; non-empty script; ends with newline;
 *       stderr empty.
 *   (b) `--json` envelope path (3 — one per shell) — §6 envelope
 *       with `data: { shell, script }`, `meta.source === 'none'`,
 *       `meta.cache_age_seconds === null`; the `data.script` field
 *       is byte-identical to the default-mode stdout.
 *   (c) Format-flag rejection (4) — `--table`, `--output table`,
 *       `--output text`, `--output ndjson` all surface
 *       `usage_error`.
 *   (d) Invalid shell flavour (1) — `monday completion powershell`
 *       surfaces `usage_error` with `details.issues[0].path ===
 *       'shell'` from the `parseArgv` boundary.
 *   (e) Missing positional (1) — `monday completion` rejected by
 *       commander's "missing required argument" path.
 *   (f) Script content sanity (4) — bash mentions
 *       `_monday_completion`; zsh mentions `compdef monday`; fish
 *       mentions `complete -c monday`; every script enumerates every
 *       registered top-level command name (registry-sync invariant).
 *   (g) MONDAY_OUTPUT env path (2) — `MONDAY_OUTPUT=json` opts INTO
 *       the envelope; `MONDAY_OUTPUT=table` rejects.
 *   (h) LEAK_CANARY redaction (3 — one per shell) — the script
 *       contains no occurrence of `MONDAY_API_TOKEN`'s literal
 *       value (the raw-bytes mode bypasses the standard
 *       redaction pass since it doesn't go through `emitSuccess`,
 *       so this test catches future drift where the templates
 *       accidentally interpolate an env value).
 */
import { describe, expect, it } from 'vitest';
import { run } from '../../../src/cli/run.js';
import { baseOptions, LEAK_CANARY } from '../helpers.js';
import { getCommandRegistry } from '../../../src/commands/index.js';
import { COMPLETION_SHELLS } from '../../../src/commands/completion.js';

interface ErrorEnvelope {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: {
      readonly issues?: readonly { readonly path: string }[];
    };
  };
}

interface JsonEnvelope {
  readonly ok: true;
  readonly data: { readonly shell: string; readonly script: string };
  readonly meta: {
    readonly schema_version: '1';
    readonly source: string;
    readonly cache_age_seconds: number | null;
  };
}

const parseError = (raw: string): ErrorEnvelope =>
  JSON.parse(raw) as ErrorEnvelope;

const parseSuccess = (raw: string): JsonEnvelope =>
  JSON.parse(raw) as JsonEnvelope;

describe('monday completion — default raw-bytes mode', () => {
  for (const shell of COMPLETION_SHELLS) {
    it(`emits a non-empty ${shell} script to stdout with NO envelope wrap`, async () => {
      const { options, captured } = baseOptions({
        argv: ['node', 'monday', 'completion', shell],
        // Force the pipe-context path (isTTY: false). The raw-bytes
        // carve-out should fire regardless of TTY state — verify.
        isTTY: false,
      });
      const result = await run(options);
      expect(result.exitCode).toBe(0);
      expect(captured.stderr()).toBe('');

      const out = captured.stdout();
      expect(out.length).toBeGreaterThan(0);
      expect(out.endsWith('\n')).toBe(true);

      // NO envelope on stdout — the script bytes are the payload.
      // The default envelope shape starts with `{"ok":true` (compact
      // JSON via `renderJson`); a script body does not match that.
      expect(out.startsWith('{"ok":')).toBe(false);
      expect(out).not.toContain('"meta"');
      expect(out).not.toContain('"schema_version"');
    });

    it(`emits the same ${shell} script under TTY context (carve-out is TTY-insensitive)`, async () => {
      const { options, captured } = baseOptions({
        argv: ['node', 'monday', 'completion', shell],
        isTTY: true,
      });
      const result = await run(options);
      expect(result.exitCode).toBe(0);
      const out = captured.stdout();
      expect(out.length).toBeGreaterThan(0);
      expect(out.endsWith('\n')).toBe(true);
      expect(out.startsWith('{"ok":')).toBe(false);
    });
  }
});

describe('monday completion — --json envelope path', () => {
  for (const shell of COMPLETION_SHELLS) {
    it(`wraps the ${shell} script in the §6 envelope`, async () => {
      const { options, captured } = baseOptions({
        argv: ['node', 'monday', 'completion', shell, '--json'],
      });
      const result = await run(options);
      expect(result.exitCode).toBe(0);
      expect(captured.stderr()).toBe('');

      const env = parseSuccess(captured.stdout());
      expect(env.ok).toBe(true);
      expect(env.data.shell).toBe(shell);
      expect(typeof env.data.script).toBe('string');
      expect(env.data.script.length).toBeGreaterThan(0);
      expect(env.meta.schema_version).toBe('1');
      expect(env.meta.source).toBe('none');
      expect(env.meta.cache_age_seconds).toBeNull();
    });

    it(`--json data.script is byte-identical to the default-mode stdout for ${shell}`, async () => {
      // Run twice — once default, once --json — and assert the
      // script bytes round-trip exactly. Catches future drift where
      // the envelope path accidentally normalises whitespace.
      const defaultRun = baseOptions({
        argv: ['node', 'monday', 'completion', shell],
      });
      await run(defaultRun.options);
      const rawStdout = defaultRun.captured.stdout();

      const jsonRun = baseOptions({
        argv: ['node', 'monday', 'completion', shell, '--json'],
      });
      await run(jsonRun.options);
      const env = parseSuccess(jsonRun.captured.stdout());

      expect(env.data.script).toBe(rawStdout);
    });

    it(`accepts --output json for ${shell} as a synonym of --json`, async () => {
      const { options, captured } = baseOptions({
        argv: ['node', 'monday', 'completion', shell, '--output', 'json'],
      });
      const result = await run(options);
      expect(result.exitCode).toBe(0);
      const env = parseSuccess(captured.stdout());
      expect(env.data.shell).toBe(shell);
      expect(env.data.script.length).toBeGreaterThan(0);
    });
  }
});

describe('monday completion — format-flag rejection', () => {
  it('rejects --table as usage_error', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'bash', '--table'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = parseError(captured.stderr());
    expect(env.error.code).toBe('usage_error');
    expect(env.error.message).toMatch(/not applicable/iu);
  });

  it('rejects --output table as usage_error', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'bash', '--output', 'table'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = parseError(captured.stderr());
    expect(env.error.code).toBe('usage_error');
    expect(env.error.message).toMatch(/not applicable/iu);
  });

  it('rejects --output text as usage_error', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'bash', '--output', 'text'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = parseError(captured.stderr());
    expect(env.error.code).toBe('usage_error');
  });

  it('rejects --output ndjson as usage_error', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'bash', '--output', 'ndjson'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = parseError(captured.stderr());
    expect(env.error.code).toBe('usage_error');
  });
});

describe('monday completion — argv parse-boundary rejections', () => {
  it('rejects an unknown shell flavour with usage_error + details.issues[0].path === "shell"', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'powershell'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = parseError(captured.stderr());
    expect(env.error.code).toBe('usage_error');
    expect(env.error.details?.issues?.[0]?.path).toBe('shell');
  });

  it('argv parses BEFORE the format-flag rejection — invalid shell + --table surfaces the shell rejection', async () => {
    // M31 pre-flight round-1 P2-2 invariant: argv parses BEFORE any
    // downstream format-flag-rejection or stub throw fires, so the
    // most specific failure (invalid shell flavour) surfaces first.
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'floppy', '--table'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = parseError(captured.stderr());
    expect(env.error.code).toBe('usage_error');
    expect(env.error.details?.issues?.[0]?.path).toBe('shell');
  });

  it('rejects a missing shell positional via commander', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion'],
    });
    const result = await run(options);
    // Commander emits a usage_error envelope when a required
    // positional is missing (exit 1).
    expect(result.exitCode).toBe(1);
    expect(captured.stderr()).not.toBe('');
  });
});

describe('monday completion — script content sanity', () => {
  it('bash script contains _monday_completion + complete -F', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'bash'],
    });
    await run(options);
    const script = captured.stdout();
    expect(script).toContain('_monday_completion()');
    expect(script).toContain('complete -F _monday_completion monday');
  });

  it('zsh script contains the #compdef directive + _monday function', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'zsh'],
    });
    await run(options);
    const script = captured.stdout();
    expect(script).toContain('#compdef monday');
    expect(script).toContain('_monday()');
  });

  it('fish script contains complete -c monday invocations + file-completion disable', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'fish'],
    });
    await run(options);
    const script = captured.stdout();
    expect(script).toContain('complete -c monday -f');
    expect(script).toContain('__fish_use_subcommand');
  });

  it('every shell script enumerates every registered top-level noun-or-verb name', async () => {
    // Registry-sync invariant: each script must mention each
    // top-level command's name verbatim so completions stay current
    // with the registry as new verbs land at v0.5+.
    //
    // Derive expected names from the registry: a CommandModule's
    // `name` is dotted (`'item.get'`); the top-level segment is the
    // noun (or top-level verb when there's no dot).
    const tops = new Set<string>();
    for (const mod of getCommandRegistry()) {
      const first = mod.name.split('.')[0];
      if (first !== undefined && first.length > 0) {
        tops.add(first);
      }
    }
    for (const shell of COMPLETION_SHELLS) {
      const { options, captured } = baseOptions({
        argv: ['node', 'monday', 'completion', shell],
      });
      await run(options);
      const script = captured.stdout();
      for (const name of tops) {
        // The token may appear inside a longer word in some shell
        // syntax (e.g. `_monday_completion` mentions `monday`); we
        // assert presence via a word boundary by surrounding with
        // shell-safe context (single-quote, space, or the start of
        // a complete -a 'name').
        expect(
          script.includes(`'${name}'`) ||
            script.includes(` ${name} `) ||
            script.includes(`'${name} `) ||
            script.includes(` ${name}'`),
        ).toBe(true);
      }
    }
  });
});

describe('monday completion — MONDAY_OUTPUT env opt-in', () => {
  it('MONDAY_OUTPUT=json opts INTO the envelope path even without --json', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'bash'],
      env: { MONDAY_OUTPUT: 'json' },
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    const env = parseSuccess(captured.stdout());
    expect(env.ok).toBe(true);
    expect(env.data.shell).toBe('bash');
  });

  it('MONDAY_OUTPUT=table rejects as usage_error', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'completion', 'bash'],
      env: { MONDAY_OUTPUT: 'table' },
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = parseError(captured.stderr());
    expect(env.error.code).toBe('usage_error');
    expect(env.error.message).toMatch(/MONDAY_OUTPUT|not applicable/iu);
  });
});

describe('monday completion — LEAK_CANARY redaction discipline', () => {
  // The default raw-bytes mode bypasses `emitSuccess` (and its
  // redactor pass) entirely. The script-emit code path uses ONLY
  // commander's compile-time command tree + option names — no env
  // values get interpolated. This LEAK_CANARY canary catches
  // future drift where a template accidentally pulls
  // `process.env.MONDAY_API_TOKEN` or similar.
  for (const shell of COMPLETION_SHELLS) {
    it(`${shell} script does not leak the MONDAY_API_TOKEN literal`, async () => {
      const { options, captured } = baseOptions({
        argv: ['node', 'monday', 'completion', shell],
        env: { MONDAY_API_TOKEN: LEAK_CANARY },
      });
      const result = await run(options);
      expect(result.exitCode).toBe(0);
      const out = captured.stdout();
      const err = captured.stderr();
      expect(out).not.toContain(LEAK_CANARY);
      expect(err).not.toContain(LEAK_CANARY);
    });
  }
});
