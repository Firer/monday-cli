/**
 * `monday status` — connectivity + auth + local-state probe matrix
 * (cli-design §11.5 / §13 v0.3 entry; v0.3-plan §3 M22).
 *
 * **v0.3-M22 pre-flight stub.** Registered for forward-compatibility
 * (agent scripts targeting `monday status` are stable across the M22
 * implementation drop) and rejects every invocation today with
 * `internal_error` carrying the M22-pending hint. The argv shape
 * (`--no-probe` opt-out; no positional) is the final shape M22
 * implementation ships against; only the action body changes.
 *
 * **`--no-probe` per Decision 7 closure.** Default behaviour probes
 * Monday (DNS / TCP / TLS / auth). `--no-probe` opts out, skipping
 * just those four network-touching probes; the local-only probes
 * (cache writability, redaction self-test, env-var pickup) still
 * run because they don't touch account state and are the v0.3 value
 * of a "check my CLI is configured correctly" run.
 *
 * **Empirical-probe finding pinned (2026-05-10, API `2026-01`).** The
 * 401 envelope shape `monday status`'s auth probe maps against:
 * status `401`, content-type `application/json; charset=utf-8`,
 * body `{"errors":[{"message":"Not authenticated","extensions":
 * {"code":"NOT_AUTHENTICATED"}}]}`. Identical envelope for
 * missing-`Authorization` and bad-`Authorization`. Maps verbatim
 * to `unauthorized` (existing error code; NO new code needed). See
 * `src/api/probes.ts` for the load-bearing probe-finding docstring.
 *
 * **What lands at M22 implementation:**
 *   - For each entry in {@link import('../api/probes.js').STATUS_PROBE_ORDER},
 *     either run the probe (default) or emit a `ProbeSkipped` slot
 *     (under `--no-probe` for network probes).
 *   - Aggregate per-probe results into the `StatusOutput` envelope
 *     shape; compute `overall` per the §11.5 rule.
 *   - Pass BOTH `ctx.env` AND `ctx.runtimeSecrets` into the
 *     redaction self-test so the probe exercises the same two-layer
 *     redaction the production emission paths use (cli-design §7.4.3
 *     — Codex M21 Part 2 P1 ratified the two-arg `collectSecrets`
 *     contract; pre-flight surface mirrors that signature so M22
 *     impl can't drift to a one-arg shape).
 *   - Emit success envelope per §6.1.
 */
import { z } from 'zod';
import type { CommandModule } from './types.js';
import { ApiError } from '../utils/errors.js';

const inputSchema = z
  .object({
    no_probe: z.boolean(),
  })
  .strict();

const probeResultEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    probe: z.string().min(1),
    elapsed_ms: z.number().nonnegative(),
    details: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('fail'),
    probe: z.string().min(1),
    elapsed_ms: z.number().nonnegative(),
    reason: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('skipped'),
    probe: z.string().min(1),
    reason: z.string().min(1),
  }),
]);

const statusOutputSchema = z
  .object({
    probes: z
      .object({
        dns: probeResultEnvelopeSchema,
        tcp: probeResultEnvelopeSchema,
        tls: probeResultEnvelopeSchema,
        auth: probeResultEnvelopeSchema,
        cache_writability: probeResultEnvelopeSchema,
        redaction_self_test: probeResultEnvelopeSchema,
        env_var_pickup: probeResultEnvelopeSchema,
      })
      .catchall(probeResultEnvelopeSchema),
    overall: z.enum(['ok', 'degraded', 'down']),
    api_version: z.string().min(1),
  })
  .strict();

export type StatusOutput = z.infer<typeof statusOutputSchema>;

export const statusCommand: CommandModule<
  z.infer<typeof inputSchema>,
  StatusOutput
> = {
  name: 'status',
  summary:
    'Run the connectivity + auth + local-state probe matrix (v0.3-M22 pre-flight stub — runtime body lands at M22 implementation)',
  examples: [
    'monday status',
    'monday status --json',
    'monday status --no-probe        # skip network probes; run local-only',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: statusOutputSchema,
  attach: (program) => {
    program
      .command('status')
      .description(statusCommand.summary)
      .option(
        '--no-probe',
        'Skip network probes (DNS / TCP / TLS / auth); run local-only probes (cache / redaction / env-var)',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...statusCommand.examples.map((e) => `  ${e}`),
          '',
          'NOTE: Pre-flight stub — runtime body lands at v0.3-M22',
          'implementation. The verb registers the argv shape so agent',
          'scripts targeting `monday status` are stable across the drop-in.',
          '',
        ].join('\n'),
      )
      // Commander's `--no-probe` declaration produces `{probe: false}`
      // on the opts object (the `--no-X` form negates `X`); the action
      // normalises to `{no_probe: !opts.probe}` so the input schema
      // mirrors the user-facing flag name. The action stays async to
      // route the stub rejection through the runner's envelope mapper
      // per the M20 / M21 pre-flight stub pattern.
      .action(async (rawOpts: unknown) => {
        const opts = rawOpts as { probe?: boolean };
        const noProbe = opts.probe === false;
        statusCommand.inputSchema.parse({ no_probe: noProbe });
        // Pre-flight stub — every invocation rejects. M22
        // implementation replaces this with the real probe-matrix
        // action per cli-design §11.5.
        await Promise.reject(
          new ApiError(
            'internal_error',
            '`monday status` is a v0.3-M22 pre-flight stub — runtime probe-matrix body lands at M22 implementation alongside `src/api/probes.ts`.',
            {
              details: {
                no_probe: noProbe,
                hint: 'M22 implementation kickoff lands the runtime DNS / TCP / TLS / auth probes + the local cache-writability + redaction-self-test + env-var-pickup probes.',
              },
            },
          ),
        );
      });
  },
};
