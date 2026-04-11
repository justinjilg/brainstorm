/**
 * FindingsStore — persist + query codebase audit findings using the
 * existing MemoryManager as the underlying storage engine.
 *
 * Design rationale: findings are just structured memory entries. By
 * piggybacking on MemoryManager, they inherit:
 *   - Local git-tracked file storage (~/.brainstorm/projects/<hash>/memory/)
 *   - Fire-and-forget push to BR shared memory
 *   - Pull path from BR on construction (cross-machine visibility)
 *   - Trust scoring + quarantine for low-confidence outputs
 *   - Approval workflow via /v1/memory/pending (enterprise governance)
 *
 * The store is a thin adapter: findings serialize to a recognizable
 * content envelope, and the parser pulls them back out on read.
 */

import type { MemoryManager } from "../memory/manager.js";
import {
  type CodebaseFinding,
  type FindingSeverity,
  type FindingCategory,
  FINDING_MARKER,
  serializeFinding,
  parseFinding,
  severityRank,
  makeFindingId,
} from "./types.js";

export interface FindingsFilter {
  severity?: FindingSeverity | FindingSeverity[];
  category?: FindingCategory | FindingCategory[];
  file?: string;
  /** Substring match against title + description + file path. */
  query?: string;
  /** Only findings discovered by this agent/model. */
  discoveredBy?: string;
}

export interface FindingsSummary {
  total: number;
  bySeverity: Record<FindingSeverity, number>;
  byCategory: Record<string, number>;
  byFile: Array<{ file: string; count: number }>;
  topCritical: CodebaseFinding[];
}

export class FindingsStore {
  constructor(private memory: MemoryManager) {}

  /**
   * Save a finding. Returns the finding with any derived fields
   * populated (id if missing, discoveredAt if missing).
   *
   * Findings save as memory entries with:
   *   - type: "reference" (they describe the codebase, not user prefs)
   *   - source: "agent_extraction" (default trust score 0.5)
   *   - name: deterministic ID so re-runs update the same entry
   *
   * The content body is the serialized finding envelope.
   */
  save(
    input: Omit<CodebaseFinding, "id" | "discoveredAt"> & {
      id?: string;
      discoveredAt?: number;
    },
  ): CodebaseFinding {
    const id =
      input.id ?? makeFindingId(input.file, input.title, input.lineStart);
    const finding: CodebaseFinding = {
      ...input,
      id,
      discoveredAt: input.discoveredAt ?? Math.floor(Date.now() / 1000),
    };

    this.memory.save({
      name: `finding-${id}`,
      description:
        `[${finding.severity}/${finding.category}] ${finding.title}`.slice(
          0,
          150,
        ),
      content: serializeFinding(finding),
      type: "reference",
      source: "agent_extraction",
    });

    return finding;
  }

  /**
   * List all findings. Walks every memory entry and filters to ones
   * whose content parses as a finding.
   *
   * For large stores this becomes O(N) on every call. Fine for the
   * initial ship — a future optimization is to maintain a findings
   * index file alongside the memory store.
   */
  list(filter?: FindingsFilter): CodebaseFinding[] {
    const all = this.memory.list();
    const findings: CodebaseFinding[] = [];
    for (const entry of all) {
      if (!entry.name.startsWith("finding-")) continue;
      const parsed = parseFinding(entry.content);
      if (parsed && matchesFilter(parsed, filter)) {
        findings.push(parsed);
      }
    }
    // Sort by severity (critical first), then by file path
    findings.sort((a, b) => {
      const severityDelta = severityRank(a.severity) - severityRank(b.severity);
      if (severityDelta !== 0) return severityDelta;
      return a.file.localeCompare(b.file);
    });
    return findings;
  }

  /** Delete a finding by its id. */
  delete(id: string): boolean {
    return this.memory.delete(`finding-${id}`);
  }

  /** Count findings (respects optional filter). */
  count(filter?: FindingsFilter): number {
    return this.list(filter).length;
  }

  /**
   * Produce a summary: counts by severity, category, and top files.
   * Used by the `brainstorm findings summary` command.
   */
  summary(filter?: FindingsFilter): FindingsSummary {
    const findings = this.list(filter);
    const bySeverity: Record<FindingSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    const byCategory: Record<string, number> = {};
    const byFileMap = new Map<string, number>();

    for (const f of findings) {
      bySeverity[f.severity]++;
      byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
      byFileMap.set(f.file, (byFileMap.get(f.file) ?? 0) + 1);
    }

    const byFile = Array.from(byFileMap.entries())
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const topCritical = findings
      .filter((f) => f.severity === "critical" || f.severity === "high")
      .slice(0, 10);

    return {
      total: findings.length,
      bySeverity,
      byCategory,
      byFile,
      topCritical,
    };
  }
}

function matchesFilter(
  finding: CodebaseFinding,
  filter?: FindingsFilter,
): boolean {
  if (!filter) return true;
  if (filter.severity !== undefined) {
    const severities = Array.isArray(filter.severity)
      ? filter.severity
      : [filter.severity];
    if (!severities.includes(finding.severity)) return false;
  }
  if (filter.category !== undefined) {
    const categories = Array.isArray(filter.category)
      ? filter.category
      : [filter.category];
    if (!categories.includes(finding.category as FindingCategory)) return false;
  }
  if (filter.file !== undefined) {
    if (!finding.file.includes(filter.file)) return false;
  }
  if (filter.discoveredBy !== undefined) {
    if (finding.discoveredBy !== filter.discoveredBy) return false;
  }
  if (filter.query !== undefined) {
    const q = filter.query.toLowerCase();
    const haystack =
      `${finding.title} ${finding.description} ${finding.file}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

// Re-export the types for consumers
export { FINDING_MARKER } from "./types.js";
export type {
  CodebaseFinding,
  FindingSeverity,
  FindingCategory,
} from "./types.js";
