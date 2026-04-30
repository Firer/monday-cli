import { randomUUID } from 'node:crypto';

/**
 * Generates the `meta.request_id` echoed in every output envelope
 * (`cli-design.md` §6.1). Wrapping `crypto.randomUUID` in an
 * injectable factory makes deterministic snapshots possible — tests
 * substitute a fixed-value generator without monkey-patching
 * `node:crypto`.
 */
export type RequestIdGenerator = () => string;

export const defaultRequestIdGenerator: RequestIdGenerator = () => randomUUID();

/**
 * Builds a generator that yields each value in `ids` in order. Falls
 * back to `defaultRequestIdGenerator` once the canned sequence is
 * exhausted so a test that under-counts gets a real UUID instead of
 * `undefined` — easier to spot than a silent failure.
 */
export const fixedRequestIdGenerator = (
  ids: readonly string[],
): RequestIdGenerator => {
  let i = 0;
  return () => {
    if (i < ids.length) {
      const id = ids[i];
      i++;
      /* c8 ignore next 4 — narrow: the `i < ids.length` guard above
         already proves `ids[i]` is defined; the explicit check
         exists only because `noUncheckedIndexedAccess` widens the
         indexed type. */
      if (id !== undefined) {
        return id;
      }
    }
    return defaultRequestIdGenerator();
  };
};
