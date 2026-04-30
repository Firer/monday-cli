# Architecture

> **Canonical contract:** the binding decisions about command surface,
> output envelope, error codes, and divergences from Monday's API live
> in [`cli-design.md`](./cli-design.md). This file describes the
> *internal* module structure that implements that contract.

## Goals (in priority order)

1. **AI-agent ergonomics.** Output should be predictable, parseable
   (default `--output json`), and stable across versions. Errors should
   carry enough structured context that an agent can recover or escalate
   without scraping prose. Side-effecting commands should be idempotent
   where the API allows.
2. **Type safety.** Every Monday entity that crosses a module boundary
   has an explicit type. Parsing is done at the edge (zod for env/argv,
   the SDK's generated types for GraphQL responses) so internal code
   only handles validated data.
3. **Composability.** A user (human or agent) should be able to chain
   commands with shell pipes — e.g. `monday items list ... | jq ... |
   xargs monday items update ...`. This shapes I/O design more than
   any single command.
4. **Human ergonomics, second.** Pretty tables, colour, spinners — but
   only when stdout is a TTY and `--output json` is not set.

## Module boundaries

```
   ┌──────────┐
   │ cli/     │   argv parsing, signal/abort plumbing, envelope emission
   └────┬─────┘
        │ resolves Config, dispatches to a command module via the registry
        ▼
   ┌──────────┐
   │ commands/│   one CommandModule per subcommand: parses argv, calls
   └────┬─────┘   api/, validates output, emits the §6 envelope
        │
        ▼
   ┌──────────┐
   │ api/     │   MondayClient over an injectable Transport: typed
   └────┬─────┘   errors, retries, abort threading, complexity surfacing
        │
        ▼
   ┌──────────┐
   │ Monday   │   network — never reached directly from commands/
   └──────────┘
```

### `cli/` (the runtime core)

- `cli/index.ts` — 5-line shebang entry; thin `runWithSignals` wrapper.
- `cli/run.ts` — testable runner: argv → commander parse → action body
  → envelope → exit code. Combines a caller-supplied abort signal with
  an internal one so SIGINT cancels in-flight work.
- `cli/program.ts` (M2.5) — commander wiring: program metadata, global
  flag declarations, command registration. Pulled out of `run.ts` so
  the runner stays focused on I/O plumbing.
- `cli/envelope-out.ts` (M2.5) — `MetaBuilder` + `writeErrorEnvelope`.
  The error path's source of truth for `meta.api_version` /
  `meta.source` so a thrown action error carries the same meta a
  success would.

### `commands/` (one CommandModule per verb)

- `commands/types.ts` — `CommandModule<I, O>` interface + the
  `ensureSubcommand` idempotent noun-creator.
- `commands/index.ts` — static registry. `cli/program.ts` walks it to
  attach commands; `commands/schema/index.ts` walks the same registry
  to emit JSON Schema 2020-12.
- `commands/emit.ts` — `emitSuccess` builds the §6 success envelope.
  Owns format selection (json / table / text / ndjson), the
  collection-meta passthrough (`nextCursor`, `hasMore`,
  `totalReturned`, `columns`), and final-byte token redaction.
- `commands/parse-argv.ts` (M3) — wraps `schema.safeParse` so
  positional/flag failures land as `usage_error` (exit 1), never the
  runner's catch-all `internal_error` (exit 2). Mandatory at every
  argv parse boundary per `validation.md`.
- `commands/<noun>/<verb>.ts` — the action. Parses argv via
  `parseArgv`, calls into `api/`, projects to the strict output
  schema, calls `emitSuccess({ ...toEmit(result) })`.

### `api/` (network + cache)

- `api/transport.ts` — `Transport` interface + `FetchTransport`. Owns
  header lockdown (`Authorization`, `API-Version`, `Content-Type` are
  transport-controlled; caller headers can't override) and timeout +
  abort signal combination.
- `api/client.ts` — `MondayClient` over `Transport`. Typed wrappers
  for the M2 account queries; `client.raw<T>(query, vars, opts)` is
  the escape hatch for queries the SDK doesn't type
  (`hierarchy_type` / `is_leaf` in M3, future `BatteryValue` etc.).
- `api/resolve-client.ts` (M2.5) — `resolveClient(ctx, programOpts)`
  returns `{ client, globalFlags, apiVersion, toEmit }`. Every
  network command calls this once at the action's top.
- `api/errors.ts` — maps Monday HTTP / GraphQL responses to the 26
  stable CLI error codes from §6.5.
- `api/retry.ts` — exponential backoff + jitter, honours
  `retry_after_seconds` and the abort signal.
- `api/cache.ts` — disk-backed cache primitives: per-board metadata,
  per-account user directory, schema version pin. `0600` mode +
  atomic writes (tmp + rename) + permission verification on read.
- `api/board-metadata.ts` (M3) — cache-aware `loadBoardMetadata`
  shared by `board describe` / `columns` / `groups`. Returns
  `{ metadata, source, cacheAgeSeconds, complexity }` so verbose-mode
  complexity flows through cache-aware commands.
- `api/columns.ts` (M3) — read-side §5.3 column resolver:
  `resolveColumn(metadata, token, options) → ColumnMatch` (pure) +
  `resolveColumnWithRefresh({...})` (auto-refreshes once on
  `column_not_found` after a cache hit). M5a's value translator will
  reuse this for `--set <token>=<value>`.
- `api/resolvers.ts` (M3) — `findOne(haystack, query, project,
  options)` for the `find` verb (NFC + case-fold + `--first`); plus
  `userByEmail` with directory-cache + `users(emails:)` fallback for
  M5a's people-column writes.
- `api/walk-pages.ts` (M3) — page-based pagination walker with
  `--limit-pages` cap + `pagination_cap_reached` warning. Used by
  every page-based list command. Cursor pagination (M4 `item list`)
  will get its own walker — the `stale_cursor` fail-fast contract
  (§5.6) doesn't apply to page-based reads.

### Hard rules

- `commands/` never imports the SDK directly — always goes through
  `api/`. Keeps the SDK upgrade surface small and lets the test stack
  swap `Transport` for a `FixtureTransport` without monkey-patching.
- `api/` is pure I/O — no console output, no exit codes. It throws
  typed errors; `commands/`'s action handler decides how to render
  them via `emit.ts` / the runner's catch-all.
- `utils/` has no knowledge of Monday — it's generic formatting,
  redaction, logging, output renderers.
- `config/` runs once per `run()` call. The resolved `Config` is
  passed explicitly to anything that needs it (no globals, no
  module-level singletons).

## Output contract

Every command must support:

- `--output json` (default for non-TTY, or when set): a single JSON
  envelope on stdout, nothing else. Errors go to stderr as a §6.5
  envelope with a stable `error.code`.
- `--output table` / `--output text` (default for TTY, single-resource
  only): human-friendly, may include colour. NDJSON is collection-only.
- Exit codes: `0` success, `1` usage error, `2` API/network error,
  `3` config error, `130` SIGINT, `>3` reserved.

The full envelope contract — `meta` skeleton, error fields, the 26
stable error codes — lives in `cli-design.md` §6 and is enforced by
the integration suite's envelope-contract assertion (`assertEnvelope
Contract`) on every M2+ command's output. Adding fields to `meta` or
`data` is non-breaking; removing or renaming is a major version bump.

## Error model

Thrown errors are instances of the typed family in `src/utils/errors.ts`,
all sharing a base class with a stable `code` from the v0.1 frozen
26-code set:

- `UsageError` — bad flags / missing required positionals / mutually
  exclusive inputs. Exit 1.
- `ConfirmationRequiredError` — destructive op without `--yes`. Exit 1
  (grouped with usage per §3.1 #5).
- `ConfigError` — invalid env / missing token / malformed config.
  Exit 3.
- `ApiError` — non-2xx GraphQL, network failure, timeout, validation.
  Most M3 cassette-driven failures land here. Exit 2.
- `CacheError` — local cache I/O failure. Auto-retried without cache;
  exit 2 if it surfaces.
- `InternalError` — last-resort code for unknown thrown values
  (signals a CLI bug). Exit 2.

The runner's catch-all in `cli/run.ts` converts any `unknown` thrown
into one of these via `toMondayError` (in `envelope-out.ts`) and emits
the §6.5 error envelope on stderr before exiting. Two layers of
redaction (key-based + value-scan over the live token) run on the
envelope before bytes hit the stream — see `.claude/rules/security.md`
for the canary discipline.

A raw `ZodError` reaching the catch-all becomes `internal_error` /
exit 2; argv schemas wrap with `parseArgv`, env / config schemas wrap
in `loadConfig`, response schemas wrap inside `api/` so a parse
failure at the right boundary surfaces as `usage_error` / `config_error`.

## Testing layers

| Layer | Lives in | What it tests | Network? |
|-------|----------|---------------|----------|
| Unit | `tests/unit/` | Pure logic — config parsing, error mapping, formatters, redaction, helper modules | No |
| Integration | `tests/integration/` | `run({ transport: FixtureTransport })` end-to-end — argv → commander → action → envelope, with a cassette replacing the network | No (mocked) |
| E2E | `tests/e2e/` | The compiled binary — spawn `node dist/cli/index.js`, assert stdout / stderr / exit code against an in-process HTTP fixture server | No (mocked) or yes (gated by `RUN_LIVE_TESTS=1`) |

### Test infrastructure

- **`tests/fixtures/load.ts`** — cassette format (`Cassette` =
  ordered `Interaction[]`, each with `operation_name` /
  `match_query` / `match_variables` / `expect_headers` / `response`
  / `repeat`) + the `FixtureTransport` integration tests inject via
  `run({ transport })`.
- **`tests/e2e/fixture-server.ts`** — an in-process HTTP server that
  replays the same cassette format over real HTTP, so spawned-binary
  E2E tests exercise the production `FetchTransport` end-to-end.
- **`tests/e2e/spawn.ts`** — `spawnCli({ args, env })` helper that
  fails fast with a clear hint if `dist/cli/index.js` is stale.
- **`tests/integration/redaction-hardening.test.ts`** — adversarial
  token-leak suite (Codex M0 §1 / M2 §4 follow-up). Asserts the
  literal canary token is absent from every emitted byte across 9
  failure shapes (Error.message, Error.stack, cause chains,
  redirected URLs, retry-decorator details, etc.).

E2E tests that hit the real Monday API must be gated behind
`RUN_LIVE_TESTS=1` and use a dedicated test workspace — the default
CI run never touches the network. Coverage thresholds live in
`vitest.config.ts` (lines/functions/statements: 95, branches: 94 —
ratchet upward as new code lands; never lower).
