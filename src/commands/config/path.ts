/**
 * `monday config path` — emits the `.env` file paths the CLI considers
 * during config loading (`cli-design.md` §7.1).
 *
 * Single shape today: one `.env` next to the user's working
 * directory. v0.2's config-file work (`~/.monday-cli/config.toml`)
 * extends this output additively — the `searched` array gets new
 * entries — without touching the field set or the schema.
 *
 * Idempotent: yes.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';

const searchedEntrySchema = z
  .object({
    kind: z.enum(['dotenv']),
    path: z.string().min(1),
    exists: z.boolean(),
    description: z.string().min(1),
  })
  .strict();

export const configPathOutputSchema = z
  .object({
    cwd: z.string().min(1),
    searched: z.array(searchedEntrySchema),
  })
  .strict();

export type ConfigPathOutput = z.infer<typeof configPathOutputSchema>;

export interface BuildConfigPathOptions {
  readonly cwd: string;
}

export const buildConfigPathOutput = (
  options: BuildConfigPathOptions,
): ConfigPathOutput => {
  const dotenvPath = resolve(options.cwd, '.env');
  return {
    cwd: options.cwd,
    searched: [
      {
        kind: 'dotenv',
        path: dotenvPath,
        exists: existsSync(dotenvPath),
        description:
          '.env file in the working directory (loaded with override:false)',
      },
    ],
  };
};

const inputSchema = z.object({}).strict();

export const configPathCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ConfigPathOutput
> = {
  name: 'config.path',
  summary: 'Show config file paths the CLI considered',
  examples: [
    'monday config path',
    'monday config path --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: configPathOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'config', 'Configuration commands');
    noun
      .command('path')
      .description(configPathCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...configPathCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action((opts: unknown) => {
        configPathCommand.inputSchema.parse(opts);
        const output = buildConfigPathOutput({ cwd: process.cwd() });
        emitSuccess({
          ctx,
          data: output,
          schema: configPathCommand.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};
