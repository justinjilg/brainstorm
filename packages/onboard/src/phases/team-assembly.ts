/**
 * Phase 2: Team Assembly — generate specialized agents.
 *
 * Two-step process:
 * 1. Heuristic pre-filter: detect baseline agents from analysis signals (free)
 * 2. LLM enrichment: write rich system prompts with real conventions
 *
 * The heuristics decide WHICH agents to create. The LLM decides
 * WHAT they know (system prompt content).
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectAnalysis, ModuleCluster } from "@brainst0rm/ingest";
import type {
  OnboardContext,
  OnboardDispatcher,
  GeneratedAgent,
} from "../types.js";
import {
  buildAssemblyPrompt,
  type AgentCandidate,
} from "../prompts/assembly.js";

interface PhaseResult {
  contextPatch: Partial<OnboardContext>;
  cost: number;
  summary: string;
  filesWritten?: string[];
}

export async function runTeamAssembly(
  context: OnboardContext,
  dispatcher: OnboardDispatcher,
): Promise<PhaseResult> {
  const { analysis, exploration } = context;

  // Step 1: Heuristic candidate detection (free)
  const candidates = detectCandidates(analysis);

  // Step 2: LLM enrichment — generate rich system prompts
  const prompt = buildAssemblyPrompt(analysis, exploration, candidates);
  const response = await dispatcher.generate(prompt, 0.5);

  // Parse LLM response
  let enrichedAgents: Array<{
    id: string;
    role: string;
    modelHint?: string;
    tools?: string[] | "all";
    maxSteps?: number;
    budget?: number;
    systemPrompt: string;
  }>;

  try {
    let json = response.text.trim();
    if (json.startsWith("```")) {
      json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    enrichedAgents = JSON.parse(json);
  } catch {
    // Fallback: create agents with generic prompts
    enrichedAgents = candidates.map((c) => ({
      id: c.id,
      role: c.role,
      modelHint: c.modelHint,
      tools: c.tools,
      systemPrompt: buildFallbackPrompt(c, analysis),
    }));
  }

  // Generate .agent.md files
  const agentsDir = join(analysis.projectPath, ".brainstorm", "agents");
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

  const agents: GeneratedAgent[] = [];
  const filesWritten: string[] = [];

  for (const enriched of enrichedAgents) {
    const candidate = candidates.find((c) => c.id === enriched.id);
    const filePath = join(agentsDir, `${enriched.id}.agent.md`);

    const content = formatAgentMd(enriched);
    writeFileSync(filePath, content, "utf-8");

    agents.push({
      id: enriched.id,
      role: enriched.role as any,
      filePath,
      content,
      rationale: candidate?.rationale ?? "LLM-generated",
    });
    filesWritten.push(filePath);
  }

  const roleList = agents.map((a) => a.id).join(", ");

  return {
    contextPatch: { agents },
    cost: response.cost,
    summary: `${agents.length} agents: ${roleList}`,
    filesWritten,
  };
}

/**
 * Detect agent candidates from static analysis signals.
 * No LLM needed — pure heuristic.
 */
