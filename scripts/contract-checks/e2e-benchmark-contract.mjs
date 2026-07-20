import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const NAME = "e2e-benchmark-contract";
const REGISTRY_PATH = "scripts/contract-checks/e2e-benchmark-registry.json";
const DOMAINS = [
  "coding",
  "web",
  "documentation",
  "infrastructure",
  "adversarial",
];
const VERIFICATION_KINDS = new Set([
  "command",
  "static-web",
  "document",
  "structured-data",
  "policy",
]);

function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !isAbsolute(value) &&
    !value.split(/[\\/]+/).includes("..")
  );
}

/** Validate the committed suite without importing build output. */
export function validateSuite(registry, source) {
  const issues = [];
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== registry.sha256) {
    issues.push(
      `suite fingerprint changed (${digest}); publish a new version instead of mutating ${registry.suiteId}`,
    );
  }

  const rows = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      issues.push(`line ${index + 1} is not valid JSON: ${error.message}`);
    }
  }
  if (rows.length !== registry.taskCount) {
    issues.push(`expected ${registry.taskCount} tasks, found ${rows.length}`);
  }

  const ids = new Set();
  const counts = Object.fromEntries(DOMAINS.map((domain) => [domain, 0]));
  for (const [index, row] of rows.entries()) {
    const prefix = `line ${index + 1}`;
    if (row.version !== 1) issues.push(`${prefix}: version must be 1`);
    if (row.workspace !== "sandbox") {
      issues.push(`${prefix}: workspace must be sandbox`);
    }
    if (typeof row.id !== "string" || row.id.length === 0) {
      issues.push(`${prefix}: id is required`);
    } else if (ids.has(row.id)) {
      issues.push(`${prefix}: duplicate id ${row.id}`);
    } else {
      ids.add(row.id);
    }
    if (!DOMAINS.includes(row.domain)) {
      issues.push(`${prefix}: unknown domain ${String(row.domain)}`);
    } else {
      counts[row.domain]++;
    }
    if (!Number.isInteger(row.maxSteps) || row.maxSteps < 1) {
      issues.push(`${prefix}: maxSteps must be a positive integer`);
    }
    if (!Number.isInteger(row.timeoutMs) || row.timeoutMs < 1_000) {
      issues.push(`${prefix}: timeoutMs must be >= 1000`);
    }
    if (!Array.isArray(row.tags) || row.tags.length === 0) {
      issues.push(`${prefix}: at least one tag is required`);
    }
    if (!row.verify || !VERIFICATION_KINDS.has(row.verify.kind)) {
      issues.push(`${prefix}: verification kind is missing or unknown`);
    } else {
      // A frozen task must carry at least one CONCRETE, checkable assertion —
      // otherwise its verification can be silently neutered (e.g. kind:"command"
      // with no commands) while the fingerprint stays self-consistent, and the
      // suite would "pass" tasks it never actually verified.
      const v = row.verify;
      const hasCheck =
        (Array.isArray(v.requiredFiles) && v.requiredFiles.length > 0) ||
        (Array.isArray(v.commands) && v.commands.length > 0) ||
        (Array.isArray(v.fileAssertions) && v.fileAssertions.length > 0) ||
        typeof v.rubric === "string";
      if (!hasCheck) {
        issues.push(
          `${prefix}: verification has no checkable assertion (needs requiredFiles, commands, fileAssertions, or a rubric)`,
        );
      }
      if (
        v.kind === "command" &&
        !(Array.isArray(v.commands) && v.commands.length > 0)
      ) {
        issues.push(
          `${prefix}: kind "command" requires a non-empty commands array`,
        );
      }
    }
    const paths = [
      ...Object.keys(row.setup?.files ?? {}),
      ...(row.verify?.requiredFiles ?? []),
      ...(row.verify?.fileAssertions ?? []).map((assertion) => assertion.path),
    ];
    for (const path of paths) {
      if (!safeRelativePath(path)) {
        issues.push(`${prefix}: path escapes sandbox: ${String(path)}`);
      }
    }
  }

  for (const domain of DOMAINS) {
    if (counts[domain] !== registry.domains[domain]) {
      issues.push(
        `${domain} distribution drifted: expected ${registry.domains[domain]}, found ${counts[domain]}`,
      );
    }
  }
  return issues;
}

/**
 * Version-binding: the fingerprint of a frozen suite must never change under a
 * fixed suiteId. Comparing the working tree against HEAD catches the
 * self-consistent rewrite the plain digest can't — editing the suite AND
 * recomputing registry.sha256 in the same change. A new suite must bump suiteId
 * (and, by convention, the versioned filename) instead of mutating v1's bytes.
 *
 * Best-effort: if git or HEAD's registry isn't available (initial commit, shallow
 * checkout, non-git tree) there's nothing to compare against, so it's a no-op —
 * the digest check still guards accidental drift.
 */
function fingerprintVersionIssues(repoRoot, registry) {
  let headRegistryRaw;
  try {
    headRegistryRaw = execFileSync("git", ["show", `HEAD:${REGISTRY_PATH}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return []; // no HEAD copy to compare against — nothing to enforce
  }
  let head;
  try {
    head = JSON.parse(headRegistryRaw);
  } catch {
    return [];
  }
  if (
    head.suiteId === registry.suiteId &&
    head.sha256 &&
    registry.sha256 &&
    head.sha256 !== registry.sha256
  ) {
    return [
      `suite fingerprint changed while suiteId stayed "${registry.suiteId}" ` +
        `(${head.sha256} → ${registry.sha256}); a frozen suite is immutable — ` +
        `bump suiteId and publish a new versioned file instead of mutating it`,
    ];
  }
  return [];
}

export async function check({ repoRoot }) {
  try {
    const registry = JSON.parse(
      readFileSync(join(repoRoot, REGISTRY_PATH), "utf8"),
    );
    if (!safeRelativePath(registry.path)) {
      return {
        name: NAME,
        ok: false,
        kind: "drift",
        issues: ["registry suite path must stay inside the repository"],
      };
    }
    const source = readFileSync(join(repoRoot, registry.path), "utf8");
    const issues = [
      ...validateSuite(registry, source),
      ...fingerprintVersionIssues(repoRoot, registry),
    ];
    return issues.length === 0
      ? {
          name: NAME,
          ok: true,
          info: [
            `${registry.suiteId}: ${registry.taskCount} immutable sandbox tasks`,
          ],
        }
      : { name: NAME, ok: false, kind: "drift", issues };
  } catch (error) {
    return {
      name: NAME,
      ok: false,
      kind: "infra",
      issues: [`could not read benchmark contract: ${error.message}`],
    };
  }
}
