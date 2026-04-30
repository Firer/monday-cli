/**
 * `monday account version` — reports the API version pinned by the
 * CLI plus the versions Monday currently exposes (`cli-design.md`
 * §4.3, §2).
 *
 * GraphQL operation(s) called:
 *   - `versions { display_name, kind, value }` (Versions)
 *
 * Idempotent: yes — pure read.
 *
 * Why two layers:
 *   - `pinned`   — what the CLI's request will carry on the
 *     `API-Version` header. Resolved against `--api-version` >
 *     `MONDAY_API_VERSION` env > the SDK's `CURRENT_VERSION` pin.
 *     Agents read this to know which Monday API surface they're
 *     talking to.
 *   - `available` — what Monday says the server supports right now.
 *     Bumping the CLI's pin is a SemVer-minor (or major if shapes
 *     change), so the lag between this list and the pin is the
 *     CLI's upgrade window.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { PINNED_API_VERSION } from '../../api/client.js';

const pinnedSchema = z
  .object({
    /** The version string sent on the wire. */
    value: z.string().min(1),
    /** Where the pinned value came from. */
    source: z.enum(['flag', 'env', 'sdk_default']),
    /** The SDK pin literal — same as the CLI's bundled SDK ships. */
    sdk_default: z.string().min(1),
  })
  .strict();

const availableEntrySchema = z
  .object({
    display_name: z.string(),
    kind: z.string(),
    value: z.string().min(1),
  })
  .strict();

export const accountVersionOutputSchema = z
  .object({
    pinned: pinnedSchema,
    available: z.array(availableEntrySchema),
  })
  .strict();

export type AccountVersionOutput = z.infer<typeof accountVersionOutputSchema>;

const inputSchema = z.object({}).strict();

export const accountVersionCommand: CommandModule<
  z.infer<typeof inputSchema>,
  AccountVersionOutput
> = {
  name: 'account.version',
  summary: 'Show pinned vs available Monday API versions',
  examples: [
    'monday account version',
    'monday account version --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: accountVersionOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'account', 'Account commands');
    noun
      .command('version')
      .description(accountVersionCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...accountVersionCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        accountVersionCommand.inputSchema.parse(opts);
        const { client, globalFlags, apiVersion } = resolveClient(
          ctx,
          program.opts(),
        );
        const source: 'flag' | 'env' | 'sdk_default' =
          globalFlags.apiVersion !== undefined
            ? 'flag'
            : ctx.env.MONDAY_API_VERSION !== undefined &&
                ctx.env.MONDAY_API_VERSION.length > 0
              ? 'env'
              : 'sdk_default';

        const result = await client.versions();
        emitSuccess({
          ctx,
          data: {
            pinned: {
              value: apiVersion,
              source,
              sdk_default: PINNED_API_VERSION,
            },
            available: result.data.versions.map((v) => ({
              display_name: v.display_name,
              kind: v.kind,
              value: v.value,
            })),
          },
          schema: accountVersionCommand.outputSchema,
          programOpts: program.opts(),
          source: 'live',
          complexity: result.complexity,
          apiVersion,
        });
      });
  },
};
