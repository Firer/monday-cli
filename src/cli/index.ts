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

process.exit(result.exitCode);
