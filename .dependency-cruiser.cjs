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
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
  },
};
