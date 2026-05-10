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
 * `src/config/credentials.ts`; the TOML parser dependency (`smol-
 * toml` is the leaning choice — minimal footprint, zero runtime
 * deps, ESM-native) is added at M21 implementation kickoff alongside
 * the runtime body. Pre-flight stubs reject every call so the
 * dep-add can land in the same commit that ships the runtime.
 *
 * **Token-storage rule (cli-design §7.2 line 5011 + §7.4 + .claude/
 * rules/security.md):** tokens are NEVER stored in `config.toml`.
 * Profile entries reference an env-var name via `api_token_env =
 * "MONDAY_API_TOKEN_<X>"` (the env var's *name*, never its value).
 * The runtime parse path enforces this with two layers of defense:
 *
 *   1. **Structural exclusion** — `.strict()` on the zod object
 *      rejects unknown keys (`api_token`, `access_token`, `secret`,
 *      etc.) at parse time.
 *   2. **Value-level shape check** — `api_token_env` is constrained
 *      to the env-var-identifier regex `/^[A-Z_][A-Z0-9_]*$/u` so
 *      a pasted opaque token value (which would carry lowercase
 *      letters, digits, and dashes) cannot pass through under the
 *      allowed key. The regex matches POSIX-style env-var names
 *      (`MONDAY_API_TOKEN_WORK`) and rejects token-looking values
 *      (`tok-fixture-xxxx`, `eyJhbGciOi...`).
 *
 * **Schema vs implementation split.** All zod schemas + type exports
 * + interface signatures are pinned in this pre-flight commit.
 * Runtime bodies (TOML parse, file I/O, environment-aware resolution)
 * are stubbed under `c8 ignore` and replaced in M21 implementation.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';

const STUB_HINT =
  'M21 implementation kickoff lands the runtime body alongside `monday auth login` / `auth logout` real bodies (and the TOML-parser dep-add — `smol-toml` is the leaning choice).';

/** Filename under `~/.monday-cli/`. Pinned for HOME-scoping. */
export const PROFILES_CONFIG_FILE_NAME = 'config.toml';

/** Parent directory under HOME (shared with credentials cache). */
export const PROFILES_DIR_NAME = '.monday-cli';

/**
 * Optional `[profiles.<name>.dev]` block per cli-design §11.3 (Monday
 * Dev convenience). Pinned here so v0.3-M26 (`monday dev …`) can read
 * the same shape without a fresh schema landing alongside that
 * milestone. The block is wholly optional — profiles without a `dev`
 * sub-table simply have no dev-shortcut configuration.
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
 * Per-profile config entry per cli-design §7.2.
 *
 * - `api_token_env` — name of the env var holding this profile's
 *   token. **The env var's name only — never the token value.** If
 *   omitted, the credentials-cache-only path applies (the profile
 *   must have been populated via `monday auth login`).
 * - `api_version` — overrides the global `MONDAY_API_VERSION` for
 *   this profile.
 * - `default_workspace` — surfaces in the per-profile resolved
 *   config; verbs that take an optional `--workspace` flag fall
 *   back to this when the flag is omitted.
 * - `timezone` — overrides the global `MONDAY_TIMEZONE` for this
 *   profile (relative-date resolution per cli-design §5.5).
 * - `dev` — optional Monday-Dev shortcut block (cli-design §11.3 +
 *   v0.3-M26).
 */
/**
 * Env-var identifier shape (POSIX-style: starts with letter or
 * underscore; subsequent characters are uppercase ASCII / digits /
 * underscores). Rejects token-looking values like `tok-fixture-xxxx`
 * or JWT-looking values like `eyJhbGciOi...` so a user pasting a
 * token under the allowed `api_token_env` key fails at parse time.
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
 *
 *   - `default_profile` — the profile name selected when no
 *     `--profile` flag and no `MONDAY_PROFILE` env are present. If
 *     omitted, the implicit v1 mode applies (uses
 *     `MONDAY_API_TOKEN` env directly without per-profile resolution).
 *   - `profiles` — keyed by profile name. Each entry conforms to
 *     {@link profileEntrySchema}.
 *
 * The `.strict()` mode rejects unknown top-level keys, and per-entry
 * `.strict()` (above) rejects unknown per-profile keys — together
 * they enforce the "no token in config.toml" rule by structural
 * exclusion. A future schema extension (e.g., `[shared]` block at
 * v0.4) lands as an explicit cli-design §7.2 amendment.
 */
export const profilesConfigSchema = z
  .object({
    default_profile: z.string().min(1).optional(),
    profiles: z.record(z.string().min(1), profileEntrySchema),
  })
  .strict();

export type ProfilesConfig = z.infer<typeof profilesConfigSchema>;

/**
 * Resolves the absolute config-file path. Pure helper. Tests pin
 * the resolved path against a tmp `home` to assert directory layout
 * matches §7.2 + §7.4.2.
 */
export interface ProfilesRootOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

/* c8 ignore next 8 — pre-flight stub. M21 implementation lands the
   `path.join(home, PROFILES_DIR_NAME, PROFILES_CONFIG_FILE_NAME)`
   resolution alongside the runtime read body. */
export const resolveProfilesConfigPath = (
  _options: ProfilesRootOptions = {},
): string => {
  throw new ApiError(
    'internal_error',
    'resolveProfilesConfigPath is a v0.3-M21 pre-flight stub — M21 implementation lands the path-resolution body.',
    { details: { hint: STUB_HINT } },
  );
};

/**
 * Reads + parses `~/.monday-cli/config.toml`. Returns `undefined`
 * when the file does not exist (typical first-run state — implicit
 * v1 mode applies). Throws `config_error` for parse failures (TOML
 * malformed) or schema-validation failures (unknown keys, type
 * mismatch).
 *
 * The runtime body uses `smol-toml` (or `@iarna/toml` — decision
 * lands at M21 implementation kickoff alongside the dep-add); the
 * choice has no impact on the public surface of this module.
 */
/* c8 ignore next 14 — pre-flight stub. M21 implementation lands the
   runtime read + parse body. */
export const loadProfilesConfig = (
  _options: ProfilesRootOptions = {},
): Promise<ProfilesConfig | undefined> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'loadProfilesConfig is a v0.3-M21 pre-flight stub — M21 implementation lands the runtime TOML-parse body.',
      { details: { hint: STUB_HINT } },
    ),
  );

