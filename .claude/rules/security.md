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

Every output path funnels through `src/utils/redact.ts`. Two layers,
**both required** — a key-based filter alone is not enough:

1. **Key-based filter.** Values under sensitive keys (`apiToken`,
   `Authorization`, `MONDAY_API_TOKEN`, plus a generic
   `(token|secret|password|api[-_]?key)` regex) are replaced
   wholesale.
2. **Value-scanning filter.** When the runtime knows the token
   value (loaded from env at startup), every string in the tree is
   scanned and any occurrence of the literal token is replaced with
   `[REDACTED]`. This is what catches the token landing in
   `Error.message`, `Error.stack`, `Error.cause.message`, fetch
   URLs, debug payloads — any unkeyed string.

Why both: a key-only filter passed all the M0 tests but leaked tokens
in `Error.message` (Codex review §1 caught this). The runner threads
`MONDAY_API_TOKEN` from env into `redact()` via the `secrets` option
so unkeyed string occurrences get scrubbed. Adversarial test shapes
the redaction suite must cover:

- token in a vanilla `Error.message`,
- token in `Error.stack`,
- token in `Error.cause.message` (chained),
- token in a lowercase `authorization` header value,
- token in a URL string,
- token alongside other content (`auth=<tok> expired` → substring
  replacement preserves debug context while removing the bytes).

Tests **must** assert the literal token (`tok-leakcheck-xxxx`) is
absent from every emitted byte across the suite. The M2 hardened
regression test extends this discipline across integration / E2E.

## Header lockdown

Caller-supplied headers must NOT be able to override transport-owned
headers. The header-construction order in `src/api/transport.ts` is:

```ts
const requestHeaders = {
  ...safeCallerHeaders,           // caller bag, with reserved names stripped
  Authorization: config.apiToken, // wins
  'API-Version': config.apiVersion,
  'Content-Type': 'application/json',
};
```

Plus a case-insensitive strip of any caller key whose lowercase form
matches a reserved name (`authorization`, `api-version`,
`content-type`). Without that, a caller could pass `authorization`
(lowercase) and the literal-key spread would leave both `Authorization`
*and* `authorization` in the final object — fetch impl picks a winner
non-deterministically.

The same rule applies to any future config-owned header. Add it to
the reserved set; don't trust spread order alone.

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
