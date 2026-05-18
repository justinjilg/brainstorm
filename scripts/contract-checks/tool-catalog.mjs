/**
 * Tool catalog freshness gate.
 *
 * Re-runs `packages/tools/src/export-catalog.ts --check` and surfaces
 * the result. The catalog already had this gate wired in CI; rolling
 * it into the preflight means a single `npm run contract-check`
 * verifies every surface in one shot.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

export async function check({ repoRoot }) {
  const result = spawnSync(
    "npx",
    ["tsx", path.join(repoRoot, "packages/tools/src/export-catalog.ts"), "--check"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.error) {
    return {
      name: "tool-catalog",
      ok: false,
      issues: [`tsx invocation failed: ${result.error.message}`],
    };
  }

  if (result.status === 0) {
    return {
      name: "tool-catalog",
      ok: true,
      issues: [],
      note: "docs/tool-catalog.json matches source-of-truth",
    };
  }

  const out = (result.stdout + result.stderr).trim();
  return {
    name: "tool-catalog",
    ok: false,
    issues: [
      "docs/tool-catalog.json is stale — run `npm run --workspace=@brainst0rm/tools export-catalog` to regenerate.",
      ...(out ? [`exporter said: ${out.split("\n").slice(0, 3).join(" | ")}`] : []),
    ],
  };
}
