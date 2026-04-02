/**
 * Phase 3: Routing Rules — wire agents to task types.
 *
 * Two-step:
 * 1. Heuristic rules from analysis signals + agent list (free)
 * 2. LLM review to adjust and add project-specific rules
 *
 * Output: routing.yaml in .brainstorm/ directory.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectAnalysis } from "@brainst0rm/ingest";
import type {
  OnboardContext,
  OnboardDispatcher,
  GeneratedRoutingRule,
  GeneratedAgent,
} from "../types.js";
import { buildRoutingPrompt } from "../prompts/routing.js";

interface PhaseResult {
  contextPatch: Partial<OnboardContext>;
  cost: number;
  summary: string;
  filesWritten?: string[];
}

export async function runRoutingRules(
  context: OnboardContext,
  dispatcher: OnboardDispatcher,
): Promise<PhaseResult> {
  const { analysis, agents } = context;

  if (!agents || agents.length === 0) {
    return {
      contextPatch: { routingRules: [] },
      cost: 0,
      summary: "No agents to route to (skipped)",
    };
  }

  // Step 1: Heuristic rules (free)
  const heuristicRules = generateHeuristicRules(analysis, agents);

  // Step 2: LLM review
  const prompt = buildRoutingPrompt(analysis, agents, heuristicRules);
  const response = await dispatcher.generate(prompt, 0.08);

  let rules: GeneratedRoutingRule[];
  try {
    let json = response.text.trim();
    if (json.startsWith("```")) {
      json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    rules = JSON.parse(json);
  } catch {
    // Fall back to heuristic rules
    rules = heuristicRules;
  }

  // Write routing.yaml
  const brainstormDir = join(analysis.projectPath, ".brainstorm");
  if (!existsSync(brainstormDir)) mkdirSync(brainstormDir, { recursive: true });

  const routingPath = join(brainstormDir, "routing.yaml");
  const yamlContent = formatRoutingYaml(rules);
  writeFileSync(routingPath, yamlContent, "utf-8");

  return {
    contextPatch: { routingRules: rules },
    cost: response.cost,
    summary: `${rules.length} routing rules`,
    filesWritten: [routingPath],
  };
}

/**
 * Generate heuristic routing rules from analysis + agents.
 */
function generateHeuristicRules(
  analysis: ProjectAnalysis,
  agents: GeneratedAgent[],
): GeneratedRoutingRule[] {
  const rules: GeneratedRoutingRule[] = [];
  const agentIds = new Set(agents.map((a) => a.id));

  // Code review → code-reviewer
  if (agentIds.has("code-reviewer")) {
    rules.push({
      match: "code-review",
      agentId: "code-reviewer",
      modelHint: "capable",
      rationale: "Route review tasks to dedicated reviewer",
    });
  }

  // Architecture/design → architect
  if (agentIds.has("architect")) {
    rules.push({
      match: "architecture",
      agentId: "architect",
      modelHint: "quality",
      rationale: "Design tasks need quality-tier reasoning",
    });
    rules.push({
      match: "refactoring",
      agentId: "architect",
      modelHint: "quality",
      rationale: "Refactoring needs architectural awareness",
    });
  }

  // Frontend tasks → frontend-expert
  if (agentIds.has("frontend-expert")) {
    rules.push({
      match: "frontend",
      agentId: "frontend-expert",
      modelHint: "capable",
      rationale: "Frontend-specific tasks",
    });
    rules.push({
      match: "component",
      agentId: "frontend-expert",
      modelHint: "capable",
      rationale: "Component creation/modification",
    });
  }

  // API tasks → api-expert
  if (agentIds.has("api-expert")) {
    rules.push({
      match: "api",
      agentId: "api-expert",
      modelHint: "capable",
      rationale: `${analysis.summary.apiRouteCount} API routes in project`,
    });
    rules.push({
      match: "endpoint",
      agentId: "api-expert",
      modelHint: "capable",
      rationale: "Endpoint creation/modification",
    });
  }

  // Testing → qa
  if (agentIds.has("qa")) {
    rules.push({
      match: "test",
      agentId: "qa",
      modelHint: "capable",
      rationale: "Test writing and debugging",
    });
  }

  // Security → security-reviewer
  if (agentIds.has("security-reviewer")) {
    rules.push({
      match: "security",
      agentId: "security-reviewer",
      modelHint: "quality",
      rationale: "Security tasks need thorough analysis",
    });
    rules.push({
      match: "audit",
      agentId: "security-reviewer",
      modelHint: "quality",
      rationale: "Code audits are security-adjacent",
    });
  }

  // CI/CD → devops
  if (agentIds.has("devops")) {
    rules.push({
      match: "deploy",
      agentId: "devops",
      modelHint: "capable",
      rationale: "Deployment and infrastructure tasks",
    });
    rules.push({
      match: "ci",
      agentId: "devops",
      modelHint: "capable",
      rationale: "CI/CD pipeline tasks",
    });
  }

  // General code generation → first coder agent
  const coderAgent = agents.find(
    (a) => a.role === "coder" && !a.id.includes("-expert"),
  );
  if (coderAgent) {
    rules.push({
      match: "code-generation",
      agentId: coderAgent.id,
      modelHint: "capable",
      rationale: "General code generation",
    });
  }

  // Debugging → first available coder or debugger
  const debugAgent = agents.find((a) => a.role === "debugger") ?? coderAgent;
  if (debugAgent) {
    rules.push({
      match: "debugging",
      agentId: debugAgent.id,
      modelHint: "capable",
      rationale: "Bug investigation and fixing",
    });
  }

  return rules;
}

/**
 * Format routing rules as YAML.
 */
function formatRoutingYaml(rules: GeneratedRoutingRule[]): string {
  const lines: string[] = [
    "# Brainstorm Routing Rules",
    "# Generated by `storm onboard` — maps task patterns to specialized agents.",
    "#",
    "# Format: match pattern → agent ID, model tier, rationale",
    "# Edit freely — these rules override heuristic routing.",
    "",
    "rules:",
  ];

  for (const rule of rules) {
    lines.push(`  - match: "${rule.match}"`);
    lines.push(`    agent: ${rule.agentId}`);
    if (rule.modelHint) lines.push(`    model: ${rule.modelHint}`);
    lines.push(`    # ${rule.rationale}`);
    lines.push("");
  }

  return lines.join("\n");
}
