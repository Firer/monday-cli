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
        // delta was smaller), a 0.05pp R42-consolidation dip
        // accommodation (95.5 → 95.45) — the post-v0.2 cleanup-window
        // R42 lift consolidated 14 inline missing-root-key checks
        // across M15-M17 verbs onto the shared
        // `assertResponseFieldPresent` helper, removing 28 covered
        // branches from per-site call locations while adding 8 covered
        // branches inside the helper — and a v0.3-M21 implementation
        // Part 1 dip (95.45 → 94.5) — landing the OAuth flow + multi-
        // profile credentials surface added ~600 LOC across
        // `src/api/oauth.ts`, `src/api/oauth-test-helper.ts`, the
        // `auth login`/`auth logout` command bodies, the credentials
        // cache + TOML loader runtime, and the `cli/program.ts`
        // preAction profile-resolution hook. Many of the new branches
        // are production-only (real-socket bind, browser-open spawn,
        // 5xx fallbacks, non-Error rejection guards in catch paths,
        // platform-specific filesystem errors) that don't reproduce
        // from a unit test against `127.0.0.1:0` + tmpdir HOMEs.
        // Extensive `/* c8 ignore */` on those paths cuts statement
        // coverage but v8's branch-coverage signal still counts the
        // associated branch indicators against the percentage.
        //
        // The post-M21 coverage-push session recovered the 95.45
        // floor (94.5 → 95.45) by (a) writing six targeted tests
        // around emit.ts mutation slots, the buildProgram default
        // cliDescription, the OAuth bindOAuthListener default args,
        // an EISDIR-via-dir-at-path readCredentials probe, and the
        // global-flag-wins profile-resolution path; and (b) folding
        // ten broken multi-line `/* c8 ignore */` directives into
        // their two-line form (single-line directive + separate
        // explanation comment) so v8 actually honours them — the
        // testing.md "c8 ignore syntax gotcha" subsection documents
        // the multi-line trap. Measured project-wide branches at
        // recovery: 95.56% with a 0.11pp margin against the new
        // floor. Raise as code lands; never lower below 94.5.
        lines: 95,
        branches: 95.45,
        functions: 95,
        statements: 95,
      },
    },
  },
});
