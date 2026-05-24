/**
 * Profile-config loader for the v0.3-M21 multi-profile surface
 * (cli-design §7.2 — `~/.monday-cli/config.toml`).
 *
 * **What this module owns.** Reading + parsing the TOML config file,
 * the per-profile config schema (zod-validated at the parse boundary
 * per `.claude/rules/validation.md`), and the profile-selection
 * resolver per §7.2 source order:
 *
 *     `--profile flag > MONDAY_PROFILE env > default_profile in
 *      config > implicit v1 mode (no config file present)`
 *
 * **What this module does NOT own.** The credentials cache (token
 * source-order within a profile) lives in
 * `src/config/credentials.ts`.
 *
 * **Token-storage rule (cli-design §7.2 + §7.4 + .claude/rules/
 * security.md):** tokens are NEVER stored in `config.toml`. Profile
 * entries reference an env-var name via `api_token_env =
 * "MONDAY_API_TOKEN_<X>"` (the env var's *name*, never its value).
 * Two layers of defense:
 *
 *   1. **Structural exclusion** — `.strict()` on the zod object
 *      rejects unknown keys (`api_token`, `access_token`, `secret`).
 *   2. **Value-level shape check** — `api_token_env` is constrained
 *      to the env-var-identifier regex `/^[A-Z_][A-Z0-9_]*$/u`.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';
import { ConfigError, asError } from '../utils/errors.js';
import { isENOENT } from '../utils/fs.js';
import { OUTPUT_FORMATS } from '../utils/output/select.js';

/** Filename under `~/.monday-cli/`. Pinned for HOME-scoping. */
export const PROFILES_CONFIG_FILE_NAME = 'config.toml';

/** Parent directory under HOME (shared with credentials cache). */
export const PROFILES_DIR_NAME = '.monday-cli';

/**
 * Optional `[profiles.<name>.dev]` block per cli-design §11.3 (Monday
 * Dev convenience). Pinned here so v0.3-M26 (`monday dev …`) can read
 * the same shape without a fresh schema landing alongside that
 * milestone.
 */
export const profileDevBlockSchema = z
  .object({
    tasks_board: z.string().min(1).optional(),
    sprints_board: z.string().min(1).optional(),
    epics_board: z.string().min(1).optional(),
    bugs_board: z.string().min(1).optional(),
    releases_board: z.string().min(1).optional(),
  })
  .strict();

export type ProfileDevBlock = z.infer<typeof profileDevBlockSchema>;

/**
 * Optional `[profiles.<name>.defaults]` block per cli-design §7.2.1
 * (v0.12-M55-E). Four scoping defaults that project onto matching
 * CLI flags via the precedence chain in `src/config/profile-
 * defaults.ts` (CLI flag > env var > profile default > unset).
 *
 * Strict allowlist: `.strict()` rejects unknown keys at the parse
 * boundary, so `monday config set api_token_env <name>` (or any
 * other non-allowlist key) surfaces `config_error` with
 * `details.reason: 'unknown_defaults_key'` (D3 in v0.12-plan §3).
 * Token-storage rule per `.claude/rules/security.md` preserved by
 * construction — the schema has no path to a token-bytes slot at
 * all (the top-level `api_token_env` remains hand-TOML-only).
 *
 * Per-key shapes pin the same regexes the runtime consumers use:
 *   - `board` / `workspace` → `^\d+$` (matches `numericIdSchema` in
 *     `src/types/ids.ts`; brand applied at the runtime consumer,
 *     not here).
 *   - `output` → `OUTPUT_FORMATS` enum verbatim from
 *     `src/utils/output/select.ts` (the existing `MONDAY_OUTPUT`
 *     env-var contract accepts all 4 values; narrowing here would
 *     silently reject `MONDAY_OUTPUT=text|ndjson` paths).
 *   - `concurrency` → positive integer (range-bounding to
 *     `MIN..MAX_CONCURRENCY` defers to the per-command parse, same
 *     shape as `--concurrency <n>` itself).
 *
 * Wrong types reject with `wrong_defaults_type` (D3 case (b)).
 */
const NUMERIC_ID_PATTERN = /^\d+$/u;

export const profileDefaultsBlockSchema = z
  .object({
    board: z
      .string()
      .regex(NUMERIC_ID_PATTERN, { message: 'expected a numeric board ID' })
      .optional(),
    workspace: z
      .string()
      .regex(NUMERIC_ID_PATTERN, { message: 'expected a numeric workspace ID' })
      .optional(),
    output: z.enum(OUTPUT_FORMATS).optional(),
    concurrency: z.number().int().positive().optional(),
  })
  .strict();

