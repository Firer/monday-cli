// Type shim for `ajv/dist/2020.js`. ajv v8 ships the 2020-12 entry as
// a separate file with a working `.d.ts` next to it but no `exports`
// map in `package.json`, so NodeNext/verbatimModuleSyntax can't
// resolve the import path automatically. Declaring the module here
// gives us typed access without disabling lint rules.
declare module 'ajv/dist/2020.js' {
  import type { Options, AnySchema, ValidateFunction } from 'ajv';
  export default class Ajv2020 {
    constructor(opts?: Options);
    compile<T = unknown>(schema: AnySchema): ValidateFunction<T>;
  }
}
