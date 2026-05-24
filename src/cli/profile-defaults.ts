/**
 * Commander application layer for the v0.12-M55-E profile-scoped
 * argument defaults (cli-design §7.2.1). Pairs with the pure
 * resolver at `src/config/profile-defaults.ts`.
 *
 * **Lifecycle.** Called from `src/cli/program.ts`'s `preAction`
 * hook AFTER profile selection completes. The hook injects
 * resolved values into Commander's option store via
 * `setOptionValueWithSource(key, value, 'config')`, so commands see
 * the value via `actionCommand.getOptionValue(key)` /
 * `actionCommand.opts()` without any per-command code change
 * (downstream parseArgv runs unchanged; Zod schemas continue to
 * own usage-error wrapping at the action boundary per
 * `src/commands/parse-argv.ts`).
 *
 * **Applicability registry — the load-bearing innovation.** Blind
 * injection of profile defaults into every command that declares
 * `--board <bid>` / `--workspace <wid>` / `--concurrency <n>`
 * would break shipped contracts. Three classes of conflict:
 *
 *   1. **Required-flag commands without a mutually-exclusive
 *      sibling** — `item list`, `item find`, `item upsert`,
 *      `doc create-in-workspace`, `doc import-html`. These accept
 *      a profile default cleanly. Their `.requiredOption` is
 *      converted to `.option` at v0.12-M55-E IMPL so the absent-
 *      flag path can be filled by the profile default.
 *
 *   2. **Commands where the flag is mutually exclusive with a
 *      sibling** — `item create --parent <iid>` rejects `--board`
 *      with a `usage_error` (subitems board is derived server-
 *      side); `update list <itemId>` is XOR with `--board`;
 *      `item search` enforces `--board` / `--workspace` /
 *      `--favorites` mutual exclusion. Profile-default injection
 *      would turn legal invocations into spurious usage errors.
 *      These commands SKIP injection entirely (entry absent from
 *      the registry).
 *
 *   3. **Commands where the flag is contextually gated by a
 *      sibling flag** — `item update --concurrency` is valid only
 *      on the bulk partial-success path (`--continue-on-error`).
 *      Injecting a profile default of `concurrency` would break
 *      single-item update + fail-fast bulk paths. The registry
 *      uses an optional `precondition` to gate injection on the
 *      sibling flag's presence (the precondition reads the actual
 *      `actionCommand.getOptionValue(...)` — preAction fires
 *      AFTER Commander parses the action body's argv, so sibling
 *      flag values are visible at injection time).
 *
 * **Output is handled at program-level, NOT per-command.**
 * `--output <fmt>` is a global flag (declared on `program` in
 * `src/cli/program.ts`); its injection is gated by absence of ALL
 * shorthand + flag + env-var paths (`--json`, `--table`,
 * `--output`, `MONDAY_OUTPUT`). This avoids overriding the
 * shorthand flags' priority in `src/utils/output/select.ts`.
 */

import type { Command } from 'commander';
import { resolveProfileDefault } from '../config/profile-defaults.js';
import type { ProfileDefaultsBlock, ProfileDefaultsKey } from '../config/profiles.js';

/**
 * Builds the "noun.verb" command-path identifier Commander
 * surfaces via `actionCommand.name()` + its `parent.name()`.
 * Mirrors the dotted-path scheme `CommandModule.name` uses
 * (`item.list`, `doc.create-in-workspace`).
 *
 * Top-level commands (no noun parent) get an undefined path —
 * none of M55-E's applicable commands are top-level, so
 * undefined means "skip injection".
 */
const commandPathOf = (cmd: Command): string | undefined => {
  // grandparent === null: parent IS the program (top-level command, no noun).
  // grandparent === undefined: cmd itself is the program (no parent at all).
  const parent = cmd.parent;
  const grandparent = parent?.parent;
  if (parent === null || grandparent === null || grandparent === undefined) {
    return undefined;
  }
  return `${parent.name()}.${cmd.name()}`;
};

/**
 * Predicate signature for the registry's optional `precondition`
 * field. Receives the running `actionCommand` so the predicate can
 * inspect sibling option values via `getOptionValue(...)`.
 */
type ApplicabilityPredicate = (cmd: Command) => boolean;

interface ApplicabilityEntry {
  readonly commandPath: string;
  readonly key: ProfileDefaultsKey;
  readonly precondition?: ApplicabilityPredicate;
}