export type ProfileDefaultsBlock = z.infer<typeof profileDefaultsBlockSchema>;

/**
 * The 4 allowlist keys companion verbs (`config set/get/unset`) may
 * operate on. Mirrors `profileDefaultsBlockSchema.shape` keys; pin
 * here so the verbs + the resolver consume a single source of truth
 * and the parse-boundary rejection-message stays consistent.
 */
export const PROFILE_DEFAULTS_KEYS = [
  'board',
  'workspace',
  'output',
  'concurrency',
] as const;

export type ProfileDefaultsKey = (typeof PROFILE_DEFAULTS_KEYS)[number];

/**
 * Env-var identifier shape (POSIX-style). Rejects token-looking
 * values like `tok-fixture-xxxx` or JWT-looking values like
 * `eyJhbGciOi...` so a user pasting a token under the allowed
 * `api_token_env` key fails at parse time.
 */
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

export const profileEntrySchema = z
  .object({
    api_token_env: z
      .string()
      .min(1)
      .regex(ENV_VAR_NAME_PATTERN, {
        message:
          '`api_token_env` must be an env-var name (e.g., `MONDAY_API_TOKEN_WORK`), NOT the token value itself. The CLI never reads tokens from `config.toml`; reference an env var or use `monday auth login` instead.',
      })
      .optional(),
    api_version: z
      .string()
      .regex(/^\d{4}-\d{2}$/u, { message: 'expected YYYY-MM' })
      .optional(),
    default_workspace: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    dev: profileDevBlockSchema.optional(),
    defaults: profileDefaultsBlockSchema.optional(),
  })
  .strict();

export type ProfileEntry = z.infer<typeof profileEntrySchema>;

/**
 * Top-level config-file shape per cli-design §7.2.
 */
export const profilesConfigSchema = z
  .object({
    default_profile: z.string().min(1).optional(),
    profiles: z.record(z.string().min(1), profileEntrySchema),
  })
  .strict();

export type ProfilesConfig = z.infer<typeof profilesConfigSchema>;

export interface ProfilesRootOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

/**
 * Resolves the absolute config-file path. Pure helper.
 */
export const resolveProfilesConfigPath = (
  options: ProfilesRootOptions = {},
): string => {
  const home = options.home ?? homedir();
  return join(home, PROFILES_DIR_NAME, PROFILES_CONFIG_FILE_NAME);
};

/**
 * Reads + parses `~/.monday-cli/config.toml`. Returns `undefined`
 * when the file does not exist (typical first-run state — implicit
 * v1 mode applies). Throws `config_error` for parse failures (TOML
 * malformed) or schema-validation failures (unknown keys, type
 * mismatch, token-smuggled-as-env-var-name).
 */
export const loadProfilesConfig = async (
  options: ProfilesRootOptions = {},
): Promise<ProfilesConfig | undefined> => {
  const fullPath = resolveProfilesConfigPath(options);
  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf8');
  } catch (err) {
    if (isENOENT(err)) {
      return undefined;
    }
    // Non-ENOENT readFile errors (EACCES, EISDIR) are platform-
    // specific and not reproducible from a tmp-dir test.
    /* c8 ignore start */
    throw new ConfigError(
      `cannot read profiles config ${fullPath}`,
      {
        cause: asError(err),
        details: { path: fullPath },
      },
    );
    /* c8 ignore stop */
  }

  let tomlParsed: unknown;
  try {
    tomlParsed = parseToml(raw);
  } catch (err) {
    throw new ConfigError(
      `malformed TOML in profiles config ${fullPath}`,
      {
        cause: asError(err),
        details: {
          path: fullPath,
          hint: 'check the file for unmatched quotes, missing `=`, or invalid section headers',
        },
      },
    );
  }

  const result = profilesConfigSchema.safeParse(tomlParsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }));
    const summary = issues
      .map((i) => (i.path !== '' ? `${i.path}: ${i.message}` : i.message))
      .join('; ');
    throw new ConfigError(
      `invalid profiles config: ${summary}`,
      {
        cause: result.error,
        details: {
          path: fullPath,
          issues,
          hint: 'profile entries must reference an env-var NAME via `api_token_env`, never the token value itself; tokens belong in env vars or the credentials cache (run `monday auth login`).',
        },
      },
    );
  }
  return result.data;
};

export interface SelectProfileInputs {
  readonly flag: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly config: ProfilesConfig | undefined;
}

