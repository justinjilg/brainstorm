/**
 * Binary registry gate.
 *
 * Every binary the monorepo publishes (`bin` field on a workspace
 * package.json) must:
 *   1. Appear in the canonical registry below — adding a binary to a
 *      package is a deliberate act; the registry is where that
 *      decision lives.
 *   2. Follow the `brainstorm-*` or `storm` naming pattern, except
 *      for explicit grandfathered exceptions. This kept biting us
 *      (e.g. `bsm-redteam` shadowed nothing useful but invited
 *      questions every time someone read the package).
 *   3. Point at a real built file under that package's `dist/`.
 *   4. Be unique across the monorepo — two packages publishing the
 *      same bin name would race at install time with whichever wins
 *      being undefined behaviour.
 *
 * Updating the registry:
 *   When a package adds, removes, or renames a `bin` entry, the
 *   developer must also update `BINARY_REGISTRY` below. The gate
 *   refuses the build until that happens.
 */

import { existsSync, readFileSync } from "node:fs";
import { globSync } from "node:fs";
import * as path from "node:path";

/**
 * Canonical registry of every binary the monorepo publishes.
 *
 * Each entry maps an installed binary name to:
 *   - owner: workspace package name that ships it
 *   - description: one-line summary surfaced in `storm --help` etc.
 *   - status: "active" | "grandfathered" (off-pattern names allowed
 *     for now) | "deprecated" (still ships but will be removed)
 */
const BINARY_REGISTRY = {
  brainstorm: {
    owner: "@brainst0rm/cli",
    description: "Brainstorm CLI — agentic loop, MCP server, God Mode dispatch.",
    status: "active",
  },
  storm: {
    owner: "@brainst0rm/cli",
    description: "Short alias for `brainstorm`. Same binary, same surface.",
    status: "active",
  },
  "brainstorm-broker": {
    owner: "@brainst0rm/broker",
    description: "Broker daemon — relay/dispatch for the endpoint agent mesh.",
    status: "active",
  },
  "brainstorm-relay": {
    owner: "@brainst0rm/relay",
    description: "Relay transport — vsock + WebSocket carrier for endpoint protocol envelopes.",
    status: "active",
  },
  "brainstorm-endpoint-stub": {
    owner: "@brainst0rm/endpoint-stub",
    description: "Endpoint-stub bin — dev harness for tool dispatch against a local sandbox.",
    status: "active",
  },
  "bsm-redteam": {
    owner: "@brainst0rm/sandbox-redteam",
    description: "Red-team probe runner — boots a sandbox and runs the attacker/defender battery.",
    // Grandfathered: doesn't match `brainstorm-*` but the bsm- prefix
    // is the historical "Brainstorm Sandbox Mesh" tooling family.
    // Renaming would break first-light scripts in @brainst0rm/sandbox.
    status: "grandfathered",
  },
};

const ALLOWED_NAME_PATTERN = /^(brainstorm(-[a-z0-9]+(-[a-z0-9]+)*)?|storm)$/;

export async function check({ repoRoot }) {
  const issues = [];

  // Walk every workspace package.json with a `bin` field.
  const pkgJsonPaths = globSync("packages/*/package.json", { cwd: repoRoot });
  const seenNames = new Map(); // name -> owner package

  for (const rel of pkgJsonPaths) {
    const abs = path.join(repoRoot, rel);
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    if (!pkg.bin) continue;
    const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : pkg.bin;
    for (const [binName, binPath] of Object.entries(bins)) {
      // Gate 1: must be in the canonical registry.
      const entry = BINARY_REGISTRY[binName];
      if (!entry) {
        issues.push(
          `${pkg.name} publishes bin "${binName}" but it's not registered. ` +
            `Add an entry to BINARY_REGISTRY in scripts/contract-checks/binary-registry.mjs.`,
        );
        continue;
      }

      // Gate 2: owner matches.
      if (entry.owner !== pkg.name) {
        issues.push(
          `${pkg.name} publishes bin "${binName}" but the registry says owner is ${entry.owner}. ` +
            `Update the registry or the package.json.`,
        );
      }

      // Gate 3: naming pattern (unless grandfathered).
      if (
        entry.status !== "grandfathered" &&
        !ALLOWED_NAME_PATTERN.test(binName)
      ) {
        issues.push(
          `bin "${binName}" violates the naming pattern (brainstorm-*, storm). ` +
            `If this is intentional, mark it status: "grandfathered" in the registry.`,
        );
      }

      // Gate 4: uniqueness across workspace.
      if (seenNames.has(binName) && seenNames.get(binName) !== pkg.name) {
        issues.push(
          `bin "${binName}" published by both ${seenNames.get(binName)} and ${pkg.name}. ` +
            `Bin names must be unique across the monorepo.`,
        );
      }
      seenNames.set(binName, pkg.name);

      // Gate 5: bin path points at a real built file. The path is
      // relative to the package root. The file may not exist before
      // the first `turbo run build`, so we only enforce existence
      // when the dist tree is present.
      const packageDir = path.dirname(abs);
      const distDir = path.join(packageDir, "dist");
      if (existsSync(distDir)) {
        const resolved = path.join(packageDir, binPath);
        if (!existsSync(resolved)) {
          issues.push(
            `${pkg.name} bin "${binName}" points at ${binPath} which doesn't exist. ` +
              `Either fix the bin path or rebuild the package.`,
          );
        }
      }
    }
  }

  // Gate 6: every registered binary has a publishing package. If
  // someone removes a bin from a package.json without updating the
  // registry, the registry stays stale and lies to future readers.
  for (const [binName, entry] of Object.entries(BINARY_REGISTRY)) {
    if (!seenNames.has(binName)) {
      issues.push(
        `registry lists "${binName}" (owner: ${entry.owner}) but no package.json declares it. ` +
          `Remove the registry entry or restore the bin field on ${entry.owner}.`,
      );
    }
  }

  return {
    name: "binary-registry",
    ok: issues.length === 0,
    issues,
    note: `${seenNames.size} binaries · ${Object.keys(BINARY_REGISTRY).length} registry entries`,
  };
}