/**
 * The applicability registry. Each entry pins ONE (commandPath,
 * key) tuple where profile-default injection is safe.
 *
 * **How to add a new entry.** When a new command is added that
 * unconditionally accepts one of the 4 allowlist keys:
 *   1. Convert its `.requiredOption('--<key> <v>')` to `.option(...)`.
 *   2. Append the entry here.
 *   3. Verify no sibling mutual-exclusion test fails.
 *
 * **How to add a new key.** Beyond the 4 allowlist keys defers to
 * v0.12.x candidate-selection per cli-design §13 v0.12 entry
 * (D4 in v0.12-plan §3 M55-E).
 */
const APPLICABILITY_REGISTRY: readonly ApplicabilityEntry[] = [
  // --board: unconditionally required, no sibling mutual-exclusion.
  { commandPath: 'item.list', key: 'board' },
  { commandPath: 'item.find', key: 'board' },
  { commandPath: 'item.upsert', key: 'board' },

  // --board on `item create`: required on the regular (non-subitem)
  // path; rejected when `--parent <iid>` selects the subitem branch
  // (the subitems board is derived server-side; see
  // `item/create.ts:432-438`). Precondition: --parent absent.
  // (Codex IMPL R1 P2 widening.)
  {
    commandPath: 'item.create',
    key: 'board',
    precondition: (cmd) => cmd.getOptionValue('parent') === undefined,
  },

  // --board on `item update` / `item clear` bulk shape: the
  // `--where` / `--filter-json` paths REQUIRE `--board <bid>` (the
  // bulk walker needs to know which board's `items_page` to scan).
  // Single-item shape derives board from the item itself; injecting
  // a profile default there would silently override the item's
  // home board. Precondition: bulk filter present.
  // (Codex IMPL R1 P2 widening.)
  {
    commandPath: 'item.update',
    key: 'board',
    precondition: (cmd) => hasBulkFilter(cmd),
  },
  {
    commandPath: 'item.clear',
    key: 'board',
    precondition: (cmd) => hasBulkFilter(cmd),
  },

  // --board on `update list` board-scan shape: when no positional
  // `[itemId]` is given, the verb lists every update across the
  // named `--board`. The single-item shape (`update list <iid>`)
  // is XOR with `--board` (see `update/list.ts` mutual-exclusion).
  // Precondition: no positional itemId. (Codex IMPL R1 P2 widening.)
  {
    commandPath: 'update.list',
    key: 'board',
    precondition: (cmd) => cmd.args.length === 0,
  },

  // --workspace: ALWAYS-required, no sibling mutual-exclusion.
  { commandPath: 'doc.create-in-workspace', key: 'workspace' },
  { commandPath: 'doc.import-html', key: 'workspace' },

  // --concurrency: gated to bulk + --continue-on-error per
  // `item/update.ts:333-340` (`--concurrency is only valid on the
  // bulk partial-success path`). The precondition reads the
  // sibling --continue-on-error value at preAction time.
  {
    commandPath: 'item.update',
    key: 'concurrency',
    precondition: (cmd) => cmd.getOptionValue('continueOnError') === true,
  },
];

/**
 * Shared bulk-shape detector for `item update` / `item clear`.
 * Mirrors the runtime check at `item/update.ts:303` +
 * `item/clear.ts:237` (`hasFilter = parsed.where.length > 0 ||
 * parsed.filterJson !== undefined`). The precondition reads
 * Commander's raw option store at preAction time, before zod
 * branding runs in the action body.
 */
const hasBulkFilter = (cmd: Command): boolean => {
  // `getOptionValue` returns `unknown` semantically — Commander's
  // typing returns `any`, so we narrow defensively before reading.
  const where: unknown = cmd.getOptionValue('where');
  const filterJson: unknown = cmd.getOptionValue('filterJson');
  const hasWhere = Array.isArray(where) && where.length > 0;
  const hasFilterJson =
    typeof filterJson === 'string' && filterJson.length > 0;
  return hasWhere || hasFilterJson;
};

/**
 * Inputs the application layer needs from the runtime context.
 * Threading a narrow interface keeps the unit-test surface small
 * (no need to construct a full `RunContext`).
 */
export interface ApplyProfileDefaultsInputs {
  readonly program: Command;
  readonly actionCommand: Command;
  readonly env: NodeJS.ProcessEnv;
  readonly profileDefaults: ProfileDefaultsBlock | undefined;
}

