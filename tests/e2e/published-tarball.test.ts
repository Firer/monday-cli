/**
 * E2E suite for the **published tarball** (`v0.1-plan.md` §3 M7).
 *
 * Every other E2E suite spawns the local `dist/cli/index.js`. Those
 * verify the source-tree binary works; they don't verify that what
 * ships to npm works. This suite closes the gap by running
 * `npm pack`, extracting the tarball into a tmp dir, and spawning
 * the binary from the extracted package.
 *
 * The point is to catch regressions that only show up at packaging
 * time:
 *   - the `bin` field in `package.json` points at a path the
 *     tarball doesn't contain (e.g. accidentally renamed),
 *   - the `files` allowlist drops something the runtime needs
 *     (e.g. `dist/cli/index.js` itself, or a sibling module),
 *   - the `files` allowlist accidentally includes something it
 *     shouldn't (`src/`, `tests/`, `node_modules/`,
 *     `.review-*.md`, the dotenv example),
 *   - `package.json` ends up with a stale `version` that doesn't
 *     match what the embedded reader reports at runtime,
 *   - a `prepack` / `prepare` hook silently mutates the package
 *     in a way the source-tree tests don't see.
 *
 * Build dependency: same as the rest of the E2E suite — `dist/` must
 * already be up-to-date before this suite runs. `npm run build`
 * happens before `test:e2e` in CI; locally, the spawn helper fails
 * fast if `dist/cli/index.js` is missing. We pass `--ignore-scripts`
 * to `npm pack` so the test doesn't trigger another full rebuild on
 * every run (and so that `prepare` isn't load-bearing for the test
 * to be valid — it's the *artefact* we're verifying, not the
 * pipeline that produced it).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly bin: Readonly<Record<string, string>>;
  readonly files: readonly string[];
}

const sourcePkg = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
) as PackageJson;

interface PackEntry {
  readonly filename: string;
  readonly files: readonly { readonly path: string }[];
}

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const spawnNode = async (
  entry: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' },
): Promise<SpawnResult> => {
  const child = spawn('node', [entry, ...args], {
    env: { ...env, NODE_NO_WARNINGS: '1' },
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
  child.stdin.end();
  const exitCode = await new Promise<number>((resolveCode, rejectCode) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectCode(new Error('tarball child timed out'));
    }, 10_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== null) {
        resolveCode(code);
        return;
      }
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

let workDir = '';
let extractedRoot = '';
let extractedBin = '';
let packedFiles: readonly { readonly path: string }[] = [];

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'monday-cli-tarball-'));
  // --ignore-scripts: the build artefact at `dist/` is the contract
  // we're checking; rebuilding here would mask "tarball ships stale
  // dist" regressions. The CI pipeline (and `npm run build` for
  // local runs) is the source of truth for the artefact.
  const out = execFileSync(
    'npm',
    [
      'pack',
      '--pack-destination',
      workDir,
      '--ignore-scripts',
      '--json',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      // npm logs progress to stderr; capture but ignore for the test.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const meta = JSON.parse(out) as readonly PackEntry[];
  if (meta.length !== 1 || meta[0] === undefined) {
    throw new Error(`expected exactly one tarball entry, got ${meta.length}`);
  }
  packedFiles = meta[0].files;
  const tarballPath = join(workDir, meta[0].filename);
  // tar -xzf extracts a npm tarball as `package/<entries>` per the
  // npm pack format spec. -C cd-s into the work dir before
  // extracting.
  execFileSync('tar', ['-xzf', tarballPath, '-C', workDir], {
    encoding: 'utf8',
  });
  extractedRoot = join(workDir, 'package');
  extractedBin = join(extractedRoot, 'dist', 'cli', 'index.js');
  // Install the package's *declared* runtime dependencies into the
  // extracted directory — exactly what `npm install -g monday-cli`
  // would do for an end user. This is the part that catches the
  // "missing runtime dep" regression: if a dep used at runtime is
  // accidentally listed under `devDependencies`, the install
  // succeeds (we only install `--omit=dev`) but the binary later
  // fails with `Cannot find package 'X'`. `--ignore-scripts` keeps
  // any postinstall side-effects (none today, but worth pinning)
  // out of the way; `--no-package-lock` skips writing a stray
  // lockfile under the tmpdir.
  execFileSync(
    'npm',
    [
      'install',
      '--omit=dev',
      '--no-package-lock',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: extractedRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}, 120_000);

afterAll(() => {
  if (workDir !== '' && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('e2e: published tarball', () => {
  it('contains the binary the package.json bin field points at', () => {
    // bin: { monday: 'dist/cli/index.js' } — the tarball must ship
    // that exact path or `npm install -g` produces a broken symlink.
    const binTargets = Object.values(sourcePkg.bin);
    expect(binTargets.length).toBeGreaterThan(0);
    for (const target of binTargets) {
      const onDisk = join(extractedRoot, target);
      expect(
        existsSync(onDisk),
        `tarball missing bin target ${target}`,
      ).toBe(true);
    }
  });

  it('does not ship dev-only paths', () => {
    // The `files` allowlist should keep `src/`, `tests/`,
    // `node_modules/`, `.review-*`, `.session-handover/`,
    // `.env*`, `coverage/`, `.git/`, the docs tree, and the
    // top-level config files (eslint.config.js etc.) out of the
    // tarball. Any of those landing in the published artefact is
    // either a leak risk or pure bloat.
    const forbidden: readonly (readonly [string, string])[] = [
      ['src/', 'source'],
      ['tests/', 'test'],
      ['node_modules/', 'node_modules'],
      ['coverage/', 'coverage'],
      ['docs/', 'docs'],
      ['.review-', 'review artefacts'],
      ['.session-handover/', 'session handover'],
      ['.env', 'dotenv files'],
      ['.git/', 'git internals'],
      ['.claude/', 'claude rules'],
      ['eslint.config', 'lint config'],
      ['vitest.config', 'vitest config'],
      ['tsconfig', 'tsconfig'],
    ];
    for (const entry of packedFiles) {
      for (const [needle, label] of forbidden) {
        expect(
          entry.path.includes(needle),
          `tarball leaks ${label}: ${entry.path}`,
        ).toBe(false);
      }
    }
  });

  it('ships dist/, README.md, and package.json (the package.json files allowlist contract)', () => {
    const paths = packedFiles.map((f) => f.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    // Sanity: at least one dist entry exists. The `bin` test above
    // pins the specific binary path.
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(true);
  });

  it('--version reports the same string the source package.json declares', async () => {
    // Source package.json and tarball package.json must agree:
    // the runtime reads its own embedded copy, so a release where
    // the source got bumped but the tarball didn't (or vice versa)
    // shows up here. Catches a stale `npm pack` cache, a broken
    // version-bump commit, or a `prepack` hook that mutated
    // `package.json` in a way the source-tree tests didn't see.
    const r = await spawnNode(extractedBin, ['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(sourcePkg.version);
    const tarballPkg = JSON.parse(
      readFileSync(join(extractedRoot, 'package.json'), 'utf8'),
    ) as PackageJson;
    expect(tarballPkg.version).toBe(sourcePkg.version);
  });

  it('--help exits 0 and lists every shipped noun', async () => {
    // The help text is part of the user-visible contract. If a
    // command file silently dropped from registration during the
    // build, --help would no longer mention it. Pin the noun
    // surface here so accidental de-registration fails loudly.
    const r = await spawnNode(extractedBin, ['--help']);
    expect(r.exitCode).toBe(0);
    const expected = [
      'account',
      'workspace',
      'board',
      'user',
      'item',
      'update',
      'cache',
      'config',
      'schema',
      'raw',
    ];
    for (const noun of expected) {
      expect(r.stdout, `help missing noun: ${noun}`).toContain(noun);
    }
  });

  it('schema --json produces a valid envelope without any network call', async () => {
    // `monday schema` is local-only — no MONDAY_API_TOKEN needed,
    // no network. It exercises the entire shipped command
    // registry (every command's input/output schema) and proves
    // the bundled `dist/` is wired correctly. If a transitive
    // module import broke during build, this is where it surfaces.
    const r = await spawnNode(extractedBin, ['schema', '--json']);
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { schema_version: string; commands: Record<string, unknown> };
      meta: { schema_version: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.schema_version).toBe('1');
    expect(env.meta.schema_version).toBe('1');
    // sanity: registry has at least the ten nouns listed above.
    expect(Object.keys(env.data.commands).length).toBeGreaterThanOrEqual(10);
  });
});
