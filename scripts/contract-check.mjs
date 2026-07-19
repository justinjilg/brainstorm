#!/usr/bin/env node
/**
 * Contract preflight — the lockstep gate that runs alongside
 * `turbo run build`. If any registered check fails, the build is
 * refused.
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
 * separate ESM module that exports either:
 *
 *   - A bare `check()` function returning `CheckResult` (legacy
 *     shape, supported for backward compat), OR
 *   - A `defineGate({ name, check })` result via `_define-gate.mjs`
 *     (preferred — shape-validated at the boundary, distinguishes
 *     drift from infrastructure failure).
 *
 * The runner is intentionally dumb: import each module, await its
 * check, accumulate results, print a unified report, exit non-zero
 * on any failure.
 *
 * Adding a new surface check:
 *   1. Create `scripts/contract-checks/<surface>.mjs` exporting
 *      `export default defineGate({ name, check })`.
 *   2. Register it in the `CHECKS` array below.
 *   3. Run `npm run contract-check`.
 *
 * Wiring
 * ------
 *   - Root `npm run build` runs this AFTER turbo build; failures
 *     block subsequent steps via non-zero exit.
 *   - CI runs this as a required job (.github/workflows/ci.yml).
 *   - Devs reproduce with `npm run contract-check`; `:json` for
 *     machine-readable output. A JSON artifact is ALWAYS written to
 *     `.contract-check/results.json` regardless of mode, so a
 *     failing CI run leaves diagnostic state on disk.
 */

import * as url from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ARTIFACT_DIR = path.join(REPO_ROOT, ".contract-check");
const ARTIFACT_FILE = path.join(ARTIFACT_DIR, "results.json");

const CHECKS = [
  // Stage-1 surface: in-process tool registry + its emitted catalog.
  "./contract-checks/tool-metadata.mjs",
  "./contract-checks/tool-catalog.mjs",
  "./contract-checks/mcp-parity.mjs",
  "./contract-checks/tool-name-references.mjs",
  // Stage-2 surface: platform contract + generated docs/markdown.
  "./contract-checks/contract-snapshots.mjs",
  "./contract-checks/docs-drift.mjs",
  "./contract-checks/docs-field-drift.mjs",
  "./contract-checks/docs-package-count.mjs",
  // Stage-3 surfaces.
  "./contract-checks/binary-registry.mjs",
  "./contract-checks/version-sync.mjs",
  "./contract-checks/cli-subcommand-registry.mjs",
  "./contract-checks/api-route-registry.mjs",
  // Stage-4 folded ratchets: legacy scripts/check-*.mjs gates that
  // used to run as individual CI steps. Same "refuse to ship if
  // invariant X is broken" shape; now part of the unified preflight
  // so one command runs the whole family.
  "./contract-checks/as-any-budget.mjs",
  "./contract-checks/ci-soft-fail-budget.mjs",
  "./contract-checks/dep-cruiser.mjs",
  "./contract-checks/abort-signal-lint.mjs",
  // Stage-4 meta-gate: the preflight must remain wired into every
  // artifact-producing workflow (CI on PR, Release on main, root
  // npm build). This gate locks the wiring so a future PR that
  // removes the preflight step from release.yml fails the build.
  "./contract-checks/release-flow-wiring.mjs",
  // Stage-5 business-harness seam: the bounded BR route matrix must
  // stay in lockstep with the harness code/docs and, when available,
  // the sibling BrainstormRouter source. This is gate #17.
  "./contract-checks/br-contract-map.mjs",
];

/** @typedef {import("./contract-checks/_define-gate.mjs").CheckResult} CheckResult */

