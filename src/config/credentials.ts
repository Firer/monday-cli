/**
 * Credentials cache primitive for the v0.3-M21 `monday auth login` /
 * `monday auth logout` verbs (cli-design §7.4 — closes Decision 3).
 *
 * **What this module owns.** The mode-`0600` per-profile credentials
 * file at `~/.monday-cli/credentials`, read/write/delete primitives,
 * and the per-profile token-source-order resolver
 * (§7.4.1: credentials cache > `api_token_env` > `config_error`).
 *
 * **What this module does NOT own.** The credentials file shape is
 * intentionally orthogonal to:
 *   - the OAuth wire flow (`src/api/oauth.ts`),
 *   - the TOML profile loader (`src/config/profiles.ts`),
 *   - the redaction layer (`src/utils/redact.ts`).
 *
 * **Mirrors `src/api/cache.ts writeJsonFile` verbatim** per cli-design
 * §7.4.2. The R-candidate "secure-file primitive shared between cache
 * + credentials" (v0.3-plan §22) flags consolidation when a third
 * consumer lands; today's two-consumer state stays below threshold,
 * so this module duplicates the disk-discipline shape rather than
 * extracting it. The duplication is intentional and the §7.4.2
 * "mirror verbatim" wording is the in-design backstop.
 *
 * **Disk discipline (§7.4.2):**
 *
 *   1. `mkdir({ recursive: true, mode: 0o700 })` + explicit `chmod
 *      0o700` on the parent dir (advisory under umask on some
 *      platforms; mirrors `src/api/cache.ts`).
 *   2. Atomic-replace via `writeFile(tmp, payload, { mode: 0o600 })`
 *      → `chmod(tmp, 0o600)` → `rename(tmp, final)`.
 *   3. Read-time `fs.fstat`-against-open-descriptor permission check
 *      (`(stats.mode & 0o077) !== 0` → refuse, surface
 *      `config_error` with `details.path` + `details.hint`).
 *
 * **What's stub vs runtime.** The pre-flight surface lands as
 * `Promise.reject(internal_error)` stubs under `c8 ignore` — M21
 * implementation replaces them with real I/O alongside the
 * `monday auth login` command body. The schema definitions, type
 * exports, file-mode constants, and source-order helper signatures
 * are pinned now so M21 commit reviews land into a Codex-reviewed
 * shape.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';

const STUB_HINT =
  'M21 implementation kickoff lands the runtime body alongside `monday auth login` / `auth logout` real bodies.';

/**
 * File-mode constant for the credentials file. Mirrors
 * `src/api/cache.ts CACHE_FILE_MODE`. The R-candidate consolidation
 * (v0.3-plan §22) would re-export this from a shared `secure-file`
 * primitive; the constant lives here for pre-flight to keep the two
 * surfaces independent.
 */
export const CREDENTIALS_FILE_MODE = 0o600;

/**
 * Bitmask used to detect group/world readable bits on read. A non-
 * zero result means the file is loose; the read path refuses to
 * open it.
 */
export const CREDENTIALS_INSECURE_BITS = 0o077;

/**
 * Pinned at `"1"` for v0.3; reserved for a future migration if the
 * per-profile shape grows incompatibly. Mirrors the cache module's
 * `CACHE_SCHEMA_VERSION`.
 */
export const CREDENTIALS_SCHEMA_VERSION = '1';

/** Filename under `~/.monday-cli/`. Pinned for HOME-scoping. */
export const CREDENTIALS_FILE_NAME = 'credentials';

/** Parent directory under HOME. Pinned to match cli-design §7.4.2. */
export const CREDENTIALS_DIR_NAME = '.monday-cli';

/**
 * Per-profile credentials entry per cli-design §7.4.1.
 *
 * - `access_token` — Monday's opaque OAuth token. Treat as bytes;
 *   never logged, never echoed in `data.*`.
 * - `obtained_at` — ISO-8601 UTC timestamp of the successful token
 *   exchange.
 * - `expires_at` — `null` for v0.3; preserved as `string | null` so
 *   a future refresh-token flow doesn't bump `schema_version`. The
 *   M21 empirical probe confirmed Monday's token response carries
 *   no `expires_in` field; tokens "do not expire" per Monday's docs.
 * - `scopes` — space-separated `scope` field from `/oauth2/token`'s
 *   response, parsed into an array. Agents self-audit
 *   ("does this profile have `boards:write`?") without re-running
 *   the OAuth flow.
 * - `account_id` — pinned at write-time from a post-exchange
 *   `account { id }` query (§7.3.1 step 8). Probe-confirmed
 *   string-typed numeric (e.g., `"34900083"`).
 */
export const profileEntrySchema = z
  .object({
    access_token: z.string().min(1),
    obtained_at: z.string().min(1),
    expires_at: z.union([z.string(), z.null()]),
    scopes: z.array(z.string()),
    account_id: z.string().min(1),
  })
  .strict();

