/**
 * `monday doc list [--workspace <wid>,...] [--order-by <created_at|
 * used_at>] [--limit <n>] [--page <n>]` — list workdocs visible to
 * the token, optionally filtered by workspace and sorted by recency
 * (cli-design.md §4.3 DOC section + §13 v0.4 entry; v0.4-plan.md §3
 * M32).
 *
 * **Wire shape.** Single `Query.docs(...)` round-trip via
 * {@link listDocuments} against `query ListDocs` with
 * `operationName: 'ListDocs'` (R-NEW-37 W2 audit-point). Page/limit
 * pagination — Monday's workdocs surface has no `items_page`-style
 * cursor; agents paginate by incrementing `--page`. The list row
 * projection ships every base Document field EXCEPT `blocks` per
 * D6 closure (rich-text bodies belong to `monday doc get <did>`).
 *
 * **Argv shape.**
 *
 *   - `--workspace <wid>,...` — comma-separated workspace ID
 *     filter (maps to wire `workspace_ids: [ID]`). Optional;
 *     absent → unfiltered (every visible doc across the account).
 *     Each entry is brand-validated via {@link WorkspaceIdSchema}.
 *     Inaccessible workspace IDs surface as empty filter results
 *     per D4 — Monday's wire silently drops unknown workspace IDs
 *     rather than rejecting the call; the CLI doesn't fire a
 *     resolver warning because the wire doesn't distinguish "no
 *     docs in workspace X" from "X not accessible".
 *   - `--order-by <created_at|used_at>` — pinned 2-value enum
 *     (per the M32 probe of `DocsOrderBy`). Default
 *     `created_at`. Both values sort `desc` server-side; no
 *     ascending variant on Monday's wire.
 *   - `--limit <n>` — `[1, 100]`, default `25` (matches Monday's
 *     wire-side default; ceiling pins worst-case payload size).
 *     Out-of-range argv rejects at parse boundary with
 *     `usage_error` (no wire call fires).
 *   - `--page <n>` — 1-based, default `1`. Out-of-range argv
 *     rejects at parse boundary.
 *
 * **Output envelope (D9).** Wrapped record `data: { documents:
 * [Document], page, limit, returned_count, has_more }`.
 * `has_more` is the `returned_count === limit` heuristic —
 * Monday's wire doesn't surface a total count, so "exactly limit
 * rows returned" is the only signal that a follow-up page may
 * exist. Agents that need exhaustive listing loop until
 * `has_more: false`.
 *
 * **Docs are live-only at v0.4-M32** per cli-design §8 cache
 * scope. Output `meta.source: "live"`, `meta.cache_age_seconds:
 * null`. Workdocs are content-heavy + frequently human-edited; the
 * stale-cache risk outweighs the cache-hit value.
 *
 * **Idempotent: yes** (pure read).
 *
 * **Runtime body landed at v0.4-M32 IMPL.** Argv parsing + schema +
 * commander wiring + `--workspace` comma-split helper all ship as
 * the real shipped argv surface; the action body's wire-call
 * dispatch + envelope emit are below. The verb is a thin wrapper
 * around {@link listDocuments} — comma-split argv → branded array
 * → fetcher → envelope.
 */
