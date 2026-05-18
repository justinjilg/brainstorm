/**
 * AbortSignal.timeout cleanup ratchet (folded from
 * scripts/lint-abort-signal-timeout.mjs).
 *
 * Guards against the specific memory-leak shape Pass 2 + Pass 3 of
 * the quality scan kept finding: `AbortSignal.timeout(ms)` wired to
 * `addEventListener("abort", …)` without `{ once: true }` or a
 * matching `removeEventListener` pair. Each leaked listener pins
 * the AbortSignal in memory until the parent timeout fires.
 *
 * Folded into the preflight so this invariant ships with the
 * unified contract.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

export async function check({ repoRoot }) {
  const script = path.join(repoRoot, "scripts/lint-abort-signal-timeout.mjs");
  const result = spawnSync("node", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return {
      name: "abort-signal-lint",
      ok: false,
      issues: [`node invocation failed: ${result.error.message}`],
    };
  }

  if (result.status === 0) {
    return {
      name: "abort-signal-lint",
      ok: true,
      note: "no AbortSignal.timeout leaks",
    };
  }

  const diag = (result.stderr || result.stdout).trim();
  return {
    name: "abort-signal-lint",
    ok: false,
    issues: diag ? diag.split("\n").filter(Boolean).slice(0, 30) : ["AbortSignal leak detected"],
  };
}
