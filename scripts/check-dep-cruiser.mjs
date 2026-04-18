#!/usr/bin/env node
/**
 * check-dep-cruiser — architectural boundary ratchet for the 27-package
 * monorepo graph.
 *
 * Rationale: v9-v12 stochastic-assessment's Architect persona flagged
 * dep-cruiser as the single highest-leverage structural gap. Pass 32
 * adds it with one rule (`no-circular`) — enough to break the moment a
 * dep cycle appears, without drowning the codebase in rule-churn.
 *
 * The ratchet philosophy is the same as `check-as-any-budget.mjs`:
 * DEP_VIOLATION_BUDGET is a committed ceiling. CI fails if the
 * current count exceeds it. To add a new rule with existing
 * violations, bump the budget in the SAME PR that adds the rule and
 * document the reason in the commit message.
 *
 * Current baseline: 0 violations (pass 32 cleared the one cycle it
 * found in packages/core/src/traceability/).
 *
 * Running:
 *   node scripts/check-dep-cruiser.mjs
 */

import { execFileSync } from "node:child_process";

const DEP_VIOLATION_BUDGET = 0;
// 2026-04-18 (post-pass-32): the no-circular rule currently passes on
// 1255 modules / 3011 dependencies across packages + apps. Keep this
// at 0 — a new circular import should fail CI immediately, not accrue.

function run() {
  try {
    execFileSync(
      "npx",
      ["depcruise", "--output-type", "err", "packages", "apps"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    // Exit 0 means zero violations.
    return { violations: 0, output: "" };
  } catch (err) {
    const output = String(err.stdout ?? "") + String(err.stderr ?? "");
    // depcruise prints "x N dependency violations (N errors, ...)"
    // on the last summary line when violations exist.
    const match = output.match(/(\d+)\s+dependency violations/);
    const count = match ? Number(match[1]) : -1;
    return { violations: count, output };
  }
}

const { violations, output } = run();

if (violations < 0) {
  console.error("dep-cruiser could not parse output:");
  console.error(output);
  process.exit(2);
}

if (violations > DEP_VIOLATION_BUDGET) {
  console.error(
    `dep-cruiser budget exceeded: ${violations} > ${DEP_VIOLATION_BUDGET}.\n` +
      `Either fix ${violations - DEP_VIOLATION_BUDGET} violation(s) or, if the\n` +
      `new violations are legitimate, raise DEP_VIOLATION_BUDGET in\n` +
      `scripts/check-dep-cruiser.mjs and document the reason.\n\n` +
      `Full output:\n${output}`,
  );
  process.exit(1);
}

const slack = DEP_VIOLATION_BUDGET - violations;
console.log(
  `dep-cruiser budget: ${violations}/${DEP_VIOLATION_BUDGET} ` +
    `(${slack} under budget)`,
);
