import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/cli/index.ts', // thin entry — exercised by E2E tests
      ],
      thresholds: {
        // Floor — raise as the codebase grows. The standard is "every
        // reachable branch covered (happy path, edge cases, errors,
        // format variations)". Genuinely unreachable defensive paths
        // (assertNever, noUncheckedIndexedAccess narrowing on guards
        // that the caller proves are non-null) are marked with
        // `/* c8 ignore */` and excluded from the count.
        //
        // The current numbers reflect M3's coverage push (Codex review +
        // user-driven gate raise). Raise as code lands; never lower.
        lines: 95,
        branches: 94,
        functions: 95,
        statements: 95,
      },
    },
  },
});
