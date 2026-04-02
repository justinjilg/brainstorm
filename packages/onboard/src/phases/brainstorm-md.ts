/**
 * Phase 5: BRAINSTORM.md Enhancement — generates rich project context.
 *
 * Combines deterministic frontmatter (from analysis) with LLM-generated
 * prose sections (architecture, gotchas, anti-patterns). The result is
 * a BRAINSTORM.md that gives agents real context before their first task.
 *
 * Frontmatter uses StormFrontmatter schema from @brainst0rm/config.
 */

import { writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { ProjectAnalysis } from "@brainst0rm/ingest";
import type {
  OnboardContext,
  OnboardDispatcher,
  ExplorationResult,
} from "../types.js";
import { buildEnrichmentPrompt } from "../prompts/enrichment.js";

interface PhaseResult {
  contextPatch: Partial<OnboardContext>;
  cost: number;
  summary: string;
  filesWritten?: string[];
}

export async function runBrainstormMd(
  context: OnboardContext,
  dispatcher: OnboardDispatcher,
): Promise<PhaseResult> {
  const { analysis, exploration, agents } = context;
  const projectName = basename(analysis.projectPath);

  // Build frontmatter deterministically
  const frontmatter = buildFrontmatter(analysis, exploration);

  // Build deterministic body sections
  const staticSections = buildStaticSections(
    analysis,
    exploration,
    agents?.map((a) => ({ id: a.id, role: a.role })),
  );

  // Get LLM-generated prose
  let proseSections = "";
  let cost = 0;

  const prompt = buildEnrichmentPrompt(analysis, exploration, agents);
  const response = await dispatcher.explore(prompt, 0.2);
  proseSections = response.text;
  cost = response.cost;

  // Assemble the full BRAINSTORM.md
  const content = assembleBrainstormMd(
    frontmatter,
    projectName,
    staticSections,
    proseSections,
  );

  // Write to disk
  const outputPath = join(analysis.projectPath, "BRAINSTORM.md");
  const isUpdate = existsSync(outputPath);
  writeFileSync(outputPath, content, "utf-8");

  return {
    contextPatch: { brainstormMd: content },
    cost,
    summary: `${isUpdate ? "Updated" : "Generated"} with conventions, domain glossary, architecture`,
    filesWritten: [outputPath],
  };
}

/**
 * Build StormFrontmatter YAML from analysis.
 */
function buildFrontmatter(
  analysis: ProjectAnalysis,
  exploration?: ExplorationResult,
): string {
  const lines: string[] = ["---", "version: 1"];

  // Project identity
  lines.push(`name: ${basename(analysis.projectPath)}`);

  // Type inference
  const type = inferProjectType(analysis);
  if (type) lines.push(`type: ${type}`);

  // Language
  const lang = mapLanguage(analysis.summary.primaryLanguage);
  if (lang) lines.push(`language: ${lang}`);

  // Framework
  const framework = mapFramework(analysis.frameworks.frameworks);
  lines.push(`framework: ${framework}`);

  // Runtime
  const runtime = inferRuntime(analysis);
  lines.push(`runtime: ${runtime}`);

  // Deploy target
  const deploy = inferDeployTarget(analysis, exploration);
  lines.push(`deploy: ${deploy}`);

  // Commands
  const buildCmd = inferBuildCommand(analysis);
  if (buildCmd) lines.push(`build_command: "${buildCmd}"`);

  const testCmd = inferTestCommand(analysis);
  if (testCmd) lines.push(`test_command: "${testCmd}"`);

  // Entry points
  if (analysis.dependencies.entryPoints.length > 0) {
    const eps = analysis.dependencies.entryPoints
      .slice(0, 5)
      .map((e) => `"${e}"`)
      .join(", ");
    lines.push(`entry_points: [${eps}]`);
  }

  // Routing hints
  lines.push("routing:");
  lines.push(`  typical_complexity: ${inferComplexity(analysis)}`);
  lines.push(`  budget_tier: ${inferBudgetTier(analysis)}`);

  lines.push("---");
  return lines.join("\n");
}

/**
 * Build deterministic body sections from analysis + exploration.
 */
function buildStaticSections(
  analysis: ProjectAnalysis,
  exploration?: ExplorationResult,
  agents?: Array<{ id: string; role: string }>,
): string {
  const sections: string[] = [];

  // Stack
  sections.push("## Stack\n");
  if (analysis.summary.primaryLanguage)
    sections.push(`- **Language:** ${analysis.summary.primaryLanguage}`);
  if (analysis.summary.frameworkList.length > 0)
    sections.push(
      `- **Frameworks:** ${analysis.summary.frameworkList.join(", ")}`,
    );
  if (analysis.frameworks.databases.length > 0)
    sections.push(
      `- **Databases:** ${analysis.frameworks.databases.join(", ")}`,
    );
  if (analysis.frameworks.testing.length > 0)
    sections.push(`- **Testing:** ${analysis.frameworks.testing.join(", ")}`);
  if (analysis.frameworks.buildTools.length > 0)
    sections.push(`- **Build:** ${analysis.frameworks.buildTools.join(", ")}`);
  sections.push(
    `- **Size:** ${analysis.summary.totalFiles} files, ${analysis.summary.totalLines.toLocaleString()} lines, ${analysis.summary.moduleCount} modules`,
  );

  // Conventions (from exploration)
  if (exploration) {
    sections.push("\n## Conventions\n");
    const c = exploration.conventions;
    sections.push(
      `- **Naming:** variables=${c.naming.variables}, files=${c.naming.files}, exports=${c.naming.exports}`,
    );
    sections.push(`- **Error handling:** ${c.errorHandling}`);
    sections.push(`- **Testing:** ${c.testingPatterns}`);
    sections.push(`- **Imports:** ${c.importStyle}`);
    if (c.stateManagement)
      sections.push(`- **State management:** ${c.stateManagement}`);
    if (c.apiPatterns) sections.push(`- **API patterns:** ${c.apiPatterns}`);
    if (c.customRules.length > 0) {
      for (const rule of c.customRules) {
        sections.push(`- ${rule}`);
      }
    }
  }

  // Domain glossary
  if (exploration && exploration.domainConcepts.length > 0) {
    sections.push("\n## Domain Glossary\n");
    for (const concept of exploration.domainConcepts) {
      sections.push(`- **${concept.name}:** ${concept.definition}`);
    }
  }

  // Key files
  if (exploration && exploration.keyFiles.length > 0) {
    sections.push("\n## Key Files\n");
    for (const kf of exploration.keyFiles) {
      sections.push(`- \`${kf.path}\` — ${kf.purpose}`);
    }
  }

  // Team (agents)
  if (agents && agents.length > 0) {
    sections.push("\n## AI Team\n");
    for (const a of agents) {
      sections.push(`- **${a.id}** (${a.role})`);
    }
  }

  return sections.join("\n");
}

/**
 * Assemble the full BRAINSTORM.md from parts.
 */
function assembleBrainstormMd(
  frontmatter: string,
  projectName: string,
  staticSections: string,
  proseSections: string,
): string {
  const parts = [frontmatter, "", `# ${projectName}`, "", staticSections];

  if (proseSections) {
    parts.push("", proseSections.trim());
  }

  return parts.join("\n") + "\n";
}

// ── Inference Helpers ──────────────────────────────────────────────

function inferProjectType(analysis: ProjectAnalysis): string | null {
  const frameworks = analysis.frameworks.frameworks.map((f) => f.toLowerCase());
  if (frameworks.includes("turborepo") || frameworks.includes("lerna"))
    return "monorepo";
  if (
    frameworks.some((f) =>
      ["nextjs", "react", "vue", "angular", "svelte"].includes(f),
    )
  )
    return "app";
  if (
    analysis.dependencies.entryPoints.some(
      (e) => e.includes("cli") || e.includes("bin"),
    )
  )
    return "cli";
  if (analysis.summary.apiRouteCount > 0) return "api";
  return null;
}

function mapLanguage(primary: string): string | null {
  const map: Record<string, string> = {
    TypeScript: "typescript",
    JavaScript: "typescript",
    Python: "python",
    Rust: "rust",
    Go: "go",
    Java: "java",
  };
  return map[primary] ?? null;
}

function mapFramework(frameworks: string[]): string {
  const lower = frameworks.map((f) => f.toLowerCase());
  if (lower.includes("nextjs") || lower.includes("next.js")) return "nextjs";
  if (lower.includes("hono")) return "hono";
  if (lower.includes("fastapi")) return "fastapi";
  if (lower.includes("express")) return "express";
  return "none";
}

function inferRuntime(analysis: ProjectAnalysis): string {
  const lang = analysis.summary.primaryLanguage.toLowerCase();
  if (lang === "python") return "python";
  if (lang === "go") return "go";
  return "node";
}

function inferDeployTarget(
  analysis: ProjectAnalysis,
  exploration?: ExplorationResult,
): string {
  if (
    exploration?.cicdSetup.deployTarget &&
    exploration.cicdSetup.deployTarget !== "none"
  ) {
    return exploration.cicdSetup.deployTarget;
  }
  const deploy = analysis.frameworks.deployment ?? [];
  if (deploy.some((d) => d.toLowerCase().includes("vercel"))) return "vercel";
  if (deploy.some((d) => d.toLowerCase().includes("docker"))) return "docker";
  return "none";
}

function inferBuildCommand(analysis: ProjectAnalysis): string | null {
  const frameworks = analysis.frameworks.frameworks.map((f) => f.toLowerCase());
  if (frameworks.includes("turborepo")) return "npx turbo run build";
  if (
    analysis.summary.primaryLanguage === "TypeScript" ||
    analysis.summary.primaryLanguage === "JavaScript"
  )
    return "npm run build";
  if (analysis.summary.primaryLanguage === "Python") return null;
  if (analysis.summary.primaryLanguage === "Go") return "go build ./...";
  return null;
}

function inferTestCommand(analysis: ProjectAnalysis): string | null {
  if (analysis.frameworks.testing.length === 0) return null;
  const frameworks = analysis.frameworks.frameworks.map((f) => f.toLowerCase());
  if (frameworks.includes("turborepo")) return "npx turbo run test";
  if (
    analysis.frameworks.testing.some((t) => t.toLowerCase().includes("vitest"))
  )
    return "npx vitest run";
  if (analysis.frameworks.testing.some((t) => t.toLowerCase().includes("jest")))
    return "npx jest";
  if (
    analysis.frameworks.testing.some((t) => t.toLowerCase().includes("pytest"))
  )
    return "pytest";
  return "npm test";
}

function inferComplexity(analysis: ProjectAnalysis): string {
  const avg = analysis.summary.avgComplexity;
  if (avg < 5) return "simple";
  if (avg < 10) return "moderate";
  if (avg < 20) return "complex";
  return "expert";
}

function inferBudgetTier(analysis: ProjectAnalysis): string {
  const files = analysis.summary.totalFiles;
  if (files < 50) return "low";
  if (files < 500) return "standard";
  return "premium";
}