async function runCheck(modulePath) {
  const absPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    modulePath,
  );
  try {
    const mod = await import(url.pathToFileURL(absPath).href);
    // Two supported export shapes:
    //   - default: a defineGate(...) result with .name + .run(ctx)
    //   - check(): the legacy bare-function shape (Stage-3 original)
    if (mod.default && typeof mod.default.run === "function") {
      return await mod.default.run({ repoRoot: REPO_ROOT });
    }
    if (typeof mod.check === "function") {
      const raw = await mod.check({ repoRoot: REPO_ROOT });
      // Tag legacy results with kind="drift" by default so the
      // human report can still distinguish infra failures (where
      // the legacy check returned ok:false with a "dist missing"
      // message, we re-tag those below).
      if (raw && raw.ok === false && !raw.kind) {
        const firstIssue = raw.issues?.[0] ?? "";
        if (
          firstIssue.includes("dist missing") ||
          firstIssue.includes("Run `npx turbo run build")
        ) {
          raw.kind = "infra";
        } else {
          raw.kind = "drift";
        }
      }
      return raw;
    }
    return {
      name: path.basename(modulePath, ".mjs"),
      ok: false,
      kind: "infra",
      issues: [
        `module exports neither default.run nor check() — refusing to run.`,
      ],
    };
  } catch (err) {
    const stack =
      err instanceof Error
        ? (err.stack?.split("\n").slice(0, 4).join("\n") ?? err.message)
        : String(err);
    return {
      name: path.basename(modulePath, ".mjs"),
      ok: false,
      kind: "infra",
      issues: [
        `failed to import gate module: ${err instanceof Error ? err.message : String(err)}`,
        stack,
      ],
    };
  }
}

async function main() {
  const startedAt = Date.now();
  const json = process.argv.includes("--json");
  const verbose = process.argv.includes("--verbose");

  /** @type {CheckResult[]} */
  const results = [];
  for (const modulePath of CHECKS) {
    results.push(await runCheck(modulePath));
  }

  const elapsed = Date.now() - startedAt;
  const failed = results.filter((r) => !r.ok);
  const driftFails = failed.filter((r) => r.kind !== "infra");
  const infraFails = failed.filter((r) => r.kind === "infra");

  // Always persist results so a failing CI run leaves state on disk
  // even when the operator forgot --json.
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(
      ARTIFACT_FILE,
      JSON.stringify(
        { ok: failed.length === 0, elapsedMs: elapsed, results },
        null,
        2,
      ) + "\n",
    );
  } catch {
    // Best-effort: a read-only filesystem shouldn't prevent reporting.
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(
        { ok: failed.length === 0, elapsedMs: elapsed, results },
        null,
        2,
      ) + "\n",
    );
    process.exit(failed.length === 0 ? 0 : 1);
  }

  // Human-readable report.
  process.stdout.write("\n=== Brainstorm Contract Preflight ===\n\n");
  for (const r of results) {
    let label;
    if (r.ok) label = "✔ PASS ";
    else if (r.kind === "infra") label = "⚠ INFRA";
    else label = "✘ FAIL ";
    process.stdout.write(`  ${label}  ${r.name}`);
    if (r.note) process.stdout.write(`  — ${r.note}`);
    process.stdout.write("\n");
    if (!r.ok) {
      for (const issue of r.issues) {
        process.stdout.write(`        · ${issue}\n`);
      }
    } else if (verbose && r.info && r.info.length > 0) {
      for (const issue of r.info) {
        process.stdout.write(`        · (info) ${issue}\n`);
      }
    }
  }

  process.stdout.write(
    `\n  ${results.length} checks · ${results.length - failed.length} passed · ${driftFails.length} drift · ${infraFails.length} infra · ${elapsed}ms\n`,
  );
  process.stdout.write(
    `  artifact: ${path.relative(REPO_ROOT, ARTIFACT_FILE)}\n\n`,
  );

  if (failed.length > 0) {
    if (infraFails.length > 0 && driftFails.length === 0) {
      process.stdout.write(
        "⚠ contract preflight could not run cleanly. Fix the INFRA issues above " +
          "(usually `npx turbo run build` first), then re-run.\n\n",
      );
    } else {
      process.stdout.write(
        "✘ contract preflight refused the build. Fix the FAIL issues above or run with --verbose for more detail.\n\n",
      );
    }
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
