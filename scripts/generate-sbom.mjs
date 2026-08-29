#!/usr/bin/env node

/**
 * Generate a deterministic CycloneDX 1.5 SBOM from pnpm-lock.yaml.
 * No install-time package metadata or npm-only lockfile is required.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const outputArg = process.argv.indexOf("--output");
const outputPath =
  outputArg !== -1
    ? resolve(process.cwd(), process.argv[outputArg + 1])
    : join(root, "docs", "internal", "sbom.json");

const lockfilePath = join(root, "pnpm-lock.yaml");
const lockfile = readFileSync(lockfilePath, "utf8");
const rootPackage = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);

const packagesStart = lockfile.indexOf("\npackages:\n");
const snapshotsStart = lockfile.indexOf("\nsnapshots:\n");
if (packagesStart === -1 || snapshotsStart === -1) {
  throw new Error("pnpm-lock.yaml is missing packages or snapshots sections");
}

const packageSection = lockfile.slice(packagesStart + 1, snapshotsStart);
const entries = [
  ...packageSection.matchAll(/^  ("(?:[^"\\]|\\.)*"|[^\n]+):\n/gm),
];
const components = [];

for (let index = 0; index < entries.length; index++) {
  const rawKey = entries[index][1];
  const key = rawKey.startsWith('"') ? JSON.parse(rawKey) : rawKey;
  const versionSeparator = key.lastIndexOf("@");
  if (versionSeparator <= 0) continue;

  const name = key.slice(0, versionSeparator);
  const version = key.slice(versionSeparator + 1).replace(/\(.+$/, "");
  if (!name || !version) continue;

  const blockStart = entries[index].index + entries[index][0].length;
  const blockEnd = entries[index + 1]?.index ?? packageSection.length;
  const block = packageSection.slice(blockStart, blockEnd);
  const integrity = block.match(/integrity:\s*([^,\s}]+)/)?.[1];
  const component = {
    type: "library",
    name,
    version,
    purl: `pkg:npm/${name.replace("/", "%2F")}@${version}`,
    // pnpm's package table is de-duplicated across prod/dev graphs. Marking it
    // required is conservative and avoids claiming a runtime dependency is
    // optional merely because another workspace also uses it for development.
    scope: "required",
  };
  if (integrity) {
    const separator = integrity.indexOf("-");
    if (separator > 0) {
      component.hashes = [
        {
          alg: integrity.slice(0, separator).toUpperCase(),
          content: integrity.slice(separator + 1),
        },
      ];
    }
  }
  components.push(component);
}

components.sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(
    `${right.name}@${right.version}`,
  ),
);

const digest = createHash("sha256").update(lockfile).digest("hex");
const serial = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${serial}`,
  version: 1,
  metadata: {
    tools: [
      {
        vendor: "brainstorm",
        name: "generate-sbom",
        version: "2.0.0",
      },
    ],
    component: {
      type: "application",
      name: rootPackage.name || "brainstorm",
      version: rootPackage.version || "0.0.0",
    },
  },
  components,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`SBOM generated: ${outputPath}`);
console.log(`  ${components.length} packages from pnpm-lock.yaml`);
console.log("  Format: CycloneDX 1.5");
