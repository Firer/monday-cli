/**
 * Shared helpers for the `monday config set/get/unset` verbs
 * (cli-design §4.3 + §7.2.1, v0.12-M55-E). Owns:
 *
 *   - `resolveActiveProfileName` — picks the profile name for write
 *     verbs (set/unset) per the same precedence chain
 *     `src/cli/program.ts`'s preAction hook applies; surfaces
 *     `config_error` in implicit-v1 mode (the verbs need a profile
 *     to write to). Mirrors `src/commands/dev/_shared.ts`.
 *
 *   - `resolveReadProfileName` — same lookup for the `get` verb but
 *     returns `undefined` in implicit-v1 mode (the verb degrades
 *     to env-only resolution rather than rejecting).
 *
 *   - `friendlyValueForKey` — coerces the positional argv `<value>`
 *     string into the typed shape `profileDefaultsBlockSchema`
 *     accepts (number for concurrency; string for board/workspace
 *     /output). Used by the `config set` parse boundary.
 */
import { ConfigError } from '../../utils/errors.js';
import {
  loadProfilesConfig,
  PROFILE_DEFAULTS_KEYS,
  selectProfile,
  type ProfileDefaultsKey,
  type ProfilesRootOptions,
} from '../../config/profiles.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { OUTPUT_FORMATS } from '../../utils/output/select.js';
import type { RunContext } from '../../cli/run.js';

export interface ResolvedWriteProfile {
  readonly name: string;
  readonly homeOptions: ProfilesRootOptions;
}

const buildHomeOptions = (ctx: RunContext): ProfilesRootOptions => {
  // Mirrors dev/_shared.ts:54-66 — HOME-truthy + length check, with
  // a defensive `c8 ignore` on the production-only HOME-unset arm.
  /* c8 ignore start */
  const home =
    ctx.env.HOME !== undefined && ctx.env.HOME.length > 0
      ? ctx.env.HOME
      : undefined;
  return home !== undefined ? { home, env: ctx.env } : { env: ctx.env };
  /* c8 ignore stop */
};

/**
 * Resolves the active profile name for a `config set/unset` verb.
 * Surfaces `config_error` when the verb runs in implicit-v1 mode —
 * mirrors `resolveActiveDevProfile`'s shape; the `[profiles.
 * <name>.defaults]` block needs a named profile to write to.
 */
export const resolveActiveProfileName = async (
  ctx: RunContext,
  programOpts: unknown,
): Promise<ResolvedWriteProfile> => {
  const homeOptions = buildHomeOptions(ctx);
  const flagProfile = parseGlobalFlags(programOpts, ctx.env).profile;

  const config = await loadProfilesConfig(homeOptions);
  const selection = selectProfile({
    flag: flagProfile,
    env: ctx.env,
    config,
  });

  if (selection.mode === 'implicit_v1') {
    throw new ConfigError(
      '`monday config set` / `monday config unset` require a named profile',
      {
        details: {
          hint: 'pass --profile <name>, set MONDAY_PROFILE=<name>, or set `default_profile` in ~/.monday-cli/config.toml',
        },
      },
    );
  }

  return { name: selection.name, homeOptions };
};

/**
 * Resolves the profile to READ for `monday config get`. Returns
 * `undefined` for the implicit-v1 case so the verb degrades to
 * env-only resolution (still reports MONDAY_BOARD etc. via the
 * pure resolver). Mirrors `resolveActiveProfileName` otherwise.
 */
export interface ResolvedReadProfile {
  readonly name: string | undefined;
  readonly homeOptions: ProfilesRootOptions;
}

export const resolveReadProfileName = async (
  ctx: RunContext,
  programOpts: unknown,
): Promise<ResolvedReadProfile> => {
  const homeOptions = buildHomeOptions(ctx);
  const flagProfile = parseGlobalFlags(programOpts, ctx.env).profile;
  const config = await loadProfilesConfig(homeOptions);
  const selection = selectProfile({
    flag: flagProfile,
    env: ctx.env,
    config,
  });
  if (selection.mode === 'implicit_v1') {
    return { name: undefined, homeOptions };
  }
  return { name: selection.name, homeOptions };
};

/**
 * Validates the positional `<key>` arg against the 4-key allowlist.
 * Throws `ConfigError` with `details.reason: 'unknown_defaults_key'`
 * per D3 case (a) + D5 in v0.12-plan §3 M55-E. NOT a zod schema —
 * `parseArgv` wraps ZodErrors as `UsageError`, but the spec binds
 * non-allowlist-key rejection to `config_error` (exit 3), so the
 * check runs OUTSIDE `parseArgv`.
 */
export const validateProfileDefaultsKey = (raw: string): ProfileDefaultsKey => {
  if (!(PROFILE_DEFAULTS_KEYS as readonly string[]).includes(raw)) {
    throw new ConfigError(
      `<key> must be one of: ${PROFILE_DEFAULTS_KEYS.join(', ')}; got "${raw}"`,
      {
        details: {
          key: raw,
          allowed_keys: PROFILE_DEFAULTS_KEYS,
          reason: 'unknown_defaults_key',
          hint: 'monday config set/get/unset only operates on the [profiles.<active>.defaults] table; top-level slots like api_token_env stay hand-TOML-editable (or via `monday auth login` for the credentials cache)',
        },
      },
    );
  }
  return raw as ProfileDefaultsKey;
};

/**
 * Coerces the positional `<value>` argv string into the typed
 * shape `profileDefaultsBlockSchema` accepts:
 *   - board / workspace → string (rejected by `^\d+$` post-coerce)
 *   - output → string (rejected by OUTPUT_FORMATS enum post-coerce)
 *   - concurrency → number (rejected by int().positive() post-coerce)
 *
 * Throws `ConfigError` with `details.reason: 'wrong_defaults_type'`
 * on a malformed value — same discriminator the resolver uses for
 * env-var-coercion failures (D3 case (b) in v0.12-plan §3 M55-E,
 * routed through `config_error` exit 3 per D5).
 */
export const coerceValueForKey = (
  key: ProfileDefaultsKey,
  raw: string,
): string | number => {
  switch (key) {
    case 'board':
    case 'workspace': {
      if (!/^\d+$/u.test(raw)) {
        throw new ConfigError(
          `<value> for ${key} must be a numeric ID (^\\d+$); got "${raw}"`,
          {
            details: {
              key,
              reason: 'wrong_defaults_type',
            },
          },
        );
      }
      return raw;
    }
    case 'output': {
      if (!(OUTPUT_FORMATS as readonly string[]).includes(raw)) {
        throw new ConfigError(
          `<value> for output must be one of: ${OUTPUT_FORMATS.join(', ')}; got "${raw}"`,
          {
            details: {
              key: 'output',
              reason: 'wrong_defaults_type',
            },
          },
        );
      }
      return raw;
    }
    case 'concurrency': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new ConfigError(
          `<value> for concurrency must be a positive integer; got "${raw}"`,
          {
            details: {
              key: 'concurrency',
              reason: 'wrong_defaults_type',
            },
          },
        );
      }
      return n;
    }
  }
};
