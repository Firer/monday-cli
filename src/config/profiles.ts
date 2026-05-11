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

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { ConfigError, asError } from '../utils/errors.js';
import { isENOENT } from '../utils/fs.js';

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
