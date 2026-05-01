# CLI standards

Loaded automatically when editing `src/cli/**` or `src/commands/**`.

These are the industry-standard patterns a polished Node CLI is expected
to follow. Most are zero- or low-cost; skipping them is the kind of
thing reviewers spot in five seconds.

## Output discipline

- **stdout is for the result; stderr is for everything else.** Progress
  spinners, warnings, debug logs → stderr. Pipe-friendliness depends
  on this rule. `monday items list | jq ...` must work.
- **Default to JSON for non-TTY stdout.** Detect via
  `process.stdout.isTTY`. When piping or redirecting, the user (or
  agent) wants machine-parseable output, not coloured tables.
- **Respect `NO_COLOR` and `FORCE_COLOR`.** chalk honours these
  automatically — don't override.
- **Respect `CI=true`.** No spinners, no animated output. ora detects
  CI and degrades gracefully — verify before relying on it.
- **No emoji in stdout** (it breaks JSON consumers and assistive tech).
  Stderr-only if at all, behind a `--no-emoji` opt-out.

## Exit codes (stable, documented surface)

| Code  | Meaning |
|-------|---------|
| `0`   | Success |
| `1`   | Usage error — bad flags, missing required args, unknown command, `confirmation_required` |
| `2`   | API error — Monday returned an error or the network failed |
| `3`   | Config error — missing/invalid token, malformed config |
| `130` | SIGINT (Ctrl-C). Set by the SIGINT handler before exit. No envelope on stderr — the exit code is the signal. |
| other | Reserved for future use |

Document these in the README and never reuse codes for different
meanings. Agents key off them.

## Help text

- Every command has a one-line description (`.description(...)`) and
  ≥1 usage example (`.addHelpText('after', '...')`).
- Show the example with `monday <cmd>`, not `$ monday <cmd>` — the
  `$` is noise that breaks copy-paste.
