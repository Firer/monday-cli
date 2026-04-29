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
        'src/types/**', // type-only modules
      ],
      thresholds: {
        // Floor — raise as the codebase grows. The standard is "every branch
        // covered (happy path, edge cases, errors, format variations)";
        // these numbers exist so a regression below the floor fails CI.
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
