import { z } from 'zod';

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

/**
 * Resolves runtime config from environment variables.
 *
 * Validation is strict so misconfiguration surfaces at startup, not on
 * the first GraphQL call. Callers should let ZodError bubble up to the
 * CLI entry, which formats it for humans.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const parsed = envSchema.parse({
    MONDAY_API_TOKEN: env.MONDAY_API_TOKEN,
    MONDAY_API_VERSION: env.MONDAY_API_VERSION,
    MONDAY_API_URL: env.MONDAY_API_URL,
    MONDAY_REQUEST_TIMEOUT_MS: env.MONDAY_REQUEST_TIMEOUT_MS,
  });

  return {
    apiToken: parsed.MONDAY_API_TOKEN,
    apiVersion: parsed.MONDAY_API_VERSION,
    apiUrl: parsed.MONDAY_API_URL,
    requestTimeoutMs: parsed.MONDAY_REQUEST_TIMEOUT_MS,
  };
};
