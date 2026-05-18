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
 *
 * Private-package carve-out:
 *   The Stage-3 review flagged that an unbounded `private: true`
 *   exemption was a future-abuse loophole — a contributor could
 *   silence a failing version-sync check by flipping the private
 *   flag. Stage-3.5 narrows the carve-out to an explicit allowlist
 *   (EXPECTED_PRIVATE_PACKAGES). A package becoming private without
 *   being on the list now fails the gate with a clear "add to
 *   allowlist" hint.
 */

/**
 * Packages explicitly allowed to run independent versioning cadence
 * because they're not npm-published. Each entry should carry a
 * one-line justification — the registry is the audit trail.
 */
const EXPECTED_PRIVATE_PACKAGES = new Map([
  [
    "@brainst0rm/image-builder",
    "Produces VM kernel + rootfs images, not npm tarballs. Ships alpha-tagged artifacts on its own cadence.",
  ],
]);

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
    } catch (err) {
      // Surface parse failures explicitly instead of silently dropping
      // the package — a malformed package.json that happens to belong
      // to the out-of-sync package would otherwise mask the drift the
      // gate exists to catch.
      issues.push(
        `cannot parse ${rel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Audit private-package allowlist BEFORE computing canonical
  // version, so a misplaced private flag fails the gate with a
  // pointed message instead of being absorbed into the
  // "no-canonical-version-known" generic error path.
  for (const { pkg } of pkgs) {
    if (!pkg.private) continue;
    if (!EXPECTED_PRIVATE_PACKAGES.has(pkg.name)) {
      issues.push(
        `${pkg.name} is marked private: true but isn't in EXPECTED_PRIVATE_PACKAGES. ` +
          `Either remove the private flag, or add an entry (with justification) to ` +
          `EXPECTED_PRIVATE_PACKAGES in scripts/contract-checks/version-sync.mjs. ` +
          `The allowlist is the audit trail for "this package intentionally runs off-version."`,
      );
    }
  }

  // Determine the canonical workspace version — the dominant version
  // across *published* packages. Allowlisted private packages run
  // independent cadence (e.g. image-builder ships VM images on alpha
  // versions); they don't contribute to or violate the canonical
  // version.
  const versionCounts = new Map();
  for (const { pkg } of pkgs) {
    if (pkg.private && EXPECTED_PRIVATE_PACKAGES.has(pkg.name)) continue;
    const v = pkg.version;
    versionCounts.set(v, (versionCounts.get(v) ?? 0) + 1);
  }
  const sortedVersions = [...versionCounts.entries()].sort((a, b) => b[1] - a[1]);
  const canonicalVersion = sortedVersions[0]?.[0];
  if (!canonicalVersion) {
    issues.push(
      "could not determine canonical workspace version (no published packages with a version field?)",
    );
    return {
      name: "version-sync",
      ok: false,
      issues,
    };
  }

  // Tie-break detection: if two versions tie for the most packages,
  // the sort order is filesystem-dependent. During a partial
  // changesets release (some packages bumped, others not), this is
  // the exact failure mode the gate exists to catch. Surface ties
  // explicitly instead of silently picking one.
  if (
    sortedVersions.length >= 2 &&
    sortedVersions[0][1] === sortedVersions[1][1]
  ) {
    const tied = sortedVersions
      .filter((e) => e[1] === sortedVersions[0][1])
      .map((e) => `${e[1]} packages @ ${e[0]}`)
      .join(" vs ");
    issues.push(
      `no dominant canonical version — workspace appears mid-release: ${tied}. ` +
        `Either complete the changesets release or align the packages by hand before merging.`,
    );
    return {
      name: "version-sync",
      ok: false,
      issues,
    };
  }

  // Gate 1: every PUBLISHED internal package shares the canonical
  // version. Allowlisted private packages are exempt — they're
  // intentionally off-axis (e.g. image-builder ships VM images, not
  // npm tarballs).
  for (const { pkg } of pkgs) {
    if (pkg.private && EXPECTED_PRIVATE_PACKAGES.has(pkg.name)) continue;
    if (pkg.version !== canonicalVersion) {
      issues.push(
        `${pkg.name} is at version ${pkg.version} but the canonical workspace version is ${canonicalVersion}. ` +
          `Align the version, or — if this package legitimately runs off-cadence — mark it private: true ` +
          `AND add it to EXPECTED_PRIVATE_PACKAGES with justification.`,
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
