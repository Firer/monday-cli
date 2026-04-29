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

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `1`  | Usage error — bad flags, missing required args, unknown command |
| `2`  | API error — Monday returned an error or the network failed |
| `3`  | Config error — missing/invalid token, malformed config |
| `>3` | Reserved for future use |

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

The top-level `program.parseAsync(argv).catch(...)` in `cli/index.ts`
handles all rejections; never `process.exit(1)` from inside an action.

## Versioning + commits

- **Semantic Versioning.** Major bumps for breaking output/exit-code
  changes (those are part of the contract); minor for new commands;
  patch for bug fixes.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`). Generates a changelog cleanly when we automate
  releases.
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
