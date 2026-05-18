/**
 * Dep-cruiser circular-import ratchet (folded from
 * scripts/check-dep-cruiser.mjs).
 *
 * Architectural boundary ratchet. The v9-v12 assessment's Architect
 * persona flagged the absence of dep-cruiser as the highest-leverage
 * structural gap for 5-year survival. Pass 32 added it; this gate
 * surfaces it through the unified preflight.
 *
 * Slow-ish: dep-cruiser walks every TypeScript file in the
 * workspace. The legacy direct invocation in CI takes 10-30s; the
 * gate adds the same cost to `npm run contract-check`.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

export async function check({ repoRoot }) {
  const script = path.join(repoRoot, "scripts/check-dep-cruiser.mjs");
  const result = spawnSync("node", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return {
      name: "dep-cruiser",
      ok: false,
      issues: [`node invocation failed: ${result.error.message}`],
    };
  }

  if (result.status === 0) {
    return {
      name: "dep-cruiser",
      ok: true,
      note: "no circular imports",
    };
  }

  const diag = (result.stderr || result.stdout).trim();
  return {
    name: "dep-cruiser",
    ok: false,
    issues: diag ? diag.split("\n").filter(Boolean).slice(0, 30) : ["circular imports detected"],
  };
}
