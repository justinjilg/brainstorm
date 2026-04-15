/**
 * Work Plan Generator — produces a structured plan for how Brainstorm
 * will orchestrate work on a codebase.
 *
 * Input: an indexed code graph with communities detected.
 * Output: a markdown work plan that reads like a senior engineer's
 * project brief — what the codebase is, where the risks are, what
 * needs attention first, and how agents will execute.
 *
 * This is the bridge between "index" and "daemon runs." The user
 * sees the plan before agents start working.
 */

import type { CodeGraph } from "../graph.js";
import {
  TIER_TO_COMPLEXITY,
  TIER_TO_QUALITY,
} from "../community/sector-profile.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("work-plan");

export interface WorkPlan {
  markdown: string;
  overview: ProjectOverview;
  sectors: SectorBrief[];
  risks: RiskAssessment;
  workItems: WorkItem[];
  orchestration: OrchestrationStrategy;
}

export interface ProjectOverview {
  name: string;
  files: number;
  functions: number;
  classes: number;
  languages: Array<{ language: string; nodes: number; percent: number }>;
  totalNodes: number;
  totalEdges: number;
  sectorCount: number;
}

export interface SectorBrief {
  name: string;
  tier: string;
  complexity: number;
  nodeCount: number;
  files: string[];
  hotFunctions: Array<{ name: string; callerCount: number }>;
  keywords: string[];
  modelTier: string;
  budgetPerTick: number;
}

export interface RiskAssessment {
  hotspots: Array<{ name: string; callerCount: number; file: string }>;
  highBlastRadius: Array<{ name: string; affectedCount: number }>;
  criticalSectors: string[];
  isolatedNodes: number;
  crossSectorEdges: number;
}

export interface WorkItem {
  id: string;
  sector: string;
  tier: string;
  priority: number;
  description: string;
  rationale: string;
  estimatedTicks: number;
  modelTier: string;
}

export interface OrchestrationStrategy {
  totalSectors: number;
  agentCount: number;
  tickRotation: string;
  estimatedTotalTicks: number;
  budgetEstimate: number;
  phaseBreakdown: Array<{
    phase: string;
    sectors: string[];
    description: string;
  }>;
}

/**
 * Generate a work plan from an indexed code graph.
 */
