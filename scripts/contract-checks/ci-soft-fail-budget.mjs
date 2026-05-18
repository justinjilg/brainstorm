/**
 * CI soft-fail budget gate (folded from
 * scripts/check-ci-continue-on-error.mjs).
 *
 * The legacy ratchet caps `continue-on-error: true` at 0 across the
 * workflow files. Background: three separate soft-fail steps accrued
 * over 5+ assessment rounds with "known CI env issue" cover stories
 * that turned out to be real bugs (99e73d0, 709abde, cdca3b9,
 * ed69a5f). The ratchet forces the conversation before soft-fail
 * debt accrues again.
 *
 * Folded into the preflight so it runs alongside every other
 * "refuse to ship if X broken" check.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

export async function check({ repoRoot }) {
  const script = path.join(repoRoot, "scripts/check-ci-continue-on-error.mjs");
  const result = spawnSync("node", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return {
      name: "ci-soft-fail-budget",
      ok: false,
      issues: [`node invocation failed: ${result.error.message}`],
    };
  }

  if (result.status === 0) {
    const summary = result.stdout.trim().split("\n")[0] || "no soft-fails";
    return {
      name: "ci-soft-fail-budget",
      ok: true,
      note: summary,
    };
  }

  const diag = (result.stderr || result.stdout).trim();
  return {
    name: "ci-soft-fail-budget",
    ok: false,
    issues: diag ? diag.split("\n").filter(Boolean) : ["soft-fail budget exceeded"],
  };
}