export type ProfileEntry = z.infer<typeof profileEntrySchema>;

/**
 * Top-level credentials file shape per cli-design §7.4.1.
 * `profiles` is a record keyed by profile name (the same name used
 * in `~/.monday-cli/config.toml` and the `--profile` flag).
 *
 * **`schema_version` pinned to literal `"1"`** so a future-version
 * credentials file (e.g., `"2"` after a v0.4 schema change) fails
 * parse-time at this security-bearing surface rather than passing
 * through and getting reinterpreted under the v0.3 schema. Mirrors
 * the cache module's "treat a different cache schema as a miss"
 * pattern but tighter — credentials files store secrets, so silent
 * acceptance of a malformed schema risks treating an attacker-
 * supplied future-shape file as authentic. The literal pin forces
 * a future migration path to land an explicit reader (e.g.,
 * `readCredentialsV2`) rather than implicit field-coercion drift.
 */
export const credentialsFileSchema = z
  .object({
    schema_version: z.literal(CREDENTIALS_SCHEMA_VERSION),
    profiles: z.record(z.string().min(1), profileEntrySchema),
  })
  .strict();

export type CredentialsFile = z.infer<typeof credentialsFileSchema>;

/**
 * Discriminated union for the per-profile token source. Mirrors the
 * §7.4.1 source order: `credentials cache > api_token_env >
 * config_error`. Consumers pattern-match on `source` to populate
 * `meta.source` in the success envelope (`live` for cache-miss
 * paths, but the source slot itself surfaces *which* credential
 * resolution path won).
 */
export type ProfileTokenSource = 'credentials_cache' | 'api_token_env';

export interface ResolvedProfileToken {
  readonly token: string;
  readonly source: ProfileTokenSource;
}

/**
 * Common options object for every read/write helper — the `home`
 * override exists so tests can drop a fixture file under a tmp dir
 * without touching the real `~/.monday-cli/`. `env` mirrors the
 * cache layer's existing test-isolation pattern.
 */
export interface CredentialsRootOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

/**
 * Inputs to {@link setProfileCredentials} — the read-modify-write
 * convenience used by `monday auth login`. Decoupled from the raw
 * `writeCredentials` so callers don't have to load-then-modify-then-
 * write themselves; the helper handles the missing-file case (creates
 * a fresh file with one profile) and the existing-file case (merges
 * the entry into the existing profiles map).
 */
export interface SetProfileCredentialsInputs {
  readonly profileName: string;
  readonly entry: ProfileEntry;
}

/**
 * Resolves the absolute credentials-file path. Pure helper — does
 * not touch the filesystem. Tests pin the resolved path against a
 * tmp `home` to assert directory layout matches §7.4.2.
 */
/* c8 ignore next 8 — pre-flight stub. M21 implementation replaces
   with `path.join(home, CREDENTIALS_DIR_NAME, CREDENTIALS_FILE_NAME)`
   alongside the runtime read/write. */
export const resolveCredentialsPath = (
  _options: CredentialsRootOptions = {},
): string => {
  throw new ApiError(
    'internal_error',
    'resolveCredentialsPath is a v0.3-M21 pre-flight stub — M21 implementation lands the path-resolution body.',
    { details: { hint: STUB_HINT } },
  );
};

/**
 * Reads the credentials file, parses it through
 * {@link credentialsFileSchema}, and returns the parsed shape.
 *
 * **Read-time discipline (§7.4.2 + .claude/rules/security.md):**
 *
 *   1. `fs.open` with `O_RDONLY`.
 *   2. `fs.fstat` against the open descriptor (TOCTOU-safe — the
 *      stat is locked to the file we'll read, not racing a path-
 *      based check).
 *   3. If `(stats.mode & CREDENTIALS_INSECURE_BITS) !== 0`, refuse:
 *      surface `config_error` with `details.path` +
 *      `details.hint: "permissions must be 0600 — run \`chmod 600
 *      ~/.monday-cli/credentials\`"`.
 *   4. Read body, JSON.parse, zod-parse via
 *      {@link credentialsFileSchema}.
 *
 * Returns `undefined` when the file does not exist (typical first-
 * run state; the credentials cache is opt-in via `monday auth
 * login`). Throws `config_error` for every other failure mode
 * (insecure mode, malformed JSON, schema mismatch).
 */
/* c8 ignore next 14 — pre-flight stub. M21 implementation replaces
   with the real read path. */
export const readCredentials = (
  _options: CredentialsRootOptions = {},
): Promise<CredentialsFile | undefined> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'readCredentials is a v0.3-M21 pre-flight stub — M21 implementation lands the runtime read body.',
      { details: { hint: STUB_HINT } },
    ),
  );

