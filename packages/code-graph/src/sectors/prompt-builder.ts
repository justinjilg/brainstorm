/**
 * Sector Prompt Builder — generates sector-specific system prompts.
 *
 * Each sector agent gets context about its territory: which files it owns,
 * key functions, complexity profile, neighboring sectors, and its role.
 */

import type { SectorProfile } from "../community/sector-profile.js";
import type { CodeGraph } from "../graph.js";

/**
 * Build a system prompt addendum for a sector agent.
 * This is appended to the base agent system prompt.
 */
export function buildSectorPrompt(
  sector: SectorProfile,
  graph: CodeGraph,
): string {
  const db = graph.getDb();

  // Get top functions by call count
  const hotFunctions = db
    .prepare(
      `
    SELECT n.name, n.kind, n.file,
      (SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id AND e.kind = 'calls') AS callerCount
    FROM nodes n
    WHERE n.community_id = ? AND n.kind IN ('function', 'method')
    ORDER BY callerCount DESC
    LIMIT 10
  `,
    )
    .all(sector.id) as Array<{
    name: string;
    kind: string;
    file: string;
    callerCount: number;
  }>;

  // Get neighboring sectors (communities connected by edges)
  const neighbors = db
    .prepare(
      `
    SELECT DISTINCT c.id, c.name
    FROM edges e
    JOIN nodes n1 ON n1.id = e.source_id
    JOIN nodes n2 ON n2.id = e.target_id
    JOIN communities c ON c.id = n2.community_id
    WHERE n1.community_id = ? AND n2.community_id != ?
    LIMIT 5
  `,
    )
    .all(sector.id, sector.id) as Array<{ id: string; name: string }>;

  const lines = [
    `## Your Sector: ${sector.name}`,
    "",
    `**Tier:** ${sector.tier} | **Complexity:** ${sector.complexityScore.toFixed(1)}/10 | **Language:** ${sector.dominantLanguage}`,
    `**Files:** ${sector.files.length} | **Nodes:** ${sector.nodeCount}`,
    "",
    "### Key Functions",
    ...hotFunctions.map(
      (f) =>
        `- \`${f.name}\` (${f.kind}, ${f.callerCount} callers) — ${f.file}`,
    ),
    "",
    "### Your Files",
    ...sector.files.slice(0, 20).map((f) => `- ${f}`),
    ...(sector.files.length > 20
      ? [`- ... and ${sector.files.length - 20} more`]
      : []),
  ];

  if (neighbors.length > 0) {
    lines.push(
      "",
      "### Connected Sectors",
      ...neighbors.map((n) => `- ${n.name}`),
    );
  }

  if (sector.keywords.length > 0) {
    lines.push("", `**Domain keywords:** ${sector.keywords.join(", ")}`);
  }

  lines.push(
    "",
    "### Your Responsibilities",
    "- Own the code quality and correctness of all files in this sector",
    "- Monitor for regressions when connected sectors change",
    "- Propose improvements based on complexity hotspots",
    "- Keep your sector plan updated with current objectives",
    `- Use code intelligence tools (code_impact, code_callers, code_search) to understand blast radius before making changes`,
  );

  return lines.join("\n");
}

/**
 * Generate a .agent.md file content for a sector agent.
 * Fits into AgentManager.loadFromFiles() pattern.
 */
export function generateSectorAgentMd(
  sector: SectorProfile,
  graph: CodeGraph,
): string {
  const prompt = buildSectorPrompt(sector, graph);

  return [
    "---",
    `name: sector-${sector.id}`,
    `description: Sector agent for ${sector.name} (${sector.tier} tier, ${sector.nodeCount} nodes)`,
    `model: ${sector.tier === "critical" ? "quality" : sector.tier === "simple" ? "cheap" : "capable"}`,
    `tools: ["file_read", "file_write", "file_edit", "glob", "grep", "git_status", "git_diff", "code_search", "code_impact", "code_callers", "code_callees", "code_communities"]`,
    `max_steps: ${sector.tier === "critical" ? 15 : sector.tier === "complex" ? 10 : 5}`,
    `role: coder`,
    "---",
    "",
    prompt,
  ].join("\n");
}
