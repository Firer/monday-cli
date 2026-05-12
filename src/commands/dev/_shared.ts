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
import { ApiError, ConfigError } from '../../utils/errors.js';
import {
  loadProfilesConfig,
  selectProfile,
  type ProfilesRootOptions,
} from '../../config/profiles.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import type { RunContext } from '../../cli/run.js';
import type { DevMapping } from '../../api/dev-conventions.js';

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
  // Tests always set HOME via the per-test tmp dir; the
  // `home === undefined` arm is defensive for production environments
  // where HOME is unset (running under a hardened systemd unit, etc.) —
  // not reproducible from any integration test.
  /* c8 ignore start */
  const home =
    ctx.env.HOME !== undefined && ctx.env.HOME.length > 0
      ? ctx.env.HOME
      : undefined;
  const homeOptions: ProfilesRootOptions =
    home !== undefined ? { home, env: ctx.env } : { env: ctx.env };
  /* c8 ignore stop */

  // `parseGlobalFlags` throws `UsageError` on a bad global flag
  // (`--retry`, `--timeout`, `--profile`, etc.). Codex M26a IMPL P1-1
  // fix: surface the UsageError synchronously so the dev verb's
  // action body never proceeds to the file-write path with invalid
  // globals. Previously a catch here let `dev configure` reach
  // `saveDevMapping` before `emitMutation`'s re-parse threw the
  // usage_error, leaving the active profile's `[profiles.<name>.dev]`
  // block clobbered despite the rejected invocation.
  const flagProfile = parseGlobalFlags(programOpts, ctx.env).profile;

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

/**
 * Slot-check helper for the 10 M26b workflow verbs. Every workflow
 * verb pulls a noun-specific board ID off the loaded {@link DevMapping}
 * + surfaces `dev_not_configured` when the slot is unset — same shape
 * 10 times pre-lift. R-NEW-32 fires at the 10-consumer threshold
 * (M26b IMPL); the helper lands with the workflow verbs themselves
 * so the duplication never appears in any feat commit.
 *
 * **Why this is `dev_not_configured`, not `dev_board_misconfigured`.**
 * Per cli-design §5.9 + the M26a round-1 P2-4 closure: the absence of
 * a slot in the dev mapping is a missing CONFIGURATION (the user
 * hasn't told the CLI which board to use). A misconfigured board —
 * board exists but doesn't expose the expected column / wiring —
 * surfaces from runtime checks via `dev_board_misconfigured` later in
 * the verb. The slot-empty case stays under `dev_not_configured`.
 */
export const requireDevBoard = (
  mapping: DevMapping,
  slot: keyof DevMapping,
  profile: string,
): string => {
  const value = mapping[slot];
  if (value === undefined) {
    const flag = slot.replace('_board', '-board');
    throw new ApiError(
      'dev_not_configured',
      `Monday Dev mapping for profile \`${profile}\` is missing the \`${slot}\` slot`,
      {
        details: {
          profile,
          slot,
          hint: `run \`monday dev configure --${flag} <bid>\` or \`monday dev discover --apply\``,
        },
      },
    );
  }
  return value;
};
