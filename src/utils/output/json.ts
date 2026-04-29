/**
 * JSON renderer (`cli-design.md` §3.1, §6).
 *
 * Pretty-prints with 2-space indent, trailing newline. Indentation
 * keeps casual `cat`'d output readable; `jq` and other consumers
 * tolerate whitespace fine. JSON output **never truncates** — that's
 * the whole point of the format-vs-presentation split (§3.2).
 */
export const renderJson = (
  envelope: unknown,
  stream: NodeJS.WritableStream,
): void => {
  stream.write(`${JSON.stringify(envelope, null, 2)}\n`);
};
