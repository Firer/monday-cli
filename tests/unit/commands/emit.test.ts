import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { run, type RunOptions } from '../../../src/cli/run.js';
import { emitDryRun, emitMutation, emitSuccess } from '../../../src/commands/emit.js';
import {
  ensureSubcommand,
  type CommandModule,
} from '../../../src/commands/types.js';
import { fixedRequestIdGenerator } from '../../../src/utils/request-id.js';

interface Captured {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

const baseOptions = (
  overrides: Partial<RunOptions> = {},
): { options: RunOptions; captured: Captured } => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const options: RunOptions = {
    argv: ['node', 'monday'],
    env: { MONDAY_API_TOKEN: 'tok' },
    stdout,
    stderr,
    isTTY: false,
    cliVersion: '0.0.0-test',
    cliDescription: 'CLI under test',
    requestIdGenerator: fixedRequestIdGenerator(['fixed-id']),
    clock: () => new Date('2026-04-29T10:00:00Z'),
    ...overrides,
  };

  return {
    options,
    captured: {
      stdout: () => Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    },
  };
};

const echoModule: CommandModule<{ name: string }, { name: string }> = {
  name: 'demo.echo',
  summary: 'Echoes a name back as data',
  examples: ['monday demo echo --name alice'],
  idempotent: true,
  inputSchema: z.object({ name: z.string().min(1) }),
  outputSchema: z.object({ name: z.string() }),
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'demo', 'Demo commands');
    noun
      .command('echo')
      .description(echoModule.summary)
      .requiredOption('--name <name>', 'name to echo')
      .action((opts: unknown) => {
        const input = echoModule.inputSchema.parse(opts);
        emitSuccess({
          ctx,
          data: { name: input.name },
          schema: echoModule.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};

describe('emitSuccess — JSON envelope', () => {
  it('emits a §6 success envelope on stdout for the resolved format', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'echo', '--name', 'alice'],
      extraCommands: [echoModule],
    });

    const result = await run(options);
    expect(result.exitCode).toBe(0);
    expect(captured.stderr()).toBe('');

    const env = JSON.parse(captured.stdout()) as {
      ok: boolean;
      data: { name: string };
      meta: {
        schema_version: string;
        api_version: string;
        cli_version: string;
        request_id: string;
        source: string;
        cache_age_seconds: number | null;
        complexity: unknown;
      };
      warnings: unknown[];
    };
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ name: 'alice' });
    expect(env.meta.schema_version).toBe('1');
    expect(env.meta.api_version).toBe('2026-01');
    expect(env.meta.cli_version).toBe('0.0.0-test');
    expect(env.meta.request_id).toBe('fixed-id');
    expect(env.meta.source).toBe('none');
    expect(env.meta.cache_age_seconds).toBeNull();
    expect(env.meta.complexity).toBeNull();
    expect(env.warnings).toEqual([]);
  });

  it('chooses table format when isTTY is true', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'echo', '--name', 'alice'],
      extraCommands: [echoModule],
      isTTY: true,
    });
    await run(options);
    // Table renderer prints a box-drawing border; JSON does not.
    expect(captured.stdout()).toContain('field');
    expect(captured.stdout()).toContain('value');
  });

  it('honours --json even when isTTY is true', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'echo', '--name', 'alice', '--json'],
      extraCommands: [echoModule],
      isTTY: true,
    });
    await run(options);
    expect(() => JSON.parse(captured.stdout()) as unknown).not.toThrow();
  });

  it('rejects --output ndjson on a single-resource command with usage_error', async () => {
    const { options, captured } = baseOptions({
      argv: [
        'node',
        'monday',
        'demo',
        'echo',
        '--name',
        'alice',
        '--output',
        'ndjson',
      ],
      extraCommands: [echoModule],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(captured.stderr()) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe('usage_error');
    expect(err.error.message).toMatch(/ndjson/u);
  });

  it('redacts the literal token from emitted output', async () => {
    const literal = 'tok-leakcheck-xxxx';
    const sneakyModule: CommandModule<unknown, { value: string }> = {
      name: 'demo.sneak',
      summary: 'returns the token unwisely',
      examples: ['monday demo sneak'],
      idempotent: true,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ value: z.string() }),
      attach: (program, ctx) => {
        const noun = ensureSubcommand(program, 'demo', 'Demo commands');
        noun
          .command('sneak')
          .description(sneakyModule.summary)
          .action(() => {
            emitSuccess({
              ctx,
              // Smuggle the literal token into the data — should be
              // value-scanned out by the emit redaction layer.
              data: { value: `auth=${ctx.env.MONDAY_API_TOKEN ?? ''}` },
              schema: sneakyModule.outputSchema,
              programOpts: program.opts(),
            });
          });
      },
    };

    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'sneak'],
      extraCommands: [sneakyModule],
      env: { MONDAY_API_TOKEN: literal },
    });
    await run(options);
    const stdout = captured.stdout();
    expect(stdout).not.toContain(literal);
    expect(stdout).toContain('[REDACTED]');
  });

  it('catches output-schema drift via the runner catch-all', async () => {
    const driftingModule: CommandModule<unknown, { name: string }> = {
      name: 'demo.drift',
      summary: 'returns the wrong shape on purpose',
      examples: ['monday demo drift'],
      idempotent: true,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ name: z.string() }),
      attach: (program, ctx) => {
        const noun = ensureSubcommand(program, 'demo', 'Demo commands');
        noun
          .command('drift')
          .description(driftingModule.summary)
          .action(() => {
            emitSuccess({
              ctx,
              // Wrong shape — `name` is missing.
              data: { wrongKey: 1 } as unknown as { name: string },
              schema: driftingModule.outputSchema,
              programOpts: program.opts(),
            });
          });
      },
    };

    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'drift'],
      extraCommands: [driftingModule],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(2);
    const err = JSON.parse(captured.stderr()) as {
      error: {
        code: string;
        details?: { issues?: readonly { path: string }[] };
      };
    };
    expect(err.error.code).toBe('internal_error');
    // R18: the wrap surfaces the failing field path on
    // `details.issues` — pre-fix, the bare ZodError lost the path
    // when the runner's catch-all mapped to internal_error.
    expect(err.error.details?.issues).toBeDefined();
    const issues = err.error.details?.issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path === 'name')).toBe(true);
  });

  it('renders text format for single-resource commands', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'echo', '--name', 'alice', '--output', 'text'],
      extraCommands: [echoModule],
    });
    await run(options);
    expect(captured.stdout()).toBe('name: alice\n');
  });

  it('rejects --output text on a collection command with usage_error', async () => {
    const collectionModule = makeCollectionModule();
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'list', '--output', 'text'],
      extraCommands: [collectionModule],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = JSON.parse(captured.stderr()) as { error: { code: string } };
    expect(env.error.code).toBe('usage_error');
  });

  it('renders --ndjson with one line per item plus a _meta trailer', async () => {
    const collectionModule = makeCollectionModule();
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'list', '--output', 'ndjson'],
      extraCommands: [collectionModule],
    });
    await run(options);
    const lines = captured.stdout().trim().split('\n');
    expect(lines.length).toBe(3); // 2 items + trailer
    const trailer = JSON.parse(lines.at(-1) ?? '') as {
      _meta: { schema_version: string };
    };
    expect(trailer._meta.schema_version).toBe('1');
  });

  it('redacts the literal token from the ndjson trailer meta (Codex review §4)', async () => {
    const literal = 'tok-leakcheck-xxxx';
    // The original (pre-fix) test put the literal in row data; that
    // path was already redacted because `renderForFormat` redacted
    // the data array regardless. The bug was specifically that the
    // trailer's `meta` was passed through unredacted. Force the
    // literal into a meta field — `MONDAY_API_VERSION` is read into
    // `meta.api_version` directly, so a token-bearing env value
    // exercises the trailer path the bug lived in.
    const collectionModule = makeCollectionModule();
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'list', '--output', 'ndjson'],
      extraCommands: [collectionModule],
      env: {
        MONDAY_API_TOKEN: literal,
        MONDAY_API_VERSION: `version-${literal}`,
      },
    });
    await run(options);
    const lines = captured.stdout().trim().split('\n');
    const trailer = JSON.parse(lines.at(-1) ?? '') as {
      _meta: { api_version: string };
    };
    expect(trailer._meta.api_version).not.toContain(literal);
    expect(trailer._meta.api_version).toContain('[REDACTED]');
    // Sanity check: every other byte of stdout is also clean.
    expect(captured.stdout()).not.toContain(literal);
  });

  it('renders collection table layout when format is table', async () => {
    const collectionModule = makeCollectionModule();
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'list', '--output', 'table'],
      extraCommands: [collectionModule],
    });
    await run(options);
    const out = captured.stdout();
    // Collection table headers are the row keys, not "field"/"value".
    expect(out).toContain('id');
    expect(out).toContain('name');
  });

  it('threads --width and --columns into the collection table renderer', async () => {
    const collectionModule = makeCollectionModule();
    const { options, captured } = baseOptions({
      argv: [
        'node',
        'monday',
        'demo',
        'list',
        '--output',
        'table',
        '--width',
        '120',
        '--columns',
        'name',
      ],
      extraCommands: [collectionModule],
    });
    await run(options);
    const out = captured.stdout();
    expect(out).toContain('name');
    // `id` was filtered out by --columns name.
    expect(out).not.toMatch(/\bid\b/u);
  });

  it('threads --width and --columns into the single-resource table renderer', async () => {
    const { options, captured } = baseOptions({
      argv: [
        'node',
        'monday',
        'demo',
        'echo',
        '--name',
        'alice',
        '--output',
        'table',
        '--width',
        '120',
        '--columns',
        'name',
      ],
      extraCommands: [echoModule],
    });
    await run(options);
    expect(captured.stdout()).toContain('name');
  });
});

