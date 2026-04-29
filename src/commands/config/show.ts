/**
 * `monday config show` — emits the resolved CLI config with the
 * Monday API token redacted to `<set>` / `<unset>` (`cli-design.md`
 * §7.1, `.claude/rules/security.md` "Redaction in output").
 *
 * Sources matter: `loadConfig()` (in `src/config/load.ts`) loads
 * `.env` into the process env before reading values, but rejects
 * on a missing token — wrong fit for a diagnostic command. We
 * preload `.env` here with the same `override: false` semantics
 * `loadConfig` uses (explicit shell exports win over file values),
 * then read the documented vars directly so a `MONDAY_API_TOKEN`
 * present only in `.env` reports as `auth: 'set'` rather than
 * lying to the user.
 *
 * Codex review §2 caught this: previously the command read
 * `ctx.env` straight, never honoured `.env`, so a token in `.env`
 * showed as unset while later API commands would happily use it.
 *
 * Numeric coercion uses `z.coerce.number().int().positive()` —
 * the same parser `loadConfig`'s env schema applies. This rejects
 * `5000abc` (which `parseInt` would silently accept as `5000`)
 * so the diagnostic matches the strict path.
 *
 * Idempotent: yes — repeated calls observe the same env state.
 */
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';

// Field naming note: the redactor's value-scan + key-pattern filter
// (`utils/redact.ts`) substitutes anything keyed under
// `(token|secret|password|api_key)` with `[REDACTED]`. That's the
// right default for incidental leakage in arbitrary command output,
// but it actively works against this command — `api_token: 'set' |
// 'unset'` would emit `[REDACTED]` and hide the very state the user
// asked for. Field names here deliberately avoid those substrings;
// the value `'set'` / `'unset'` is itself trivially non-sensitive
// (no token bytes ever leave the process).
const authStateSchema = z.enum(['set', 'unset']);

const apiVersionStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('explicit'), value: z.string() }),
  z.object({ state: z.literal('default'), value: z.string() }),
]);

const apiUrlStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('explicit'), value: z.string() }),
  z.object({ state: z.literal('default'), value: z.string() }),
]);

const timeoutStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('explicit'), value: z.number().int() }),
  z.object({ state: z.literal('default'), value: z.number().int() }),
]);

const profileStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('default') }),
  z.object({ state: z.literal('explicit'), value: z.string() }),
]);

export const configShowOutputSchema = z
  .object({
    auth: authStateSchema,
    api_version: apiVersionStateSchema,
    api_url: apiUrlStateSchema,
    request_timeout_ms: timeoutStateSchema,
    profile: profileStateSchema,
  })
  .strict();

export type ConfigShowOutput = z.infer<typeof configShowOutputSchema>;

const DEFAULT_API_VERSION = '2026-01';
const DEFAULT_API_URL = 'https://api.monday.com/v2';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Reads the documented env vars and produces the redacted view.
 * Pure — easy to unit-test against a synthetic env without spawning
 * commander.
 */
export interface BuildConfigShowOptions {
  /**
   * Working directory used to locate `.env`. Defaults to
   * `process.cwd()`. Tests pin a tmp dir to assert the load path
   * behaves predictably.
   */
  readonly cwd?: string;
  /**
   * If true, look for and merge `.env` into `env` (without
   * overriding existing entries). Defaults to true for parity with
   * `loadConfig()` — agents asking "what's configured?" should see
   * the same answer whichever path the CLI takes next.
   */
  readonly loadDotenv?: boolean;
}

const timeoutCoercion = z.coerce.number().int().positive();

export const buildConfigShowOutput = (
  env: NodeJS.ProcessEnv,
  options: BuildConfigShowOptions = {},
): ConfigShowOutput => {
  const loadDotenv = options.loadDotenv ?? true;
  if (loadDotenv) {
    // `override: false` matches `loadConfig()` so explicit shell
    // exports always win over file defaults — agents pinning a
    // token in their shell aren't surprised by a stale `.env`.
    dotenvConfig({
      path: resolve(options.cwd ?? process.cwd(), '.env'),
      processEnv: env,
      override: false,
      quiet: true,
    });
  }

  const token = env.MONDAY_API_TOKEN;
  const apiVersion = env.MONDAY_API_VERSION;
  const apiUrl = env.MONDAY_API_URL;
  const timeoutRaw = env.MONDAY_REQUEST_TIMEOUT_MS;
  const profile = env.MONDAY_PROFILE;

  // Use the same coercion `loadConfig`'s env schema applies — a
  // value like `5000abc` is rejected (yields a `default` slot)
  // rather than silently truncated to `5000` by `parseInt`.
  const timeoutResult = timeoutCoercion.safeParse(timeoutRaw);

  return {
    auth: token !== undefined && token.length > 0 ? 'set' : 'unset',
    api_version:
      apiVersion !== undefined && apiVersion.length > 0
        ? { state: 'explicit', value: apiVersion }
        : { state: 'default', value: DEFAULT_API_VERSION },
    api_url:
      apiUrl !== undefined && apiUrl.length > 0
        ? { state: 'explicit', value: apiUrl }
        : { state: 'default', value: DEFAULT_API_URL },
    request_timeout_ms: timeoutResult.success
      ? { state: 'explicit', value: timeoutResult.data }
      : { state: 'default', value: DEFAULT_TIMEOUT_MS },
    profile:
      profile !== undefined && profile.length > 0
        ? { state: 'explicit', value: profile }
        : { state: 'default' },
  };
};

const inputSchema = z.object({}).strict();

export const configShowCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ConfigShowOutput
> = {
  name: 'config.show',
  summary: 'Show the resolved CLI configuration (token redacted)',
  examples: [
    'monday config show',
    'monday config show --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: configShowOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'config', 'Configuration commands');
    noun
      .command('show')
      .description(configShowCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...configShowCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action((opts: unknown) => {
        configShowCommand.inputSchema.parse(opts);
        const output = buildConfigShowOutput(ctx.env);
        emitSuccess({
          ctx,
          data: output,
          schema: configShowCommand.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};
