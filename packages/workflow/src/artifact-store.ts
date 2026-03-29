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
import { join } from "node:path";
import { homedir } from "node:os";
import type { Artifact, WorkflowRun } from "@brainst0rm/shared";

const ARTIFACTS_BASE = join(homedir(), ".brainstorm", "artifacts");

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
  }>;
}

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
 * Write an artifact to disk and return the file path.
 */
export function writeArtifact(runId: string, artifact: Artifact): string {
  const dir = ensureWorkspace(runId);
  const ext =
    artifact.contentType === "json"
      ? "json"
      : artifact.contentType === "code"
        ? "ts"
        : artifact.contentType === "markdown"
          ? "md"
          : "txt";
  const filename = `step-${artifact.stepId}-${artifact.iteration}.${ext}`;
  const filePath = join(dir, filename);

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
 * List all workflow runs with manifests.
 */
export function listRuns(limit = 10): ArtifactManifest[] {
  if (!existsSync(ARTIFACTS_BASE)) return [];

  const dirs = readdirSync(ARTIFACTS_BASE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, limit);

  const manifests: ArtifactManifest[] = [];
  for (const dir of dirs) {
    const m = readManifest(dir);
    if (m) manifests.push(m);
  }
  return manifests;
}

/**
 * Read an artifact's content from disk.
 */
export function readArtifact(
  runId: string,
  stepId: string,
  iteration = 0,
): string | null {
  const dir = getWorkspaceDir(runId);
  if (!existsSync(dir)) return null;

  const files = readdirSync(dir).filter((f) => f.startsWith(`step-${stepId}-`));
  if (files.length === 0) return null;

  const target = files.find((f) => f.includes(`-${iteration}.`)) ?? files[0];
  try {
    return readFileSync(join(dir, target), "utf-8");
  } catch {
    return null;
  }
}