/**
 * Atomically writes the credentials file. Mirrors `src/api/cache.ts
 * writeJsonFile` verbatim:
 *
 *   1. `mkdir({ recursive: true, mode: 0o700 })` + `chmod 0o700`
 *      on `~/.monday-cli/`.
 *   2. `writeFile(tmpPath, JSON.stringify(file), { mode: 0o600 })`.
 *   3. `chmod(tmpPath, 0o600)` (re-applied because `writeFile`'s
 *      `mode` is advisory under umask).
 *   4. `rename(tmpPath, finalPath)` (atomic on the same filesystem).
 *
 * Best-effort cleanup of `tmpPath` on any failure so a half-written
 * `.tmp` doesn't accumulate.
 *
 * Surfaces `config_error` on disk-full / permissions / underlying
 * filesystem errors (per cli-design §7.3.3 — `config_error` covers
 * post-exchange persistence failure with exit 3).
 */
/* c8 ignore next 14 — pre-flight stub. M21 implementation replaces
   with the real atomic-replace body. */
export const writeCredentials = (
  _file: CredentialsFile,
  _options: CredentialsRootOptions = {},
): Promise<void> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'writeCredentials is a v0.3-M21 pre-flight stub — M21 implementation lands the runtime write body.',
      { details: { hint: STUB_HINT } },
    ),
  );

/**
 * Read-modify-write convenience for `monday auth login`'s success
 * path. Loads the existing file (or starts a fresh `{schema_version,
 * profiles: {}}` if absent), inserts/replaces the named profile's
 * entry, and writes the result back via {@link writeCredentials}.
 *
 * **Idempotent at the credentials-write layer** — re-running with
 * the same `(profileName, entry)` produces a byte-identical file
 * (modulo timestamp). cli-design §7.3.2 leans on this idempotency
 * for the post-OAuth-flow contract: "running this verb leaves the
 * named profile authenticated."
 */
/* c8 ignore next 14 — pre-flight stub. M21 implementation replaces
   with read-modify-write composing the lower-level helpers. */
export const setProfileCredentials = (
  _inputs: SetProfileCredentialsInputs,
  _options: CredentialsRootOptions = {},
): Promise<void> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'setProfileCredentials is a v0.3-M21 pre-flight stub — M21 implementation lands the read-modify-write body.',
      { details: { hint: STUB_HINT } },
    ),
  );

/**
 * Idempotent profile delete for `monday auth logout`. Loads the
 * file (no-op + `ok: true` if file is absent OR profile is absent),
 * removes the named profile from `profiles`, writes the result back.
 *
 * **Pre-flight contract**: when the post-delete `profiles` map is
 * empty, the implementation **still writes `{schema_version,
 * profiles: {}}`** rather than deleting the file outright — keeps
 * the schema-version pin discoverable by `monday config show` and
 * avoids a special "fresh-install vs all-logged-out" ambiguity.
 * M21 implementation respects this.
 */
/* c8 ignore next 14 — pre-flight stub. M21 implementation replaces
   with the runtime delete body. */
export const deleteProfileCredentials = (
  _profileName: string,
  _options: CredentialsRootOptions = {},
): Promise<void> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'deleteProfileCredentials is a v0.3-M21 pre-flight stub — M21 implementation lands the runtime delete body.',
      { details: { hint: STUB_HINT } },
    ),
  );

/**
 * Per-profile token-source resolver per cli-design §7.4.1 source
 * order:
 *
 *   1. **Credentials cache entry** for `profileName` (if present +
 *      mode-check passes via {@link readCredentials}).
 *   2. **`api_token_env`** value from the profile's `config.toml`
 *      entry (if the named env var is populated). Caller passes
 *      `apiTokenEnvName` resolved from the TOML loader; this module
 *      does NOT read the TOML file.
 *   3. Otherwise → `config_error` with `details.hint` pointing at
 *      `monday auth login --profile <profileName>` OR setting the
 *      named env var.
 *
 * The credentials cache wins over `api_token_env` because
 * `monday auth login` is the explicit user action that wrote the
 * cache; honouring it without requiring a config-file edit is the
 * agent-ergonomic default. `monday auth logout --profile <name>`
 * removes the cache entry, restoring the env-fallback path.
 */
export interface ResolveProfileTokenInputs {
  readonly profileName: string;
  /**
   * The `api_token_env` env-var name the profile's `config.toml`
   * entry referenced (e.g., `"MONDAY_API_TOKEN_WORK"`). `undefined`
   * when the profile has no `api_token_env` configured (forces the
   * credentials-cache-only path).
   */
  readonly apiTokenEnvName: string | undefined;
}

/* c8 ignore next 14 — pre-flight stub. M21 implementation lands the
   real resolution against {@link readCredentials} + env lookup. */
export const resolveProfileToken = (
  _inputs: ResolveProfileTokenInputs,
  _options: CredentialsRootOptions = {},
): Promise<ResolvedProfileToken> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'resolveProfileToken is a v0.3-M21 pre-flight stub — M21 implementation lands the source-order resolution body.',
      { details: { hint: STUB_HINT } },
    ),
  );