/**
 * Walks the registry, calling `setOptionValueWithSource(key,
 * value, 'config')` for each entry whose:
 *   - `commandPath` matches the running command's
 *     `${parent}.${name}`, AND
 *   - precondition (if any) returns true, AND
 *   - the option is currently undefined on the action command
 *     (an explicit `--<key> <v>` always wins per §7.2.1).
 *
 * The `'config'` source string is Commander's standard 4-tuple
 * (`'cli' | 'env' | 'config' | 'default'`); using `'config'` lets
 * downstream `getOptionValueSource(key)` callers distinguish a
 * resolved-from-profile value from an explicit flag, an env, or
 * Commander's own default.
 *
 * Throws `ConfigError` if the env-var validation in the resolver
 * rejects (e.g. `MONDAY_CONCURRENCY=foo`). The error propagates
 * through preAction → the runner's catch-all → exit 3 envelope.
 */
export const applyPerCommandProfileDefaults = (
  inputs: ApplyProfileDefaultsInputs,
): void => {
  const path = commandPathOf(inputs.actionCommand);
  if (path === undefined) {
    return;
  }
  // Per-key LAZY resolution (Codex IMPL R1 P1): only validate the
  // env-var for a key the registry actually injects into THIS
  // command. An eager `resolveAllProfileDefaults` here meant a
  // malformed `MONDAY_BOARD=bad` could fail unrelated commands
  // (`auth login`, `item get`, etc.) because resolution validated
  // every key on every preAction. Now: only resolve a key after
  // the path matches + precondition holds + the option is absent.
  for (const entry of APPLICABILITY_REGISTRY) {
    if (entry.commandPath !== path) {
      continue;
    }
    if (entry.precondition !== undefined && !entry.precondition(inputs.actionCommand)) {
      continue;
    }
    if (inputs.actionCommand.getOptionValue(entry.key) !== undefined) {
      // Explicit flag (or earlier injection) wins.
      continue;
    }
    const result = resolveProfileDefault(entry.key, {
      env: inputs.env,
      profileDefaults: inputs.profileDefaults,
    });
    if (result.source === 'unset') {
      continue;
    }
    inputs.actionCommand.setOptionValueWithSource(
      entry.key,
      result.value,
      'config',
    );
  }
};

/**
 * Program-level `--output` injection. Separate from the per-
 * command registry because `--output` is a global flag declared
 * on `program` (not on individual subcommands).
 *
 * **Gating:** inject the profile-default `output` ONLY when ALL of:
 *   - `program.opts().json` is falsy (no `--json` shorthand)
 *   - `program.opts().table` is falsy (no `--table` shorthand)
 *   - `program.opts().output` is undefined (no explicit `--output`)
 *   - `env.MONDAY_OUTPUT` is unset or empty
 *
 * Avoids overriding the shorthand-flag priority in
 * `src/utils/output/select.ts` (shorthand > explicit > env > TTY).
 * The injection acts AS env from `select.ts`'s perspective once
 * Commander surfaces it via `program.opts().output`.
 */
export const applyProgramOutputDefault = (
  program: Command,
  env: NodeJS.ProcessEnv,
  profileDefaults: ProfileDefaultsBlock | undefined,
): void => {
  const programOpts: Readonly<{
    readonly json?: boolean;
    readonly table?: boolean;
    readonly output?: string;
  }> = program.opts();
  if (programOpts.json === true || programOpts.table === true) {
    return;
  }
  if (programOpts.output !== undefined) {
    return;
  }
  if (env.MONDAY_OUTPUT !== undefined && env.MONDAY_OUTPUT.length > 0) {
    return;
  }
  // Lazy single-key resolution (Codex IMPL R1 P1): validating
  // only `output`'s env binding here means a malformed
  // `MONDAY_BOARD` can't crash a command whose only profile-
  // defaults touch is the program-level output gate.
  const outputResult = resolveProfileDefault('output', {
    env,
    profileDefaults,
  });
  if (outputResult.source === 'unset') {
    return;
  }
  program.setOptionValueWithSource('output', outputResult.value, 'config');
};

/**
 * Convenience: run both per-command + program-level injection in
 * one call. Used from `src/cli/program.ts`'s preAction hook.
 */
export const applyAllProfileDefaults = (
  inputs: ApplyProfileDefaultsInputs,
): void => {
  applyProgramOutputDefault(inputs.program, inputs.env, inputs.profileDefaults);
  applyPerCommandProfileDefaults(inputs);
};
