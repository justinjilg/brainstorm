/**
 * Tests for the contract-check gates.
 *
 * Each gate has a clear failure shape; this suite documents the
 * shape by running each check module in isolation and asserting its
 * structure. The gates themselves verify behaviour against committed
 * state — these tests verify the gates' API.
 *
 * Run: node --test scripts/contract-checks/__tests__/contract-check.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const GATES = [
  "tool-metadata",
  "tool-catalog",
  "mcp-parity",
  "contract-snapshots",
  "docs-drift",
  "binary-registry",
  "version-sync",
  "cli-subcommand-registry",
  "api-route-registry",
];

for (const name of GATES) {
  test(`gate ${name}: exports check() returning the expected shape`, async () => {
    const mod = await import(`../${name}.mjs`);
    assert.equal(typeof mod.check, "function", `${name} must export check()`);
    const result = await mod.check({ repoRoot: REPO_ROOT });
    assert.equal(typeof result.name, "string", `${name} must return .name`);
    assert.equal(result.name, name, `${name} must return its own name`);
    assert.equal(
      typeof result.ok,
      "boolean",
      `${name} must return .ok as boolean`,
    );
    assert.ok(Array.isArray(result.issues), `${name} must return .issues array`);
    if (!result.ok) {
      assert.ok(
        result.issues.length > 0,
        `${name}: ok=false must carry at least one issue`,
      );
    }
  });
}

test("preflight passes against committed main state", async () => {
  let failed = 0;
  for (const name of GATES) {
    const mod = await import(`../${name}.mjs`);
    const result = await mod.check({ repoRoot: REPO_ROOT });
    if (!result.ok) {
      failed++;
      process.stderr.write(`  ${name}: FAIL — ${result.issues.join("; ")}\n`);
    }
  }
  assert.equal(failed, 0, "all gates must pass against committed state");
});
