/**
 * Graph-Aware Documentation — generates docs from the code knowledge graph.
 *
 * Produces:
 * - Call graph Mermaid diagrams for top connected functions
 * - Community/sector map showing relationships between code clusters
 * - Per-community summaries with key functions and complexity
 * - Hotspot report (most depended-on symbols)
 */

export interface GraphDoc {
  markdown: string;
  callGraphMermaid: string;
  communityMapMermaid: string;
  communityCount: number;
  hotspotCount: number;
}

/**
 * Graph interface — duck-typed to avoid hard dependency on @brainst0rm/code-graph.
 */
interface GraphLike {
  getDb(): any;
  extendedStats(): {
    files: number;
    functions: number;
    classes: number;
    methods: number;
    nodes: number;
    graphEdges: number;
    communities: number;
    callEdges: number;
  };
  getCommunities(): Array<{
    id: string;
    name: string | null;
    nodeCount: number;
    complexityScore: number | null;
  }>;
  getNodesInCommunity(id: string): Array<{
    id: string;
    kind: string;
    name: string;
    file: string;
  }>;
}

/**
 * Generate graph-aware documentation.
 */
export function generateGraphDoc(graph: GraphLike): GraphDoc {
  const stats = graph.extendedStats();
  const communities = graph.getCommunities();
  const db = graph.getDb();

  // ── Call Graph Mermaid ──────────────────────────────────────────

  // Get top 20 most-connected functions for the call graph
  const hotspots = db
    .prepare(
      `
    SELECT
      ce.callee AS name,
      COUNT(*) AS callerCount,
      f.file
    FROM call_edges ce
    JOIN functions f ON f.name = ce.callee
    GROUP BY ce.callee, f.file
    ORDER BY callerCount DESC
    LIMIT 20
  `,
    )
    .all() as Array<{ name: string; callerCount: number; file: string }>;

  // Build call graph edges for the top functions
  const topNames = new Set(hotspots.map((h) => h.name));
  const callEdges = db
    .prepare(
      `
    SELECT DISTINCT caller, callee
    FROM call_edges
    WHERE caller IN (${hotspots.map(() => "?").join(",")})
       OR callee IN (${hotspots.map(() => "?").join(",")})
    LIMIT 100
  `,
    )
    .all(
      ...hotspots.map((h) => h.name),
      ...hotspots.map((h) => h.name),
    ) as Array<{ caller: string | null; callee: string }>;

  const callGraphLines = ["graph LR"];
  const seenEdges = new Set<string>();
  for (const edge of callEdges) {
    if (!edge.caller) continue;
    const key = `${edge.caller}-->${edge.callee}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    // Sanitize for Mermaid (remove dots, special chars)
    const from = sanitizeMermaidId(edge.caller);
    const to = sanitizeMermaidId(edge.callee);
    callGraphLines.push(`  ${from} --> ${to}`);
  }
  const callGraphMermaid = callGraphLines.join("\n");

  // ── Community Map Mermaid ──────────────────────────────────────

  const communityMapLines = ["graph TB"];

  // Subgraph per community
  for (const community of communities) {
    const nodes = graph.getNodesInCommunity(community.id);
    const safeName = sanitizeMermaidId(community.name ?? community.id);
    const label = community.name ?? community.id;

    // Parse tier from metadata
    let tier = "standard";
    try {
      const meta = db
        .prepare("SELECT metadata_json FROM communities WHERE id = ?")
        .get(community.id) as any;
      if (meta?.metadata_json) {
        const parsed = JSON.parse(meta.metadata_json);
        tier = parsed.tier ?? "standard";
      }
    } catch {
      /* ignore */
    }

    communityMapLines.push(
      `  subgraph ${safeName}["${label} (${tier}, ${nodes.length} nodes)"]`,
    );

    // Show top 5 functions in the community
    const topFunctions = nodes
      .filter((n) => n.kind === "function" || n.kind === "method")
      .slice(0, 5);

    for (const fn of topFunctions) {
      const fnId = sanitizeMermaidId(`${safeName}_${fn.name}`);
      communityMapLines.push(`    ${fnId}["${fn.name}"]`);
    }

    communityMapLines.push("  end");
  }

  // Cross-community edges
  if (communities.length > 1) {
    const crossEdges = db
      .prepare(
        `
      SELECT DISTINCT n1.community_id AS from_community, n2.community_id AS to_community
      FROM edges e
      JOIN nodes n1 ON n1.id = e.source_id
      JOIN nodes n2 ON n2.id = e.target_id
      WHERE n1.community_id IS NOT NULL
        AND n2.community_id IS NOT NULL
        AND n1.community_id != n2.community_id
      LIMIT 50
    `,
      )
      .all() as Array<{ from_community: string; to_community: string }>;

    const seenCrossEdges = new Set<string>();
    for (const edge of crossEdges) {
      const key = `${edge.from_community}->${edge.to_community}`;
      if (seenCrossEdges.has(key)) continue;
      seenCrossEdges.add(key);

      const fromName =
        communities.find((c) => c.id === edge.from_community)?.name ??
        edge.from_community;
      const toName =
        communities.find((c) => c.id === edge.to_community)?.name ??
        edge.to_community;
      communityMapLines.push(
        `  ${sanitizeMermaidId(fromName)} -.-> ${sanitizeMermaidId(toName)}`,
      );
    }
  }

  const communityMapMermaid = communityMapLines.join("\n");

  // ── Markdown Assembly ──────────────────────────────────────────

  const sections: string[] = [
    "# Code Intelligence Report",
    "",
    "## Graph Statistics",
    "",
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Files | ${stats.files} |`,
    `| Functions | ${stats.functions} |`,
    `| Classes | ${stats.classes} |`,
    `| Methods | ${stats.methods} |`,
    `| Graph Nodes | ${stats.nodes} |`,
    `| Graph Edges | ${stats.graphEdges} |`,
    `| Call Edges | ${stats.callEdges} |`,
    `| Communities | ${stats.communities} |`,
    "",
  ];

  // Languages
  const languages = db
    .prepare(
      "SELECT language, COUNT(*) AS count FROM nodes WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC",
    )
    .all() as Array<{ language: string; count: number }>;

  if (languages.length > 0) {
    sections.push(
      "## Languages",
      "",
      ...languages.map((l) => `- **${l.language}**: ${l.count} nodes`),
      "",
    );
  }

  // Community summaries
  if (communities.length > 0) {
    sections.push("## Code Sectors", "");

    for (const community of communities) {
      let tier = "standard";
      let keywords: string[] = [];
      try {
        const meta = db
          .prepare("SELECT metadata_json FROM communities WHERE id = ?")
          .get(community.id) as any;
        if (meta?.metadata_json) {
          const parsed = JSON.parse(meta.metadata_json);
          tier = parsed.tier ?? "standard";
          keywords = parsed.keywords ?? [];
        }
      } catch {
        /* ignore */
      }

      const nodes = graph.getNodesInCommunity(community.id);
      const files = [...new Set(nodes.map((n) => n.file))];

      sections.push(
        `### ${community.name ?? community.id}`,
        "",
        `**Tier:** ${tier} | **Nodes:** ${community.nodeCount} | **Complexity:** ${(community.complexityScore ?? 0).toFixed(1)}/10`,
        "",
      );

      if (keywords.length > 0) {
        sections.push(`**Keywords:** ${keywords.join(", ")}`, "");
      }

      sections.push(
        "**Files:**",
        ...files.slice(0, 10).map((f) => `- ${f}`),
        ...(files.length > 10 ? [`- ... and ${files.length - 10} more`] : []),
        "",
      );
    }
  }

  // Hotspots
  if (hotspots.length > 0) {
    sections.push(
      "## Hotspots (Most Depended-On Functions)",
      "",
      "| Rank | Function | Callers | File |",
      "|------|----------|---------|------|",
      ...hotspots
        .slice(0, 15)
        .map(
          (h, i) =>
            `| ${i + 1} | \`${h.name}\` | ${h.callerCount} | ${h.file} |`,
        ),
      "",
    );
  }

  // Call graph
  sections.push(
    "## Call Graph (Top Functions)",
    "",
    "```mermaid",
    callGraphMermaid,
    "```",
    "",
  );

  // Community map
  if (communities.length > 0) {
    sections.push(
      "## Sector Map",
      "",
      "```mermaid",
      communityMapMermaid,
      "```",
      "",
    );
  }

  return {
    markdown: sections.join("\n"),
    callGraphMermaid,
    communityMapMermaid,
    communityCount: communities.length,
    hotspotCount: hotspots.length,
  };
}

function sanitizeMermaidId(s: string): string {
  return (
    s
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^_+/, "")
      .replace(/_+$/, "") || "unnamed"
  );
}
