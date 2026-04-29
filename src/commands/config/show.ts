/**
 * `monday config show` — emits the resolved CLI config with the
 * Monday API token redacted to `<set>` / `<unset>` (`cli-design.md`
 * §7.1, `.claude/rules/security.md` "Redaction in output").
 *
 * Why this command doesn't call `loadConfig()`:
 *
 *  - `loadConfig()` rejects on a missing token. That's the right
 *    behaviour for "I'm about to make an API call" but actively
 *    unhelpful for "show me what I have configured" — agents reach
 *    for `monday config show` to debug a missing-token state.
 *
 *  - We instead read each documented env var directly and report
 *    presence + parsed value (where benign). The token is reduced
 *    to `<set>` / `<unset>`; non-secret values (`MONDAY_API_VERSION`,
 *    `MONDAY_API_URL`, `MONDAY_REQUEST_TIMEOUT_MS`) are echoed
 *    verbatim because exposing them is the whole point.
 *
 * Idempotent: yes — repeated calls observe the same env state.
 */
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
export const buildConfigShowOutput = (
  env: NodeJS.ProcessEnv,
): ConfigShowOutput => {
  const token = env.MONDAY_API_TOKEN;
  const apiVersion = env.MONDAY_API_VERSION;
  const apiUrl = env.MONDAY_API_URL;
  const timeoutRaw = env.MONDAY_REQUEST_TIMEOUT_MS;
  const profile = env.MONDAY_PROFILE;

  const timeoutNumber =
    timeoutRaw !== undefined && timeoutRaw.length > 0
      ? Number.parseInt(timeoutRaw, 10)
      : Number.NaN;

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
    request_timeout_ms:
      Number.isFinite(timeoutNumber) && timeoutNumber > 0
        ? { state: 'explicit', value: timeoutNumber }
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
