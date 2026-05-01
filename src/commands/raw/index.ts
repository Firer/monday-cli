/**
 * `monday raw <query> [--vars <json>]` —
 * `monday raw --query-file <path|-> [--vars-file <path|->]` —
 * generic GraphQL escape hatch (`cli-design.md` §4.3 line 579,
 * §10.5; `v0.1-plan.md` §3 M6).
 *
 * The CLI ships friendly verbs for the v0.1-allowlisted Monday
 * surfaces, but power users / agents that need a query the CLI
 * doesn't model (a brand-new Monday API, an old API field the SDK
 * still types incorrectly, an experimental query) need an escape
 * hatch. `monday raw` is that escape:
 *
 *   - Sends the literal GraphQL document to Monday's `/v2` endpoint
 *     under the same auth + retry + redaction treatment as every
 *     other command.
 *   - Wraps Monday's `data: ...` response in the standard §6
 *     envelope so an agent's parser doesn't branch on raw vs friendly.
 *   - Maps GraphQL / HTTP errors per the existing
 *     `api/errors.ts` mapping — `unauthorized`, `complexity_exceeded`,
 *     `rate_limited`, `not_found`, etc. — so error codes are stable
 *     even on raw queries.
 *
 * **Mutually exclusive sources.** Query may come from:
 *   1. positional `<query>` — inline (shell-quote multi-line).
 *   2. `--query-file <path>` — read from disk (cli-design §4.4).
 *   3. `--query-file -` — read from stdin (`ctx.stdin`), letting
 *      agents pipe a `cat foo.gql`-style document in.
 *
 * Variables are optional; when provided they may come from:
 *   1. `--vars <json>` — inline JSON object.
 *   2. `--vars-file <path>` — JSON file on disk.
 *   3. `--vars-file -` — JSON read from stdin.
 *
 * Stdin is shared between `--query-file -` and `--vars-file -` —
 * they're mutually exclusive (only one source can read from stdin
 * per invocation; we surface a `usage_error` if both are `-`).
 *
 * **Mutation gate.** The document is parsed via `analyzeRawDocument`
 * (M6 close P1 fix) and any `mutation` operation is rejected with
 * `usage_error` unless `--allow-mutation` is passed. `subscription`
 * operations are unconditionally rejected (HTTP transport can't
 * carry them). Read paths stay safe-by-default — an agent that
 * means to mutate has to opt in.
 *
 * **`operationName` selection.** GraphQL servers use `operationName`
 * to pick which operation to execute when a document has multiple.
 * The pre-fix M6 hardcoded `'MondayRaw'`, which broke any document
 * whose only operation didn't happen to be named `MondayRaw`. The
 * fixed behaviour walks the AST and picks correctly:
 *   - 1 anonymous op → omit `operationName` (Monday picks the only one).
 *   - 1 named op → pass that name.
 *   - N ops → require `--operation-name <name>` (validated against
 *     the document's operations).
 *
 * **No auto-pagination.** `raw` sends exactly one GraphQL request
 * per invocation. If the agent's query uses cursor pagination
 * (Monday's `items_page(...) { cursor, items { ... } }`), the
 * caller is responsible for re-running `raw` with the next cursor —
 * the CLI doesn't walk the cursor for you. The friendly `item list
 * --all` / `item search --all` verbs handle the walk; `raw` doesn't,
 * because it can't tell which selection set is the cursor source.
 *
 * **Idempotency + dry-run.** Idempotency depends on the document —
 * `query { … }` operations are idempotent reads; `mutation { … }`
 * operations may or may not be. The `idempotent` slot on the
 * `CommandModule` is `false` (we can't narrow at registration
 * time). For `--dry-run`: cli-design §9.2 binds every mutating
 * command to support it, so when the analyser detects a mutation
 * AND `--dry-run` is set, the command emits a §6.4 dry-run
 * envelope (`data: null`, `meta.dry_run: true`,
 * `planned_changes: [{operation: 'raw_graphql', kind: 'mutation',
 * operation_name, query, variables}]`) and skips the network call
 * entirely (no `resolveClient`, `meta.source: 'none'`). For
 * read-only documents `--dry-run` is a no-op — there's no mutation
 * to "not execute" — and the query runs normally.
 *
 * **No envelope summarisation.** Monday's response shape is
 * passed through verbatim under `data`. A schema-validating
 * downstream consumer can wrap it; the CLI doesn't try to flatten
 * or normalise (it can't — the shape is the user's, not ours).
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { CommandModule } from '../types.js';
import { emitSuccess, emitDryRun } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import { UsageError } from '../../utils/errors.js';
import { analyzeRawDocument } from '../../api/raw-document.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { PINNED_API_VERSION } from '../../api/client.js';
import type { RunContext } from '../../cli/run.js';

const inputSchema = z
  .object({
    query: z.string().optional(),
    vars: z.string().optional(),
    queryFile: z.string().min(1).optional(),
    varsFile: z.string().min(1).optional(),
    operationName: z.string().min(1).optional(),
    allowMutation: z.boolean().default(false),
  })
  .strict();

/**
 * Output schema. Raw passes Monday's `data` through verbatim; the
 * CLI doesn't know its shape. `z.unknown()` is the right slot — the
 * envelope contract holds (`{ ok, data, meta, warnings }`), but
 * `data` is opaque to the CLI's renderer. JSON output is the only
 * format that makes sense for raw; table / text / ndjson would have
 * to invent a column projection.
 */
