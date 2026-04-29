# TypeScript conventions

Loaded automatically when editing `src/**/*.ts` or `tests/**/*.ts`.

## Type safety

- **No `any`.** Lint-enforced. If a third-party type is wrong, narrow with
  `unknown` + a type guard, or write a `.d.ts` augmentation. Never widen
  to `any` to silence the compiler.
- **Avoid `null` unless `null` is a meaningful value.** "Absent" is
  `undefined` (or omit the optional property entirely). Use `null` only
  when the API/data model has a `null`-distinct-from-absent semantics
  (e.g. "field was explicitly cleared" vs "field never set"). Document
  why when you do.
- **Parse at the edge.** zod for env/argv/JSON-from-disk; SDK-generated
  types for GraphQL responses. Once a value is past its parser, internal
  code consumes the validated type — no defensive re-checks. Heavy
  validation is a feature, not overhead — see `validation.md` for
  patterns (branded IDs, discriminated unions, parse-vs-safeParse).
- **`exactOptionalPropertyTypes` is on.** `{ x?: string }` does *not*
  accept `{ x: undefined }` — write `{ x?: string | undefined }` if you
  need both. Prefer the form without `| undefined`; it forces callers to
  omit the property rather than pass an explicit `undefined`.
- **`noUncheckedIndexedAccess` is on.** `arr[0]` is `T | undefined`. Use
  optional chaining or explicit length checks.
- **`verbatimModuleSyntax` is on.** Type-only imports must use
  `import type` (or inline `import { type Foo, bar }`). The lint rule
  auto-fixes this.

## Imports

- **Use `.js` extensions in TS imports** (`import { foo } from './bar.js'`)
  — required for NodeNext ESM resolution. The TS compiler rewrites them
  correctly.
- **Type imports are inline.** `import { type Foo, bar }` — enforced by
  `consistent-type-imports`.
- **No side-effect imports for types.** Enforced by
  `no-import-type-side-effects`.

## Functions

- **Exported functions get explicit return types.** Keeps the public
  surface stable when an implementation change would otherwise widen the
  inferred type.
- **Internal callbacks/arrow functions can infer.** Don't clutter local
  closures with annotations the compiler already knows.
- **`readonly` by default for class fields.** Lint enforces
  `prefer-readonly` — opt out only with a clear "this is reassigned"
  comment.

## Errors

- Throw classes from `src/utils/errors.ts` (`ConfigError`, `ApiError`,
  `UsageError`). Don't throw bare strings or `Error`.
- `useUnknownInCatchVariables` is on — narrow with `instanceof` or
  `err instanceof Error ? err.message : String(err)`.
- Re-throw with `cause`: `throw new ApiError(msg, { cause: err })`.

## I/O

- `console.log` for command output, `console.error` for errors and progress.
  In CLI mode this is fine — `no-console` is intentionally off. Structured
  logging goes through `utils/logger.ts` (when added).
- Output JSON by default for non-TTY stdout. The format contract lives in
  `docs/architecture.md`.

## Generics

- Constrain type parameters (`<T extends Foo>`), don't accept bare `<T>`.
- Default type parameters when there's an obvious common case: `<T = unknown>`.
