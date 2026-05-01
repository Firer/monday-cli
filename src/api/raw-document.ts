/**
 * GraphQL document analysis for `monday raw` (M6 close, P1 fix).
 *
 * `monday raw` accepts an arbitrary GraphQL document. Two contract
 * decisions ride on what the document actually contains, and neither
 * can be answered by a string sniff:
 *
 *   1. **Mutation gate.** The CLI rejects `mutation` / `subscription`
 *      operations unless `--allow-mutation` is passed. Read paths
 *      stay safe-by-default; an agent that meant to mutate has to
 *      say so explicitly (`cli-design.md` §10.5). A naive
 *      `query.includes('mutation')` regex matches the comment
 *      `# uses the mutation api` and the field `mutation_test` —
 *      neither is an actual mutation operation.
 *   2. **`operationName` selection.** GraphQL servers use
 *      `operationName` to pick which operation to execute when a
 *      document has multiple. Hard-coding `'MondayRaw'` (the
 *      pre-fix M6 behaviour) breaks every document that doesn't
 *      happen to be named `MondayRaw` — Monday's server returns a
 *      "Unknown operation" error instead of executing the only
 *      operation present. The right answer:
 *        - 0 ops: `usage_error` ("no operations").
 *        - 1 op, anonymous: omit `operationName` from the wire
 *          request so Monday picks the only operation.
 *        - 1 op, named: pass that name.
 *        - N ops: require explicit `--operation-name <n>` and
 *          confirm it matches one of the operation names.
 *
 * The `graphql` reference parser does both jobs by walking the AST
 * — comments, fragment names, string literals can't fool it.
 *
 * Errors thrown are `UsageError`s carrying the error code
 * `usage_error` (cli-design §6.5). The fix landed alongside the
 * `--allow-mutation` and `--operation-name` flags on the `raw`
 * command in M6 close.
 */
import { parse, Kind, OperationTypeNode, type DocumentNode, type OperationDefinitionNode } from 'graphql';
import { UsageError } from '../utils/errors.js';

export interface RawDocumentAnalysis {
  /**
   * The `operationName` to send on the wire. `undefined` when the
   * document has exactly one anonymous operation (Monday picks it).
   */
  readonly operationName: string | undefined;
  /** `true` when at least one operation in the doc is a mutation. */
  readonly hasMutation: boolean;
  /** `true` when at least one operation is a subscription. */
  readonly hasSubscription: boolean;
  /**
   * One entry per operation in input order — used for error details
   * and tests so the caller can confirm the parser saw what it
   * expected.
   */
  readonly operations: readonly {
    readonly operation: 'query' | 'mutation' | 'subscription';
    readonly name: string | undefined;
  }[];
}

export interface AnalyzeRawDocumentInputs {
  readonly query: string;
  /**
   * Caller-supplied `--operation-name`. Required when the document
   * has more than one operation; optional otherwise (used as a
   * sanity check — must match one of the operation names if set).
   */
  readonly explicitOperationName: string | undefined;
  /**
   * `true` when `--allow-mutation` is set. Mutations and
   * subscriptions are rejected with `usage_error` when this is
   * `false`.
   */
  readonly allowMutation: boolean;
}

/**
 * Parses the GraphQL document and applies the two raw-command
 * contract gates: mutation rejection (unless allowed) and
 * `operationName` selection.
 */