/**
 * Inputs to {@link selectProfile}. The full resolution pipeline:
 *
 *   1. Use `flag` if non-empty (`--profile <name>` from
 *      {@link import('../types/global-flags.js').GlobalFlags}).
 *   2. Else use `env.MONDAY_PROFILE` if non-empty.
 *   3. Else use `config.default_profile` if present.
 *   4. Else return the implicit-v1 sentinel (signalling no per-
 *      profile config; consumers fall back to `MONDAY_API_TOKEN`
 *      env directly per §7.1).
 */
export interface SelectProfileInputs {
  readonly flag: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly config: ProfilesConfig | undefined;
}

/**
 * Result of profile selection. The discriminated `mode` slot lets
 * consumers branch cleanly between "use a named profile" (the v0.3+
 * path) and "use implicit v1 mode" (no config file, no flag, no
 * env — fall back to `MONDAY_API_TOKEN`). Mirroring this through
 * the type system means `cli/run.ts`'s config-load can't accidentally
 * skip the v1-fallback branch.
 */
export type SelectProfileResult =
  | {
      readonly mode: 'named';
      readonly name: string;
      readonly entry: ProfileEntry;
    }
  | { readonly mode: 'implicit_v1' };

/**
 * Resolves the active profile per cli-design §7.2 source order.
 * Surfaces `usage_error` on a `--profile`/`MONDAY_PROFILE` mismatch
 * (per the existing {@link import('../types/global-flags.js')
 * .parseGlobalFlags} contract — that catch fires before this
 * resolver runs).
 *
 * Surfaces `config_error` when:
 *   - `--profile work` names a profile not present in the config
 *     file, OR
 *   - `default_profile` names a profile not present, OR
 *   - The implicit-v1 path applies but the config file is present
 *     (config-file presence implies the user wants per-profile
 *     resolution; absence implies v1).
 */
/* c8 ignore next 8 — pre-flight stub. M21 implementation lands the
   resolution body. */
export const selectProfile = (
  _inputs: SelectProfileInputs,
): SelectProfileResult => {
  throw new ApiError(
    'internal_error',
    'selectProfile is a v0.3-M21 pre-flight stub — M21 implementation lands the source-order resolution body.',
    { details: { hint: STUB_HINT } },
  );
};
