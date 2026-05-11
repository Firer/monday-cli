/**
 * Shared helpers for the `monday dev …` namespace verbs.
 *
 * Owns the per-verb preamble pattern surfaced across `dev discover`
 * / `dev configure` / `dev doctor` (M26a) + the workflow verbs
 * (M26b): resolve the active profile name (via the same
 * flag-/env-/default_profile priority `src/cli/program.ts`'s
 * preAction hook applies for token resolution) so the verb can
 * read/write the `[profiles.<name>.dev]` block.
 *
 * **What this module owns.** The pure profile-name resolution. Token
 * resolution is the preAction hook's job (already shipped at
 * v0.3-M21); this helper picks up the same precedence chain and
 * surfaces the resolved name for the dev block IO.
 *
 * **What this module does NOT own.** The dev mapping IO itself
 * (`loadDevMapping` / `saveDevMapping` in
 * `src/api/dev-conventions.ts`); those take the resolved profile
 * name as a parameter.
 */
import { ConfigError } from '../../utils/errors.js';
import {
  loadProfilesConfig,
  selectProfile,
  type ProfilesRootOptions,
} from '../../config/profiles.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import type { RunContext } from '../../cli/run.js';

export interface ResolvedDevProfile {
  readonly name: string;
  readonly homeOptions: ProfilesRootOptions;
}

/**
 * Resolves the active profile name for a dev-namespace verb.
 * Surfaces `config_error` (NOT `dev_not_configured`) when the verb
 * runs in implicit-v1 mode — the dev namespace is fundamentally
 * named-profile-only since the dev block lives under
 * `[profiles.<name>.dev]`.
 *
 * Precedence mirrors `cli-design.md` §7.2 + `src/cli/program.ts`'s
 * preAction hook:
 *   1. `--profile <name>` global flag
 *   2. `MONDAY_PROFILE` env var
 *   3. `default_profile` in `~/.monday-cli/config.toml`
 *   4. Implicit-v1 sentinel → throws `config_error`
 */
export const resolveActiveDevProfile = async (
  ctx: RunContext,
  programOpts: unknown,
): Promise<ResolvedDevProfile> => {
  // HOME-truthy + length check mirrors `src/cli/program.ts:171-174`.
  const home =
    ctx.env.HOME !== undefined && ctx.env.HOME.length > 0
      ? ctx.env.HOME
      : undefined;
  const homeOptions: ProfilesRootOptions =
    /* c8 ignore next */
    home !== undefined ? { home, env: ctx.env } : { env: ctx.env };

  let flagProfile: string | undefined;
  try {
    flagProfile = parseGlobalFlags(programOpts, ctx.env).profile;
  } catch {
    // A global-flag parse failure already surfaces as `usage_error`
    // via the runner's catch-all; this helper just falls back to
    // env/default below.
    /* c8 ignore next */
    flagProfile = undefined;
  }

  const config = await loadProfilesConfig(homeOptions);
  const selection = selectProfile({
    flag: flagProfile,
    env: ctx.env,
    config,
  });

  if (selection.mode === 'implicit_v1') {
    throw new ConfigError(
      '`monday dev` verbs require a named profile',
      {
        details: {
          hint: 'set MONDAY_PROFILE=<name>, pass --profile <name>, or set `default_profile` in ~/.monday-cli/config.toml (run `monday auth login --profile <name>` to populate the credentials cache too)',
        },
      },
    );
  }

  return { name: selection.name, homeOptions };
};
