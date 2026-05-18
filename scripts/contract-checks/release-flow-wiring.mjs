/**
 * Release-flow wiring gate.
 *
 * The preflight is only load-bearing if every path that produces
 * shipping artifacts runs it. Stage-3 wired it into `npm run build`
 * and the CI build job. Stage-4 wires it into `release.yml` before
 * the changesets publish step. This gate locks that wiring: if
 * someone deletes the "Contract preflight" step from release.yml,
 * the build fails until they put it back (or rename it AND update
 * this gate).
 *
 * The principle: every artifact-producing workflow should mention
 * the preflight by name. Failure to do so is silent drift —
 * publishing could resume bypassing the gate without anyone
 * noticing until a contract violation actually ships.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const REQUIRED_WIRINGS = [
  {
    file: ".github/workflows/ci.yml",
    needle: "node scripts/contract-check.mjs",
    why: "CI must run the preflight on every PR — the gate exists to block merges that would break main.",
  },
  {
    file: ".github/workflows/release.yml",
    needle: "node scripts/contract-check.mjs",
    why: "Release workflow must run the preflight before changesets publish — otherwise npm publish bypasses the gate.",
  },
  {
    file: "package.json",
    needle: "contract-check",
    why: "Root package.json must expose `npm run contract-check` and run it from `npm run build`.",
  },
];

export async function check({ repoRoot }) {
  const issues = [];

  for (const wire of REQUIRED_WIRINGS) {
    const abs = path.join(repoRoot, wire.file);
    if (!existsSync(abs)) {
      issues.push(
        `${wire.file}: file missing — cannot verify preflight wiring. ${wire.why}`,
      );
      continue;
    }
    const content = readFileSync(abs, "utf8");
    if (!content.includes(wire.needle)) {
      issues.push(
        `${wire.file}: missing reference to "${wire.needle}". ${wire.why}`,
      );
    }
  }

  return {
    name: "release-flow-wiring",
    ok: issues.length === 0,
    issues,
    note: `${REQUIRED_WIRINGS.length} wirings verified`,
  };
}