export type SelectProfileResult =
  | {
      readonly mode: 'named';
      readonly name: string;
      readonly entry: ProfileEntry;
    }
  | { readonly mode: 'implicit_v1' };

/**
 * Resolves the active profile per cli-design §7.2 source order:
 *
 *   1. `flag` (from `--profile <name>`).
 *   2. `env.MONDAY_PROFILE`.
 *   3. `config.default_profile`.
 *   4. Implicit-v1 sentinel.
 *
 * Surfaces `config_error` when:
 *   - any of (1)/(2)/(3) names a profile not present in the config
 *     file, OR
 *   - `flag` / `MONDAY_PROFILE` is set but no config file exists
 *     (the flag/env imply per-profile resolution that the missing
 *     config can't fulfil).
 */
export const selectProfile = (
  inputs: SelectProfileInputs,
): SelectProfileResult => {
  const flagName =
    inputs.flag !== undefined && inputs.flag.length > 0
      ? inputs.flag
      : undefined;
  const envName =
    inputs.env.MONDAY_PROFILE !== undefined &&
    inputs.env.MONDAY_PROFILE.length > 0
      ? inputs.env.MONDAY_PROFILE
      : undefined;

  // (1)/(2): explicit selection. The credentials cache is the
  // authoritative store for tokens (cli-design §7.4.1), and
  // `monday auth login --profile <name>` populates it without
  // requiring a `config.toml` edit. Two cases:
  //
  //   - No config file: return a synthetic empty entry. The caller
  //     resolves the token via `resolveProfileToken`, which checks
  //     the credentials cache first and surfaces `config_error`
  //     only if neither cache nor `api_token_env` is populated.
  //   - Config file present but profile not in `profiles`: error
  //     loud — the user expressed an explicit `[profiles.<name>]`
  //     intent that the file doesn't satisfy.
  const explicit = flagName ?? envName;
  if (explicit !== undefined) {
    if (inputs.config === undefined) {
      return { mode: 'named', name: explicit, entry: {} };
    }
    const entry = inputs.config.profiles[explicit];
    if (entry === undefined) {
      throw new ConfigError(
        `profile \`${explicit}\` not found in ~/.monday-cli/config.toml`,
        {
          details: {
            profile: explicit,
            available_profiles: Object.keys(inputs.config.profiles),
            source: flagName !== undefined ? '--profile flag' : 'MONDAY_PROFILE env',
            hint: `add a [profiles.${explicit}] section to ~/.monday-cli/config.toml, OR run \`monday auth login --profile ${explicit}\` to populate the credentials cache directly`,
          },
        },
      );
    }
    return { mode: 'named', name: explicit, entry };
  }

  // (3): default_profile from config.
  if (inputs.config?.default_profile !== undefined) {
    const name = inputs.config.default_profile;
    const entry = inputs.config.profiles[name];
    if (entry === undefined) {
      throw new ConfigError(
        `default_profile \`${name}\` not found in ~/.monday-cli/config.toml`,
        {
          details: {
            profile: name,
            available_profiles: Object.keys(inputs.config.profiles),
            source: 'default_profile in config.toml',
            hint: 'set `default_profile` to one of the listed available_profiles, or remove the `default_profile` line to fall back to the first profile listed',
          },
        },
      );
    }
    return { mode: 'named', name, entry };
  }

  // (4): implicit v1.
  return { mode: 'implicit_v1' };
};

/**
 * Filesystem mode for config.toml. Mirrors `src/config/credentials.ts`
 * + `src/api/dev-conventions.ts:saveDevMapping` discipline per
 * `.claude/rules/security.md`: files under `~/.monday-cli/` carry
 * user-scoped data even when not directly token-bearing.
 */
const CONFIG_FILE_MODE = 0o600;

/**
 * Atomically writes `~/.monday-cli/config.toml`. Mirrors the
 * disk-discipline in `src/api/dev-conventions.ts:saveDevMapping`:
 *   1. `mkdir({ recursive: true, mode: 0o700 })` + explicit chmod.
 *   2. `writeFile(tmpPath, ..., { mode: 0o600 })` + explicit chmod.
 *   3. `rename(tmpPath, finalPath)` (atomic on same FS).
 *
 * The full `ProfilesConfig` is re-validated through
 * `profilesConfigSchema` before write so an in-memory mutation
 * bypass can't slip a bad file onto disk.
 *
 * **TOML round-trip caveat.** `smol-toml`'s `stringify` produces
 * canonical TOML output — comments + bespoke formatting from the
 * original file are NOT preserved. Same trade-off as `saveDevMapping`
 * (the CLI-managed slots are the auth, dev, and now-defaults blocks;
 * top-level slots stay hand-TOML-editable for those who want
 * comments).
 */