export function generateWorkPlan(
  graph: CodeGraph,
  projectName?: string,
): WorkPlan {
  const db = graph.getDb();
  const stats = graph.extendedStats();
  const name = projectName ?? "project";

  // ── Overview ────────────────────────────────────────────────────

  const languages = db
    .prepare(
      "SELECT language, COUNT(*) AS count FROM nodes WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC",
    )
    .all() as Array<{ language: string; count: number }>;
  const totalLangNodes = languages.reduce((s, l) => s + l.count, 0);

  const overview: ProjectOverview = {
    name,
    files: stats.files,
    functions: stats.functions,
    classes: stats.classes,
    languages: languages.map((l) => ({
      language: l.language,
      nodes: l.count,
      percent:
        totalLangNodes > 0 ? Math.round((l.count / totalLangNodes) * 100) : 0,
    })),
    totalNodes: stats.nodes,
    totalEdges: stats.graphEdges,
    sectorCount: stats.communities,
  };

  // ── Sector Briefs ───────────────────────────────────────────────

  const communities = graph.getCommunities();
  const sectors: SectorBrief[] = [];

  for (const c of communities) {
    const nodes = graph.getNodesInCommunity(c.id);
    if (nodes.length < 3) continue; // skip tiny sectors

    let tier = "standard";
    let keywords: string[] = [];
    try {
      const meta = db
        .prepare("SELECT metadata_json FROM communities WHERE id = ?")
        .get(c.id) as any;
      if (meta?.metadata_json) {
        const parsed = JSON.parse(meta.metadata_json);
        tier = parsed.tier ?? "standard";
        keywords = parsed.keywords ?? [];
      }
    } catch {}

    // Top functions by caller count
    const memberNames = nodes
      .filter((n) => n.kind === "function" || n.kind === "method")
      .map((n) => n.name);
    const hotFunctions: SectorBrief["hotFunctions"] = [];
    for (const fname of memberNames.slice(0, 50)) {
      const count =
        (
          db
            .prepare("SELECT COUNT(*) AS c FROM call_edges WHERE callee = ?")
            .get(fname) as any
        )?.c ?? 0;
      if (count > 0) hotFunctions.push({ name: fname, callerCount: count });
    }
    hotFunctions.sort((a, b) => b.callerCount - a.callerCount);

    const files = [...new Set(nodes.map((n) => n.file))];
    const modelTier =
      tier === "critical"
        ? "quality (Opus-tier)"
        : tier === "complex"
          ? "capable (Sonnet-tier)"
          : tier === "simple"
            ? "cheap (Haiku-tier)"
            : "capable";
    const budgetPerTick =
      tier === "critical"
        ? 0.1
        : tier === "complex"
          ? 0.05
          : tier === "standard"
            ? 0.02
            : 0.01;

    sectors.push({
      name: c.name ?? c.id,
      tier,
      complexity: c.complexityScore ?? 0,
      nodeCount: nodes.length,
      files,
      hotFunctions: hotFunctions.slice(0, 5),
      keywords,
      modelTier,
      budgetPerTick,
    });
  }

  // Sort: critical first, then by complexity
  const tierOrder: Record<string, number> = {
    critical: 0,
    complex: 1,
    standard: 2,
    simple: 3,
  };
  sectors.sort(
    (a, b) =>
      (tierOrder[a.tier] ?? 4) - (tierOrder[b.tier] ?? 4) ||
      b.complexity - a.complexity,
  );

  // ── Risk Assessment ─────────────────────────────────────────────

  const hotspots = db
    .prepare(
      `
    SELECT ce.callee AS name, COUNT(*) AS callerCount, f.file
    FROM call_edges ce JOIN functions f ON f.name = ce.callee
    GROUP BY ce.callee, f.file ORDER BY callerCount DESC LIMIT 15
  `,
    )
    .all() as Array<{ name: string; callerCount: number; file: string }>;

  // Functions with deepest transitive impact
  const highBlastRadius: RiskAssessment["highBlastRadius"] = [];
  for (const h of hotspots.slice(0, 5)) {
    const impact = graph.impactAnalysis(h.name, 3);
    highBlastRadius.push({ name: h.name, affectedCount: impact.length });
  }

  const criticalSectors = sectors
    .filter((s) => s.tier === "critical")
    .map((s) => s.name);

  // Isolated nodes (no edges)
  const isolatedNodes =
    (
      db
        .prepare(
          `
    SELECT COUNT(*) AS c FROM nodes n
    WHERE n.kind != 'file'
    AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_id = n.id OR e.target_id = n.id)
  `,
        )
        .get() as any
    )?.c ?? 0;

  // Cross-sector edges
  const crossSectorEdges =
    (
      db
        .prepare(
          `
    SELECT COUNT(*) AS c FROM edges e
    JOIN nodes n1 ON n1.id = e.source_id
    JOIN nodes n2 ON n2.id = e.target_id
    WHERE n1.community_id IS NOT NULL AND n2.community_id IS NOT NULL
    AND n1.community_id != n2.community_id
  `,
        )
        .get() as any
    )?.c ?? 0;

  const risks: RiskAssessment = {
    hotspots,
    highBlastRadius,
    criticalSectors,
    isolatedNodes,
    crossSectorEdges,
  };

  // ── Work Items ──────────────────────────────────────────────────

  const workItems: WorkItem[] = [];
  let itemId = 1;

  for (const sector of sectors) {
    // Every sector gets an audit
    workItems.push({
      id: `WI-${String(itemId++).padStart(3, "0")}`,
      sector: sector.name,
      tier: sector.tier,
      priority:
        sector.tier === "critical"
          ? 1
          : sector.tier === "complex"
            ? 2
            : sector.tier === "standard"
              ? 3
              : 4,
      description: `Audit ${sector.name}: review ${sector.files.length} files for code quality, dead code, error handling gaps`,
      rationale: `${sector.tier} sector with complexity ${sector.complexity.toFixed(1)}/10 and ${sector.nodeCount} nodes`,
      estimatedTicks: Math.ceil(sector.files.length / 3),
      modelTier: sector.modelTier,
    });

    // Critical/complex sectors get simplification review
    if (sector.tier === "critical" || sector.tier === "complex") {
      workItems.push({
        id: `WI-${String(itemId++).padStart(3, "0")}`,
        sector: sector.name,
        tier: sector.tier,
        priority: sector.tier === "critical" ? 2 : 3,
        description: `Simplify hotspots in ${sector.name}: ${sector.hotFunctions
          .slice(0, 3)
          .map((f) => f.name)
          .join(", ")}`,
        rationale: `Top functions have ${sector.hotFunctions[0]?.callerCount ?? 0}+ callers — high blast radius`,
        estimatedTicks: sector.hotFunctions.length,
        modelTier: sector.modelTier,
      });
    }

    // Every sector gets test coverage review
    workItems.push({
      id: `WI-${String(itemId++).padStart(3, "0")}`,
      sector: sector.name,
      tier: sector.tier,
      priority: sector.tier === "critical" ? 2 : 4,
      description: `Test coverage review for ${sector.name}: identify critical paths without tests`,
      rationale: `${sector.hotFunctions.length} key functions need coverage verification`,
      estimatedTicks: Math.ceil(sector.hotFunctions.length / 2),
      modelTier: sector.modelTier,
    });
  }

  workItems.sort((a, b) => a.priority - b.priority);

  // ── Orchestration Strategy ──────────────────────────────────────

  const agentCount = sectors.length;
  const totalTicks = workItems.reduce((s, w) => s + w.estimatedTicks, 0);
  const totalBudget = sectors.reduce(
    (s, sec) => s + sec.budgetPerTick * Math.ceil(sec.files.length / 3),
    0,
  );

  const phases: OrchestrationStrategy["phaseBreakdown"] = [
    {
      phase: "1. Critical Sector Audit",
      sectors: sectors.filter((s) => s.tier === "critical").map((s) => s.name),
      description:
        "Audit critical sectors first — auth, crypto, parsers. Use quality-tier models. Highest priority.",
    },
    {
      phase: "2. Complex Sector Review",
      sectors: sectors.filter((s) => s.tier === "complex").map((s) => s.name),
      description:
        "Review complex business logic. Simplify hotspots. Use capable-tier models.",
    },
    {
      phase: "3. Standard Sector Sweep",
      sectors: sectors.filter((s) => s.tier === "standard").map((s) => s.name),
      description:
        "Standard code quality pass. Use capable-tier models with lower budgets.",
    },
    {
      phase: "4. Simple Sector Cleanup",
      sectors: sectors.filter((s) => s.tier === "simple").map((s) => s.name),
      description:
        "Quick pass on utils, config, tests. Use cheap-tier models. Fast execution.",
    },
  ].filter((p) => p.sectors.length > 0);

  const orchestration: OrchestrationStrategy = {
    totalSectors: sectors.length,
    agentCount,
    tickRotation:
      "Round-robin by oldest lastTickAt — ensures every sector gets attention. Critical sectors get more budget per tick.",
    estimatedTotalTicks: totalTicks,
    budgetEstimate: totalBudget,
    phaseBreakdown: phases,
  };

  // ── Generate Markdown ───────────────────────────────────────────

  const markdown = renderMarkdown(
    overview,
    sectors,
    risks,
    workItems,
    orchestration,
  );

  log.info(
    {
      sectors: sectors.length,
      workItems: workItems.length,
      estimatedTicks: totalTicks,
      budgetEstimate: totalBudget.toFixed(4),
    },
    "Work plan generated",
  );

  return { markdown, overview, sectors, risks, workItems, orchestration };
}