- Required flags are marked `<required>`, optional `[optional]`
  (commander's convention).
- Where there's a related command, cross-reference it in `--help`
  ("See also: monday items create").

## Signal handling

- Handle `SIGINT` (Ctrl-C) gracefully: cancel in-flight requests, flush
  any partial output, exit `130`. Don't dump a stack trace.
- Long-running commands (paginated fetches, bulk updates) check for
  cancellation between iterations. Use an `AbortController` threaded
  through to `client.request({ signal })` (the SDK supports it via the
  underlying fetch).

## Stdin

- Commands that take a "thing to operate on" should accept it from
  stdin when no positional arg is given and stdin is not a TTY:
  ```bash
  echo "item-id" | monday items get
  monday items list | jq -r '.[].id' | xargs monday items archive
  ```
- Document the stdin contract in `--help`.

## Idempotency

- Side-effecting commands document whether they're idempotent. If yes,
  re-running with the same args is safe (Monday's `change_*` mutations
  are usually idempotent; `create_*` is not — adding the same item
  twice creates two items).
- For non-idempotent commands, support `--dry-run` so an agent can
  preview the change before committing.

## Async + commander

Commander action handlers can be async, but errors from them are not
caught by the top-level `parseAsync` rejection unless awaited. The
shape we use:

```ts
program
  .command('foo')
  .action(async (opts: unknown) => {
    const parsed = fooOptionsSchema.parse(opts); // zod validates flags
    await runFoo(parsed);                         // throws on failure
  });
```

The top-level `program.parseAsync(argv).catch(...)` in `cli/run.ts`
handles all rejections; never `process.exit(1)` from inside an action.

## Commander's runtime option shape (don't trust the schema in your head)

Commander's `program.opts()` does *not* match what your option
declarations look like. Three traps caught by Codex review during
M0 — the schema declared one shape, the runtime emitted another,
and the tests passed because they fed hand-shaped objects rather
than driving real argv:

| Declaration | argv | `program.opts()` produces |
|-------------|------|---------------------------|
| `--no-cache` | `--no-cache` | `{ cache: false }` |
| `--no-color` | `--no-color` | `{ color: false }` |
| `--columns <list>` | `--columns id,name` | `{ columns: 'id,name' }` (string, **not** array — commander does not split) |
| `--width <n>` | `--width 120` | `{ width: '120' }` (string — schema must coerce) |
| `--retry <n>` | `--retry 3` | `{ retry: '3' }` (string) |
| `--timeout <ms>` | `--timeout 5000` | `{ timeout: '5000' }` (string) |
| `--json` | `--json` | `{ json: true }` |
| `--json` | (absent) | `json` is `undefined` (schema must default) |

Two consequences:

1. **The zod schema for global flags must accept commander's actual
   shape on the boundary**, not the consumer-friendly shape. Project
   to the friendly shape (`noCache`, `noColor`, `columns: string[]`)
   in a normaliser function below the schema, not in the schema
   itself. See `src/types/global-flags.ts` (`globalFlagsRawSchema`
   + `parseGlobalFlags`) for the pattern.
2. **Tests that drive flags must drive real argv through commander.**
   Hand-shaped objects (`schema.parse({ noCache: true })`) lie
   about what production sees. The unit suite for global flags
   builds a real `Command`, calls `program.parse(argv, { from:
   'user' })`, then passes `program.opts()` to `parseGlobalFlags`.
   If you skip this step, your "every flag has a unit test" claim
   is hollow — that's exactly what M0 shipped before review.

## Versioning + commits

- **Semantic Versioning.** Major bumps for breaking output/exit-code
  changes (those are part of the contract); minor for new commands;
  patch for bug fixes.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`). Generates a changelog cleanly when we automate
  releases.
- **Atomic and incremental.** Each commit is one self-contained unit
  of progress: small enough to revert cleanly, large enough to stand
  alone (one command + its tests + its docs is the canonical chunk).
  Don't bundle unrelated changes into one commit; don't split a
  coherent change into many. If a commit's diff doesn't tell a single
  story, split it.
- **Messages explain WHY and HOW, not WHAT.** The diff is the WHAT;
  beautiful self-documenting code with named identifiers reinforces
  it. The message is for the *motivation* (constraint, bug, decision
  forcing the change) and the *approach* (the load-bearing design
  choice, the alternative we rejected). "added X, removed Y" prose
  is wasted lines.

  Bad:

  ```
  feat: add item set command

  - Adds src/commands/item/set.ts
  - Adds tests for the set command
  - Wires it up in cli/index.ts
  ```

  Good:

  ```
  feat: add item set — single-column writes via the friendly translator

  Lands the smallest user-visible mutation so the column-value
  abstraction (§5.3) gets exercised against real fixtures before
  multi-column bulk and dry-run pile on. Picks the simple-vs-rich
  mutation per column type so dry-run reports the right operation.
  Errors `unsupported_column_type` for non-allowlisted types with
  `deferred_to: "v0.2"` in `details` — points agents at the v0.2
  writer-expansion milestone rather than a v0.1 escape hatch
  that doesn't exist.
  ```

  If a change doesn't have a meaningful why/how worth saying, the
  subject line alone is fine. Short beats padded.
- One feature/fix per PR. Keeps the changelog readable.

## Dependencies

- Every new runtime dep adds startup latency. Audit before adding.
- Prefer stdlib (`node:fs/promises`, `node:url`, `node:path`) over
  npm packages for things stdlib does fine.
- Pin major versions in `package.json` (`^14.0.0`); commit
  `package-lock.json` for reproducibility.
- `npm audit` clean before release; treat `high`/`critical` as merge
  blockers.

## Documentation

- Every command's source file has a top-of-file comment naming the
  Monday GraphQL operation(s) it calls — agents grep for this when
  planning changes.
- Public output formats (JSON shapes) are documented and treated as a
  stable surface. Schema additions are minor; renames/removals are
  major.
