/**
 * Deep-clone-and-redact helper.
 *
 * The CLI holds a Monday API token with the user's full account
 * permissions; the security rules in `.claude/rules/security.md`
 * forbid that token appearing in *any* emitted byte — log lines,
 * error messages, debug payloads, JSON envelopes. Every output
 * path funnels through this function.
 *
 * The default sensitive-key list covers the names we know about
 * (`apiToken`, `Authorization`, `MONDAY_API_TOKEN`) plus a generic
 * `(token|secret|password|api[-_]?key)` pattern that catches
 * future-named secrets without an extra audit step. Callers extend
 * the list when they have local context (e.g. a credentials cache
 * field name).
 *
 * Circular references are tracked via a `WeakSet` and replaced
 * with a `[Circular]` marker — never the original value, never a
 * thrown error that could leak in a stack trace.
 */

const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'apiToken',
  'Authorization',
  'MONDAY_API_TOKEN',
];

const DEFAULT_SENSITIVE_PATTERN = /(token|secret|password|api[-_]?key)/iu;

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';

export interface RedactOptions {
  /** Extra exact-match key names to redact (case-insensitive). */
  readonly extraKeys?: readonly string[];
  /** Additional regex applied to keys (case-insensitive recommended). */
  readonly extraPattern?: RegExp;
  /** Marker substituted in place of the redacted value. */
  readonly placeholder?: string;
}

const isSensitiveKey = (
  key: string,
  extraKeys: readonly string[],
  extraPattern: RegExp | undefined,
): boolean => {
  const lower = key.toLowerCase();
  for (const sensitive of DEFAULT_SENSITIVE_KEYS) {
    if (sensitive.toLowerCase() === lower) {
      return true;
    }
  }
  for (const sensitive of extraKeys) {
    if (sensitive.toLowerCase() === lower) {
      return true;
    }
  }
  if (DEFAULT_SENSITIVE_PATTERN.test(key)) {
    return true;
  }
  if (extraPattern?.test(key) === true) {
    return true;
  }
  return false;
};

const redactInternal = (
  value: unknown,
  seen: WeakSet<object>,
  extraKeys: readonly string[],
  extraPattern: RegExp | undefined,
  placeholder: string,
): unknown => {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactInternal(entry, seen, extraKeys, extraPattern, placeholder),
    );
  }

  // Errors carry `cause`/`message`/`stack` that may have been
  // populated by a chain we don't control — round-trip through a
  // plain object so all enumerable + the well-known non-enumerable
  // names get redacted in one place.
  if (value instanceof Error) {
    const cloned: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    if (value.stack !== undefined) {
      cloned.stack = value.stack;
    }
    if (value.cause !== undefined) {
      cloned.cause = redactInternal(
        value.cause,
        seen,
        extraKeys,
        extraPattern,
        placeholder,
      );
    }
    for (const key of Object.keys(value)) {
      // Copy own enumerable properties (preserves `code`, `details`, etc.).
      cloned[key] = (value as unknown as Record<string, unknown>)[key];
    }
    return redactInternal(cloned, seen, extraKeys, extraPattern, placeholder);
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key, extraKeys, extraPattern)) {
      result[key] = placeholder;
      continue;
    }
    result[key] = redactInternal(
      child,
      seen,
      extraKeys,
      extraPattern,
      placeholder,
    );
  }
  return result;
};

/**
 * Deep-clone `value`, replacing values under sensitive keys with
 * `[REDACTED]`. The input is never mutated. Circular references
 * resolve to `[Circular]`. Returns `unknown` because the redaction
 * step erases type information about which keys were present —
 * callers cast at the consumption point if they know the shape.
 */
export const redact = (value: unknown, options: RedactOptions = {}): unknown => {
  const seen = new WeakSet<object>();
  return redactInternal(
    value,
    seen,
    options.extraKeys ?? [],
    options.extraPattern,
    options.placeholder ?? REDACTED,
  );
};
