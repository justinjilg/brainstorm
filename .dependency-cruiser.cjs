/**
 * dependency-cruiser config — architectural ratchet for the 27-package
 * monorepo graph.
 *
 * Rationale: v9–v12 stochastic-assessment's Architect persona flagged
 * the absence of dep-cruiser as the single highest-impact gap for
 * 5-year feature-growth survival. Without boundary enforcement, a
 * monorepo of this size drifts into circular-import thickets and
 * deep-reach coupling as packages multiply.
 *
 * Pass 32 starts narrow with ONE rule: `no-circular`. This is a
 * repo-wide sanity guarantee that breaks the moment a dep cycle
 * appears. Add more rules in follow-up passes — each new rule should
 * be introduced with its current violation count as the baseline,
 * then ratcheted down like `scripts/check-as-any-budget.mjs` handles
 * `as any`.
 *
 * Running:
 *   npx depcruise packages apps
 * or via `node scripts/check-dep-cruiser-budget.mjs` which enforces
 * the ratchet in CI.
 */

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular imports prevent static analysis, make build order brittle, " +
        "and hide real design smells. Break the cycle with an interface or a " +
        "shared base package.",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "no-workspace-deep-import",
      severity: "error",
      comment:
        "Cross-package imports must go through the public barrel " +
        "(index.ts) of the target workspace package. Reaching into " +
        "another package's src/* bypasses the public contract, makes " +
        "refactors dangerous (internal moves become silent breaking " +
        "changes), and defeats tsup's treeshaking by pulling internal " +
        "modules directly instead of the built index.js. At rule " +
        "introduction: 0 violations across the 27-package monorepo — " +
        "the codebase is already clean, the rule locks that in. Adding " +
        "a deep import now fails CI; do the fix or raise the budget " +
        "in the SAME PR with a documented reason.",
      from: { path: "^packages/([^/]+)/src/" },
      to: {
        // Target is another workspace package's src/ BUT NOT its
        // public index barrel. Workspace imports resolve directly to
        // `packages/<pkg>/src/<file>.ts` (pnpm/npm workspace symlinks
        // don't go through node_modules for source builds).
        path: "^packages/([^/]+)/src/(?!index\\.(?:ts|js)$)",
        // Exclude same-package imports — dep-cruiser's `sameAs` backref
        // lets us say "only flag when the `to` package captured group
        // is NOT identical to the `from` package captured group."
        pathNot: "^packages/$1/src/",
      },
    },
    {
      name: "no-orphans-in-packages",
      severity: "error",
      comment:
        "Orphaned source files in packages/ are dead code. Either " +
        "wire them up, delete them, or re-export through the package " +
        "index (if they're part of the public API). Baseline at rule " +
        "introduction: 0 violations — two orphans (workflow/" +
        "consensus-review.ts, core/security/scan-utils.ts) were " +
        "deleted in the same commit. Exclusions cover legitimate " +
        "entry points (src/index.ts, src/bin/*), test files, types " +
        "files (imported as type-only so dep-cruiser without " +
        "tsPreCompilationDeps flags them as orphan), and tsup/" +
        "vitest configs that shouldn't be graph nodes. NOT applied " +
        "to apps/ because Next.js + Electron rely on convention-" +
        "based dynamic loading that dep-cruiser cannot trace.",
      from: {
        orphan: true,
        path: "^packages/[^/]+/src/",
        pathNot: [
          "^packages/[^/]+/src/index\\.ts$",
          "^packages/[^/]+/src/bin/",
          "^packages/[^/]+/src/cli/brainstorm\\.ts$",
          "__tests__/",
          "\\.test\\.ts$",
          "\\.spec\\.ts$",
          "export-catalog\\.ts$",
          "\\.config\\.(ts|js|cjs|mjs)$",
          "\\.d\\.ts$",
          // `types.ts` files are imported only as `import type {...}`.
          // Without tsPreCompilationDeps dep-cruiser doesn't see them
          // as imports — but we can't enable that globally because it
          // exposes type-only circular deps the no-circular rule
          // wasn't meant to catch. Excluding types.ts from orphan
          // detection is the targeted trade-off.
          "/types\\.ts$",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    // Exclude build outputs and generated artifacts from every rule.
    // Without this, `.next/build/chunks/*.js` and `dist/*` appear as
    // orphans (they are — they're outputs, not source).
    exclude: {
      path: "(^|/)(dist|node_modules|\\.next|release|test-results)(/|$)",
    },
  },
};
