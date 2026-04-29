# Architecture

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
   │ cli/     │   argv parsing, top-level error handling, --help/--version
   └────┬─────┘
        │ resolves Config, dispatches to a command module
        ▼
   ┌──────────┐
   │ commands/│   one file per subcommand: parses options, calls api/,
   └────┬─────┘   formats result via utils/, returns exit code
        │
        ▼
   ┌──────────┐
   │ api/     │   thin wrapper over @mondaydotcomorg/api: holds the
   └────┬─────┘   ApiClient, normalises errors, applies retries/timeouts
        │
        ▼
   ┌──────────┐
   │ Monday   │   network — never reached directly from commands/
   └──────────┘
```

The hard rules:

- `commands/` never imports the SDK directly — always goes through `api/`.
  This keeps the SDK upgrade surface small and lets us swap clients
  (e.g. for fixture replay) by swapping one module.
- `api/` is pure I/O — no console output, no exit codes. It throws typed
  errors; the caller decides how to render them.
- `utils/` has no knowledge of Monday — it's generic formatting/logging.
- `config/` runs once at startup. After that, the resolved `Config` is
  passed explicitly to anything that needs it (no globals, no module-level
  singletons).

## Output contract

Every command must support:

- `--output json` (default for non-TTY, or when set): a single JSON value
  on stdout, nothing else. Errors go to stderr as a JSON object with at
  minimum `{ "error": { "code": string, "message": string } }`.
- `--output table` / `--output text` (default for TTY): human-friendly,
  may include colour and spinners.
- Exit codes: `0` success, `1` user/usage error, `2` API error,
  `3` config error, `>3` reserved.

This contract is part of the public surface — changes need a major version
bump.

## Error model

All thrown errors should be instances of a small set of named classes
defined in `src/utils/errors.ts` (to be added):

- `ConfigError` — invalid env/argv. Maps to exit code 3.
- `ApiError` — non-2xx GraphQL response, network failure, timeout. Holds
  the original SDK error as `cause`. Maps to exit code 2.
- `UsageError` — bad command-line args (missing required flag, mutually
  exclusive flags, etc.). Maps to exit code 1.

The CLI entry's catch-all converts `unknown` into one of these or re-throws.

## Testing layers

| Layer | Lives in | What it tests | Network? |
|-------|----------|---------------|----------|
| Unit | `tests/unit/` | Pure logic — config parsing, formatters, error mapping | No |
| Integration | `tests/integration/` | `commands/*` against a mocked GraphQL transport | No (mocked) |
| E2E | `tests/e2e/` | The compiled binary — spawn `node dist/cli/index.js`, assert stdout/exit | No (mocked) or yes (gated by env) |

E2E tests that hit the real Monday API must be gated behind an env flag
(e.g. `RUN_LIVE_TESTS=1`) and use a dedicated test workspace. The default
CI run never touches the network.
