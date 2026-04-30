# Development

> **Before writing code:** read [`cli-design.md`](./cli-design.md). It
> defines the command surface, output envelope, error codes, and what's
> in v0.1 vs deferred. Implementation follows that contract; changes
> to the contract land via PRs that argue for the change.

## First-time setup

```bash
git clone <repo-url> monday-cli
cd monday-cli
npm install
cp .env.example .env
# edit .env — at minimum set MONDAY_API_TOKEN
```

## Running locally

```bash
npm run dev -- --help                    # tsx (no build, fastest iteration)
npm run build && npm start -- --help     # exercise the compiled binary
```

`npm link` will symlink the `monday` bin into your PATH after a build, so
you can use it from any directory.

## Quality gates

The project enforces three gates. Run all three before committing:

```bash
npm run typecheck
npm run lint
npm test
```

Or all at once:

```bash
npm run typecheck && npm run lint && npm test
```

## Adding a new command

The shape is established by M0–M3; new commands plug into it without
ceremony. Each step is small — read `src/commands/account/whoami.ts`
(simplest), `src/commands/board/list.ts` (page-based collection), and
`src/commands/board/describe.ts` (cache-aware single resource) for
working references.

### 1. Create the file: `src/commands/<group>/<verb>.ts`

Export a `CommandModule<Input, Output>` instance — never a free
function. The module bundles input + output schemas, examples, and an
`attach(program, ctx)` hook that wires commander.

```ts
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';

const inputSchema = z.object({ /* positionals + flags */ }).strict();
const outputSchema = z.object({ /* what we promise to emit */ }).strict();

export const myCommand: CommandModule<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: 'group.verb',
  summary: 'one-liner shown by --help',
  examples: ['monday group verb <arg>', 'monday group verb <arg> --json'],
  idempotent: true,                     // documented per command
  inputSchema,
  outputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'group', 'Group commands');
    noun
      .command('verb <arg>')
      .description(myCommand.summary)
      .addHelpText('after', /* "Examples:\n  ..." */)
      .action(async (arg: unknown, opts: unknown) => {
        const parsed = parseArgv(myCommand.inputSchema, {
          arg,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, toEmit } = resolveClient(ctx, program.opts());
        const result = await client.raw<...>(QUERY, vars, { operationName: 'X' });
        emitSuccess({
          ctx,
          data: outputSchema.parse(/* projection of result.data */),
          schema: myCommand.outputSchema,
          programOpts: program.opts(),
          ...toEmit(result),
        });
      });
  },
};
```

Key invariants:

- **Use `parseArgv`, never `inputSchema.parse`** at the action
  boundary. A raw `ZodError` would land as `internal_error` / exit 2;
  `parseArgv` wraps it as `usage_error` / exit 1 with structured
  `details.issues`. Mandatory per `validation.md`.
- **Use `resolveClient(ctx, program.opts())`** for any network
  command. It returns `{ client, globalFlags, apiVersion, toEmit }`,
  commits `meta.api_version` / `meta.source` for the error path, and
  closes over `apiVersion` so the success path can't drift.
- **Splat `...toEmit(result)`** into the `emitSuccess` options so
  `source` / `apiVersion` / `complexity` / `cacheAgeSeconds` flow
  in as required keys. Cache-aware commands construct the meta
  values directly (see `board describe` for the pattern).
- **Output schemas use `.strict()`** — they describe what we promise
  to emit, so internal drift fails fast. Upstream-data parsing inside
  `api/` should default to strip-mode (drop unknown SDK-added fields).

### 2. Add the API helper (when the command needs new GraphQL)

If no method on `MondayClient` covers the GraphQL operation, either
add a typed wrapper to `src/api/client.ts` or use `client.raw<T>()`
directly. The latter is fine for one-off shapes; the former when
multiple commands need it. Either way, the GraphQL string + the
projection schema live in `src/api/`, never in `commands/*`.

For shared cross-command logic (caching, name resolution, paginated
walks, filter parsing, item projection), add a focused module to
`src/api/` rather than duplicating it across commands. M3 added
`board-metadata.ts`, `columns.ts`, `resolvers.ts`, `walk-pages.ts`;
M4 added `pagination.ts` (cursor walker), `filters.ts` (`--where`
parser), `sort.ts` (per-page ID-asc), `item-projection.ts`
(canonical §6.2 / §6.3 item shape) for the same reason.

For commands sharing a *full action shape* (not just a logic helper),
the lightweight pattern is `src/commands/run-by-id-lookup.ts` (M4 R7)
— compresses `parseArgv → resolveClient → client.raw → not_found →
emit` into one call. Used by all five v0.1 get-by-id commands. Pick
this over per-command boilerplate when the shape is identical and
the only variation is the GraphQL query + collection key + error
detail key.

### 3. Page-based collections: use `walkPages`

Page-based list commands (Monday's `boards` / `workspaces` / `users`
/ `updates` queries — anything `limit:` + `page:`) go through the
shared walker. It enforces the `--limit-pages` cap and emits the
`pagination_cap_reached` warning when capped:

```ts
const result = await walkPages<unknown, RawBoards>({
  fetchPage: (page) => client.raw<RawBoards>(QUERY, { ..., page }, opts),
  extractItems: (r) => r.data.boards ?? [],
  pageSize: limit,
  all: parsed.all === true,
  startPage: parsed.page ?? 1,
  maxPages: parsed.limitPages ?? DEFAULT_MAX_PAGES,
});
const warnings: Warning[] = [];
if (parsed.all === true && result.hasMore) {
  warnings.push(buildCapWarning(result.pagesFetched));
}
```