function detectCandidates(analysis: ProjectAnalysis): AgentCandidate[] {
  const candidates: AgentCandidate[] = [];

  // Always: architect
  candidates.push({
    id: "architect",
    role: "architect",
    rationale: "Every project needs high-level design guidance",
    modelHint: "quality",
  });

  // Always: code-reviewer
  candidates.push({
    id: "code-reviewer",
    role: "code-reviewer",
    rationale: "Code review is critical for quality",
    tools: ["file_read", "grep", "glob", "git_diff", "git_log"],
    modelHint: "capable",
  });

  // Frontend framework detected → frontend-expert
  const frontendFrameworks = [
    "react",
    "nextjs",
    "next.js",
    "vue",
    "angular",
    "svelte",
  ];
  if (
    analysis.frameworks.frameworks.some((f) =>
      frontendFrameworks.includes(f.toLowerCase()),
    )
  ) {
    candidates.push({
      id: "frontend-expert",
      role: "coder",
      rationale: `Frontend framework detected: ${analysis.frameworks.frameworks.filter((f) => frontendFrameworks.includes(f.toLowerCase())).join(", ")}`,
      modelHint: "capable",
    });
  }

  // API routes detected → api-expert
  if (analysis.summary.apiRouteCount > 0) {
    candidates.push({
      id: "api-expert",
      role: "coder",
      rationale: `${analysis.summary.apiRouteCount} API routes detected`,
      modelHint: "capable",
    });
  }

  // Testing frameworks detected → qa
  if (analysis.frameworks.testing.length > 0) {
    candidates.push({
      id: "qa",
      role: "qa",
      rationale: `Testing with ${analysis.frameworks.testing.join(", ")}`,
      modelHint: "capable",
    });
  }

  // CI/CD detected → devops
  if (analysis.frameworks.ci && analysis.frameworks.ci.length > 0) {
    candidates.push({
      id: "devops",
      role: "devops",
      rationale: `CI/CD detected: ${analysis.frameworks.ci.join(", ")}`,
      tools: ["file_read", "file_write", "grep", "glob", "shell"],
      modelHint: "capable",
    });
  }

  // High complexity → security-reviewer
  if (
    analysis.summary.avgComplexity > 10 ||
    analysis.summary.hotspotCount > 5
  ) {
    candidates.push({
      id: "security-reviewer",
      role: "security-reviewer",
      rationale: `High complexity (avg ${analysis.summary.avgComplexity.toFixed(1)}) warrants security review`,
      tools: ["file_read", "grep", "glob"],
      modelHint: "quality",
    });
  }

  // Module-specific experts for top 3 complex clusters
  const topClusters = analysis.dependencies.clusters
    .filter((c) => c.files.length >= 3)
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, 3);

  for (const cluster of topClusters) {
    const safeName = cluster.directory
      .replace(/[/\\]/g, "-")
      .replace(/^-/, "")
      .replace(/-$/, "");

    if (!safeName || candidates.some((c) => c.id === `${safeName}-expert`))
      continue;

    candidates.push({
      id: `${safeName}-expert`,
      role: "coder",
      rationale: `Module "${cluster.directory}" has ${cluster.files.length} files`,
      moduleScope: cluster,
      modelHint: "capable",
    });
  }

  return candidates;
}

/**
 * Format an enriched agent into .agent.md content.
 */
function formatAgentMd(agent: {
  id: string;
  role: string;
  modelHint?: string;
  tools?: string[] | "all";
  maxSteps?: number;
  budget?: number;
  systemPrompt: string;
}): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${agent.id}`);
  lines.push(`role: ${agent.role}`);
  lines.push(`model: ${agent.modelHint ?? "capable"}`);
  if (agent.tools && agent.tools !== "all") {
    lines.push(`tools: [${agent.tools.map((t) => `"${t}"`).join(", ")}]`);
  }
  if (agent.maxSteps) lines.push(`max_steps: ${agent.maxSteps}`);
  if (agent.budget) lines.push(`budget: ${agent.budget}`);
  lines.push("---");
  lines.push("");
  lines.push(agent.systemPrompt);
  return lines.join("\n");
}

/**
 * Build a fallback system prompt when LLM fails.
 */
function buildFallbackPrompt(
  candidate: AgentCandidate,
  analysis: ProjectAnalysis,
): string {
  const lines: string[] = [
    `# ${candidate.id}`,
    "",
    `You are a ${candidate.role} for a ${analysis.summary.primaryLanguage} project.`,
    "",
    `## Context`,
    `- Language: ${analysis.summary.primaryLanguage}`,
    `- Frameworks: ${analysis.summary.frameworkList.join(", ") || "none"}`,
    `- ${analysis.summary.totalFiles} files, ${analysis.summary.totalLines.toLocaleString()} lines`,
  ];

  if (candidate.moduleScope) {
    lines.push(
      "",
      `## Module Scope: ${candidate.moduleScope.directory}`,
      `- Files: ${candidate.moduleScope.files.length}`,
      `- Cohesion: ${candidate.moduleScope.cohesion > 0.5 ? "high" : candidate.moduleScope.cohesion > 0.2 ? "medium" : "low"}`,
    );
  }

  return lines.join("\n");
}