import { z } from 'zod';
import { UsageError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { WorkspaceIdSchema } from '../../types/ids.js';
import {
  DEFAULT_DOC_LIST_LIMIT,
  MAX_DOC_LIST_LIMIT,
  MIN_DOC_LIST_LIMIT,
  docListOutputSchema,
  docsOrderBySchema,
  listDocuments,
  type DocListOutput,
} from '../../api/documents.js';

const inputSchema = z
  .object({
    /**
     * Raw comma-separated workspace IDs (e.g. `"123,456"`). Split +
     * brand-validated inside the action body so the per-entry parse
     * boundary fires AFTER the top-level argv parse — keeps the
     * error envelope's `details.issues[].path` pointing at the
     * `--workspace` argv slot rather than a per-entry index.
     */
    workspace: z.string().min(1, '--workspace must not be empty').optional(),
    orderBy: docsOrderBySchema.optional(),
    limit: z
      .number()
      .int({ message: '--limit must be an integer' })
      .min(MIN_DOC_LIST_LIMIT, {
        message: `--limit must be at least ${String(MIN_DOC_LIST_LIMIT)}`,
      })
      .max(MAX_DOC_LIST_LIMIT, {
        message: `--limit must be at most ${String(MAX_DOC_LIST_LIMIT)} ` +
          `(M32 pins the ceiling to keep worst-case response sizes bounded ` +
          `for doc-heavy accounts)`,
      })
      .optional(),
    page: z
      .number()
      .int({ message: '--page must be an integer' })
      .min(1, { message: '--page is 1-based and must be at least 1' })
      .optional(),
  })
  .strict();

export const docListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocListOutput
> = {
  name: 'doc.list',
  summary: 'List workdocs visible to the token (optional workspace filter)',
  examples: [
    'monday doc list',
    'monday doc list --workspace 12345',
    'monday doc list --workspace 12345,67890 --order-by used_at --limit 50',
    'monday doc list --page 2 --limit 25 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: docListOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(
      program,
      'doc',
      'Document commands (workdocs; read-only at v0.4 — see cli-design §13 v0.4 entry)',
    );
    noun
      .command('list')
      .description(docListCommand.summary)
      .option(
        '--workspace <list>',
        'Comma-separated workspace IDs to filter docs by (e.g. "12345,67890"). Inaccessible workspace IDs return no docs.',
      )
      .option(
        '--order-by <field>',
        'Sort field; one of: created_at (default), used_at. Both sort desc; no ascending variant on the wire.',
      )
      .option(
        '--limit <n>',
        `Page size, range [${String(MIN_DOC_LIST_LIMIT)}, ${String(MAX_DOC_LIST_LIMIT)}]; default ${String(DEFAULT_DOC_LIST_LIMIT)}.`,
        parseStrictDecimal,
      )
      .option(
        '--page <n>',
        '1-based page number; default 1.',
        parseStrictDecimal,
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docListCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          `  - Default limit ${String(DEFAULT_DOC_LIST_LIMIT)} matches Monday's wire-side default.`,
          '  - has_more in the envelope is a returned_count === limit heuristic (Monday\'s wire doesn\'t surface a total count).',
          '',
        ].join('\n'),
      )
      .action(
        async (opts: {
          workspace?: string;
          orderBy?: string;
          limit?: number;
          page?: number;
        }) => {
          const parsed = parseArgv(docListCommand.inputSchema, {
            ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
            ...(opts.orderBy === undefined ? {} : { orderBy: opts.orderBy }),
            ...(opts.limit === undefined ? {} : { limit: opts.limit }),
            ...(opts.page === undefined ? {} : { page: opts.page }),
          });

          // Parse `--workspace` once at the boundary so a malformed
          // workspace ID surfaces `usage_error` ahead of any wire
          // call. Empty entries (trailing comma, double comma) reject
          // with a clear hint. Brand each entry via WorkspaceIdSchema
          // so a non-numeric token reaches the agent with the same
          // brand-error shape every other ID validator uses.
          const workspaceIds: readonly string[] | undefined =
            parsed.workspace === undefined
              ? undefined
              : parseWorkspaceListArg(parsed.workspace);

          const { client, apiVersion } = resolveClient(ctx, program.opts());
          const result = await listDocuments({
            client,
            ...(workspaceIds === undefined ? {} : { workspaceIds }),
            ...(parsed.orderBy === undefined ? {} : { orderBy: parsed.orderBy }),
            ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
            ...(parsed.page === undefined ? {} : { page: parsed.page }),
          });
          const returnedCount = result.documents.length;
          emitSuccess({
            ctx,
            data: {
              documents: [...result.documents],
              page: result.page,
              limit: result.limit,
              returned_count: returnedCount,
              has_more: returnedCount === result.limit,
            },
            schema: docListCommand.outputSchema,
            programOpts: program.opts(),
            kind: 'single',
            warnings: [],
            source: result.source,
            cacheAgeSeconds: result.cacheAgeSeconds,
            complexity: result.complexity,
            apiVersion,
          });
        },
      );
  },
};

/**
 * Strict decimal-integer parser for commander option-value coercion
 * on `--limit` + `--page`. `Number.parseInt` would silently truncate
 * `'25.5'` → `25` and `'25abc'` → `25`, bypassing the schema-layer
 * `.int()` check (Codex round-1 P2-1). The strict variant returns
 * `Number.NaN` for any input that isn't a decimal-integer string;
 * the schema's `.int()` then rejects `NaN` and the user sees a
 * `usage_error` with the per-flag bound-violation message.
 *
 * Leading-zero handling: a single `0` is accepted (range floor is
 * enforced separately by the schema), but `'01'` / `'007'` are
 * rejected because Monday's wire IDs and page numbers never carry
 * leading zeros + the strict shape matches `DECIMAL_USER_ID_PATTERN`
 * elsewhere in the codebase.
 */
const parseStrictDecimal = (raw: string): number => {
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
    return Number.NaN;
  }
  return Number.parseInt(raw, 10);
};

/**
 * Splits a comma-separated `--workspace` argv string into an array of
 * brand-validated WorkspaceId strings. Empty entries reject with
 * `usage_error`; non-numeric entries reject via the WorkspaceIdSchema
 * brand. Whitespace around commas is trimmed.
 *
 * Exported via {@link _internals} only for parity with the existing
 * comma-split-helper pattern in `src/commands/workspace/add-users.ts`
 * — production code calls it inline within the command's action
 * body.
 */
const parseWorkspaceListArg = (raw: string): readonly string[] => {
  const tokens = raw.split(',').map((t) => t.trim());
  const ids: string[] = [];
  for (const token of tokens) {
    if (token === '') {
      throw new UsageError(
        '--workspace contains an empty entry (trailing comma or double ' +
          'comma); pass a comma-separated list of numeric workspace IDs.',
        {
          details: {
            hint:
              'e.g. --workspace 12345,67890 — no leading, trailing, or ' +
              'duplicate commas',
            argv_value: raw,
          },
        },
      );
    }
    const parsed = WorkspaceIdSchema.safeParse(token);
    if (!parsed.success) {
      throw new UsageError(
        `--workspace entry ${JSON.stringify(token)} is not a numeric ` +
          `workspace ID`,
        {
          details: {
            issues: parsed.error.issues.map((i) => ({
              path: i.path.map((p) => String(p)).join('.'),
              message: i.message,
            })),
            argv_value: raw,
            hint: 'workspace IDs are numeric (e.g. 12345)',
          },
        },
      );
    }
    ids.push(parsed.data);
  }
  return ids;
};

/**
 * Internals exposed for unit-test access (argv parser pinning).
 * NOT a public API — the comma-split helper + decimal parser stay
 * production-internal.
 */
export const _internals = {
  parseWorkspaceListArg,
  parseStrictDecimal,
} as const;
