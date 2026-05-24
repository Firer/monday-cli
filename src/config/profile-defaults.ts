/**
 * Pure resolver for the `[profiles.<active>.defaults]` precedence
 * chain (cli-design.md §7.2.1, v0.12-M55-E). Given the env bag and
 * the parsed `[profiles.<active>.defaults]` table for the active
 * profile, returns the resolved value for one of the 4 allowlist
 * keys + a `source` discriminator.
 *
 * **Two consumers, single resolver.**
 *
 *   1. `src/cli/profile-defaults.ts` — Commander application layer
 *      that walks the applicability registry during preAction and
 *      injects resolved values via `setOptionValueWithSource()`.
 *   2. `src/commands/config/get.ts` — emits the resolved value +
 *      source discriminator at the `monday config get [key]`
 *      surface.
 *
 * **Precedence chain (cli-design §7.2.1):** for each allowlist key,
 * the resolved value is the first non-empty source in:
 *
 *   1. CLI flag (`--board <bid>` on the invocation) — OUT OF SCOPE
 *      for this resolver (D1 application layer reads CLI flag via
 *      Commander's `getOptionValue`; D2 explicitly excludes
 *      `cli_flag` from `monday config get`'s source surface — that
 *      verb is a config-state read, not a runtime resolution).
 *   2. Env var (per-key — `MONDAY_BOARD` / `MONDAY_WORKSPACE` /
 *      `MONDAY_OUTPUT` / `MONDAY_CONCURRENCY`).
 *   3. Profile default (`[profiles.<active>.defaults].<key>`).
 *   4. Unset.
 *
 * **Source discriminator** values: `'env_var' | 'profile_default' |
 * 'unset'`. CLI-flag source is not surfaced here — that's the
 * application layer's concern.
 */

import { z } from 'zod';
import { ConfigError } from '../utils/errors.js';
import { OUTPUT_FORMATS, type OutputFormat } from '../utils/output/select.js';
import {
  PROFILE_DEFAULTS_KEYS,
  type ProfileDefaultsBlock,
  type ProfileDefaultsKey,
} from './profiles.js';

/**
 * The per-key env-var binding table per cli-design §7.2.1
 * "Env-var bindings". One mapping per allowlist key; pinned here so
 * the resolver + any future surface that needs the binding (e.g.
 * `monday config get` reverse lookup) consumes the same map.
 */
export const PROFILE_DEFAULT_ENV_BINDINGS: Readonly<
  Record<ProfileDefaultsKey, string>
> = {
  board: 'MONDAY_BOARD',
  workspace: 'MONDAY_WORKSPACE',
  output: 'MONDAY_OUTPUT',
  concurrency: 'MONDAY_CONCURRENCY',
};

/**
 * The shape an applicability rule's predicate sees. Mirrors the
 * subset of the `Command` interface the resolver inspects;
 * separated from a direct Commander dependency so unit tests can
 * drive synthetic shapes without instantiating a real `Command`.
 */
export interface ResolveProfileDefaultInputs {
  readonly env: NodeJS.ProcessEnv;
  readonly profileDefaults: ProfileDefaultsBlock | undefined;
}

/** Discriminated-union return shape — keeps the consumer's switch
 * arms exhaustive (`lint switch-exhaustiveness-check` applies). */
export type ResolveProfileDefaultResult =
  | { readonly source: 'env_var'; readonly value: string }
  | {
      readonly source: 'profile_default';
      readonly value: string | number;
    }
  | { readonly source: 'unset' };

/**
 * Coerce + validate one env-var value through the same zod shape
 * the TOML parse boundary applies. A malformed env (e.g.
 * `MONDAY_CONCURRENCY=foo`) surfaces as `config_error` per the
 * §7.2.1 "Env-var coercion follows the §7.1 pattern" rule, not as
 * a silent fall-through to the profile default.
 *
 * Returns the validated string (numeric keys) / number
 * (concurrency) / enum value (output). Throws `ConfigError` on
 * malformed values.
 */
