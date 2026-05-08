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
        // dry-run, the M18-close ratchet that raised branches from
        // 95 to 95.5 (actual project branch coverage at v0.2.0 was
        // 95.51%; §3 M18 exit aimed for 96 but the actual M13–M18
        // delta was smaller), and a 0.05pp R42-consolidation dip
        // accommodation (95.5 → 95.45) — the post-v0.2 cleanup-window
        // R42 lift consolidated 14 inline missing-root-key checks
        // across M15-M17 verbs onto the shared
        // `assertResponseFieldPresent` helper, removing 28 covered
        // branches from per-site call locations (14 sites × 2 outcomes
        // each, all covered) while adding 8 covered branches inside
        // the helper. Net: same code path coverage in
        // absolute-branches terms (down 20 covered branches AND down
        // 20 denominator branches), but the global percentage drops
        // ~0.04pp because the denominator's reduced base now weights
        // unrelated lower-coverage areas (workspace/update.ts at
        // 79.3%, item/update.ts at 87.6%, etc) more heavily. The dip
        // is a known mathematical consequence anticipated by the
        // post-v0.2 cleanup-window handoff (~0.05-0.1pp band) and
        // documented in v0.2-plan §22 R42 Risk. Will close at the
        // next milestone's focused coverage push (slipped from M18
        // per the §22 R42 entry's dedicated session note). Raise as
        // code lands; never lower below 95.45.
        lines: 95,
        branches: 95.45,
        functions: 95,
        statements: 95,
      },
    },
  },
});
