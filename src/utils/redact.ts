/**
 * Deep-clone-and-redact helper.
 *
 * The CLI holds a Monday API token with the user's full account
 * permissions; the security rules in `.claude/rules/security.md`
 * forbid that token appearing in *any* emitted byte — log lines,
 * error messages, debug payloads, JSON envelopes. Every output
 * path funnels through this function.
 *
 * Two independent layers (a key-based filter alone is not enough —
 * Codex review §1 caught this gap):
 *
 *  - **Key-based filter.** Values under sensitive keys (`apiToken`,
 *    `Authorization`, `MONDAY_API_TOKEN`, plus a generic
 *    `(token|secret|password|api[-_]?key)` regex) are replaced
 *    wholesale.
 *  - **Value-scanning filter.** When the caller provides a `secrets`
 *    list (typically the literal Monday API token loaded at startup),
 *    every string in the tree is scanned and any occurrence of any
 *    listed secret is replaced with the placeholder. This catches
 *    `Error.message`, `Error.stack`, fetch URLs, debug payloads —
 *    anywhere a token could land outside a sensitively-named key.
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

/** Secrets shorter than this are skipped to avoid pathological */
/* false positives (e.g. a single-character token literally appearing */
/* everywhere). Real Monday tokens are 40+ chars; this floor leaves   */
/* plenty of room for realistic tokens while filtering out useless   */
/* "ab"/"x" entries. */
const MIN_SECRET_LENGTH = 8;

export interface RedactOptions {
  /** Extra exact-match key names to redact (case-insensitive). */
  readonly extraKeys?: readonly string[];
  /** Additional regex applied to keys (case-insensitive recommended). */
  readonly extraPattern?: RegExp;
  /** Marker substituted in place of the redacted value. */
  readonly placeholder?: string;
  /**
   * Literal secret values to scrub from any string anywhere in the
   * tree. Typically the loaded Monday API token; the runner threads
   * it through so a token landing in `Error.message` or a fetch URL
   * still gets redacted before emit. Entries shorter than 8 chars
   * are ignored (false-positive risk).
   */
  readonly secrets?: readonly string[];
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

const scrubSecretsInString = (
  value: string,
  secrets: readonly string[],
  placeholder: string,
): string => {
  let scrubbed = value;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) {
      continue;
    }
    if (scrubbed.includes(secret)) {
      scrubbed = scrubbed.split(secret).join(placeholder);
    }
  }
  return scrubbed;
};

interface InternalContext {
  readonly seen: WeakSet<object>;
  readonly extraKeys: readonly string[];
  readonly extraPattern: RegExp | undefined;
  readonly placeholder: string;
  readonly secrets: readonly string[];
}

const redactInternal = (value: unknown, ctx: InternalContext): unknown => {
  if (value === null) {
    return value;
  }
  if (typeof value === 'string') {
    return ctx.secrets.length > 0
      ? scrubSecretsInString(value, ctx.secrets, ctx.placeholder)
      : value;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (ctx.seen.has(value)) {
    return CIRCULAR;
  }
  ctx.seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactInternal(entry, ctx));
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
      cloned.cause = redactInternal(value.cause, ctx);
    }
    for (const key of Object.keys(value)) {
      // Copy own enumerable properties (preserves `code`, `details`, etc.).
      cloned[key] = (value as unknown as Record<string, unknown>)[key];
    }
    return redactInternal(cloned, ctx);
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key, ctx.extraKeys, ctx.extraPattern)) {
      result[key] = ctx.placeholder;
      continue;
    }
    result[key] = redactInternal(child, ctx);
  }
  return result;
};

/**
 * Deep-clone `value`, replacing values under sensitive keys with
 * `[REDACTED]` and any literal secrets in `options.secrets` with
 * the same placeholder. The input is never mutated. Circular
 * references resolve to `[Circular]`. Returns `unknown` because the
 * redaction step erases type information about which keys were
 * present — callers cast at the consumption point if they know the
 * shape.
 */
export const redact = (value: unknown, options: RedactOptions = {}): unknown => {
  const ctx: InternalContext = {
    seen: new WeakSet<object>(),
    extraKeys: options.extraKeys ?? [],
    extraPattern: options.extraPattern,
    placeholder: options.placeholder ?? REDACTED,
    secrets: options.secrets ?? [],
  };
  return redactInternal(value, ctx);
};
