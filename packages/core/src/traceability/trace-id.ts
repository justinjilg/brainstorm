/**
 * Traceability ID System — stable cross-linked identifiers for artifacts.
 *
 * Inspired by CyberFabric's Cyber Pilot: every artifact (requirement, design,
 * plan task, code change, test) gets a stable TraceId that links it to its
 * origin and downstream dependents.
 *
 * TraceId format: {type}-{project}-{sequence}
 *   REQ-brainstorm-001   (requirement)
 *   DES-brainstorm-001   (design decision)
 *   PLN-brainstorm-001   (plan task)
 *   CHG-brainstorm-001   (code change)
 *   TST-brainstorm-001   (test)
 *   ADR-brainstorm-001   (architecture decision record)
 *
 * Every artifact carries its traceId plus links to parent/child artifacts.
 * This enables: "show me every code change that traces back to REQ-brainstorm-042"
 * and "which requirements are covered by tests?"
 */

import { createHash } from "node:crypto";

export type ArtifactType = "REQ" | "DES" | "PLN" | "CHG" | "TST" | "ADR";

export interface TraceLink {
  /** TraceId of the linked artifact. */
  targetId: string;
  /** Relationship type. */
  relation:
    | "implements"
    | "derives-from"
    | "tests"
    | "supersedes"
    | "blocks"
    | "related";
}

export interface TracedArtifact {
  /** Stable identifier: {type}-{project}-{sequence} */
  traceId: string;
  /** Artifact type. */
  type: ArtifactType;
  /** Project slug. */
  project: string;
  /** Human-readable title. */
  title: string;
  /** Description or content. */
  description: string;
  /** Status. */
  status: "draft" | "active" | "completed" | "deprecated";
  /** Links to parent/child artifacts. */
  links: TraceLink[];
  /** Who/what created this artifact. */
  author: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  updatedAt: string;
  /** File path if this artifact lives in a file. */
  filePath?: string;
  /** Metadata. */
  metadata: Record<string, unknown>;
}

// ── ID Generation ─────────────────────────────────────────────────

const TYPE_PREFIXES: Record<ArtifactType, string> = {
  REQ: "REQ",
  DES: "DES",
  PLN: "PLN",
  CHG: "CHG",
  TST: "TST",
  ADR: "ADR",
};

/**
 * Generate a stable TraceId from artifact content.
 * Uses content hash to ensure the same artifact always gets the same ID
 * (idempotent — safe to re-run).
 */
export function generateTraceId(
  type: ArtifactType,
  project: string,
  content: string,
): string {
  const hash = createHash("sha256")
    .update(`${type}:${project}:${content}`)
    .digest("hex")
    .slice(0, 6);
  return `${TYPE_PREFIXES[type]}-${project}-${hash}`;
}

/**
 * Generate a sequential TraceId (for when ordering matters).
 */
export function generateSequentialTraceId(
  type: ArtifactType,
  project: string,
  sequence: number,
): string {
  return `${TYPE_PREFIXES[type]}-${project}-${String(sequence).padStart(3, "0")}`;
}

/**
 * Parse a TraceId into its components.
 */
export function parseTraceId(traceId: string): {
  type: ArtifactType;
  project: string;
  identifier: string;
} | null {
  const match = traceId.match(/^(REQ|DES|PLN|CHG|TST|ADR)-([^-]+)-(.+)$/);
  if (!match) return null;
  return {
    type: match[1] as ArtifactType,
    project: match[2],
    identifier: match[3],
  };
}

/**
 * Validate that a TraceId is well-formed.
 */
export function isValidTraceId(traceId: string): boolean {
  return parseTraceId(traceId) !== null;
}