const makeCollectionModule = (): CommandModule<unknown, readonly { id: string; name: string }[]> => {
  const mod: CommandModule<unknown, readonly { id: string; name: string }[]> = {
    name: 'demo.list',
    summary: 'lists items',
    examples: ['monday demo list'],
    idempotent: true,
    inputSchema: z.object({}).strict(),
    outputSchema: z.array(z.object({ id: z.string(), name: z.string() })),
    attach: (program, ctx) => {
      const noun = ensureSubcommand(program, 'demo', 'Demo commands');
      noun
        .command('list')
        .description(mod.summary)
        .action(() => {
          emitSuccess({
            ctx,
            data: [
              { id: '1', name: 'one' },
              { id: '2', name: 'two' },
            ],
            schema: mod.outputSchema,
            programOpts: program.opts(),
            kind: 'collection',
          });
        });
    },
  };
  return mod;
};

describe('emitSuccess — collection meta passthrough', () => {
  it('threads next_cursor / has_more / total_returned / columns into meta', async () => {
    const mod: CommandModule<unknown, readonly { id: string; name: string }[]> = {
      name: 'demo.cursor',
      summary: 'cursor walker',
      examples: ['monday demo cursor'],
      idempotent: true,
      inputSchema: z.object({}).strict(),
      outputSchema: z.array(z.object({ id: z.string(), name: z.string() })),
      attach: (program, ctx) => {
        const noun = ensureSubcommand(program, 'demo', 'Demo commands');
        noun
          .command('cursor')
          .description('cursor walker')
          .action(() => {
            emitSuccess({
              ctx,
              data: [{ id: '1', name: 'one' }],
              schema: mod.outputSchema,
              programOpts: program.opts(),
              kind: 'collection',
              nextCursor: 'cur-abc',
              hasMore: true,
              totalReturned: 99,
              columns: {
                status_4: { id: 'status_4', type: 'status', title: 'Status' },
              },
            });
          });
      },
    };
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'cursor', '--json'],
      extraCommands: [mod],
    });
    await run(options);
    const env = JSON.parse(captured.stdout()) as {
      meta: {
        next_cursor: string | null;
        has_more: boolean;
        total_returned: number;
        columns: Readonly<Record<string, unknown>>;
      };
    };
    expect(env.meta.next_cursor).toBe('cur-abc');
    expect(env.meta.has_more).toBe(true);
    expect(env.meta.total_returned).toBe(99);
    expect(env.meta.columns).toEqual({
      status_4: { id: 'status_4', type: 'status', title: 'Status' },
    });
  });

  it('--ndjson is rejected for single-resource commands', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'echo', '--name', 'a', '--output', 'ndjson'],
      extraCommands: [echoModule],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = JSON.parse(captured.stderr()) as { error: { code: string } };
    expect(env.error.code).toBe('usage_error');
  });

  it('--output text is rejected for collection commands', async () => {
    const list = makeCollectionModule();
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'list', '--output', 'text'],
      extraCommands: [list],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = JSON.parse(captured.stderr()) as { error: { code: string } };
    expect(env.error.code).toBe('usage_error');
  });
});

