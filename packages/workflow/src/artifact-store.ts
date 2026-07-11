/**
 * Artifact Store — persist workflow step outputs to disk.
 *
 * Creates a workspace directory per workflow run and writes each
 * step's artifact as a file with metadata manifest.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { Artifact, WorkflowRun } from "@brainst0rm/shared";

const ARTIFACTS_BASE = join(homedir(), ".brainstorm", "artifacts");

/**
 * Sanitize a stepId before it lands in a filesystem path. stepIds come from
 * workflow definitions and — on the review-step path — can be influenced by
 * LLM output, so a stepId like "../../.ssh/authorized_keys" would otherwise
 * let writeArtifact() write outside the workspace directory.
 */
function sanitizeStepId(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("artifact-store: empty stepId");
  }
  if (raw.length > 100) {
    throw new Error(
      `artifact-store: stepId too long (${raw.length} > 100 chars)`,
    );
  }
  if (raw.includes("/") || raw.includes("\\")) {
    throw new Error(
      `artifact-store: path separator in stepId (${JSON.stringify(raw)})`,
    );
  }
  if (raw.includes("..") || raw.startsWith(".")) {
    throw new Error(
      `artifact-store: traversal or dot-prefix in stepId (${JSON.stringify(raw)})`,
    );
  }
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`artifact-store: control character in stepId`);
    }
  }
  return raw;
}

export interface ArtifactManifest {
  runId: string;
  description: string;
  preset: string;
  startedAt: string;
  completedAt?: string;
  totalCost: number;
  steps: Array<{
    stepId: string;
    agentRole: string;
    modelUsed: string;
    artifactPath: string;
    contentType: string;
    confidence: number;
    cost: number;
    iteration: number;
    /**
     * DeerFlow-style output/scratch separation (see Artifact.kind).
     * Optional for backward compat: manifests written before this field
     * existed are treated as "output" when read (see readManifest).
     */
    kind?: "output" | "scratch";
  }>;
}

/** Subdirectory an artifact file lands in, keyed by its `kind`. */
const KIND_DIRS = { output: "outputs", scratch: "scratch" } as const;

/**
 * Get the workspace directory for a workflow run.
 */
export function getWorkspaceDir(runId: string): string {
  return join(ARTIFACTS_BASE, runId);
}

/**
 * Ensure the workspace directory exists.
 */
export function ensureWorkspace(runId: string): string {
  const dir = getWorkspaceDir(runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Ensure the outputs/ or scratch/ subdirectory (per artifact kind) exists
 * under a run's workspace and return its path.
 */
function ensureKindDir(runId: string, kind: "output" | "scratch"): string {
  const dir = join(ensureWorkspace(runId), KIND_DIRS[kind]);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write an artifact to disk and return the file path.
 *
 * Files are routed into a DeerFlow-style `outputs/` or `scratch/` subdir of
 * the run's workspace, keyed by `artifact.kind` (default: "output").
 * `manifest.json` itself stays at the run root regardless of kind.
 */
export function writeArtifact(runId: string, artifact: Artifact): string {
  const kind = artifact.kind ?? "output";
  const dir = ensureKindDir(runId, kind);
  const safeStepId = sanitizeStepId(artifact.stepId);
  const iteration = Number(artifact.iteration);
  if (!Number.isFinite(iteration) || iteration < 0) {
    throw new Error(
      `artifact-store: invalid iteration (${String(artifact.iteration)})`,
    );
  }
  const ext =
    artifact.contentType === "json"
      ? "json"
      : artifact.contentType === "code"
        ? "ts"
        : artifact.contentType === "markdown"
          ? "md"
          : "txt";
  const filename = `step-${safeStepId}-${iteration}.${ext}`;
  const filePath = join(dir, filename);

  // Belt-and-braces: even with sanitation, assert the resolved path stays
  // under the kind subdir root before committing the write.
  const root = resolve(dir);
  const target = resolve(filePath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(
      `artifact-store: resolved path escapes workspace (${target})`,
    );
  }

  writeFileSync(filePath, artifact.content, "utf-8");
  return filePath;
}

/**
 * Write or update the manifest for a workflow run.
 */
export function writeManifest(runId: string, manifest: ArtifactManifest): void {
  const dir = ensureWorkspace(runId);
  const filePath = join(dir, "manifest.json");
  writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf-8");
}

/**
 * Read a manifest for a workflow run.
 *
 * Manifests written before the output/scratch split have step entries
 * without a `kind` — `kind` is optional on the type for exactly this
 * reason, so those still parse cleanly. Callers that care should treat a
 * missing `kind` as "output" (e.g. `step.kind ?? "output"`).
 */
export function readManifest(runId: string): ArtifactManifest | null {
  const filePath = join(getWorkspaceDir(runId), "manifest.json");
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * List all workflow runs with manifests, most recent first.
 */
export function listRuns(limit = 10): ArtifactManifest[] {
  if (!existsSync(ARTIFACTS_BASE)) return [];

  // runIds are randomUUID() (engine.ts:62), so sorting directory names
  // lexically returns runs in essentially random order — not "most
  // recent first" as the `.reverse().slice(limit)` shape implied.
  // Read every manifest, sort by startedAt, then slice. For typical
  // workflow-run counts (dozens, not thousands) the full-scan cost
  // is negligible; a manifest that fails to parse is silently
  // dropped (same behavior as before).
  const dirs = readdirSync(ARTIFACTS_BASE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const manifests: ArtifactManifest[] = [];
  for (const dir of dirs) {
    const m = readManifest(dir);
    if (m) manifests.push(m);
  }
  manifests.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return manifests.slice(0, limit);
}

/**
 * Find and read a step's artifact file within a single directory (does not
 * recurse). Returns null if the directory doesn't exist or has no match.
 */
function readArtifactFrom(
  dir: string,
  safeStepId: string,
  iteration: number,
): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) =>
    f.startsWith(`step-${safeStepId}-`),
  );
  const target = files.find((f) => f.includes(`-${iteration}.`));
  if (!target) return null;
  try {
    return readFileSync(join(dir, target), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read an artifact's content from disk.
 *
 * Checks outputs/ then scratch/ (the artifact's kind isn't known to the
 * caller), then falls back to the run's root dir directly for runs written
 * before the output/scratch split.
 */
export function readArtifact(
  runId: string,
  stepId: string,
  iteration = 0,
): string | null {
  const runDir = getWorkspaceDir(runId);
  if (!existsSync(runDir)) return null;

  const safeStepId = sanitizeStepId(stepId);

  for (const sub of [KIND_DIRS.output, KIND_DIRS.scratch]) {
    const found = readArtifactFrom(join(runDir, sub), safeStepId, iteration);
    if (found !== null) return found;
  }
  // Legacy flat layout (pre output/scratch split): files sat directly in
  // the run root.
  return readArtifactFrom(runDir, safeStepId, iteration);
}