### 3a. Cursor-based collections: use `paginate`

Cursor-based commands (`item list`, `item search`, `item find` —
anything via `items_page` → `next_items_page`) go through the
cursor walker in `src/api/pagination.ts`:

```ts
const result = await paginate<unknown, InitialResponse | NextResponse>({
  fetchInitial: (effectiveLimit) => client.raw<InitialResponse>(
    QUERY,
    { ..., limit: effectiveLimit },
    { operationName: 'X' },
  ),
  fetchNext: (cursor, effectiveLimit) => client.raw<NextResponse>(
    NEXT_QUERY,
    { cursor, limit: effectiveLimit },
    { operationName: 'XNext' },
  ),
  extractPage: (r) => /* shape into { cursor, items } */,
  getId: idFromRawItem,
  now: ctx.clock,                 // injected for deterministic
                                  // stale-cursor age tests
  all: parsed.all === true,
  ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  pageSize: parsed.pageSize ?? DEFAULT_PAGE_SIZE,
  // For NDJSON streaming:
  // onItem: (raw) => stdout.write(JSON.stringify(redact(project(raw))) + '\n'),
});
```

Hard rules:

- **`fetchInitial` / `fetchNext` MUST honour `effectiveLimit`** —
  the walker passes `min(pageSize, remainingBudget)` so Monday's
  cursor advances over exactly the rows the walker emits. Passing a
  larger constant `limit:` corrupts cursor state on `--limit <
  pageSize` resume (Codex M4 pass-2 §1).
- **`now: ctx.clock` is mandatory** — the §5.6 stale-cursor age
  computation uses this. Wall-clock breaks deterministic tests and
  can give wrong answers if the system clock skews mid-walk.
- **Don't catch `stale_cursor` and retry.** §5.6 forbids it
  (silent re-issue can duplicate or skip rows). The walker enriches
  the error with `details.cursor_age_seconds /
  items_returned_so_far / last_item_id` and re-throws; the runner's
  catch-all surfaces the §6.5 envelope.

### 4. Register

Import the module in `src/commands/index.ts` and append it to the
registry. `cli/program.ts` walks the registry to attach commander
commands; `commands/schema/index.ts` walks the same list to emit
JSON Schema 2020-12. Order is registration order is irrelevant
(`monday schema` sorts lexicographically).

### 5. Test

The pyramid:

- `tests/unit/<area>/<thing>.test.ts` — pure logic + helper modules.
  Example: `walkPages` cap behaviour, `findOne` ambiguity, the
  `exampleSetForColumn` per-type mapping. Drive every reachable
  branch (testing.md "every branch covered" rule); mark genuinely
  unreachable defensive guards with `/* c8 ignore */`.
- `tests/integration/commands/<noun>.test.ts` — drive
  `run({ transport: FixtureTransport })` end-to-end. Each command
  needs at least: happy path, one error code per noun (M2's pattern
  — `unauthorized` via HTTP 401 also pins the
  `--api-version 2026-04` → error envelope meta agreement, including
  on pre-`resolveClient` `usage_error` paths via the program's
  preAction hook — Codex M4 pass-2 §3), parse-boundary `usage_error`
  for any non-trivial input shape. Shared scaffolding lives in
  `tests/integration/helpers.ts` (M4 R6 — `baseOptions / drive /
  EnvelopeShape / parseEnvelope / assertEnvelopeContract`); new test
  files import from there.
- `tests/e2e/<area>.test.ts` — spawn the compiled binary against
  the in-process fixture HTTP server (`tests/e2e/fixture-server.ts`)
  for one command per noun. M3's E2E suite lives in
  `tests/e2e/m3.test.ts`; copy the shape.

**Hand-shaped objects are forbidden.** Tests must drive real argv
through commander (`program.parse(argv, { from: 'user' })` and pass
`program.opts()` through), not feed hand-shaped records into
`parseGlobalFlags` / input schemas. M0's review found this exact
shape silently passing — see `.claude/rules/testing.md` for the
canonical anti-pattern.

### 6. Document

- **`docs/cli-design.md`** — the binding contract. New command in §4.3
  command tree; new error code in §6.5; new warning code in §6.1.
  Design changes go through Codex review before merge (see
  `cli-design.md` history `ee3f288`, `5218ca0` for the pattern).
- **`docs/v0.1-plan.md`** — milestone block + post-mortem after Codex
  review. Spec gaps the implementation surfaced (e.g. M3's
  `--limit-pages` flag) are logged as backfill work in the
  milestone's exit block.
- **`CLAUDE.md`** — bump "Status" if a milestone shipped; bump
  "Contract at a glance" if a binding decision moved.
- **`docs/api-reference.md`** — add to the cheat sheet only if the
  command introduces a Monday concept not already covered.

## Testing against the live API

By default no test touches the network. To run live E2E tests:

```bash
export MONDAY_API_TOKEN=<test-workspace-token>
export RUN_LIVE_TESTS=1
npm run test:e2e
```

Live tests must use a dedicated test workspace — never a production one —
and must clean up everything they create (use `try { ... } finally
{ cleanup() }`).

## Releasing

Not yet defined. Will use changesets or similar once we have something
worth shipping.