describe('emitMutation (M5b)', () => {
  const mutationModule: CommandModule<unknown, { id: string; name: string }> = {
    name: 'demo.mutate',
    summary: 'demo mutation',
    examples: ['monday demo mutate'],
    idempotent: true,
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ id: z.string(), name: z.string() }),
    attach: (program, ctx) => {
      const noun = ensureSubcommand(program, 'demo', 'Demo commands');
      noun
        .command('mutate')
        .description(mutationModule.summary)
        .action(() => {
          emitMutation({
            ctx,
            data: { id: '1', name: 'X' },
            schema: mutationModule.outputSchema,
            programOpts: program.opts(),
            source: 'live',
            resolvedIds: { status: 'col_a' },
          });
        });
    },
  };

  it('emits a mutation envelope with resolved_ids slot', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'mutate'],
      extraCommands: [mutationModule],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(captured.stdout()) as {
      ok: boolean;
      data: { id: string };
      resolved_ids?: Readonly<Record<string, string>>;
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('1');
    expect(env.resolved_ids).toEqual({ status: 'col_a' });
  });

  it('catches outputSchema drift via the R18 wrap (details.issues populated)', async () => {
    const driftModule: CommandModule<unknown, { name: string }> = {
      name: 'demo.drift-mutation',
      summary: 'returns wrong shape',
      examples: ['monday demo drift-mutation'],
      idempotent: true,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ name: z.string() }),
      attach: (program, ctx) => {
        const noun = ensureSubcommand(program, 'demo', 'Demo commands');
        noun
          .command('drift-mutation')
          .description(driftModule.summary)
          .action(() => {
            emitMutation({
              ctx,
              // Wrong shape — `name` missing.
              data: { wrongKey: 1 } as unknown as { name: string },
              schema: driftModule.outputSchema,
              programOpts: program.opts(),
            });
          });
      },
    };
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'drift-mutation'],
      extraCommands: [driftModule],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(2);
    const err = JSON.parse(captured.stderr()) as {
      error: {
        code: string;
        details?: { issues?: readonly { path: string }[] };
      };
    };
    expect(err.error.code).toBe('internal_error');
    expect(err.error.details?.issues).toBeDefined();
    expect((err.error.details?.issues ?? []).length).toBeGreaterThan(0);
  });
});

describe('emitDryRun (M5b)', () => {
  const dryRunModule: CommandModule<unknown, null> = {
    name: 'demo.dryrun',
    summary: 'demo dry-run',
    examples: ['monday demo dryrun'],
    idempotent: true,
    inputSchema: z.object({}).strict(),
    outputSchema: z.null(),
    attach: (program, ctx) => {
      const noun = ensureSubcommand(program, 'demo', 'Demo commands');
      noun
        .command('dryrun')
        .description(dryRunModule.summary)
        .action(() => {
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [{ operation: 'change_simple_column_value', item_id: '1' }],
          });
        });
    },
  };

  it('emits a §6.4 dry-run envelope with data:null + meta.dry_run + planned_changes', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'demo', 'dryrun'],
      extraCommands: [dryRunModule],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(captured.stdout()) as {
      ok: boolean;
      data: null;
      meta: { dry_run?: boolean };
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    expect(env.ok).toBe(true);
    expect(env.data).toBeNull();
    expect(env.meta.dry_run).toBe(true);
    expect(env.planned_changes.length).toBe(1);
  });
});
