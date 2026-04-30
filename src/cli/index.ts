#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithSignals } from './run.js';

interface PackageJson {
  readonly version: string;
  readonly description: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, '..', '..', 'package.json'), 'utf8'),
) as PackageJson;

const result = await runWithSignals({
  argv: process.argv,
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  isTTY: process.stdout.isTTY,
  cliVersion: pkg.version,
  cliDescription: pkg.description,
});

// Set the exit code rather than calling `process.exit(...)` directly.
// `process.exit` terminates the process before stdout / stderr have
// finished flushing to a pipe, which truncates large outputs (e.g.
// `monday schema --json` once it crosses the kernel pipe buffer at
// ~64KB). Using `process.exitCode` lets Node exit naturally once the
// event loop drains the pending writes — the published exit code
// stays the same, but every byte the CLI wrote actually reaches the
// reader. cli.md "exit codes are part of the contract" is preserved.
process.exitCode = result.exitCode;
