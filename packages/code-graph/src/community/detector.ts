/**
 * Community Detection — groups related code using Louvain algorithm.
 *
 * Builds a graphology graph from the nodes/edges tables, runs Louvain
 * community detection, then writes community assignments back to the DB.
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { CodeGraph } from "../graph.js";
import { nameCommunity } from "./namer.js";
import { classifySectorTier, type SectorProfile } from "./sector-profile.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("community-detect");

export interface DetectionResult {
  communities: SectorProfile[];
  totalNodes: number;
  modularity: number;
}

/**
 * Detect communities in the code graph using Louvain algorithm.
 * Writes results to the communities table and updates nodes with community_id.
 */
export function detectCommunities(graph: CodeGraph): DetectionResult {
  const db = graph.getDb();

  // Load nodes and edges into a graphology graph
  const g = new Graph({ type: "undirected" });

  const nodes = db
    .prepare(
      "SELECT id, kind, name, file, language FROM nodes WHERE kind != 'file'",
    )
    .all() as Array<{
    id: string;
    kind: string;
    name: string;
    file: string;
    language: string | null;
  }>;

  if (nodes.length === 0) {
    return { communities: [], totalNodes: 0, modularity: 0 };
  }

  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (!nodeIds.has(node.id)) {
      g.addNode(node.id, {
        name: node.name,
        kind: node.kind,
        file: node.file,
        language: node.language,
      });
      nodeIds.add(node.id);
    }
  }

  const edges = db
    .prepare("SELECT source_id, target_id, kind FROM edges")
    .all() as Array<{ source_id: string; target_id: string; kind: string }>;

  for (const edge of edges) {
    if (nodeIds.has(edge.source_id) && nodeIds.has(edge.target_id)) {
      // Avoid duplicate edges in undirected graph
      if (!g.hasEdge(edge.source_id, edge.target_id)) {
        try {
          g.addEdge(edge.source_id, edge.target_id, { kind: edge.kind });
        } catch {
          // Edge may already exist or self-loop
        }
      }
    }
  }

  // Skip community detection if graph is too small or disconnected
  if (g.order < 3 || g.size === 0) {
    log.info(
      { nodes: g.order, edges: g.size },
      "Graph too small for community detection",
    );
    return { communities: [], totalNodes: g.order, modularity: 0 };
  }

  // Run Louvain (detailed returns communities + modularity)
  const detailed = louvain.detailed(g);
  const communityMap = detailed.communities;
  const modularity = detailed.modularity ?? 0;

  // Group nodes by community
  const communityNodes = new Map<string, string[]>();
  for (const [nodeId, communityId] of Object.entries(communityMap)) {
    const key = String(communityId);
    const existing = communityNodes.get(key) ?? [];
    existing.push(nodeId);
    communityNodes.set(key, existing);
  }

  // Build community profiles
  const profiles: SectorProfile[] = [];

  // Clear old communities
  db.prepare("DELETE FROM communities").run();
  db.prepare("UPDATE nodes SET community_id = NULL").run();

  const insertCommunity = db.prepare(
    "INSERT INTO communities (id, name, node_count, complexity_score, metadata_json) VALUES (?, ?, ?, ?, ?)",
  );
  const updateNode = db.prepare(
    "UPDATE nodes SET community_id = ? WHERE id = ?",
  );

  const tx = db.transaction(() => {
    for (const [communityId, memberIds] of communityNodes) {
      // Get node details for naming and profiling
      const members = memberIds.map((id) => {
        const attrs = g.getNodeAttributes(id);
        return {
          id,
          name: attrs.name,
          kind: attrs.kind,
          file: attrs.file,
          language: attrs.language,
        };
      });

      const name = nameCommunity(members);
      const profile = classifySectorTier(members, db);
      const id = `community-${communityId}`;

      profiles.push({
        ...profile,
        id,
        name,
        nodeIds: memberIds,
        nodeCount: memberIds.length,
      });

      insertCommunity.run(
        id,
        name,
        memberIds.length,
        profile.complexityScore,
        JSON.stringify({
          tier: profile.tier,
          dominantLanguage: profile.dominantLanguage,
          keywords: profile.keywords,
          files: profile.files,
        }),
      );

      for (const nodeId of memberIds) {
        updateNode.run(id, nodeId);
      }
    }
  });
  tx();

  log.info(
    {
      communities: profiles.length,
      nodes: nodes.length,
      modularity,
    },
    "Community detection complete",
  );

  return {
    communities: profiles,
    totalNodes: nodes.length,
    modularity,
  };
}
