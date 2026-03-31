#!/usr/bin/env node

/**
 * SBOM Generator — CycloneDX format from package-lock.json
 *
 * Generates a Software Bill of Materials for supply chain visibility.
 * Output: docs/internal/sbom.json (CycloneDX 1.5)
 *
 * Usage: node scripts/generate-sbom.mjs [--output path]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const outputArg = process.argv.indexOf("--output");
const outputPath =
  outputArg !== -1
    ? process.argv[outputArg + 1]
    : join(ROOT, "docs", "internal", "sbom.json");

// Read package-lock.json
const lockfilePath = join(ROOT, "package-lock.json");
if (!existsSync(lockfilePath)) {
  console.error("Error: package-lock.json not found at", lockfilePath);
  process.exit(1);
}

const lockfile = JSON.parse(readFileSync(lockfilePath, "utf-8"));
const rootPkg = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf-8")
);

// Build component list from lockfile packages
const components = [];
const packages = lockfile.packages || {};

for (const [pkgPath, info] of Object.entries(packages)) {
  // Skip root entry
  if (pkgPath === "") continue;

  // Extract package name from path
  const name = info.name || pkgPath.replace(/^node_modules\//, "");
  if (!name) continue;

  const component = {
    type: "library",
    name,
    version: info.version || "unknown",
    purl: `pkg:npm/${name.replace("/", "%2F")}@${info.version || "unknown"}`,
    scope: info.dev ? "optional" : "required",
  };

  // Add license if available
  if (info.license) {
    component.licenses = [{ license: { id: info.license } }];
  }

  // Add integrity hash if available
  if (info.integrity) {
    const algorithm = info.integrity.split("-")[0];
    const hash = info.integrity.split("-").slice(1).join("-");
    component.hashes = [{ alg: algorithm.toUpperCase(), content: hash }];
  }

  components.push(component);
}

// Sort components by name for deterministic output
components.sort((a, b) => a.name.localeCompare(b.name));

// Build CycloneDX 1.5 BOM
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [
      {
        vendor: "brainstorm",
        name: "generate-sbom",
        version: "1.0.0",
      },
    ],
    component: {
      type: "application",
      name: rootPkg.name || "brainstorm",
      version: rootPkg.version || "0.0.0",
    },
  },
  components,
};

// Write output
writeFileSync(outputPath, JSON.stringify(bom, null, 2) + "\n");

const devCount = components.filter((c) => c.scope === "optional").length;
const prodCount = components.filter((c) => c.scope === "required").length;

console.log(`SBOM generated: ${outputPath}`);
console.log(
  `  ${components.length} total packages (${prodCount} production, ${devCount} dev)`
);
console.log(`  Format: CycloneDX 1.5`);
