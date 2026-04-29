# Security

Loaded automatically when editing `src/**/*.ts`, `tests/**/*.ts`, or
`.env*` files.

The CLI holds a Monday.com API token with the user's full account
permissions. Treat it like a password.

## Token handling rules

1. **Never log the token.** Not at any verbosity level. Not in error
   messages. Not in `--debug` mode. Not in telemetry. The logger
   (when added) must redact known-sensitive keys (`apiToken`,
   `Authorization`, `MONDAY_API_TOKEN`) before emit.
2. **Never include the token in `Error.message`.** Errors get printed,
   captured in shells, pasted into bug reports. If you're tempted to
   include "request was: ..." in an error, redact the auth header first.
3. **Never write the token to disk** unless the user explicitly opts in
   (e.g. a future `monday auth login` that caches credentials). When
   we do cache, the file lives at `~/.monday-cli/credentials` with mode
   `0600` and is excluded from any export/diagnostics command.
4. **Never echo the token on stdout** — even if the user asks for "the
   current config", redact it (`MONDAY_API_TOKEN: <set>` / `<unset>`,
   not the value).
5. **Never include the token in URLs** (query strings get logged by
   proxies, browsers, server access logs). Monday accepts only header
   auth anyway — there's no temptation here, but it's worth stating.

## Source priority for the token

```
process.env.MONDAY_API_TOKEN          (highest — explicit in current shell)
└── .env file in cwd                   (loaded by dotenv if present)
    └── ~/.monday-cli/credentials      (future — opt-in cached login)
```

CLI flags must NOT accept the token (`--token <value>`) — flags appear
in `ps`, shell history, and crash dumps. If a user really needs to pass
a token inline, they can do `MONDAY_API_TOKEN=... monday ...`, which
keeps it in the process env only.

## Fail-secure config

If `loadConfig()` rejects (missing token, bad URL, etc.), the CLI exits
**non-zero before any network call**. Never default to "anonymous" or
"public" mode silently — there is no public Monday API.

## Redaction in output

When emitting structured output (errors, debug, dry-runs) that may
contain headers or request bodies, redact via a single helper:

```ts
const redact = (obj: unknown): unknown => { /* deep-clone, replace any
  value at a known-sensitive key with "[REDACTED]" */ };
```

The helper lives in `src/utils/redact.ts` (when added). Tests assert
that known-sensitive shapes round-trip with the secret stripped.

## TLS

The SDK uses `graphql-request` over standard `fetch` — TLS verification
is on by default. Don't disable it. If the user is behind a corporate
proxy with self-signed certs, they should set `NODE_EXTRA_CA_CERTS`,
not `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## File permissions

Any file the CLI writes that contains the token (future credentials
cache, debug bundles) must be created with mode `0600` and verified
on read (`fs.fstat` + `mode & 0o077` check). Refuse to use a file
that's group/world-readable.

## Dependencies

- Run `npm audit` periodically; treat `high`/`critical` as merge
  blockers. The SDK itself pulls `graphql-request` — keep an eye on
  its advisories.
- Pin direct deps to tight-but-not-exact ranges (`^14.0.0`). Use
  `package-lock.json` (committed) for reproducibility.
- Never add a runtime dep without a clear need; CLI startup time is
  user-visible.

## Test fixtures

Recorded GraphQL responses in `tests/fixtures/` must not contain real
tokens, real user emails, or real workspace IDs. Use clearly synthetic
values (`token-fixture-xxxx`, `user@example.test`, `123456`). A test
that asserts on a redaction path is a good idea.

## Reporting

If you find a security issue while working on the CLI, **don't open a
public issue** describing it. Note it in your local context and
escalate to Nick directly.
