/**
 * `monday schema [<command>]` — emits the CLI surface as JSON Schema
 * 2020-12 (`cli-design.md` §11.1).
 *
 * Two consumers:
 *
 *  - **Agents.** Ingest `monday schema --json` once per session;
 *    every command's input flags + output shape are described
 *    machine-readably. No `--help` scraping, no doc parsing,
 *    no English-message dependence. The error-code list is
 *    embedded so agents key off `code` against the same source
 *    of truth this CLI does.
 *
 *  - **The CLI itself.** Every command's `outputSchema` is the
 *    same zod schema the `emitSuccess` drift-catch reads. The
 *    schema command and the runtime contract can never diverge
 *    because there's only one schema.
 *
 * `z.toJSONSchema` (zod v4 native) handles brand / refinement /
 * coercion round-trips that earlier zod-to-JSON-Schema libs got
 * wrong. Sharp-edge note: brands erase to their wrapped type in
 * the JSON Schema output (a `BoardId` becomes a `string` with
 * the regex), which is the right behaviour for an external
 * consumer — they validate against the wire shape, not the brand.
 *
 * Idempotent: yes — pure read.
 *
 * The command lives at the top of the namespace (`monday schema`),
 * not as a verb under a noun, because it describes the entire
 * surface, not a Monday concept.
 */
import { z } from 'zod';
import {
  CODE_RETRYABLE_DEFAULT,
  CODE_TYPICAL_HTTP_STATUS,
  ERROR_CODES,
  exitCodeForError,
  UsageError,
} from '../../utils/errors.js';
import { getCommandRegistry } from '../index.js';
import type { CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';

const jsonSchemaSchema: z.ZodType = z.unknown();

const commandEntrySchema = z
  .object({
    name: z.string().min(1),
    summary: z.string().min(1),
    examples: z.array(z.string()),
    idempotent: z.boolean(),
    input: jsonSchemaSchema,
    output: jsonSchemaSchema,
  })
  .strict();

const errorCodeEntrySchema = z
  .object({
    code: z.enum(ERROR_CODES),
    exit_code: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(130),
    ]),
    /**
     * Default retry policy per `cli-design.md` §6.5. Per-instance
     * `error.retryable` may override (e.g. a Monday rate-limit
     * response with a custom Retry-After) — agents check the live
     * envelope first, fall back to this hint.
     */
    retryable: z.boolean(),
    /**
     * Typical HTTP status when this code originates from Monday's
     * API. `null` for codes with no fixed expectation (config /
     * cache / usage failures, anything originating local).
     */
    typical_http_status: z.number().int().nullable(),
  })
  .strict();

const exitCodeEntrySchema = z
  .object({
    code: z.number().int(),
    meaning: z.string().min(1),
  })
  .strict();

export const schemaOutputSchema = z
  .object({
    schema_version: z.literal('1'),
    api_version: z.string().min(1),
    cli_version: z.string().min(1),
    commands: z.record(z.string(), commandEntrySchema),
    error_codes: z.array(errorCodeEntrySchema),
    exit_codes: z.array(exitCodeEntrySchema),
  })
  .strict();

export type SchemaOutput = z.infer<typeof schemaOutputSchema>;

const inputSchema = z
  .object({
    command: z.string().min(1).optional(),
  })
  .strict();

const EXIT_CODES: readonly { readonly code: number; readonly meaning: string }[] = [
  { code: 0, meaning: 'success' },
  { code: 1, meaning: 'usage error (bad flags, missing required args)' },
  { code: 2, meaning: 'API or local-resource error (network, cache, validation)' },
  { code: 3, meaning: 'config error (missing/invalid token)' },
  { code: 130, meaning: 'aborted by SIGINT' },
];

export interface BuildSchemaOptions {
  readonly modules: readonly CommandModule[];
  readonly apiVersion: string;
  readonly cliVersion: string;
  /** When set, narrow `commands` to just this dotted name. */
  readonly only?: string;
}

const toCommandEntry = (
  mod: CommandModule,
): z.infer<typeof commandEntrySchema> => ({
  name: mod.name,
  summary: mod.summary,
  examples: [...mod.examples],
  idempotent: mod.idempotent,
  input: z.toJSONSchema(mod.inputSchema),
  output: z.toJSONSchema(mod.outputSchema),
});

/**
 * Pure builder so unit tests can validate the emitted shape against
 * a JSON Schema validator without spawning commander / running an
 * envelope through emit.
 */
export const buildSchemaOutput = (options: BuildSchemaOptions): SchemaOutput => {
  let modules: readonly CommandModule[];
  if (options.only !== undefined) {
    const found = options.modules.find((m) => m.name === options.only);
    if (found === undefined) {
      const available = options.modules.map((m) => m.name).sort();
      throw new UsageError(`unknown command "${options.only}"`, {
        details: { hint: 'see `monday schema` for the full list', available },
      });
    }
    modules = [found];
  } else {
    modules = options.modules;
  }

  // Lexicographic order so two runs in different registration order
  // produce byte-equal output — agents diff `monday schema --json`
  // across versions to spot contract changes.
  const sorted = [...modules].sort((a, b) => a.name.localeCompare(b.name));
  const commands = Object.fromEntries(
    sorted.map((m) => [m.name, toCommandEntry(m)]),
  );

  return {
    schema_version: '1',
    api_version: options.apiVersion,
    cli_version: options.cliVersion,
    commands,
    error_codes: ERROR_CODES.map((code) => ({
      code,
      exit_code: exitCodeForError(code),
      retryable: CODE_RETRYABLE_DEFAULT[code],
      typical_http_status: CODE_TYPICAL_HTTP_STATUS[code],
    })),
    exit_codes: [...EXIT_CODES],
  };
};

export const schemaCommand: CommandModule<
  z.infer<typeof inputSchema>,
  SchemaOutput
> = {
  name: 'schema',
  summary: 'Emit the CLI command surface as JSON Schema 2020-12',
  examples: [
    'monday schema --json',
    'monday schema config.show --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: schemaOutputSchema,
  attach: (program, ctx) => {
    program
      .command('schema')
      .argument(
        '[command]',
        'narrow output to a single command (dotted name, e.g. config.show)',
      )
      .description(schemaCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...schemaCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action((commandArg: string | undefined, opts: unknown) => {
        const parsed = schemaCommand.inputSchema.parse({
          ...(commandArg === undefined ? {} : { command: commandArg }),
          ...(opts as object),
        });
        const data = buildSchemaOutput({
          modules: getCommandRegistry(),
          apiVersion: ctx.env.MONDAY_API_VERSION ?? '2026-01',
          cliVersion: ctx.cliVersion,
          ...(parsed.command === undefined ? {} : { only: parsed.command }),
        });
        emitSuccess({
          ctx,
          data,
          schema: schemaCommand.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};

