/**
 * BrainstormRouter business-harness contract map gate.
 *
 * Gate #17 locks the most important product seam: the routes this
 * business harness uses to operate through BR. When the sibling
 * brainstormrouter repo is available, this runs the full map check
 * against BR source, OpenAPI, capability metadata, RBAC, SDK paths,
 * and the committed artifacts. In single-repo CI, it falls back to
 * the committed artifact as the BR snapshot and still verifies that
 * current harness code/docs match the 20-route contract.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const NAME = "br-contract-map";
const ARTIFACT = "artifacts/br-business-contract-map.json";

function readJson(absPath) {
  return JSON.parse(readFileSync(absPath, "utf8"));
}

function readMaybe(absPath) {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return "";
  }
}

function validateArtifactBackedSnapshot(repoRoot) {
  const artifactPath = path.join(repoRoot, ARTIFACT);
  if (!existsSync(artifactPath)) {
    return {
      ok: false,
      issues: [
        `${ARTIFACT} missing - run \`npm run br:contract-map\` with the sibling brainstormrouter repo available.`,
      ],
    };
  }

  let map;
  try {
    map = readJson(artifactPath);
  } catch (err) {
    return {
      ok: false,
      issues: [
        `${ARTIFACT} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const issues = [];
  if (map.schema_version !== 1) {
    issues.push(`${ARTIFACT}: schema_version must be 1.`);
  }
  if (map.ok !== true) {
    issues.push(`${ARTIFACT}: last generated map was not ok.`);
  }
  if (!map.br_repo_detected) {
    issues.push(
      `${ARTIFACT}: committed snapshot must be generated with the sibling brainstormrouter repo detected.`,
    );
  }
  if (!Array.isArray(map.routes) || map.routes.length === 0) {
    issues.push(`${ARTIFACT}: routes[] missing or empty.`);
  }
  if (map.counts?.warnings !== 0) {
    issues.push(
      `${ARTIFACT}: committed snapshot has ${map.counts?.warnings ?? "unknown"} warning(s); gate requires zero warnings.`,
    );
  }

  for (const route of map.routes ?? []) {
    for (const [file, needle] of route.codeRefs ?? []) {
      const text = readMaybe(path.join(repoRoot, file));
      if (!text.includes(needle)) {
        issues.push(
          `${route.id}: code reference missing: ${file} :: ${needle}`,
        );
      }
    }
    for (const [file, needle] of route.docRefs ?? []) {
      const text = readMaybe(path.join(repoRoot, file));
      if (!text.includes(needle)) {
        issues.push(`${route.id}: doc reference missing: ${file} :: ${needle}`);
      }
    }
    for (const [file, needle] of route.negativeCodeRefs ?? []) {
      const text = readMaybe(path.join(repoRoot, file));
      if (text.includes(needle)) {
        issues.push(
          `${route.id}: forbidden code reference present: ${file} :: ${needle}`,
        );
      }
    }
  }

  for (const entry of map.legacy_doc_mentions ?? []) {
    const text = readMaybe(path.join(repoRoot, entry.doc));
    if (text.includes(entry.stale)) {
      issues.push(
        `${entry.doc}: stale ${entry.stale} still present; replace with ${entry.replacement}`,
      );
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    note: `${map.counts?.routes ?? map.routes?.length ?? 0} routes verified from committed BR snapshot`,
  };
}

export async function check({ repoRoot }) {
  const brRoot =
    process.env.BRAINSTORMROUTER_REPO ??
    path.resolve(repoRoot, "..", "brainstormrouter");
  const script = path.join(repoRoot, "scripts/br-business-contract-map.mjs");

  if (!existsSync(script)) {
    return {
      name: NAME,
      ok: false,
      issues: [`scripts/br-business-contract-map.mjs missing.`],
      kind: "infra",
    };
  }

  if (existsSync(brRoot)) {
    const result = spawnSync(process.execPath, [script, "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, BRAINSTORMROUTER_REPO: brRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
      return {
        name: NAME,
        ok: false,
        kind: "infra",
        issues: [`node invocation failed: ${result.error.message}`],
      };
    }

    if (result.status !== 0) {
      const output = `${result.stderr}\n${result.stdout}`
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(0, 30);
      return {
        name: NAME,
        ok: false,
        kind: result.status === 2 ? "infra" : "drift",
        issues:
          output.length > 0
            ? output
            : [`br-business-contract-map exited ${result.status}`],
      };
    }
  }

  const snapshot = validateArtifactBackedSnapshot(repoRoot);
  if (!snapshot.ok) {
    return {
      name: NAME,
      ok: false,
      kind: "drift",
      issues: snapshot.issues,
    };
  }

  return {
    name: NAME,
    ok: true,
    note: existsSync(brRoot)
      ? `${snapshot.note}; full sibling BR check passed`
      : `${snapshot.note}; sibling BR repo not present, using artifact snapshot`,
  };
}
