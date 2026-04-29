import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../utils/errors.js';

// Validate the env vars under their actual names so error messages
// reference what the user can fix (`MONDAY_API_TOKEN`) rather than the
// internal camelCase property.
const envSchema = z.object({
  MONDAY_API_TOKEN: z.string().min(1),
  MONDAY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/u).optional(),
  MONDAY_API_URL: z.url().default('https://api.monday.com/v2'),
  MONDAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export interface Config {
  readonly apiToken: string;
  readonly apiVersion: string | undefined;
  readonly apiUrl: string;
  readonly requestTimeoutMs: number;
}

export interface LoadConfigOptions {
  /**
   * Whether to read a `.env` file from `cwd` and merge it into `env` with
   * existing values winning. Defaults to `true` only when `env` is the
   * live `process.env`; tests that inject their own env get a clean
   * read by default.
   */
  readonly loadDotenv?: boolean;
  /** Directory to look for `.env` in. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/**
 * Resolves runtime config from environment variables.
 *
 * Validation is strict so misconfiguration surfaces at startup, not on
 * the first GraphQL call. Raw `ZodError`s never escape — they're wrapped
 * in `ConfigError` (`code: "config_error"`, exit 3 per `cli-design.md`
 * §3.1 #5) with a structured `details.issues` per zod path. The runner's
 * catch-all sees a typed CLI error and emits the §6 envelope; without
 * the wrap, a missing token surfaces as `internal_error` and exit 2.
 *
 * `.env` is loaded with `override: false` so explicit shell exports
 * always win over file defaults — agents pinning a token in their
 * shell aren't surprised by a stale `.env` next to the repo.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): Config => {
  const { loadDotenv = env === process.env, cwd = process.cwd() } = options;

  if (loadDotenv) {
    dotenvConfig({
      path: resolve(cwd, '.env'),
      processEnv: env,
      override: false,
      quiet: true,
    });
  }

  const result = envSchema.safeParse({
    MONDAY_API_TOKEN: env.MONDAY_API_TOKEN,
    MONDAY_API_VERSION: env.MONDAY_API_VERSION,
    MONDAY_API_URL: env.MONDAY_API_URL,
    MONDAY_REQUEST_TIMEOUT_MS: env.MONDAY_REQUEST_TIMEOUT_MS,
  });

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    const summary = issues
      .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
      .join('; ');
    throw new ConfigError(
      `invalid Monday CLI config: ${summary}`,
      {
        cause: result.error,
        details: { issues, hint: 'set MONDAY_API_TOKEN in your shell or .env' },
      },
    );
  }

  const parsed = result.data;
  return {
    apiToken: parsed.MONDAY_API_TOKEN,
    apiVersion: parsed.MONDAY_API_VERSION,
    apiUrl: parsed.MONDAY_API_URL,
    requestTimeoutMs: parsed.MONDAY_REQUEST_TIMEOUT_MS,
  };
};
