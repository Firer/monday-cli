# Validation

Loaded automatically when editing `src/**/*.ts` or `tests/**/*.ts`.

This is a CLI that receives input from many untrusted sources (env vars,
argv, files on disk, JSON pasted by humans, GraphQL responses from a
remote API). **Heavy validation is a feature, not overhead.** Validate
aggressively at every boundary, then trust the validated type internally.

## The core principle: parse, don't validate

Don't return a `boolean` from a check function and keep using the raw
input. **Parse the input into a more specific type** and use that type
forward. The compiler then enforces that no unparsed value reaches code
that needs the parsed shape.

```ts
// ❌ Bad — boolean check leaves the raw type at every callsite
const isValidId = (s: string): boolean => /^\d+$/.test(s);
if (isValidId(input)) { /* input is still string here */ }

// ✅ Good — parse to a branded type; downstream code can't accept anything else
const parseItemId = (s: string): ItemId => ItemIdSchema.parse(s);
const id = parseItemId(input); // id: ItemId — distinct from plain string
```

## Boundaries that need validation

Every one of these is a parse point:

| Boundary | Validator | Notes |
|----------|-----------|-------|
| Environment variables | zod schema in `src/config/load.ts` | Already wired. New env vars go in this schema. |
| CLI flags / args | zod schema per command in `src/commands/.../<verb>.ts` | Commander gives you `string`/`string[]`/`boolean` — coerce/refine via zod before calling `api/`. |
| JSON from disk / stdin | zod | Includes user-supplied column-value JSON when bulk-importing. |
| Config files (future) | zod | If we add `~/.monday-cli/config.json`, it parses through a schema. |
| GraphQL responses | SDK's generated types | Trust the SDK's typed ops. For freestyle `client.request<T>()` queries, `T` is your responsibility — wrap in a zod schema or a type guard if the field shape is non-trivial. |
| User-supplied Monday IDs | branded `BoardId`/`ItemId`/etc. | See "Branded IDs" below. |

## zod patterns

### Schema-driven types

Define the schema, derive the type — never the other way around. Keeps
the schema and the type in lockstep.

```ts
const itemSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  state: z.enum(['active', 'archived', 'deleted']),
});
type Item = z.infer<typeof itemSchema>;
```

### `parse` vs `safeParse`

- **`parse`** — throws on failure. Use at startup, in command actions,
  and anywhere the failure should bubble up to the CLI's top-level error
  handler. This is the default.
- **`safeParse`** — returns `{ success: true, data } | { success: false, error }`.
  Use when failure is *expected* and recoverable (e.g. trying multiple
  schemas, falling back to a default, validating one item in a batch
  without aborting the whole batch).

Don't reach for `safeParse` to "avoid the try/catch". Throwing is the
right control flow when invalid input is a bug or a user error.

### Branded IDs

Monday has many ID-shaped strings: board IDs, item IDs, column IDs,
user IDs, workspace IDs, group IDs. They are all numeric strings and
**all interchangeable to the type system unless we brand them**. Branding
catches "passed a board ID where an item ID was wanted" at compile time.

```ts
export const BoardIdSchema = z.string().regex(/^\d+$/u).brand<'BoardId'>();
export const ItemIdSchema = z.string().regex(/^\d+$/u).brand<'ItemId'>();
export type BoardId = z.infer<typeof BoardIdSchema>;
export type ItemId = z.infer<typeof ItemIdSchema>;

const moveItem = (board: BoardId, item: ItemId): Promise<void> => { ... };
moveItem(itemId, boardId); // ❌ compile error — args swapped
```

Place ID schemas in `src/types/ids.ts` (when added). Always brand new
ID kinds; never widen back to plain `string`.

### Discriminated unions for variants

Monday column values are a tagged union (the `type` field discriminates).
Model them as a zod discriminated union, not as a fat optional record:

```ts
const columnValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('status'), label: z.string() }),
  z.object({ type: z.literal('person'), personIds: z.array(z.number()) }),
  // ...
]);
```

`switch-exhaustiveness-check` (lint) then forces every consumer to
handle every variant.

### Coercion at the edge

`z.coerce.*` is for boundaries where the input is always-string (env
vars, CLI flags). Don't use it inside the codebase — once you're past
the boundary, types are trustworthy and coercion masks bugs.

```ts
// In env schema — yes
MONDAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

// Inside the codebase — no
const timeout = z.coerce.number().parse(someInternalValue); // smell
```

### Strict object shape

Default to `.strict()` (reject unknown keys) for inputs we own (config
files, command schemas). Use the default `.strip()` (drop unknown keys)
for upstream API responses we don't fully model.

```ts
const cliOptionsSchema = z.object({ board: BoardIdSchema, name: z.string() }).strict();
```

`.passthrough()` is rarely the right answer; if you're tempted, document
why.

### Refinements & cross-field rules

`.refine()` for single-field invariants, `.superRefine()` for multi-field.
Always include a message — the default ("Invalid input") tells the user
nothing.

```ts
const dateRangeSchema = z.object({
  start: z.iso.date(),
  end: z.iso.date(),
}).refine((v) => v.start <= v.end, {
  message: 'start must be on or before end',
  path: ['end'],
});
```

## Error formatting for humans

Raw `ZodError` is JSON-shaped — useful for `--output json`, hostile to
humans. The CLI entry should format errors based on the active output
mode. A small helper in `src/utils/errors.ts` (when added) should:

- For TTY: list `path: message` per issue, one per line, in red.
- For JSON: emit `{ "error": { "code": "config_error", "issues": [...] } }`
  on stderr.
- Always exit with the right exit code (config=3, usage=1, api=2).

## Never bubble raw ZodError out of a parse boundary

A raw `ZodError` reaching the runner's catch-all becomes
`internal_error` (exit 2) — because it's not a `MondayCliError`.
That's wrong: a config validation failure is `config_error` (exit 3),
a flag validation failure is `usage_error` (exit 1). Wrap at every
parse point:

```ts
// In src/config/load.ts — parsing env into Config
const result = envSchema.safeParse(envInput);
if (!result.success) {
  const issues = result.error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
    code: i.code,
  }));
  throw new ConfigError(`invalid config: ...`, {
    cause: result.error,
    details: { issues, hint: 'set MONDAY_API_TOKEN ...' },
  });
}
```

```ts
// In a command's argv parser
const result = fooOptionsSchema.safeParse(opts);
if (!result.success) {
  throw new UsageError(`invalid flags: ${summarise(result.error)}`, {
    cause: result.error,
    details: { issues: ... },
  });
}
```

Codex review caught this gap in M0: `loadConfig` threw raw
`ZodError`, the runner mapped it to `internal_error`, and the test
that "verified" the missing-token path was a manually-thrown
`ConfigError` (a fixture, not the real path). Lesson: a parse
boundary always wraps. The `safeParse + wrap` pattern is mandatory
at every entry point listed in "Boundaries that need validation"
above.

## Anti-patterns

- **Defensive re-validation.** Once a value is past its parser, downstream
  code consumes the typed value. Don't `parse(parse(x))`.
- **Validating after work.** If you validate *after* doing something
  side-effecting, you've already paid the cost. Validate first.
- **Throwing bare strings.** `throw 'bad input'` defeats `useUnknownInCatchVariables`.
  Throw a `ZodError` (let zod do it) or an error class from `utils/errors.ts`.
- **`.optional()` everywhere "just in case".** Optional means "absence is
  meaningful". If a field is required, mark it required and let the
  parser reject the input.
- **Plain `string` for IDs.** If it identifies a Monday entity, brand it.
