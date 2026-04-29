import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildConfigPathOutput,
  configPathCommand,
  configPathOutputSchema,
} from '../../../../src/commands/config/path.js';

describe('buildConfigPathOutput', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'monday-cli-cfg-path-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('reports a single dotenv search location relative to cwd', () => {
    const out = buildConfigPathOutput({ cwd });
    expect(out.cwd).toBe(cwd);
    expect(out.searched.length).toBe(1);
    expect(out.searched[0]?.kind).toBe('dotenv');
    expect(out.searched[0]?.path).toBe(join(cwd, '.env'));
  });

  it('reports exists=false when the .env file is missing', () => {
    const out = buildConfigPathOutput({ cwd });
    expect(out.searched[0]?.exists).toBe(false);
  });

  it('reports exists=true when the .env file is present', async () => {
    await writeFile(join(cwd, '.env'), 'MONDAY_API_TOKEN=tok\n');
    const out = buildConfigPathOutput({ cwd });
    expect(out.searched[0]?.exists).toBe(true);
  });

  it('passes the outputSchema validation', () => {
    const out = buildConfigPathOutput({ cwd });
    expect(() => configPathOutputSchema.parse(out)).not.toThrow();
  });
});

describe('configPathCommand metadata', () => {
  it('declares idempotent=true and at least one usage example', () => {
    expect(configPathCommand.idempotent).toBe(true);
    expect(configPathCommand.examples.length).toBeGreaterThan(0);
  });

  it('uses a dotted command name for the registry/schema lookup', () => {
    expect(configPathCommand.name).toBe('config.path');
  });
});
