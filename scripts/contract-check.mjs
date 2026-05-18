#!/usr/bin/env node
/**
 * Contract preflight — the lockstep gate that runs before `turbo run
 * build`. If any registered check fails, the build is refused.
 *
 * This is the brainstorm-side counterpart to BrainstormRouter's
 * `contract-compile.ts --check` mode: a single entry point that
 * inspects every surface the monorepo emits (tool registry, MCP
 * shapes, CLI binaries, docs, API routes, internal SDK parity) and
 * fails fast on drift.
 *
 * Architecture
 * ------------
 * Each "surface check" lives under `scripts/contract-checks/` as a
 * separate ESM module that exports a single `check()` function
 * returning `CheckResult`. The runner here is intentionally dumb:
 * import each module, await its check, accumulate results, print a
 * unified report, exit non-zero on any failure.
 *
 * Adding a new surface check:
 *   1. Create `scripts/contract-checks/<surface>.mjs` exporting
 *      `export async function check() { return { name, ok, issues } }`.
 *   2. Register it in the `CHECKS` array below.
 *   3. Run `npm run contract-check`.
 *
 * Wiring
 * ------
 *   - Root `npm run build` runs this first; failures block tsup.
 *   - CI runs this as a required job (.github/workflows/ci.yml).
 *   - Packages that publish should add `prepublishOnly` so a stale
 *     local build can never produce a tarball that bypasses the gate.
 *
 * Why a node script rather than vitest:
 *   Vitest can already run the Stage-1 / Stage-2 gate tests via
 *   `npm run test`. But the build pipeline shouldn't depend on the
 *   full test suite — that's slow, flaky-prone, and conflates
 *   "tests are red" with "the contract is broken". The contract
 *   gates are pure functions over committed state and built dist;
 *   they belong in a fast, deterministic preflight separate from
 *   tests.
 */

import * as url from "node:url";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const CHECKS = [
  // Stage-1 surface: in-process tool registry + its emitted catalog.
  "./contract-checks/tool-metadata.mjs",
  "./contract-checks/tool-catalog.mjs",
  "./contract-checks/mcp-parity.mjs",
  // Stage-2 surface: platform contract + generated docs/markdown.
  "./contract-checks/contract-snapshots.mjs",
  "./contract-checks/docs-drift.mjs",
  // Stage-3 surfaces (added by this PR).
  "./contract-checks/binary-registry.mjs",
  "./contract-checks/version-sync.mjs",
  "./contract-checks/cli-subcommand-registry.mjs",
  "./contract-checks/api-route-registry.mjs",
];

/** @typedef {{ name: string, ok: boolean, issues: string[], note?: string }} CheckResult */

async function main() {
  const startedAt = Date.now();
  const json = process.argv.includes("--json");
  const verbose = process.argv.includes("--verbose");

  /** @type {CheckResult[]} */
  const results = [];
  for (const modulePath of CHECKS) {
    const absPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      modulePath,
    );
    try {
      const mod = await import(url.pathToFileURL(absPath).href);
      const result = await mod.check({ repoRoot: REPO_ROOT, verbose });
      results.push(result);
    } catch (err) {
      results.push({
        name: path.basename(modulePath, ".mjs"),
        ok: false,
        issues: [
          `check module threw: ${err instanceof Error ? err.message : String(err)}`,
        ],
      });
    }
  }

  const elapsed = Date.now() - startedAt;
  const failed = results.filter((r) => !r.ok);

  if (json) {
    process.stdout.write(
      JSON.stringify({ ok: failed.length === 0, elapsedMs: elapsed, results }, null, 2) +
        "\n",
    );
    process.exit(failed.length === 0 ? 0 : 1);
  }

  // Human-readable report.
  process.stdout.write("\n=== Brainstorm Contract Preflight ===\n\n");
  for (const r of results) {
    const icon = r.ok ? "✔" : "✘";
    const stamp = r.ok ? "PASS" : "FAIL";
    process.stdout.write(`  ${icon} ${stamp}  ${r.name}`);
    if (r.note) process.stdout.write(`  — ${r.note}`);
    process.stdout.write("\n");
    if (!r.ok) {
      for (const issue of r.issues) {
        process.stdout.write(`        · ${issue}\n`);
      }
    } else if (verbose && r.issues.length > 0) {
      for (const issue of r.issues) {
        process.stdout.write(`        · (info) ${issue}\n`);
      }
    }
  }

  process.stdout.write(
    `\n  ${results.length} checks · ${results.length - failed.length} passed · ${failed.length} failed · ${elapsed}ms\n\n`,
  );

  if (failed.length > 0) {
    process.stdout.write(
      "✘ contract preflight refused the build. Fix the issues above or run with --verbose for more detail.\n\n",
    );
    process.exit(1);
  }
  process.stdout.write("✔ contract preflight passed.\n\n");
}

main().catch((err) => {
  process.stderr.write(
    `contract preflight crashed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(2);
});
