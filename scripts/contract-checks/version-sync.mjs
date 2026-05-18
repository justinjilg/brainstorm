/**
 * Workspace dep version sync gate.
 *
 * Every internal `@brainst0rm/*` dependency declared in a workspace
 * package.json MUST match the current workspace version. The pattern
 * we kept hitting (and which caused the pre-existing `main` CI
 * breakage that PR #343 fixed) is:
 *
 *   - sandbox-redteam declares `"@brainst0rm/sandbox": "0.1.0"`.
 *   - Workspace bumps to 0.14.4 via changesets release.
 *   - npm refuses to satisfy the 0.1.0 pin from the workspace, falls
 *     back to a stale tarball, the nested install lacks the current
 *     dist tree, and every consumer's build dies on a resolve error.
 *
 * The gate is structural: read the root package.json's workspace
 * version (or the `version` field on each package), assert every
 * internal dep declaration points at that version. Allow
 * `workspace:*` and `workspace:^` prefixes (the npm-workspaces
 * idiom for pinning to the local copy).
 */

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import * as path from "node:path";

export async function check({ repoRoot }) {
  const issues = [];

  // Build a map of internal package name → declared version.
  const pkgPaths = globSync("packages/*/package.json", { cwd: repoRoot });
  const internalVersions = new Map();
  const pkgs = [];

  for (const rel of pkgPaths) {
    const abs = path.join(repoRoot, rel);
    try {
      const pkg = JSON.parse(readFileSync(abs, "utf8"));
      if (pkg.name?.startsWith("@brainst0rm/") && pkg.version) {
        internalVersions.set(pkg.name, pkg.version);
        pkgs.push({ pkg, abs, isPrivate: pkg.private === true });
      }
    } catch {
      // skip unparseable
    }
  }

  // Determine the canonical workspace version — the dominant version
  // across *published* packages. Private packages may run independent
  // cadence (e.g. image-builder ships VM images on alpha versions);
  // they don't contribute to or violate the canonical version.
  const versionCounts = new Map();
  for (const { pkg } of pkgs) {
    if (pkg.private) continue;
    const v = pkg.version;
    versionCounts.set(v, (versionCounts.get(v) ?? 0) + 1);
  }
  const canonicalVersion = [...versionCounts.entries()].sort(
    (a, b) => b[1] - a[1],
  )[0]?.[0];
  if (!canonicalVersion) {
    return {
      name: "version-sync",
      ok: false,
      issues: ["could not determine canonical workspace version (no published packages with a version field?)"],
    };
  }

  // Gate 1: every PUBLISHED internal package shares the canonical
  // version. Private packages are exempt — they're intentionally
  // off-axis (e.g. image-builder is a Docker-based image producer,
  // not an npm package).
  for (const { pkg } of pkgs) {
    if (pkg.private) continue;
    if (pkg.version !== canonicalVersion) {
      issues.push(
        `${pkg.name} is at version ${pkg.version} but the canonical workspace version is ${canonicalVersion}. ` +
          `If this is deliberate (independent release cadence), mark it private: true.`,
      );
    }
  }

  // Gate 2: every internal dep declaration points at the package's
  // own declared version, NOT at a stale pin. This is the exact
  // drift PR #343 fixed.
  for (const { pkg, abs } of pkgs) {
    for (const depGroup of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[depGroup];
      if (!deps) continue;
      for (const [depName, depVersion] of Object.entries(deps)) {
        if (!depName.startsWith("@brainst0rm/")) continue;
        if (!internalVersions.has(depName)) continue; // external @brainst0rm scope? unlikely

        // workspace: protocol resolves at install time; ignore.
        if (typeof depVersion === "string" && depVersion.startsWith("workspace:"))
          continue;

        const expected = internalVersions.get(depName);
        if (depVersion !== expected) {
          const rel = path.relative(repoRoot, abs);
          issues.push(
            `${rel} ${depGroup}.${depName} = "${depVersion}" but workspace ships ${expected}. ` +
              `Bump to "${expected}" or switch to "workspace:^${expected}".`,
          );
        }
      }
    }
  }

  return {
    name: "version-sync",
    ok: issues.length === 0,
    issues,
    note: `${pkgs.length} workspace packages · canonical version ${canonicalVersion}`,
  };
}
