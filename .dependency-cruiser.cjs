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
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
  },
};
