/**
 * Obsidian Vault Generator — projects the code knowledge graph into
 * an Obsidian-compatible folder of linked Markdown notes.
 *
 * Structure:
 *   vault/
 *   ├── README.md                    (vault overview with stats)
 *   ├── Sectors/
 *   │   ├── sector-name.md           (community overview with members)
 *   │   └── ...
 *   ├── Functions/
 *   │   ├── functionName.md          (callers, callees, community, source)
 *   │   └── ...
 *   ├── Classes/
 *   │   ├── ClassName.md             (methods, inheritance)
 *   │   └── ...
 *   ├── Hotspots.md                  (most connected functions)
 *   ├── Sector Map.md                (Mermaid diagram of all sectors)
 *   └── Analytics.md                 (graph statistics)
 *
 * Every note uses [[wikilinks]] so Obsidian's graph view shows
 * the structural relationships visually.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeGraph } from "../graph.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("obsidian-vault");

export interface VaultResult {
  vaultPath: string;
  notesWritten: number;
  sectors: number;
  functions: number;
  classes: number;
}

/**
 * Generate an Obsidian vault from the code knowledge graph.
 */
export function generateObsidianVault(
  graph: CodeGraph,
  outputPath: string,
): VaultResult {
  const db = graph.getDb();
  const stats = graph.extendedStats();

  // Create directory structure
  const sectorsDir = join(outputPath, "Sectors");
  const functionsDir = join(outputPath, "Functions");
  const classesDir = join(outputPath, "Classes");
  mkdirSync(sectorsDir, { recursive: true });
  mkdirSync(functionsDir, { recursive: true });
  mkdirSync(classesDir, { recursive: true });

  let notesWritten = 0;

  // ── Function Notes ──────────────────────────────────────────────

  const functions = db
    .prepare(
      `
    SELECT f.name, f.file, f.start_line, f.end_line, f.signature, f.exported,
           n.community_id, n.id AS node_id
    FROM functions f
    LEFT JOIN nodes n ON n.name = f.name AND n.file = f.file AND n.kind = 'function'
    ORDER BY f.name
  `,
    )
    .all() as any[];

  for (const fn of functions) {
    const callers = db
      .prepare(
        "SELECT DISTINCT caller FROM call_edges WHERE callee = ? AND caller IS NOT NULL LIMIT 20",
      )
      .all(fn.name) as any[];

    const callees = db
      .prepare(
        "SELECT DISTINCT callee FROM call_edges WHERE caller = ? LIMIT 20",
      )
      .all(fn.name) as any[];

    // Get community name
    let communityName: string | null = null;
    if (fn.community_id) {
      const comm = db
        .prepare("SELECT name FROM communities WHERE id = ?")
        .get(fn.community_id) as any;
      communityName = comm?.name ?? null;
    }

    const lines = [
      `---`,
      `type: function`,
      `file: "${fn.file}"`,
      `line: ${fn.start_line}`,
      `exported: ${fn.exported ? "true" : "false"}`,
      communityName ? `sector: "[[${safeName(communityName)}]]"` : null,
      `---`,
      "",
      `# ${fn.name}`,
      "",
      `**File:** \`${fn.file}:${fn.start_line}\``,
      fn.signature ? `**Signature:** \`${fn.signature.slice(0, 150)}\`` : null,
      communityName ? `**Sector:** [[${safeName(communityName)}]]` : null,
      "",
    ].filter(Boolean);

    if (callers.length > 0) {
      lines.push("## Called By", "");
      for (const c of callers) {
        lines.push(`- [[${safeName(c.caller)}]]`);
      }
      lines.push("");
    }

    if (callees.length > 0) {
      lines.push("## Calls", "");
      for (const c of callees) {
        lines.push(`- [[${safeName(c.callee)}]]`);
      }
      lines.push("");
    }

    const filePath = join(functionsDir, `${safeName(fn.name)}.md`);
    writeFileSync(filePath, lines.join("\n"), "utf-8");
    notesWritten++;
  }

  // ── Class Notes ─────────────────────────────────────────────────

  const classes = db
    .prepare(
      "SELECT name, file, start_line, end_line, exported FROM classes ORDER BY name",
    )
    .all() as any[];

  for (const cls of classes) {
    const methods = db
      .prepare(
        "SELECT name, start_line, is_static, is_async FROM methods WHERE class_name = ? ORDER BY start_line",
      )
      .all(cls.name) as any[];

    const lines = [
      `---`,
      `type: class`,
      `file: "${cls.file}"`,
      `line: ${cls.start_line}`,
      `exported: ${cls.exported ? "true" : "false"}`,
      `---`,
      "",
      `# ${cls.name}`,
      "",
      `**File:** \`${cls.file}:${cls.start_line}\``,
      "",
    ];

    if (methods.length > 0) {
      lines.push("## Methods", "");
      for (const m of methods) {
        const qualifiedName = `${cls.name}.${m.name}`;
        const flags = [
          m.is_static ? "static" : null,
          m.is_async ? "async" : null,
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `- [[${safeName(qualifiedName)}]]${flags ? ` (${flags})` : ""}`,
        );
      }
      lines.push("");
    }

    const filePath = join(classesDir, `${safeName(cls.name)}.md`);
    writeFileSync(filePath, lines.join("\n"), "utf-8");
    notesWritten++;
  }

  // ── Sector Notes ────────────────────────────────────────────────

  const communities = graph.getCommunities();
  for (const community of communities) {
    const nodes = graph.getNodesInCommunity(community.id);
    const files = [...new Set(nodes.map((n) => n.file))];

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

    const tierEmoji: Record<string, string> = {
      critical: "🔴",
      complex: "🟠",
      standard: "🟡",
      simple: "🟢",
    };

    const lines = [
      `---`,
      `type: sector`,
      `tier: ${tier}`,
      `nodes: ${community.nodeCount}`,
      `complexity: ${(community.complexityScore ?? 0).toFixed(1)}`,
      `---`,
      "",
      `# ${tierEmoji[tier] ?? "⚪"} ${community.name ?? community.id}`,
      "",
      `**Tier:** ${tier} | **Nodes:** ${community.nodeCount} | **Complexity:** ${(community.complexityScore ?? 0).toFixed(1)}/10`,
      "",
    ];

    if (keywords.length > 0) {
      lines.push(`**Keywords:** ${keywords.join(", ")}`, "");
    }

    // Group members by kind
    const funcs = nodes.filter((n) => n.kind === "function");
    const meths = nodes.filter((n) => n.kind === "method");
    const clsNodes = nodes.filter((n) => n.kind === "class");

    if (funcs.length > 0) {
      lines.push("## Functions", "");
      for (const f of funcs) {
        lines.push(`- [[${safeName(f.name)}]] — \`${f.file}\``);
      }
      lines.push("");
    }

    if (clsNodes.length > 0) {
      lines.push("## Classes", "");
      for (const c of clsNodes) {
        lines.push(`- [[${safeName(c.name)}]] — \`${c.file}\``);
      }
      lines.push("");
    }

    if (meths.length > 0) {
      lines.push("## Methods", "");
      for (const m of meths) {
        lines.push(`- [[${safeName(m.name)}]] — \`${m.file}\``);
      }
      lines.push("");
    }

    lines.push("## Files", "");
    for (const f of files.slice(0, 30)) {
      lines.push(`- \`${f}\``);
    }
    if (files.length > 30) lines.push(`- ... and ${files.length - 30} more`);

    const filePath = join(
      sectorsDir,
      `${safeName(community.name ?? community.id)}.md`,
    );
    writeFileSync(filePath, lines.join("\n"), "utf-8");
    notesWritten++;
  }

  // ── Hotspots Note ───────────────────────────────────────────────

  const hotspots = db
    .prepare(
      `
    SELECT ce.callee AS name, COUNT(*) AS callerCount, f.file
    FROM call_edges ce
    JOIN functions f ON f.name = ce.callee
    GROUP BY ce.callee, f.file
    ORDER BY callerCount DESC
    LIMIT 25
  `,
    )
    .all() as any[];

  const hotspotLines = [
    "# 🔥 Hotspots",
    "",
    "Most depended-on functions in the codebase. Changes here have the highest blast radius.",
    "",
    "| Rank | Function | Callers | File |",
    "|------|----------|---------|------|",
    ...hotspots.map(
      (h: any, i: number) =>
        `| ${i + 1} | [[${safeName(h.name)}]] | ${h.callerCount} | \`${h.file}\` |`,
    ),
    "",
  ];
  writeFileSync(
    join(outputPath, "Hotspots.md"),
    hotspotLines.join("\n"),
    "utf-8",
  );
  notesWritten++;

  // ── Sector Map ──────────────────────────────────────────────────

  const sectorMapLines = [
    "# 🗺️ Sector Map",
    "",
    "Visual map of all code sectors and their relationships.",
    "",
    "```mermaid",
    "graph TB",
  ];

  for (const community of communities) {
    const label = community.name ?? community.id;
    const sid = safeMermaid(label);
    sectorMapLines.push(`  ${sid}["${label} (${community.nodeCount})"]`);
  }

  // Cross-sector edges
  try {
    const crossEdges = db
      .prepare(
        `
      SELECT DISTINCT n1.community_id AS from_c, n2.community_id AS to_c
      FROM edges e
      JOIN nodes n1 ON n1.id = e.source_id
      JOIN nodes n2 ON n2.id = e.target_id
      WHERE n1.community_id IS NOT NULL AND n2.community_id IS NOT NULL
        AND n1.community_id != n2.community_id
      LIMIT 50
    `,
      )
      .all() as any[];

    const seen = new Set<string>();
    for (const edge of crossEdges) {
      const key = `${edge.from_c}->${edge.to_c}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fromName =
        communities.find((c) => c.id === edge.from_c)?.name ?? edge.from_c;
      const toName =
        communities.find((c) => c.id === edge.to_c)?.name ?? edge.to_c;
      sectorMapLines.push(
        `  ${safeMermaid(fromName)} --> ${safeMermaid(toName)}`,
      );
    }
  } catch {
    /* no cross edges */
  }

  sectorMapLines.push("```", "");
  writeFileSync(
    join(outputPath, "Sector Map.md"),
    sectorMapLines.join("\n"),
    "utf-8",
  );
  notesWritten++;

  // ── Analytics Note ──────────────────────────────────────────────

  const languages = db
    .prepare(
      "SELECT language, COUNT(*) AS count FROM nodes WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC",
    )
    .all() as any[];

  const analyticsLines = [
    "# 📊 Analytics",
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
    `| Sectors | ${stats.communities} |`,
    "",
    "## Languages",
    "",
    ...languages.map((l: any) => `- **${l.language}**: ${l.count} nodes`),
    "",
    "## Sectors by Tier",
    "",
  ];

  for (const community of communities) {
    let tier = "standard";
    try {
      const meta = db
        .prepare("SELECT metadata_json FROM communities WHERE id = ?")
        .get(community.id) as any;
      if (meta?.metadata_json)
        tier = JSON.parse(meta.metadata_json).tier ?? "standard";
    } catch {
      /* ignore */
    }
    analyticsLines.push(
      `- **${community.name ?? community.id}** — ${tier} (${community.nodeCount} nodes, complexity ${(community.complexityScore ?? 0).toFixed(1)})`,
    );
  }

  writeFileSync(
    join(outputPath, "Analytics.md"),
    analyticsLines.join("\n"),
    "utf-8",
  );
  notesWritten++;

  // ── Vault README ────────────────────────────────────────────────

  const readmeLines = [
    "# 🧠 Brainstorm Code Intelligence",
    "",
    `> Auto-generated from the code knowledge graph. Open this folder in Obsidian to explore.`,
    "",
    `**${stats.files} files** indexed across **${languages.length} language(s)** into **${stats.nodes} nodes** and **${stats.graphEdges} edges**.`,
    `**${communities.length} sectors** detected via Louvain community detection.`,
    "",
    "## Quick Links",
    "",
    "- [[Hotspots]] — Most depended-on functions (highest blast radius)",
    "- [[Sector Map]] — Visual map of code sectors",
    "- [[Analytics]] — Graph statistics and metrics",
    "",
    "## Sectors",
    "",
    ...communities.map(
      (c) => `- [[${safeName(c.name ?? c.id)}]] (${c.nodeCount} nodes)`,
    ),
    "",
    "## How to Use",
    "",
    "1. Open this folder as an Obsidian vault",
    "2. Enable the **Graph View** (Ctrl/Cmd+G) to see structural relationships",
    "3. Click any function to see its callers, callees, and sector membership",
    "4. Use the Sector Map for a high-level architectural view",
    "",
    `*Generated by Brainstorm Code Intelligence Engine*`,
  ];
  writeFileSync(join(outputPath, "README.md"), readmeLines.join("\n"), "utf-8");
  notesWritten++;

  // ── Obsidian config ─────────────────────────────────────────────

  const obsidianDir = join(outputPath, ".obsidian");
  mkdirSync(obsidianDir, { recursive: true });

  // Minimal app config to enable graph view and wikilinks
  writeFileSync(
    join(obsidianDir, "app.json"),
    JSON.stringify(
      {
        useMarkdownLinks: false, // Use [[wikilinks]]
        showFrontmatter: true,
        livePreview: true,
      },
      null,
      2,
    ),
    "utf-8",
  );

  const result: VaultResult = {
    vaultPath: outputPath,
    notesWritten,
    sectors: communities.length,
    functions: functions.length,
    classes: classes.length,
  };

  log.info(result, "Obsidian vault generated");
  return result;
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_").replace(/\./g, "-");
}

function safeMermaid(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "") || "unnamed";
}
