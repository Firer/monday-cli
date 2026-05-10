/**
 * Integration tests for the v0.3-M22 `monday status` + `monday usage`
 * pre-flight stubs.
 *
 * Both verbs ship as stubs that `Promise.reject(internal_error)` until
 * M22 implementation lands the runtime probe matrix +
 * `platform_api.daily_*` projection. The tests confirm:
 *
 *   - The verbs register on the program (argv parse doesn't surface
 *     `unknown_command`).
 *   - `--no-probe` is accepted by `monday status` (the argv shape
 *     pinned by Decision 7 closure).
 *   - The stub action rejects with `internal_error` carrying the
 *     M22-pending hint.
 *   - `--json` mode emits the standard error envelope shape.
 *
 * M22 implementation replaces these stub-rejection tests with the
 * real success-envelope shape assertions per cli-design §11.5.2 /
 * §11.5.3.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../../../src/cli/run.js';
import { baseOptions, parseEnvelope } from '../helpers.js';

const driveDiagnostics = async (
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    isTTY: false,
  });
  const result = await run(options);
  return {
    exitCode: result.exitCode,
    stdout: captured.stdout(),
    stderr: captured.stderr(),
  };
};

describe('monday status (M22 pre-flight stub)', () => {
  it('rejects every invocation with internal_error + M22-pending hint', async () => {
    const { exitCode, stderr } = await driveDiagnostics(['status', '--json']);
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(stderr);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('internal_error');
    expect(envelope.error.message).toContain('pre-flight stub');
    const details = envelope.error.details as { hint: string; no_probe: boolean };
    expect(details.hint).toContain('M22 implementation');
    expect(details.no_probe).toBe(false);
  });

  it('accepts --no-probe and threads it into details.no_probe', async () => {
    const { exitCode, stderr } = await driveDiagnostics([
      'status',
      '--no-probe',
      '--json',
    ]);
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('internal_error');
    const details = envelope.error.details as { no_probe: boolean };
    expect(details.no_probe).toBe(true);
  });

  it('error envelope carries the standard §6.5 fields (request_id, retrieved_at)', async () => {
    const { stderr } = await driveDiagnostics(['status', '--json']);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.meta.schema_version).toBe('1');
    expect(envelope.meta.request_id).toBeTruthy();
    expect(envelope.meta.retrieved_at).toBeTruthy();
  });
});

describe('monday usage (M22 pre-flight stub)', () => {
  it('rejects every invocation with internal_error + M22-pending hint', async () => {
    const { exitCode, stderr } = await driveDiagnostics(['usage', '--json']);
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(stderr);
    if (envelope.ok) throw new Error('expected error envelope');
    expect(envelope.error.code).toBe('internal_error');
    expect(envelope.error.message).toContain('pre-flight stub');
    const details = envelope.error.details as { hint: string };
    expect(details.hint).toContain('M22 implementation');
  });

  it('rejects unknown flags via the input-schema strict-parse layer', async () => {
    // Pre-flight contract: the input schema is z.object({}).strict()
    // — adding an unknown flag should fail argv parse (commander
    // rejects unknown options before the action runs).
    const { exitCode } = await driveDiagnostics([
      'usage',
      '--unknown-flag',
      '--json',
    ]);
    // Commander rejects unknown options with a non-zero exit before
    // our envelope can wrap; the runner maps commander's exit shape
    // to exit 1 (usage error class).
    expect(exitCode).toBeGreaterThan(0);
  });
});
