/**
 * Text renderer for single-resource commands (`cli-design.md` §3.2,
 * §4 DoD #8).
 *
 * Flat `key: value` dump — one line per top-level field. Nested
 * objects (column values, etc.) get JSON-stringified inline since
 * a deeper indent-tree usually hurts more than helps for typical
 * `monday <noun> get` callers reading in a terminal. Tables are the
 * shape humans want for collections; text is the fallback for
 * single-resource calls when JSON looks too noisy.
 */
const formatValue = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
};

export interface TextInput {
  readonly data: Readonly<Record<string, unknown>>;
}

export const renderText = (
  input: TextInput,
  stream: NodeJS.WritableStream,
): void => {
  for (const [key, value] of Object.entries(input.data)) {
    stream.write(`${key}: ${formatValue(value)}\n`);
  }
};
