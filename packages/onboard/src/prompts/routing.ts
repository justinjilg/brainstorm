/**
 * Routing Prompt — generates task-to-agent routing rules.
 *
 * Takes heuristic rule candidates + agent list and asks the LLM
 * to review, adjust, and add project-specific rules.
 */

import type { GeneratedAgent, GeneratedRoutingRule } from "../types.js";
import type { ProjectAnalysis } from "@brainst0rm/ingest";

export function buildRoutingPrompt(
  analysis: ProjectAnalysis,
  agents: GeneratedAgent[],
  heuristicRules: GeneratedRoutingRule[],
): string {
  return `You are configuring task routing for an AI coding assistant. Each task should be routed to the most appropriate specialized agent.

## Available Agents
${agents.map((a) => `- **${a.id}** (${a.role}): ${a.rationale}`).join("\n")}

## Project Context
- Language: ${analysis.summary.primaryLanguage}
- Frameworks: ${analysis.summary.frameworkList.join(", ") || "none"}
- ${analysis.summary.apiRouteCount} API routes, ${analysis.summary.moduleCount} modules

## Heuristic Rules (auto-generated)
These rules were generated from static analysis. Review them and add any project-specific rules.

${heuristicRules.map((r) => `- match: "${r.match}" → agent: ${r.agentId} (${r.modelHint ?? "auto"}) — ${r.rationale}`).join("\n")}

## Instructions

Return a JSON array of routing rules. Include the heuristic rules (adjusted if needed) plus any additional project-specific rules.

\`\`\`json
[
  {
    "match": "task type or keyword pattern",
    "agentId": "agent-id",
    "modelHint": "quality | capable | cheap",
    "rationale": "why this rule exists"
  }
]
\`\`\`

Guidelines:
- "match" should be a task type (code-generation, debugging, refactoring, etc.) or keyword pattern
- Every agent should have at least one routing rule
- Security-sensitive tasks should route to quality-tier models
- Simple fixes can use cheap-tier models
- Respond ONLY with the JSON array`;
}
