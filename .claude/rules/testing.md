# Testing standards

Loaded automatically when editing `tests/**/*.ts`.

## Coverage standard

The bar is **every branch covered**. That is:

- **Happy path** — the documented, successful use of the function/command.
- **Edge cases** — empty inputs, max-size inputs, boundaries, off-by-one
  candidates, Unicode/whitespace, idempotency.
- **Error cases** — every `throw`, every `catch`, every rejection. Assert
  on the error type and message — not just "it threw".
- **Format variations** — every value of an enum/discriminated union.
  Lint's `switch-exhaustiveness-check` only catches `switch` statements;
  if your code branches on a string union via `if/else`, your tests must
  hit every arm.

The numeric thresholds in `vitest.config.ts` (90% / 90% / 90% / 90%) are a
**floor**, not a target. The target is "every branch I can name". Raise
the floor as the codebase grows; never lower it.

### `c8 ignore` syntax gotcha (vitest v8 provider)

When marking a genuinely defensive branch as ignored, the `/* c8 ignore
next N */` directive **must be a single-line comment immediately above
the line(s) being ignored.** Multi-line block comments break it:

```ts
// ❌ Doesn't work — the directive spans two lines so v8 doesn't honor it
/* c8 ignore next 4 — defensive: schema's `.min(1)` rejects empty
   arrays. */
const board = data.boards[0];
if (board === undefined) {
  throw new ApiError('internal_error', '...');
}

// ✅ Works — directive is a single-line comment
// Defensive: schema's `.min(1)` rejects empty arrays.
const board = data.boards[0];
/* c8 ignore next 3 */
if (board === undefined) {
  throw new ApiError('internal_error', '...');
}
```

Two-line variant — directive on its own line, explanation either above
or below — also works:

```ts
/* c8 ignore next 3 */
// Defensive: caller passes non-empty matches.
if (resolved.length === 0) {
  throw new ApiError('internal_error', '...');
}
```

If you need a longer explanation, write the comment on a separate line
from the directive. The line-counting starts AFTER the directive's
closing `*/`, so embedding prose inside the directive comment confuses
the parser. Symptom: a defensively-guarded branch shows up as uncovered
even though the directive looks correct. M12's upsert.ts lift recovered
8 branches across 4 sites by converting multi-line directives to the
single-line form.

## Test layers

| Layer | Path | Allowed | Forbidden |
|-------|------|---------|-----------|
| Unit | `tests/unit/` | Pure imports from `src/`, in-memory data | Network, fs writes outside `os.tmpdir`, child processes |
| Integration | `tests/integration/` | Mocked SDK transport (e.g. `vi.spyOn(client, 'request')`), in-process command invocation | Real network, real binary spawn |
| E2E | `tests/e2e/` | `child_process.spawn(node, ['dist/cli/index.js', ...])`, mocked transport via env-injected URL | Real Monday API unless `RUN_LIVE_TESTS=1` |

## Mocking rules

- **Mock at the network boundary, not internal modules.** Stub
  `client.request` (the SDK's escape hatch) or `fetch`/`undici` —
  not `commands/items/get.ts`'s helpers. The point is to verify the
  real code path under realistic inputs.
- **Restore mocks in `afterEach`.** Use `vi.restoreAllMocks()` or
  `vi.resetAllMocks()` consistently — pick one per file.
- **Fixtures live in `tests/fixtures/`** as `.json` files keyed by the
  query they record. Loaders go in `tests/fixtures/load.ts`.

## Assertions

- Prefer `toMatchObject` over `toEqual` when you only care about a subset
  of fields — keeps tests robust to harmless additions.
- Snapshot tests are allowed for stable structured output (e.g. table
  formatter). Use inline snapshots (`toMatchInlineSnapshot`) for
  small outputs so the assertion lives next to the test.
- For thrown errors: `expect(() => fn()).toThrow(ErrorClass)` then
  separately `expect(() => fn()).toThrow(/specific message/)` — both
  type and message are part of the contract.

## Naming

- File: `<unit-under-test>.test.ts` — colocated under the matching
  `tests/<layer>/` path.
- `describe` block: name of the function/class/command.
- `it` block: a sentence that completes "it ___" — `it('rejects empty
  inputs', ...)`, not `it('test empty', ...)`.

## Anti-patterns to avoid

- **Tests that assert on implementation details** (call counts on internal
  helpers, exact log strings the user never sees). Assert on observable
  behaviour.
- **Shared state between tests.** Each `it` is independent. If setup is
  expensive, use `beforeEach` (not `beforeAll` unless you guarantee
  no mutation).
- **Skipping the unhappy path.** A test file that only covers the happy
  path is incomplete and will be sent back at review.
- **Hand-shaping objects that production assembles from somewhere
  else.** If a function consumes the result of `program.opts()`, the
  test must build a real `Command`, parse argv through it, and pass
  `program.opts()` through — not a hand-shaped record. The same
  rule applies for any wire-format-derived input: GraphQL responses
  go through fixture cassettes, not freehand objects; parsed config
  comes from a tmp-dir `.env` file, not a literal `{}`. Hand-shaped
  inputs lie about what production sees and let schema/runtime
  drift sit unnoticed (M0's "every flag is unit-tested" claim
  stayed green for two days because of this exact mistake — Codex
  review §4–§6 caught it).
- **Hand-thrown typed errors as "real path" coverage.** A test that
  registers an action which `throw new ConfigError(...)` does not
  prove that `loadConfig({})` actually produces a `ConfigError`. If
  the contract says "exit 3 on missing token", drive the real
  invocation that loads config and bypass any throw fixtures —
  otherwise the test passes while the real path returns `internal_
  error` / exit 2. Same pattern for `UsageError`, `ApiError`, etc.
