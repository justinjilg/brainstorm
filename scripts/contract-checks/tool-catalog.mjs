/**
 * Tool catalog freshness gate.
 *
 * Re-runs `packages/tools/src/export-catalog.ts --check` and surfaces
 * the result. The catalog already had this gate wired in CI; rolling
 * it into the preflight means a single `npm run contract-check`
 * verifies every surface in one shot.
 */

import { spawnSync } from "node:child_process";

export async function check({ repoRoot }) {
  // Resolve tsx via `pnpm --filter @brainst0rm/tools exec` — tsx is a
  // devDependency of the tools PACKAGE, not the root, so `npx tsx` (hoist-
  // dependent) and bare `pnpm exec tsx` (resolves from root node_modules/.bin,
  // where tsx isn't linked in CI's layout) both fail with "tsx not found".
  // `--filter` runs in the tools package dir where tsx IS in node_modules/.bin
  // — the same mechanism ci.yml uses for `export-catalog:check`. The script
  // path is package-relative; export-catalog.ts resolves its own paths from
  // import.meta.url, so the working directory does not matter.
  // pnpm.cmd needs a shell to resolve on Windows; this gate only runs in the
  // ubuntu build-and-test job, but the flag keeps it portable.
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@brainst0rm/tools",
      "exec",
      "tsx",
      "src/export-catalog.ts",
      "--check",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
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
