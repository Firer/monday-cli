import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Default vitest timeout is 5s. M13's registry growth (50+
    // commands) plus v8 coverage instrumentation pushes a handful
    // of suites past that floor — schema-build / ajv-compile /
    // published-tarball spawn / schema-snapshot all build the
    // full registry and pay the per-command cost. Bumping the
    // floor to 15s keeps `npm run test:coverage` runnable without
    // sprinkling per-test overrides; the non-instrumented `npm
    // test` finishes in ~13s overall.
    testTimeout: 15_000,
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
        // user-driven gate raise), the M9.5 branches ratchet that
        // followed the resolution-pass.ts + foldAndRemap lifts and the
        // three coverage tests for board describe + item create
        // dry-run, and the M18-close ratchet that raised branches
        // from 95 to 95.5 (actual project branch coverage at v0.2.0
        // is 95.51%; §3 M18 exit aimed for 96 but the actual M13–M18
        // delta was smaller — the new code went in at 100% per-file
        // coverage but the global percentage only ticked up ~0.5pp
        // because the denominator grew alongside the numerator).
        // Raise as code lands; never lower.
        lines: 95,
        branches: 95.5,
        functions: 95,
        statements: 95,
      },
    },
  },
});
