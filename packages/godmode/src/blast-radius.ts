/**
 * Blast Radius Computation — maps code changes to affected symbols and sectors.
 *
 * When a ChangeSet simulation runs, this module queries the code knowledge graph
 * to compute the structural blast radius: what functions are transitively affected,
 * which community sectors are impacted, and what the risk multiplier is.
 *
 * Critical sectors (auth, crypto, parsing) multiply the risk score.
 */

import type { BlastRadius } from "./types.js";
import { createLogger } from "@brainst0rm/shared";

/** Escape SQL LIKE wildcards to prevent unintended pattern matching. */
function escapeLike(s: string): string {
  return s.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const log = createLogger("blast-radius");

/** Tier-based risk multipliers. */
const TIER_RISK: Record<string, number> = {
  critical: 3.0,
  complex: 1.5,
  standard: 1.0,
  simple: 0.5,
};

/**
 * Compute blast radius for a set of changed files using the code graph.
 *
 * The graph parameter is duck-typed to avoid a hard dependency on @brainst0rm/code-graph.
 * It needs: getDb(), impactAnalysis(), findDefinition()
 */
export function computeBlastRadius(
  changedFiles: string[],
  graph: {
    getDb: () => any;
    impactAnalysis: (
      name: string,
      maxDepth?: number,
    ) => Array<{ name: string; depth: number; file: string }>;
    findDefinition: (name: string) => any[];
  },
  maxDepth = 3,
): BlastRadius {
  const db = graph.getDb();
  const allAffected = new Map<
    string,
    { name: string; file: string; depth: number }
  >();
  const affectedCommunityIds = new Set<string>();

  for (const file of changedFiles) {
    // Find all functions defined in this file
    const functions = db
      .prepare("SELECT name FROM functions WHERE file = ? OR file LIKE ?")
      .all(file, `%${escapeLike(file)}`) as Array<{ name: string }>;

    for (const fn of functions) {
      // Run impact analysis (transitive callers)
      const impact = graph.impactAnalysis(fn.name, maxDepth);
      for (const item of impact) {
        if (!allAffected.has(item.name)) {
          allAffected.set(item.name, item);
        }
      }
    }

    // Find which communities contain nodes in this file
    const communities = db
      .prepare(
        "SELECT DISTINCT community_id FROM nodes WHERE (file = ? OR file LIKE ?) AND community_id IS NOT NULL",
      )
      .all(file, `%${escapeLike(file)}`) as Array<{ community_id: string }>;

    for (const c of communities) {
      affectedCommunityIds.add(c.community_id);
    }
  }

  // Also find communities of transitively affected symbols
  for (const [, item] of allAffected) {
    const nodes = db
      .prepare(
        "SELECT community_id FROM nodes WHERE name = ? AND community_id IS NOT NULL",
      )
      .all(item.name) as Array<{ community_id: string }>;
    for (const n of nodes) {
      affectedCommunityIds.add(n.community_id);
    }
  }

  // Build community details
  const affectedCommunities: BlastRadius["affectedCommunities"] = [];
  for (const communityId of affectedCommunityIds) {
    const community = db
      .prepare("SELECT id, name, metadata_json FROM communities WHERE id = ?")
      .get(communityId) as
      | { id: string; name: string; metadata_json: string }
      | undefined;

    if (community) {
      let tier = "standard";
      try {
        const meta = JSON.parse(community.metadata_json);
        tier = meta.tier ?? "standard";
      } catch {
        /* ignore */
      }

      affectedCommunities.push({
        id: community.id,
        name: community.name ?? communityId,
        tier,
      });
    }
  }

  // Compute risk multiplier — max tier risk across all affected communities
  let riskMultiplier = 1.0;
  for (const c of affectedCommunities) {
    const tierRisk = TIER_RISK[c.tier] ?? 1.0;
    if (tierRisk > riskMultiplier) riskMultiplier = tierRisk;
  }

  const result: BlastRadius = {
    affectedSymbols: Array.from(allAffected.values()),
    affectedCommunities,
    riskMultiplier,
    totalAffected: allAffected.size,
  };

  log.debug(
    {
      changedFiles: changedFiles.length,
      totalAffected: result.totalAffected,
      communities: affectedCommunities.length,
      riskMultiplier,
    },
    "Blast radius computed",
  );

  return result;
}
