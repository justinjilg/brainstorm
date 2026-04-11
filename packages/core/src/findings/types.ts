/**
 * Codebase audit finding — structured entry produced by document-mode
 * orchestration when a fleet of agents explores and annotates a codebase.
 *
 * Findings are stored as memory entries with a recognizable content
 * envelope, so they flow through every piece of the existing sync
 * infrastructure (retry queue, pull path, approval workflow, trust
 * scoring, git tracking) without any new persistence layer. The CLI
 * parses findings back out of memory entries for the `brainstorm
 * findings list|summary` commands.
 */

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type FindingCategory =
  | "security"
  | "performance"
  | "reliability"
  | "maintainability"
  | "correctness"
  | "testing"
  | "documentation"
  | "complexity"
  | "tech-debt"
  | "dependency"
  | "accessibility"
  | "unknown";

export interface CodebaseFinding {
  /** Stable ID. Usually derived from file path + line + title hash. */
  id: string;
  /** Short one-line title (<= 80 chars). */
  title: string;
  /** Full description of what was found and why it matters. */
  description: string;
  /** Severity classification. */
  severity: FindingSeverity;
  /** Category taxonomy. */
  category: FindingCategory;
  /** File path relative to project root. */
  file: string;
  /** Optional line range (inclusive). */
  lineStart?: number;
  lineEnd?: number;
  /** Optional suggested fix — natural language or diff-like snippet. */
  suggestedFix?: string;
  /** Which agent/model produced the finding. */
  discoveredBy?: string;
  /** Unix timestamp when the finding was recorded. */
  discoveredAt: number;
  /** Optional free-form tags for custom slicing. */
  tags?: string[];
}

/** Marker prefix for serializing findings into memory entry content. */
export const FINDING_MARKER = "[FINDING]";

/**
 * Serialize a finding into the content body of a memory entry.
 * Format:
 *
 *   [FINDING]
 *   { "id": "...", "title": "...", ... }
 *
 * The parser scans for the marker on the first non-empty line, then
 * parses the remainder as JSON. Robust against surrounding whitespace
 * and trailing commentary (only the first JSON object is read).
 */
export function serializeFinding(finding: CodebaseFinding): string {
  return `${FINDING_MARKER}\n${JSON.stringify(finding, null, 2)}`;
}

/**
 * Parse a finding from memory entry content. Returns null if the
 * content does not start with the finding marker or fails JSON parse.
 *
 * Lenient about whitespace and comment noise the agent might emit
 * around the marker — the important thing is that we can recover
 * structured data on the read path.
 */
export function parseFinding(content: string): CodebaseFinding | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith(FINDING_MARKER)) return null;

  const rest = trimmed.slice(FINDING_MARKER.length).trim();
  // Find first JSON object by balance matching — tolerates trailing text
  const start = rest.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(rest.slice(start, end));
    if (!isValidFinding(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Structural validation. Defensive against agent output that might
 * hallucinate a finding-looking JSON without the required fields.
 */
function isValidFinding(obj: unknown): obj is CodebaseFinding {
  if (typeof obj !== "object" || obj === null) return false;
  const f = obj as Record<string, unknown>;
  if (typeof f.id !== "string" || !f.id) return false;
  if (typeof f.title !== "string" || !f.title) return false;
  if (typeof f.description !== "string") return false;
  if (typeof f.file !== "string" || !f.file) return false;
  if (typeof f.discoveredAt !== "number") return false;
  if (!isValidSeverity(f.severity)) return false;
  if (typeof f.category !== "string") return false; // allow unknown category
  return true;
}

function isValidSeverity(value: unknown): value is FindingSeverity {
  return (
    value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "info"
  );
}

/**
 * Sort key for ordering findings by urgency. Lower = more urgent.
 */
export function severityRank(severity: FindingSeverity): number {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    case "info":
      return 4;
  }
}

/**
 * Make a deterministic id for a finding from its content. Used when
 * agents don't supply an explicit id so we can dedupe across workers
 * that discover the same issue.
 */
export function makeFindingId(
  file: string,
  title: string,
  lineStart?: number,
): string {
  const base = `${file}:${lineStart ?? 0}:${title}`;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
