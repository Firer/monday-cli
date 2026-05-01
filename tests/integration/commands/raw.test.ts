/**
 * Integration tests for `monday raw` (M6).
 *
 * Pyramid: covers every argv shape the command accepts (positional
 * inline, --query-file, --query-file -, --vars, --vars-file,
 * --vars-file -, plus mutual exclusion + empty + malformed JSON
 * branches) end-to-end through the runner against `FixtureTransport`
 * cassettes. The redaction canary test confirms that user-supplied
 * paths echoing the env token are scrubbed.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  drive,
  LEAK_CANARY,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import type { Interaction } from '../../fixtures/load.js';

// Anonymous shorthand queries have no operationName on the wire — the
// server picks the only operation. Fixture cassettes therefore omit
// `operation_name`. Named operations (`query Get(...)`) DO carry the
// name on the wire and pin against `operation_name: 'Get'` below.
const meQueryInteraction: Interaction = {
  response: {
    data: {
      me: {
        id: '7',
        name: 'Alice',
        email: 'alice@example.test',
      },
    },
  },
};

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-raw-int-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('monday raw (integration)', () => {
  it('inline query: passes through to Monday and wraps in §6 envelope', async () => {
    const out = await drive(
      ['raw', '{ me { id name email } }', '--json'],
      { interactions: [meQueryInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data?: { me?: { id?: string; name?: string } };
    };
    expect(env.ok).toBe(true);
    expect(env.data?.me?.id).toBe('7');
    expect(env.data?.me?.name).toBe('Alice');
    expect(env.meta.source).toBe('live');
  });

  it('inline query with --vars: variables thread through to the request', async () => {
    const out = await drive(
      [
        'raw',
        'query Get($id: ID!) { items(ids: [$id]) { id name } }',
        '--vars',
        '{"id": "12345"}',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'Get',
            response: {
              data: { items: [{ id: '12345', name: 'Refactor login' }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data?: { items?: { id: string; name: string }[] };
    };
    expect(env.ok).toBe(true);
    expect(env.data?.items?.[0]?.id).toBe('12345');
  });

  it('--query-file <path>: reads from disk', async () => {
    const queryPath = join(tmpRoot, 'me.gql');
    await writeFile(queryPath, '{ me { id name } }', 'utf8');
    const out = await drive(
      ['raw', '--query-file', queryPath, '--json'],
      { interactions: [meQueryInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.ok).toBe(true);
  });

  it('--query-file -: reads from stdin', async () => {
    const out = await drive(
      ['raw', '--query-file', '-', '--json'],
      { interactions: [meQueryInteraction] },
      { stdin: Readable.from(['{ me { id name } }']) },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.ok).toBe(true);
  });

  it('--vars-file <path>: reads variables JSON from disk', async () => {
    const varsPath = join(tmpRoot, 'vars.json');
    await writeFile(varsPath, '{"id": "12345"}', 'utf8');
    const out = await drive(
      [
        'raw',
        'query Get($id: ID!) { items(ids: [$id]) { id name } }',
        '--vars-file',
        varsPath,
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'Get',
            response: {
              data: { items: [{ id: '12345', name: 'Refactor login' }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('rejects empty positional <query> with usage_error', async () => {
    const out = await drive(['raw', '   ', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects no source with usage_error', async () => {
    const out = await drive(['raw', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects positional + --query-file as mutually exclusive', async () => {
    const queryPath = join(tmpRoot, 'me.gql');
    await writeFile(queryPath, '{ me { id } }', 'utf8');
    const out = await drive(
      ['raw', '{ me { id } }', '--query-file', queryPath, '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects --vars + --vars-file as mutually exclusive', async () => {
    const varsPath = join(tmpRoot, 'vars.json');
    await writeFile(varsPath, '{}', 'utf8');
    const out = await drive(
      [
        'raw',
        '{ me { id } }',
        '--vars',
        '{}',
        '--vars-file',
        varsPath,
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects malformed --vars JSON with usage_error', async () => {
    const out = await drive(
      ['raw', '{ me { id } }', '--vars', '{not json', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects --vars JSON that parses to a non-object (array)', async () => {
    const out = await drive(
      ['raw', '{ me { id } }', '--vars', '["a","b"]', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects --vars JSON that parses to null', async () => {
    const out = await drive(
      ['raw', '{ me { id } }', '--vars', 'null', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects --vars JSON that parses to a primitive (number)', async () => {
    const out = await drive(
      ['raw', '{ me { id } }', '--vars', '42', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects malformed --vars-file content with usage_error (file source)', async () => {
    const varsPath = join(tmpRoot, 'bad.json');
    await writeFile(varsPath, '{not json', 'utf8');
    const out = await drive(
      ['raw', '{ me { id } }', '--vars-file', varsPath, '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects --query-file - and --vars-file - both requesting stdin', async () => {
    const out = await drive(
      ['raw', '--query-file', '-', '--vars-file', '-', '--json'],
      { interactions: [] },
      { stdin: Readable.from(['{ me { id } }']) },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects --query-file <missing-path> with usage_error', async () => {
    const out = await drive(
      ['raw', '--query-file', join(tmpRoot, 'no-such.gql'), '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('GraphQL error (Monday returns errors[]) maps via api/errors.ts', async () => {
    const out = await drive(
      ['raw', '{ me { id } }', '--json'],
      {
        interactions: [
          {
            http_status: 401,
            response: {
              errors: [
                {
                  message: 'Not authenticated',
                  extensions: { code: 'UnauthorizedException' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
  });

  it('--vars-file -: reads JSON variables from stdin', async () => {
    const out = await drive(
      [
        'raw',
        'query Get($id: ID!) { items(ids: [$id]) { id name } }',
        '--vars-file',
        '-',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'Get',
            response: {
              data: { items: [{ id: '12345', name: 'Refactor login' }] },
            },
          },
        ],
      },
      { stdin: Readable.from(['{"id": "12345"}']) },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data?: { items?: { id: string }[] };
    };
    expect(env.data?.items?.[0]?.id).toBe('12345');
  });

  it('rejects --vars-file <missing-path> with usage_error', async () => {
    const out = await drive(
      [
        'raw',
        '{ me { id } }',
        '--vars-file',
        join(tmpRoot, 'no-such.json'),
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --vars-file content with usage_error', async () => {
    const varsPath = join(tmpRoot, 'empty.json');
    await writeFile(varsPath, '   \n', 'utf8');
    const out = await drive(
      ['raw', '{ me { id } }', '--vars-file', varsPath, '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty stdin --vars-file - with usage_error', async () => {
    const out = await drive(
      ['raw', '{ me { id } }', '--vars-file', '-', '--json'],
      { interactions: [] },
      { stdin: Readable.from(['   ']) },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty stdin --query-file - with usage_error', async () => {
    const out = await drive(
      ['raw', '--query-file', '-', '--json'],
      { interactions: [] },
      { stdin: Readable.from(['\n']) },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --query-file content with usage_error', async () => {
    const queryPath = join(tmpRoot, 'empty.gql');
    await writeFile(queryPath, '   \n', 'utf8');
    const out = await drive(
      ['raw', '--query-file', queryPath, '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  // ── Mutation gate (M6 close P1 fix) ────────────────────────────────
  it('mutation rejected by default (no --allow-mutation) — usage_error', async () => {
    const out = await drive(
      [
        'raw',
        'mutation { create_workspace(name: "X", kind: open) { id } }',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message ?? '').toMatch(/mutation/iu);
    // Pre-network failure: cli-design §6.1 says `source: 'none'`
    // is for "errors that fail before any read". The analyser
    // fires before resolveClient commits `live`, so the error
    // envelope must report 'none' (Codex M6 pass-2 P2).
    expect(env.meta.source).toBe('none');
  });

  it('mutation accepted with --allow-mutation', async () => {
    const out = await drive(
      [
        'raw',
        'mutation Bump { create_workspace(name: "X", kind: open) { id } }',
        '--allow-mutation',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'Bump',
            response: { data: { create_workspace: { id: '999' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data?: { create_workspace?: { id: string } };
    };
    expect(env.data?.create_workspace?.id).toBe('999');
  });

  it('anonymous mutation + --dry-run: operation_name echoes null', async () => {
    // Drives raw/index.ts:451 `analysis.operationName ?? null` — when
    // the mutation has no name (`mutation { ... }`), the planned-change
    // shape echoes operation_name as JSON null, not omits the field.
    // Agents reading the dry-run envelope rely on the slot being
    // present even for unnamed mutations.
    const out = await drive(
      [
        'raw',
        'mutation { create_workspace(name: "X", kind: open) { id } }',
        '--allow-mutation',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    expect(env.planned_changes[0]).toMatchObject({
      operation: 'raw_graphql',
      operation_kind: 'mutation',
      operation_name: null,
    });
  });

  it('mutation + --dry-run: emits planned-change envelope, no wire call (M6 P1)', async () => {
    // cli-design §9.2 binds every mutating command to support
    // `--dry-run`. Pre-fix, raw silently sent the mutation
    // regardless. The fix emits the §6.4 dry-run envelope and
    // skips the network entirely (cassette stays empty).
    const out = await drive(
      [
        'raw',
        'mutation Bump { create_workspace(name: "X", kind: open) { id } }',
        '--allow-mutation',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    expect(env.ok).toBe(true);
    expect(env.data).toBeNull();
    expect(env.meta.dry_run).toBe(true);
    expect(env.meta.source).toBe('none');
    expect(env.planned_changes).toHaveLength(1);
    const planned = env.planned_changes[0];
    expect(planned).toMatchObject({
      operation: 'raw_graphql',
      operation_kind: 'mutation',
      operation_name: 'Bump',
    });
    expect(planned?.query).toContain('mutation Bump');
  });

  it('query + --dry-run: --dry-run is a no-op (read-only) and the query executes', async () => {
    // cli-design §9.2 only binds `--dry-run` for *mutating*
    // commands. Queries are read-only, so `--dry-run` is a
    // no-op and the document goes out as normal.
    const out = await drive(
      ['raw', '{ me { id name } }', '--dry-run', '--json'],
      { interactions: [meQueryInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data?: { me?: { id?: string } };
    };
    expect(env.ok).toBe(true);
    expect(env.data?.me?.id).toBe('7');
    expect(env.meta.source).toBe('live');
  });

  it('mixed doc + --operation-name selects query: --dry-run is a no-op (M6 P2 pass-5)', async () => {
    // Codex M6 pass-5 P2: dry-run gating must use the *selected*
    // op's kind, not the document-wide `hasMutation`. A mixed doc
    // with `--operation-name <a-query>` selects a read-only op,
    // so `--dry-run` is a no-op and Read executes against Monday.
    const out = await drive(
      [
        'raw',
        'query Read { me { id name } } mutation Write { create_workspace(name: "X", kind: open) { id } }',
        '--operation-name',
        'Read',
        '--allow-mutation',
        '--dry-run',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'Read',
            response: { data: { me: { id: '7', name: 'Alice' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data?: { me?: { id?: string } };
    };
    expect(env.ok).toBe(true);
    expect(env.data?.me?.id).toBe('7');
    // Live execution, not dry-run — the query side of the mixed
    // doc is read-only.
    expect(env.meta.source).toBe('live');
  });

  it('mixed doc + --operation-name selects mutation: --dry-run emits planned-change (M6 P2 pass-5)', async () => {
    const out = await drive(
      [
        'raw',
        'query Read { me { id name } } mutation Write { create_workspace(name: "X", kind: open) { id } }',
        '--operation-name',
        'Write',
        '--allow-mutation',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly Readonly<Record<string, unknown>>[];
    };
    expect(env.ok).toBe(true);
    expect(env.data).toBeNull();
    expect(env.meta.dry_run).toBe(true);
    expect(env.meta.source).toBe('none');
    expect(env.planned_changes[0]).toMatchObject({
      operation: 'raw_graphql',
      operation_kind: 'mutation',
      operation_name: 'Write',
    });
  });

  it('subscription always rejected (HTTP transport can\'t carry it)', async () => {
    const out = await drive(
      [
        'raw',
        'subscription { itemUpdated { id } }',
        '--allow-mutation',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message ?? '').toMatch(/subscription/iu);
  });

  it('GraphQL syntax error surfaces as usage_error (parse-time)', async () => {
    const out = await drive(
      ['raw', '{ me { id', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message ?? '').toMatch(/parse|syntax/iu);
  });

  // ── operationName selection (M6 close P1 fix) ──────────────────────
  it('multi-op without --operation-name fails with usage_error', async () => {
    const out = await drive(
      [
        'raw',
        'query A { me { id } } query B { me { name } }',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message ?? '').toMatch(/operation-name/iu);
  });

  it('multi-op with --operation-name picks the named op', async () => {
    const out = await drive(
      [
        'raw',
        'query A { me { id } } query B { me { name } }',
        '--operation-name',
        'B',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'B',
            response: { data: { me: { name: 'Alice' } } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data?: { me?: { name?: string } };
    };
    expect(env.data?.me?.name).toBe('Alice');
  });

  it('multi-op with unmatched --operation-name fails', async () => {
    const out = await drive(
      [
        'raw',
        'query A { me { id } } query B { me { name } }',
        '--operation-name',
        'C',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--operation-name on a single-op doc whose name disagrees fails', async () => {
    const out = await drive(
      ['raw', 'query Foo { me { id } }', '--operation-name', 'Bar', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--operation-name on a single anonymous-op doc fails', async () => {
    const out = await drive(
      ['raw', '{ me { id } }', '--operation-name', 'Foo', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('document with no operations (fragment-only) fails', async () => {
    const out = await drive(
      ['raw', 'fragment X on Me { id }', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('user-input canary: --query-file path containing the token is redacted', async () => {
    // M5b cleanup precedent (Codex finding #4): user-input echo paths
    // must scrub the env-token canary even when it lands in argv.
    const out = await drive(
      [
        'raw',
        '--query-file',
        join(tmpRoot, `nonexistent-${LEAK_CANARY}.gql`),
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });
});
