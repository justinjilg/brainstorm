/**
 * as-any budget gate (folded from scripts/check-as-any-budget.mjs).
 *
 * The legacy ratchet has run in CI since the v9 stochastic
 * assessment. Stage-4 of the contract preflight folds it into the
 * unified orchestrator so one `npm run contract-check` runs every
 * "refuse to ship if invariant X is broken" check the repo has —
 * not just the contract-defined surfaces.
 *
 * The legacy script remains the source-of-truth implementation;
 * this gate spawns it and adapts the exit code + stderr into a
 * CheckResult. CI's existing direct call still works, so the legacy
 * step stays as a safety net while the preflight becomes primary.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

export async function check({ repoRoot }) {
  const script = path.join(repoRoot, "scripts/check-as-any-budget.mjs");
  const result = spawnSync("node", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return {
      name: "as-any-budget",
      ok: false,
      issues: [`node invocation failed: ${result.error.message}`],
    };
  }

  if (result.status === 0) {
    // Stdout includes "as-any budget: N/BUDGET (M under budget)".
    const summary = result.stdout.trim().split("\n")[0] || "within budget";
    return {
      name: "as-any-budget",
      ok: true,
      note: summary,
    };
  }

  // Exit code != 0: budget exceeded. Surface the full diagnostic
  // from stderr (script prints fix-hint text there).
  const diag = (result.stderr || result.stdout).trim();
  return {
    name: "as-any-budget",
    ok: false,
    issues: diag ? diag.split("\n").filter(Boolean) : ["budget exceeded (no detail)"],
  };
}
