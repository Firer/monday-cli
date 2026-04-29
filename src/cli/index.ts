#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  readonly version: string;
  readonly description: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, '..', '..', 'package.json'), 'utf8'),
) as PackageJson;

const program = new Command();

program
  .name('monday')
  .description(pkg.description)
  .version(pkg.version);

// Commands will be registered here as the integration is built out.
// Keeping the entry intentionally bare for now — see docs/architecture.md.

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`monday: ${message}\n`);
  process.exit(1);
});
