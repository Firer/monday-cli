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
 */

import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConfigError } from '../utils/errors.js';
import { isENOENT } from '../utils/fs.js';

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
 *
 * **`schema_version` pinned to literal `"1"`** so a future-version
 * credentials file (e.g., `"2"` after a v0.4 schema change) fails
 * parse-time at this security-bearing surface rather than passing
 * through and getting reinterpreted under the v0.3 schema.
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
 * config_error`.
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

const formatMode = (mode: number): string =>
  `0${(mode & 0o777).toString(8).padStart(3, '0')}`;

const wrapAsConfigError = (
  err: unknown,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ConfigError => {
  const cause = err instanceof Error ? err : new Error(String(err));
  return new ConfigError(message, { cause, details });
};

/**
 * Resolves the absolute credentials-file path. Pure helper — does
 * not touch the filesystem.
 */
export const resolveCredentialsPath = (
  options: CredentialsRootOptions = {},
): string => {
  const home = options.home ?? homedir();
  return join(home, CREDENTIALS_DIR_NAME, CREDENTIALS_FILE_NAME);
};

const credentialsDirPath = (options: CredentialsRootOptions): string =>
  join(options.home ?? homedir(), CREDENTIALS_DIR_NAME);

/**
 * Reads the credentials file, parses it through
 * {@link credentialsFileSchema}, and returns the parsed shape.
 *
 * Returns `undefined` when the file does not exist (typical first-
 * run state). Throws `config_error` for every other failure mode
 * (insecure mode, malformed JSON, schema mismatch).
 */
export const readCredentials = async (
  options: CredentialsRootOptions = {},
): Promise<CredentialsFile | undefined> => {
  const fullPath = resolveCredentialsPath(options);

  let handle;
  try {
    handle = await open(fullPath, fsConstants.O_RDONLY);
  } catch (err) {
    if (isENOENT(err)) {
      return undefined;
    }
    /* c8 ignore next 3 — non-ENOENT open() errors (EACCES, ENOTDIR)
       are platform-specific and not reproducible from a tmp-dir test. */
    throw wrapAsConfigError(err, `cannot read credentials file ${fullPath}`, {
      path: fullPath,
    });
  }

  try {
    const stats = await handle.stat();
    if ((stats.mode & CREDENTIALS_INSECURE_BITS) !== 0) {
      throw new ConfigError(
        `refusing to read credentials file with insecure permissions ${formatMode(stats.mode)}`,
        {
          details: {
            path: fullPath,
            mode: formatMode(stats.mode),
            hint: `permissions must be 0600 — run \`chmod 600 ${fullPath}\``,
          },
        },
      );
    }
    const raw = await handle.readFile('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw wrapAsConfigError(err, `malformed JSON in credentials file ${fullPath}`, {
        path: fullPath,
        hint: `delete the file and re-run \`monday auth login --profile <name>\``,
      });
    }
    const result = credentialsFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      }));
      throw new ConfigError(
        `credentials file does not conform to v${CREDENTIALS_SCHEMA_VERSION} schema`,
        {
          cause: result.error,
          details: {
            path: fullPath,
            issues,
            hint: `delete the file and re-run \`monday auth login --profile <name>\``,
          },
        },
      );
    }
    return result.data;
  } finally {
    await handle.close();
  }
};

const ensureSecureDir = async (path: string): Promise<void> => {
  // mkdir respects umask, so the explicit `mode` is advisory on some
  // platforms. Re-apply via chmod so a tightened-after-creation
  // directory doesn't betray credentials to another user.
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  } catch (err) {
    /* c8 ignore next 3 — disk-full / permissions-denied path; not
       reproducible from a unit test against a tmp dir. */
    throw wrapAsConfigError(err, `cannot prepare credentials directory ${path}`, {
      path,
    });
  }
};

/**
 * Atomically writes the credentials file. Mirrors `src/api/cache.ts
 * writeEntry` verbatim:
 *
 *   1. `mkdir({ recursive: true, mode: 0o700 })` + `chmod 0o700`.
 *   2. `writeFile(tmpPath, payload, { mode: 0o600 })`.
 *   3. `chmod(tmpPath, 0o600)` (re-applied because `writeFile`'s
 *      `mode` is advisory under umask).
 *   4. `rename(tmpPath, finalPath)` (atomic on the same filesystem).
 *
 * Best-effort cleanup of `tmpPath` on any failure so a half-written
 * `.tmp` doesn't accumulate.
 */
