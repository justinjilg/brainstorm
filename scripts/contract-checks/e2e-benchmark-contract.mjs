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
    const issues = validateSuite(registry, source);
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