// ── Markdown Rendering ──────────────────────────────────────────

function renderMarkdown(
  overview: ProjectOverview,
  sectors: SectorBrief[],
  risks: RiskAssessment,
  workItems: WorkItem[],
  orchestration: OrchestrationStrategy,
): string {
  const lines: string[] = [];

  // Header
  lines.push(
    `# Work Plan: ${overview.name}`,
    "",
    `> Auto-generated by Brainstorm Code Intelligence Engine`,
    "",
  );

  // Overview
  lines.push(
    "## 1. Codebase Overview",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Files | ${overview.files} |`,
    `| Functions | ${overview.functions} |`,
    `| Classes | ${overview.classes} |`,
    `| Graph Nodes | ${overview.totalNodes} |`,
    `| Graph Edges | ${overview.totalEdges.toLocaleString()} |`,
    `| Code Sectors | ${overview.sectorCount} |`,
    "",
  );

  if (overview.languages.length > 0) {
    lines.push(
      "**Languages:**",
      ...overview.languages.map(
        (l) => `- ${l.language}: ${l.nodes} nodes (${l.percent}%)`,
      ),
      "",
    );
  }

  // Risk Assessment
  lines.push("## 2. Risk Assessment", "");

  if (risks.criticalSectors.length > 0) {
    lines.push(
      `**Critical sectors** (require quality-tier models):`,
      ...risks.criticalSectors.map((s) => `- ${s}`),
      "",
    );
  }

  lines.push(
    "**Hotspots** (most depended-on functions — changes here break the most things):",
    "",
    "| Function | Callers | Blast Radius | File |",
    "|----------|---------|-------------|------|",
  );
  for (const h of risks.hotspots.slice(0, 10)) {
    const blast = risks.highBlastRadius.find((b) => b.name === h.name);
    lines.push(
      `| \`${h.name}\` | ${h.callerCount} | ${blast ? blast.affectedCount + " affected" : "-"} | \`${h.file.split("/").slice(-2).join("/")}\` |`,
    );
  }
  lines.push(
    "",
    `**Isolated nodes:** ${risks.isolatedNodes} (no connections — potential dead code)`,
    `**Cross-sector edges:** ${risks.crossSectorEdges} (coupling between sectors)`,
    "",
  );

  // Sector Breakdown
  lines.push(
    "## 3. Sector Breakdown",
    "",
    `${sectors.length} sectors detected via Louvain community detection, classified by complexity:`,
    "",
  );

  for (const sector of sectors) {
    const tierEmoji: Record<string, string> = {
      critical: "🔴",
      complex: "🟠",
      standard: "🟡",
      simple: "🟢",
    };
    lines.push(
      `### ${tierEmoji[sector.tier] ?? "⚪"} ${sector.name}`,
      "",
      `**Tier:** ${sector.tier} | **Complexity:** ${sector.complexity.toFixed(1)}/10 | **Nodes:** ${sector.nodeCount} | **Files:** ${sector.files.length}`,
      `**Model:** ${sector.modelTier} | **Budget/tick:** $${sector.budgetPerTick.toFixed(2)}`,
      "",
    );

    if (sector.hotFunctions.length > 0) {
      lines.push(
        "Key functions:",
        ...sector.hotFunctions.map(
          (f) => `- \`${f.name}\` (${f.callerCount} callers)`,
        ),
        "",
      );
    }

    if (sector.keywords.length > 0) {
      lines.push(`Domain: ${sector.keywords.join(", ")}`, "");
    }

    lines.push(
      "Files:",
      ...sector.files
        .slice(0, 8)
        .map((f) => `- \`${f.split("/").slice(-3).join("/")}\``),
      ...(sector.files.length > 8
        ? [`- ... and ${sector.files.length - 8} more`]
        : []),
      "",
    );
  }

  // Work Items
  lines.push(
    "## 4. Work Items",
    "",
    `${workItems.length} items across ${sectors.length} sectors, ordered by priority:`,
    "",
    "| ID | Priority | Sector | Description | Ticks | Model |",
    "|-----|----------|--------|-------------|-------|-------|",
  );

  for (const item of workItems) {
    lines.push(
      `| ${item.id} | P${item.priority} | ${item.sector} | ${item.description} | ${item.estimatedTicks} | ${item.modelTier.split(" ")[0]} |`,
    );
  }
  lines.push("");

  // Orchestration Strategy
  lines.push(
    "## 5. Orchestration Strategy",
    "",
    `**Agents:** ${orchestration.agentCount} sector agents`,
    `**Total estimated ticks:** ${orchestration.estimatedTotalTicks}`,
    `**Estimated budget:** $${orchestration.budgetEstimate.toFixed(4)}`,
    `**Tick rotation:** ${orchestration.tickRotation}`,
    "",
    "### Execution Phases",
    "",
  );

  for (const phase of orchestration.phaseBreakdown) {
    lines.push(
      `**${phase.phase}**`,
      phase.description,
      `Sectors: ${phase.sectors.join(", ") || "none"}`,
      "",
    );
  }

  lines.push(
    "## 6. How to Execute",
    "",
    "```bash",
    "# Run the daemon with sector intelligence",
    "brainstorm chat --daemon",
    "",
    "# The daemon will:",
    "# 1. Index the codebase (if not already done)",
    "# 2. Detect sectors and assign agents",
    "# 3. Create persistent plans per sector",
    "# 4. Rotate through sectors, working on objectives",
    "# 5. Use quality-tier models for critical sectors, cheap for simple",
    "# 6. Record progress to SQLite (survives restarts)",
    "```",
    "",
    "*Generated by Brainstorm Code Intelligence Engine*",
  );

  return lines.join("\n");
}