const validateEnvValue = (
  key: ProfileDefaultsKey,
  raw: string,
): string | number => {
  switch (key) {
    case 'board':
    case 'workspace': {
      const result = z
        .string()
        .regex(/^\d+$/u, { message: 'expected a numeric ID' })
        .safeParse(raw);
      if (!result.success) {
        throw new ConfigError(
          `${PROFILE_DEFAULT_ENV_BINDINGS[key]}=${raw} is not a valid ${key} ID (expected ^\\d+$)`,
          {
            cause: result.error,
            details: {
              key,
              env_var: PROFILE_DEFAULT_ENV_BINDINGS[key],
              reason: 'wrong_defaults_type',
            },
          },
        );
      }
      return result.data;
    }
    case 'output': {
      const result = z.enum(OUTPUT_FORMATS).safeParse(raw);
      if (!result.success) {
        throw new ConfigError(
          `${PROFILE_DEFAULT_ENV_BINDINGS.output}=${raw} is not a valid output format (expected one of: ${OUTPUT_FORMATS.join(', ')})`,
          {
            cause: result.error,
            details: {
              key: 'output',
              env_var: PROFILE_DEFAULT_ENV_BINDINGS.output,
              reason: 'wrong_defaults_type',
            },
          },
        );
      }
      return result.data;
    }
    case 'concurrency': {
      const result = z.coerce
        .number()
        .int()
        .positive()
        .safeParse(raw);
      if (!result.success) {
        throw new ConfigError(
          `${PROFILE_DEFAULT_ENV_BINDINGS.concurrency}=${raw} is not a positive integer`,
          {
            cause: result.error,
            details: {
              key: 'concurrency',
              env_var: PROFILE_DEFAULT_ENV_BINDINGS.concurrency,
              reason: 'wrong_defaults_type',
            },
          },
        );
      }
      return result.data;
    }
  }
};

/**
 * Resolves a single allowlist key against the precedence chain.
 * Pure helper consumable by both the Commander application layer
 * and the `monday config get` verb.
 *
 * The env-var layer takes precedence over the profile default per
 * §7.2.1 "Env-var bindings". An empty env value (`MONDAY_BOARD=""`)
 * is treated as unset for the env layer (consistent with how every
 * existing env-var consumer in the codebase treats `length > 0`),
 * so it falls through to the profile default.
 */
export const resolveProfileDefault = (
  key: ProfileDefaultsKey,
  inputs: ResolveProfileDefaultInputs,
): ResolveProfileDefaultResult => {
  const envName = PROFILE_DEFAULT_ENV_BINDINGS[key];
  const envValue = inputs.env[envName];
  if (envValue !== undefined && envValue.length > 0) {
    return { source: 'env_var', value: validateEnvValue(key, envValue) as string };
  }

  const profileValue = inputs.profileDefaults?.[key];
  if (profileValue !== undefined) {
    return { source: 'profile_default', value: profileValue };
  }

  return { source: 'unset' };
};

/**
 * Resolves all 4 allowlist keys at once. Convenience wrapper for
 * the application layer — walks `PROFILE_DEFAULTS_KEYS`, calls
 * `resolveProfileDefault` per key, returns the map.
 *
 * Throws `ConfigError` if any env value is malformed (the per-key
 * validation throws inside the map walk). Callers in the
 * application layer let the error bubble through preAction → the
 * runner's catch-all → exit 3 envelope.
 */
export const resolveAllProfileDefaults = (
  inputs: ResolveProfileDefaultInputs,
): Readonly<Record<ProfileDefaultsKey, ResolveProfileDefaultResult>> => {
  const result: Record<ProfileDefaultsKey, ResolveProfileDefaultResult> = {
    board: { source: 'unset' },
    workspace: { source: 'unset' },
    output: { source: 'unset' },
    concurrency: { source: 'unset' },
  };
  for (const key of PROFILE_DEFAULTS_KEYS) {
    result[key] = resolveProfileDefault(key, inputs);
  }
  return result;
};

/**
 * Type-guard helper for the `output` key — narrows
 * `ResolveProfileDefaultResult` to the OutputFormat string when
 * the resolution succeeded. Used by the application layer's
 * output-injection gate (program-level, not per-command).
 */
export const outputResultToFormat = (
  result: ResolveProfileDefaultResult,
): OutputFormat | undefined => {
  if (result.source === 'unset') {
    return undefined;
  }
  return result.value as OutputFormat;
};