export const writeProfilesConfig = async (
  next: ProfilesConfig,
  options: ProfilesRootOptions = {},
): Promise<void> => {
  const validated = profilesConfigSchema.parse(next);
  const fullPath = resolveProfilesConfigPath(options);
  const dir = join(options.home ?? homedir(), PROFILES_DIR_NAME);

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  } catch (err) {
    // Disk-full / permissions-denied path; not reproducible from a
    // tmp-dir test.
    /* c8 ignore start */
    throw new ConfigError(`cannot prepare config directory ${dir}`, {
      cause: asError(err),
      details: { path: dir },
    });
    /* c8 ignore stop */
  }

  const payload = stringifyToml(validated);
  const tmpPath = `${fullPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, payload, { mode: CONFIG_FILE_MODE });
    await chmod(tmpPath, CONFIG_FILE_MODE);
    await rename(tmpPath, fullPath);
  } catch (err) {
    // Disk-full / atomic-rename failure path; not reproducible from
    // a tmp-dir test.
    /* c8 ignore start */
    await unlink(tmpPath).catch(() => undefined);
    throw new ConfigError(`cannot write config file ${fullPath}`, {
      cause: asError(err),
      details: { path: fullPath },
    });
    /* c8 ignore stop */
  }
};

/**
 * Applies a `[profiles.<name>.defaults]` mutation (set or unset)
 * to the config file. Used by `monday config set/unset` (cli-design
 * §4.3 + §7.2.1, v0.12-M55-E). Pure transform — does NOT touch
 * `[profiles.<name>]` top-level slots or `[profiles.<name>.dev]`.
 *
 * `mode: 'set'`: writes `value` at `profiles[name].defaults[key]`.
 * `mode: 'unset'`: removes `profiles[name].defaults[key]`. If the
 * defaults block becomes empty post-removal, the empty `defaults:
 * {}` slot is dropped from the entry. If the profile entry then
 * becomes empty (no api_token_env / api_version / etc.), the entry
 * itself stays — explicit profile presence is meaningful even when
 * empty (the profile is "known" to the config).
 *
 * Returns the prior value of the key (for the `--json` envelope's
 * `previous_value` slot; `undefined` when the key was unset).
 */
export interface MutateProfileDefaultsInputs {
  readonly profile: string;
  readonly mode: 'set' | 'unset';
  readonly key: ProfileDefaultsKey;
  /** Required when mode === 'set'; ignored otherwise. */
  readonly value?: string | number;
}

export interface MutateProfileDefaultsResult {
  readonly previousValue: string | number | undefined;
}

export const mutateProfileDefaultsInPlace = (
  config: ProfilesConfig | undefined,
  inputs: MutateProfileDefaultsInputs,
): { readonly next: ProfilesConfig; readonly result: MutateProfileDefaultsResult } => {
  const base: ProfilesConfig = config ?? { profiles: {} };
  const existingEntry: ProfileEntry = base.profiles[inputs.profile] ?? {};
  const existingDefaults: ProfileDefaultsBlock = existingEntry.defaults ?? {};
  const previousValue = existingDefaults[inputs.key];

  let nextDefaults: ProfileDefaultsBlock;
  if (inputs.mode === 'set') {
    // value is required for 'set' — type-narrow at the parse boundary
    // in the calling verb (config/set.ts inputSchema), so trust here.
    nextDefaults = {
      ...existingDefaults,
      [inputs.key]: inputs.value,
    };
  } else {
    const { [inputs.key]: _drop, ...rest } = existingDefaults;
    void _drop;
    nextDefaults = rest;
  }

  // Drop the `defaults` slot entirely when empty to keep the
  // round-tripped TOML clean (no `[profiles.work.defaults]` header
  // with no body underneath).
  const nextEntry: ProfileEntry = (() => {
    if (Object.keys(nextDefaults).length === 0) {
      const { defaults: _drop, ...rest } = existingEntry;
      void _drop;
      return rest;
    }
    return { ...existingEntry, defaults: nextDefaults };
  })();

  const next: ProfilesConfig = {
    ...base,
    profiles: {
      ...base.profiles,
      [inputs.profile]: nextEntry,
    },
  };

  return { next, result: { previousValue } };
};
