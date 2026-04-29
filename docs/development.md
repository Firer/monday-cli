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

1. **Create the file:** `src/commands/<group>/<verb>.ts` — e.g.
   `src/commands/items/get.ts`. Export a `Command` (commander) instance,
   not a free function. Keep it thin: parse options → call `api/` →
   format → return.
2. **Add the API method:** if no method in `src/api/` covers the
   GraphQL operation, add one. The API module owns all knowledge of the
   GraphQL schema; commands consume typed objects.
3. **Register:** import the command in `src/cli/index.ts` and attach it
   to the right subcommand group.
4. **Test:**
   - `tests/unit/<group>/<verb>.test.ts` — argument parsing, formatter
     branches, error mapping.
   - `tests/integration/<group>/<verb>.test.ts` — mocks the SDK
     transport, asserts on the GraphQL request body and on the rendered
     output.
   - `tests/e2e/<group>/<verb>.test.ts` — spawn the compiled binary
     for any non-trivial command.
5. **Document:**
   - Update `docs/api-reference.md` if the command introduces a Monday
     concept the cheat sheet doesn't cover.
   - Update the README usage section if the command is part of the
     public surface.

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