export const writeCredentials = async (
  file: CredentialsFile,
  options: CredentialsRootOptions = {},
): Promise<void> => {
  // Re-validate before write so a caller passing a malformed shape
  // (e.g., a hand-built object that bypassed the schema) can't slip
  // a bad file onto disk.
  const validated = credentialsFileSchema.parse(file);
  const fullPath = resolveCredentialsPath(options);
  const dir = credentialsDirPath(options);

  await ensureSecureDir(dir);

  const payload = JSON.stringify(validated, null, 2);
  const tmpPath = `${fullPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, payload, { mode: CREDENTIALS_FILE_MODE });
    await chmod(tmpPath, CREDENTIALS_FILE_MODE);
    await rename(tmpPath, fullPath);
  } catch (err) {
    /* c8 ignore next 5 — disk-full / atomic-rename failure path; not
       reproducible from a unit test against a tmp dir. */
    await unlink(tmpPath).catch(() => undefined);
    throw wrapAsConfigError(err, `cannot write credentials file ${fullPath}`, {
      path: fullPath,
    });
  }
};

/**
 * Read-modify-write convenience for `monday auth login`'s success
 * path. Loads the existing file (or starts a fresh `{schema_version,
 * profiles: {}}` if absent), inserts/replaces the named profile's
 * entry, and writes the result back via {@link writeCredentials}.
 */
export const setProfileCredentials = async (
  inputs: SetProfileCredentialsInputs,
  options: CredentialsRootOptions = {},
): Promise<void> => {
  const existing = await readCredentials(options);
  const next: CredentialsFile = {
    schema_version: CREDENTIALS_SCHEMA_VERSION,
    profiles: {
      ...(existing?.profiles ?? {}),
      [inputs.profileName]: inputs.entry,
    },
  };
  await writeCredentials(next, options);
};

/**
 * Idempotent profile delete for `monday auth logout`. Loads the
 * file (no-op if file is absent), removes the named profile from
 * `profiles`, writes the result back. When the post-delete
 * `profiles` map is empty, **still writes
 * `{schema_version, profiles: {}}`** rather than deleting the file
 * outright (per cli-design §7.3.2 — keeps the schema-version pin
 * discoverable + avoids a fresh-install vs all-logged-out
 * ambiguity).
 *
 * Returns whether the named profile was present pre-delete — the
 * caller surfaces this in the success envelope's `was_present`
 * slot.
 */
export const deleteProfileCredentials = async (
  profileName: string,
  options: CredentialsRootOptions = {},
): Promise<{ readonly wasPresent: boolean }> => {
  const existing = await readCredentials(options);
  if (existing === undefined) {
    return { wasPresent: false };
  }
  const wasPresent = Object.prototype.hasOwnProperty.call(
    existing.profiles,
    profileName,
  );
  if (!wasPresent) {
    return { wasPresent: false };
  }
  const nextProfiles: Record<string, ProfileEntry> = Object.fromEntries(
    Object.entries(existing.profiles).filter(([key]) => key !== profileName),
  );
  const next: CredentialsFile = {
    schema_version: CREDENTIALS_SCHEMA_VERSION,
    profiles: nextProfiles,
  };
  await writeCredentials(next, options);
  return { wasPresent: true };
};

/**
 * Per-profile token-source resolver per cli-design §7.4.1 source
 * order: credentials cache > `api_token_env` > `config_error`.
 *
 * The credentials cache wins over `api_token_env` because
 * `monday auth login` is the explicit user action that wrote the
 * cache; honouring it without requiring a config-file edit is the
 * agent-ergonomic default. `monday auth logout --profile <name>`
 * removes the cache entry, restoring the env-fallback path.
 */
export interface ResolveProfileTokenInputs {
  readonly profileName: string;
  readonly apiTokenEnvName: string | undefined;
}

export const resolveProfileToken = async (
  inputs: ResolveProfileTokenInputs,
  options: CredentialsRootOptions = {},
): Promise<ResolvedProfileToken> => {
  const credentials = await readCredentials(options);
  const cached = credentials?.profiles[inputs.profileName];
  if (cached !== undefined) {
    return { token: cached.access_token, source: 'credentials_cache' };
  }
  if (inputs.apiTokenEnvName !== undefined) {
    const env = options.env ?? process.env;
    const fromEnv = env[inputs.apiTokenEnvName];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return { token: fromEnv, source: 'api_token_env' };
    }
  }
  const hint =
    inputs.apiTokenEnvName !== undefined
      ? `no token for profile \`${inputs.profileName}\` — run \`monday auth login --profile ${inputs.profileName}\` or set ${inputs.apiTokenEnvName}`
      : `no token for profile \`${inputs.profileName}\` — run \`monday auth login --profile ${inputs.profileName}\``;
  throw new ConfigError(
    `no credentials available for profile \`${inputs.profileName}\``,
    {
      details: {
        profile: inputs.profileName,
        api_token_env: inputs.apiTokenEnvName ?? null,
        hint,
      },
    },
  );
};