export const rawOutputSchema = z.unknown();
export type RawOutput = unknown;

/**
 * Reads the GraphQL query document from one of the three accepted
 * sources. Throws `usage_error` if multiple sources are set, none
 * are set, or stdin is requested but unwired. Mirrors the body-source
 * shape `update create` uses for `--body` / `--body-file`.
 *
 * The empty-after-trim check fires on every source so a whitespace-
 * only query (`monday raw "   "` or a stdin pipe of `\n`) can't
 * sneak past as a no-op or surface as a confusing Monday-side parse
 * error.
 */
const readQuery = async (
  inlineQuery: string | undefined,
  queryFile: string | undefined,
  stdin: NodeJS.ReadableStream | undefined,
  varsFile: string | undefined,
): Promise<string> => {
  if (inlineQuery !== undefined && queryFile !== undefined) {
    throw new UsageError(
      'monday raw: <query> positional and --query-file are mutually ' +
        'exclusive; pick one source for the GraphQL document.',
      {
        details: {
          has_inline_query: true,
          query_file: queryFile,
        },
      },
    );
  }
  if (inlineQuery === undefined && queryFile === undefined) {
    throw new UsageError(
      'monday raw requires either a <query> positional or --query-file ' +
        '<path>. Use --query-file - to read from stdin.',
    );
  }
  if (inlineQuery !== undefined) {
    if (inlineQuery.trim().length === 0) {
      throw new UsageError(
        '<query> cannot be empty (or whitespace-only). Pass a GraphQL ' +
          'document or use --query-file <path>.',
      );
    }
    return inlineQuery;
  }
  // queryFile path. Stdin (`-`) needs `ctx.stdin` wired AND no
  // overlapping --vars-file - request (only one stdin reader per run).
  if (queryFile === '-') {
    if (varsFile === '-') {
      throw new UsageError(
        '--query-file - and --vars-file - both request stdin; only ' +
          'one source can read stdin per invocation. Pass --vars or ' +
          '--vars-file <path> for the variables.',
      );
    }
    /* c8 ignore next 6 — defensive wiring guard. The runner always
       passes `process.stdin`; reaching this branch means a test or
       custom embedding called `run()` with `stdin: undefined`. */
    if (stdin === undefined) {
      throw new UsageError(
        '--query-file - requested stdin, but no stdin is wired into ' +
          'the runner. This is a programmer wiring bug.',
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const query = Buffer.concat(chunks).toString('utf8').trim();
    if (query.length === 0) {
      throw new UsageError(
        'stdin produced an empty GraphQL document. Pipe non-empty ' +
          'content into --query-file - or pass an inline <query>.',
        { details: { query_file: '-' } },
      );
    }
    return query;
  }
  // File on disk. queryFile is narrowed to string here (the inline
  // / undefined / `-` branches all returned above), but TypeScript
  // can't follow the cross-branch narrowing — re-check explicitly
  // to satisfy the type system without a non-null assertion.
  // Path travels through fs.readFile verbatim — security.md's
  // value-scanning redactor still scrubs the env token if it ever
  // landed here, but the path itself is user-supplied and harmless.
  /* c8 ignore next 6 — defensive guard for a branch the
     control-flow above already eliminated. */
  if (queryFile === undefined) {
    throw new UsageError('monday raw: query file path missing (internal).');
  }
  const path = queryFile;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    throw new UsageError(
      `--query-file: failed to read ${JSON.stringify(path)} (${
        err instanceof Error ? err.message : String(err)
      }).`,
      {
        cause: err,
        details: { query_file: path },
      },
    );
  }
  const query = raw.trim();
  if (query.length === 0) {
    throw new UsageError(
      `--query-file: ${JSON.stringify(path)} is empty (after trim). ` +
        `Pass a non-empty GraphQL document.`,
      { details: { query_file: path } },
    );
  }
  return query;
};

/**
 * Reads the GraphQL variables JSON from one of `--vars`,
 * `--vars-file`, or stdin (when `--vars-file -`). Returns an empty
 * object when no source is set — Monday accepts queries with no
 * variables. Throws `usage_error` for a malformed JSON blob, mutual-
 * exclusion violations, or empty content from a path / stdin.
 *
 * Ensures the parsed result is an OBJECT, not a primitive / array.
 * Monday's `variables` accepts a JSON object; passing `42` or
 * `["a","b"]` is a programmer error that should surface up-front.
 */
const readVars = async (
  inlineVars: string | undefined,
  varsFile: string | undefined,
  stdin: NodeJS.ReadableStream | undefined,
): Promise<Readonly<Record<string, unknown>>> => {
  if (inlineVars !== undefined && varsFile !== undefined) {
    throw new UsageError(
      'monday raw: --vars and --vars-file are mutually exclusive; pick ' +
        'one source for the GraphQL variables.',
      {
        details: {
          has_inline_vars: true,
          vars_file: varsFile,
        },
      },
    );
  }
  if (inlineVars === undefined && varsFile === undefined) {
    return {};
  }
  let raw: string;
  if (inlineVars !== undefined) {
    raw = inlineVars;
  } else if (varsFile === '-') {
    /* c8 ignore next 6 — defensive wiring guard, same as the
       --query-file - branch. */
    if (stdin === undefined) {
      throw new UsageError(
        '--vars-file - requested stdin, but no stdin is wired into ' +
          'the runner. This is a programmer wiring bug.',
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw.length === 0) {
      throw new UsageError(
        'stdin produced empty --vars-file content. Pipe a JSON object ' +
          'into --vars-file - or pass --vars <json> inline.',
        { details: { vars_file: '-' } },
      );
    }
  } else {
    /* c8 ignore next 4 — defensive guard for a branch the
       control-flow above already eliminated. */
    if (varsFile === undefined) {
      throw new UsageError('monday raw: vars file path missing (internal).');
    }
    const path = varsFile;
    let fileRaw: string;
    try {
      fileRaw = await readFile(path, 'utf8');
    } catch (err: unknown) {
      throw new UsageError(
        `--vars-file: failed to read ${JSON.stringify(path)} (${
          err instanceof Error ? err.message : String(err)
        }).`,
        {
          cause: err,
          details: { vars_file: path },
        },
      );
    }
    raw = fileRaw.trim();
    if (raw.length === 0) {
      throw new UsageError(
        `--vars-file: ${JSON.stringify(path)} is empty (after trim). ` +
          `Pass a non-empty JSON object.`,
        { details: { vars_file: path } },
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new UsageError(
      `monday raw: GraphQL variables are not valid JSON (${
        err instanceof Error ? err.message : String(err)
      }).`,
      {
        cause: err,
        details: {
          source: inlineVars !== undefined ? 'inline' : varsFile,
        },
      },
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new UsageError(
      `monday raw: GraphQL variables must be a JSON object (got ${
        Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed
      }). Wrap your value in {"key": ...}.`,
      {
        details: {
          source: inlineVars !== undefined ? 'inline' : varsFile,
          parsed_kind: Array.isArray(parsed)
            ? 'array'
            : parsed === null
              ? 'null'
              : typeof parsed,
        },
      },
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
};

export const rawCommand: CommandModule<z.infer<typeof inputSchema>> = {
  name: 'raw',
  summary: 'Send a raw GraphQL document to Monday',
  examples: [
    "monday raw '{ me { id name email } }'",
    'monday raw --query-file ./query.gql --vars-file ./vars.json',
    "cat query.gql | monday raw --query-file -",
    "monday raw 'mutation { create_workspace(name: \"X\", kind: open) { id } }' --allow-mutation",
  ],
  idempotent: false,
  inputSchema,
  outputSchema: rawOutputSchema,
  attach: (program, ctx) => {
    program
      .command('raw [query]')
      .description(rawCommand.summary)
      .option('--vars <json>', 'GraphQL variables as inline JSON')
      .option('--query-file <path>', 'read the GraphQL document from a file (or - for stdin)')
      .option('--vars-file <path>', 'read --vars JSON from a file (or - for stdin)')
      .option('--operation-name <name>', 'select an operation when the document defines more than one')
      .option('--allow-mutation', 'allow `mutation` operations (default: rejected)')
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...rawCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - The document is parsed; mutations are rejected unless --allow-mutation.',
          '  - Subscriptions are not supported (HTTP transport).',
          '  - No auto-pagination: pass cursors yourself for items_page-style queries.',
          '',
        ].join('\n'),
      )
      .action(async (query: unknown, opts: unknown) => {
        const parsed = parseArgv(rawCommand.inputSchema, {
          ...(query === undefined ? {} : { query: query as string }),
          ...(opts as Readonly<Record<string, unknown>>),
        });

        // Read + validate before resolving the client. This keeps the
        // pre-network failure path's error envelope honest:
        // `meta.source` stays at the runner's default (no
        // `setSource('live')` commit) so a `usage_error` from the
        // analyser surfaces with `source: 'none'` per cli-design §6.1
        // (`"none"` is for errors that fail before any read). Codex
        // M6 pass-2 — pre-fix, `resolveClient` ran first and committed
        // `live` even when no wire call followed, which lied about
        // provenance on the failure envelope.
        const queryDoc = await readQuery(
          parsed.query,
          parsed.queryFile,
          ctx.stdin,
          parsed.varsFile,
        );
        const vars = await readVars(parsed.vars, parsed.varsFile, ctx.stdin);

        const analysis = analyzeRawDocument({
          query: queryDoc,
          explicitOperationName: parsed.operationName,
          allowMutation: parsed.allowMutation,
        });

        // §9.2 binds every mutating command to honour `--dry-run`.
        // When the analyser detected a mutation AND `--dry-run` is
        // set, emit the planned-change envelope and skip the wire
        // call entirely. `resolveClient` is intentionally NOT called:
        // no auth, no network, no `setSource('live')` commit. This
        // closes Codex M6 pass-4 P1 — pre-fix, `monday raw 'mutation
        // ...' --allow-mutation --dry-run` silently sent the
        // mutation. For read-only documents `--dry-run` is a no-op
        // (queries don't mutate) so the query path keeps running.
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        if (globalFlags.dryRun && analysis.hasMutation) {
          const apiVersion =
            globalFlags.apiVersion ??
            ctx.env.MONDAY_API_VERSION ??
            PINNED_API_VERSION;
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'raw_graphql',
                operation_kind: 'mutation',
                operation_name: analysis.operationName ?? null,
                query: queryDoc,
                variables: vars,
              },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const { client, toEmit } = resolveClient(ctx, program.opts());

        await sendRawQuery({
          client,
          ctx,
          programOpts: program.opts(),
          toEmit,
          query: queryDoc,
          vars,
          operationName: analysis.operationName,
        });
      });
  },
};

interface SendRawInputs {
  readonly client: ReturnType<typeof resolveClient>['client'];
  readonly ctx: RunContext;
  readonly programOpts: unknown;
  readonly toEmit: ReturnType<typeof resolveClient>['toEmit'];
  readonly query: string;
  readonly vars: Readonly<Record<string, unknown>>;
  readonly operationName: string | undefined;
}

const sendRawQuery = async (inputs: SendRawInputs): Promise<void> => {
  const response = await inputs.client.raw<unknown>(
    inputs.query,
    inputs.vars,
    inputs.operationName === undefined
      ? {}
      : { operationName: inputs.operationName },
  );
  emitSuccess({
    ctx: inputs.ctx,
    data: response.data,
    schema: rawOutputSchema,
    programOpts: inputs.programOpts,
    // toEmit threads apiVersion + source + complexity +
    // cacheAgeSeconds through. Raw queries always go live (no cache
    // layer); toEmit's defaults match.
    ...inputs.toEmit(response),
    kind: 'single',
  });
};
