import type { Command } from 'commander';
import type { z } from 'zod';
import type { RunContext } from '../cli/run.js';
import { lookupNounDescription } from './noun-descriptions.js';

/**
 * A registered CLI command (`v0.1-plan.md` §4 DoD #2).
 *
 * Every command — top-level (`schema`) or noun-verb (`config show`)
 * — exports one of these. The static `commandRegistry`
 * (`src/commands/index.ts`) collects them; `run()` walks the registry
 * once per invocation to wire commander, and `monday schema` walks
 * the same registry to emit JSON Schema.
 *
 * The contract is:
 *
 *  - `name` is the dotted path from `monday`: `"config.show"`,
 *    `"cache.clear"`, `"schema"`. Used as the JSON Schema key and the
 *    `monday schema <command>` argument.
 *  - `inputSchema` validates the parsed argv at the action boundary
 *    (per `validation.md` "parse, don't validate"). It's the source
 *    of truth for `monday schema`'s input description.
 *  - `outputSchema` describes the `data` payload the success envelope
 *    will carry — it's executable, so the integration tests can
 *    `outputSchema.parse(data)` to catch drift, and `monday schema`
 *    emits it via `z.toJSONSchema`.
 *  - `attach(program, ctx)` wires the command onto commander. It owns
 *    parent-noun creation (`ensureSubcommand`), positional / flag
 *    declarations, the `addHelpText('after', ...)` example, and the
 *    action body. The action: parses argv via `inputSchema`, calls
 *    the command's logic, validates via `outputSchema`, and emits
 *    via `emitSuccess`.
 *
 * Why a generic interface and not a concrete class: per-command
 * differences (positional vs flag-only, single-resource vs
 * collection, accepts-stdin or not) are best captured as code in
 * `attach` rather than ferried through shared options that grow
 * unbounded as the surface expands.
 */
export interface CommandModule<I = unknown, O = unknown> {
  readonly name: string;
  /** One-line summary used as `description()` on commander. */
  readonly summary: string;
  /**
   * Usage examples emitted via `addHelpText('after', ...)`. Per the
   * `cli.md` rule, every command has at least one. Lines should
   * start with `monday <cmd>` (no `$` prefix — the dollar-sign hurts
   * copy-paste).
   */
  readonly examples: readonly string[];
  /**
   * Documented per command (`v0.1-plan.md` §4 DoD #6). Read-only
   * commands are trivially idempotent; mutations document explicitly
   * whether re-running with the same args is safe.
   */
  readonly idempotent: boolean;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly attach: (program: Command, ctx: RunContext) => void;
}

/**
 * Idempotently finds-or-creates a noun-level command on `program`.
 * Multiple verb commands share the same parent (`monday config show`,
 * `monday config path`); each `attach` calls this so the parent is
 * registered exactly once regardless of registration order.
 *
 * `summary` is optional — when omitted, the description is looked
 * up in `NOUN_DESCRIPTIONS` (the single source of truth). Passing
 * an explicit `summary` overrides the map; this override path is
 * preserved across the v0.10-M53 → IMPL migration window so the
 * existing ~120 call sites compile unchanged, and `M53 IMPL` drops
 * the explicit summary from each site (see `docs/v0.10-plan.md`
 * §3 M53 D2 for the migration story).
 *
 * The 2-arg + 3-arg overloads are deliberate: TypeScript's
 * `exactOptionalPropertyTypes` does not apply to function parameters,
 * so a single `summary?: string` parameter would silently accept
 * `ensureSubcommand(program, name, undefined)` (and fall through to
 * the map lookup). Overloads force callers to either omit the third
 * argument entirely or pass a concrete string.
 */
// Overloads are deliberate: the 2-arg + 3-arg public signatures
// force callers to either omit the third argument entirely or pass
// a concrete string. A single `summary?: string` parameter would
// silently accept `ensureSubcommand(program, name, undefined)` (the
// implementation `summary ?? lookupNounDescription(name)` falls
// through to the map either way, so the runtime is equivalent — but
// the type-level check makes "maybe-undefined override" impossible
// from typed call sites, which prevents the typo class where a
// caller meant to pass a real summary but threaded a maybe-undefined
// variable). `@typescript-eslint/unified-signatures` would prefer
// the collapsed form; the type-safety guarantee is worth the waiver.
/* eslint-disable @typescript-eslint/unified-signatures */
export function ensureSubcommand(program: Command, name: string): Command;
export function ensureSubcommand(
  program: Command,
  name: string,
  summary: string,
): Command;
/* eslint-enable @typescript-eslint/unified-signatures */
export function ensureSubcommand(
  program: Command,
  name: string,
  summary?: string,
): Command {
  const existing = program.commands.find((c) => c.name() === name);
  if (existing !== undefined) {
    return existing;
  }
  const description = summary ?? lookupNounDescription(name);
  const child = program.command(name).description(description);
  return child;
}