export const analyzeRawDocument = (
  inputs: AnalyzeRawDocumentInputs,
): RawDocumentAnalysis => {
  let ast: DocumentNode;
  try {
    ast = parse(inputs.query);
  } catch (err: unknown) {
    throw new UsageError(
      `monday raw: GraphQL document failed to parse (${
        err instanceof Error ? err.message : String(err)
      }).`,
      {
        cause: err,
        details: { hint: 'check the document for syntax errors' },
      },
    );
  }

  const operations: OperationDefinitionNode[] = ast.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length === 0) {
    throw new UsageError(
      'monday raw: GraphQL document has no executable operations ' +
        '(found only fragments / type definitions). Pass a document ' +
        'with at least one query or mutation.',
      {
        details: {
          definition_kinds: ast.definitions.map((d) => d.kind),
        },
      },
    );
  }

  const opSummaries = operations.map((op) => ({
    operation: op.operation,
    name: op.name?.value,
  }));

  const hasMutation = opSummaries.some(
    (o) => o.operation === OperationTypeNode.MUTATION,
  );
  const hasSubscription = opSummaries.some(
    (o) => o.operation === OperationTypeNode.SUBSCRIPTION,
  );

  // Subscriptions never work over Monday's HTTP endpoint and the
  // CLI's transport doesn't speak websockets, so reject them
  // unconditionally — `--allow-mutation` doesn't unlock them.
  if (hasSubscription) {
    throw new UsageError(
      'monday raw: GraphQL `subscription` operations are not supported ' +
        '(the CLI transport is HTTP, not websocket). Rewrite the ' +
        'document as a query.',
      {
        details: {
          operations: opSummaries,
        },
      },
    );
  }

  if (hasMutation && !inputs.allowMutation) {
    const mutationNames = opSummaries
      .filter((o) => o.operation === OperationTypeNode.MUTATION)
      .map((o) => o.name ?? '<anonymous>');
    throw new UsageError(
      'monday raw: GraphQL `mutation` operations are blocked by default. ' +
        'Pass `--allow-mutation` if you intend to write through the ' +
        'escape hatch (the friendly verbs — `item set`, `item update`, ' +
        '`update create` — are preferred for the v0.1-modelled writes).',
      {
        details: {
          mutation_operations: mutationNames,
          hint: '--allow-mutation acknowledges the write intent',
        },
      },
    );
  }

  // Operation-name selection. Three cases keyed off operation count.
  if (operations.length === 1) {
    const only = opSummaries[0];
    /* c8 ignore next 5 — defensive: length === 1 means index 0 is
       defined; the branch exists to satisfy noUncheckedIndexedAccess
       without a non-null assertion. */
    if (only === undefined) {
      throw new UsageError('monday raw: internal — operation index 0 missing.');
    }
    if (
      inputs.explicitOperationName !== undefined &&
      only.name !== undefined &&
      inputs.explicitOperationName !== only.name
    ) {
      throw new UsageError(
        `monday raw: --operation-name ${JSON.stringify(
          inputs.explicitOperationName,
        )} doesn't match the document's only operation ` +
          `${JSON.stringify(only.name)}. Drop --operation-name or ` +
          `correct the value.`,
        {
          details: {
            requested: inputs.explicitOperationName,
            available: [only.name],
          },
        },
      );
    }
    if (
      inputs.explicitOperationName !== undefined &&
      only.name === undefined
    ) {
      throw new UsageError(
        `monday raw: --operation-name ${JSON.stringify(
          inputs.explicitOperationName,
        )} was passed but the document's single operation is ` +
          `anonymous (no name). Either drop --operation-name or name ` +
          `the operation in the document.`,
        {
          details: {
            requested: inputs.explicitOperationName,
            available: [],
          },
        },
      );
    }
    return {
      operationName: only.name,
      hasMutation,
      hasSubscription,
      operations: opSummaries,
    };
  }

  // Multi-operation: caller MUST disambiguate.
  const namedOps = opSummaries
    .map((o) => o.name)
    .filter((n): n is string => n !== undefined);
  if (inputs.explicitOperationName === undefined) {
    throw new UsageError(
      `monday raw: document has ${String(operations.length)} operations ` +
        `(${namedOps.length === 0 ? '<all anonymous>' : namedOps.join(', ')}); ` +
        `pass --operation-name <name> to select one.`,
      {
        details: {
          operations: opSummaries,
          available: namedOps,
        },
      },
    );
  }
  if (!namedOps.includes(inputs.explicitOperationName)) {
    throw new UsageError(
      `monday raw: --operation-name ${JSON.stringify(
        inputs.explicitOperationName,
      )} doesn't match any operation in the document.`,
      {
        details: {
          requested: inputs.explicitOperationName,
          available: namedOps,
        },
      },
    );
  }
  return {
    operationName: inputs.explicitOperationName,
    hasMutation,
    hasSubscription,
    operations: opSummaries,
  };
};
