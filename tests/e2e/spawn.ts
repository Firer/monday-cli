import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared spawn helper for E2E tests (`v0.1-plan.md` §5.3).
 *
 * Spawns the compiled binary at `dist/cli/index.js`. The build must
 * be up-to-date — `npm run build` runs ahead of `test:e2e` in CI; for
 * local runs the test fails fast with a clear hint if the binary is
 * missing. Each call creates a fresh child process; stdout/stderr
 * are captured into strings so assertions can `expect(out).toContain(...)`
 * without dealing with streams.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const binaryPath = resolve(repoRoot, 'dist/cli/index.js');

export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SpawnCliOptions {
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdin?: string;
  /** Spawn timeout in ms. Defaults to 10 s — plenty for any local cmd. */
  readonly timeoutMs?: number;
}

export const spawnCli = async (
  options: SpawnCliOptions,
): Promise<SpawnResult> => {
  if (!existsSync(binaryPath)) {
    throw new Error(
      `dist/cli/index.js missing at ${binaryPath} — run \`npm run build\` first`,
    );
  }
  const spawnOptions: SpawnOptionsWithoutStdio = {
    env: {
      ...(options.env ?? { PATH: process.env.PATH ?? '' }),
      // Node 22+ prints a `DEP0040` warning to stderr when any
      // dependency reaches into the deprecated `punycode` module
      // (transitive: graphql-request → undici / whatwg-url). The
      // warning is environmental and lands as `(node:1234) ...` on
      // stderr — which makes `expect(stderr).toBe('')` fail and, on
      // some CI nodes, bleeds into stdout and breaks JSON.parse.
      // Suppressing here keeps the spawned CLI's output clean for
      // contract assertions; the CLI itself never relies on these
      // warnings.
      NODE_NO_WARNINGS: '1',
    },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
  const child = spawn('node', [binaryPath, ...options.args], spawnOptions);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  if (options.stdin !== undefined) {
    child.stdin.end(options.stdin);
  } else {
    child.stdin.end();
  }

  const exitCode = await new Promise<number>((resolveCode, rejectCode) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectCode(
        new Error(`child process timed out after ${String(options.timeoutMs ?? 10_000)}ms`),
      );
    }, options.timeoutMs ?? 10_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== null) {
        resolveCode(code);
        return;
      }
      // killed by signal; map to the exit-code convention used by shells.
      resolveCode(128 + (signal === null ? 0 : 1));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectCode(err);
    });
  });

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    exitCode,
  };
};
