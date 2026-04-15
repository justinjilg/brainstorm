/**
 * Sector Profile — classifies communities by complexity tier.
 *
 * Tier mapping uses BR's existing Complexity and QualityTier types:
 *   critical → Complexity: "expert",   QualityTier: 1
 *   complex  → Complexity: "complex",  QualityTier: 2
 *   standard → Complexity: "moderate", QualityTier: 3
 *   simple   → Complexity: "simple",   QualityTier: 5
 */

import type Database from "better-sqlite3";

export type SectorTier = "critical" | "complex" | "standard" | "simple";

export interface SectorProfile {
  id: string;
  name: string;
  tier: SectorTier;
  complexityScore: number;
  dominantLanguage: string;
  keywords: string[];
  files: string[];
  nodeIds: string[];
  nodeCount: number;
}

/** BR Complexity type mapping. */
export const TIER_TO_COMPLEXITY: Record<SectorTier, string> = {
  critical: "expert",
  complex: "complex",
  standard: "moderate",
  simple: "simple",
};

/** BR QualityTier mapping (1=best, 5=cheapest). */
export const TIER_TO_QUALITY: Record<SectorTier, number> = {
  critical: 1,
  complex: 2,
  standard: 3,
  simple: 5,
};

// Keywords that signal high-complexity sectors
const CRITICAL_KEYWORDS = new Set([
  "crypto",
  "cipher",
  "encrypt",
  "decrypt",
  "hash",
  "hmac",
  "sign",
  "verify",
  "auth",
  "authenticate",
  "authorize",
  "permission",
  "rbac",
  "oauth",
  "jwt",
  "token",
  "parse",
  "parser",
  "ast",
  "lexer",
  "tokenize",
  "compiler",
  "codegen",
  "state",
  "machine",
  "fsm",
  "transition",
  "automaton",
  "consensus",
  "raft",
  "paxos",
  "distributed",
  "security",
  "sanitize",
  "escape",
  "injection",
  "xss",
  "csrf",
]);

const SIMPLE_KEYWORDS = new Set([
  "config",
  "constant",
  "enum",
  "type",
  "interface",
  "model",
  "util",
  "helper",
  "format",
  "convert",
  "stringify",
  "test",
  "spec",
  "mock",
  "fixture",
  "stub",
  "readme",
  "doc",
  "example",
  "demo",
  "crud",
  "list",
  "create",
  "update",
  "delete",
]);

interface NodeInfo {
  id: string;
  name: string;
  kind: string;
  file: string;
  language: string | null;
}

/**
 * Classify a community's complexity tier from its member nodes.
 */
export function classifySectorTier(
  members: NodeInfo[],
  db: Database.Database,
): Omit<SectorProfile, "id" | "name" | "nodeIds" | "nodeCount"> {
  // Count languages
  const langCounts = new Map<string, number>();
  for (const m of members) {
    const lang = m.language ?? "unknown";
    langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
  }
  const dominantLanguage =
    [...langCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

  // Unique files
  const files = [...new Set(members.map((m) => m.file))];

  // Extract keywords from function/method names
  const allKeywords: string[] = [];
  for (const m of members) {
    const stems = m.name
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[_\-.]/)
      .filter((s) => s.length > 2);
    allKeywords.push(...stems);
  }

  // Check for critical/simple signals
  const criticalHits = allKeywords.filter((k) =>
    CRITICAL_KEYWORDS.has(k),
  ).length;
  const simpleHits = allKeywords.filter((k) => SIMPLE_KEYWORDS.has(k)).length;

  // Compute complexity score from call edge density
  let avgInDegree = 0;
  if (members.length > 0) {
    const memberIds = members.map((m) => m.id);
    const placeholders = memberIds.map(() => "?").join(",");
    const edgeCount =
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM edges WHERE target_id IN (${placeholders})`,
          )
          .get(...memberIds) as any
      )?.c ?? 0;
    avgInDegree = edgeCount / members.length;
  }

  // Calculate complexity score (0-10)
  const keywordScore =
    Math.min(5, criticalHits * 1.5) - Math.min(3, simpleHits * 0.5);
  const densityScore = Math.min(5, avgInDegree);
  const complexityScore = Math.max(
    0,
    Math.min(10, keywordScore + densityScore),
  );

  // Classify tier
  let tier: SectorTier;
  if (criticalHits >= 3 || complexityScore >= 7) {
    tier = "critical";
  } else if (complexityScore >= 4 || criticalHits >= 1) {
    tier = "complex";
  } else if (simpleHits >= 3 || complexityScore <= 1.5) {
    tier = "simple";
  } else {
    tier = "standard";
  }

  // Deduplicate keywords for the profile
  const uniqueKeywords = [...new Set(allKeywords)]
    .filter((k) => CRITICAL_KEYWORDS.has(k) || SIMPLE_KEYWORDS.has(k))
    .slice(0, 10);

  return {
    tier,
    complexityScore,
    dominantLanguage,
    keywords: uniqueKeywords,
    files,
  };
}
