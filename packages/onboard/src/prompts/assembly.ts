/**
 * Assembly Prompt — generates enriched agent system prompts.
 *
 * Takes heuristic agent candidates + exploration results and asks
 * the LLM to write rich system prompts that embed actual conventions,
 * domain knowledge, and module-specific context.
 */

import type { ExplorationResult, GeneratedAgent } from "../types.js";
import type { ProjectAnalysis, ModuleCluster } from "@brainst0rm/ingest";

export interface AgentCandidate {
  id: string;
  role: string;
  rationale: string;
  moduleScope?: ModuleCluster;
  tools?: string[];
  modelHint?: string;
}

export function buildAssemblyPrompt(
  analysis: ProjectAnalysis,
  exploration: ExplorationResult | undefined,
  candidates: AgentCandidate[],
): string {
  const sections: string[] = [];

  sections.push(`You are designing a team of specialized AI agents for a codebase. Each agent needs a rich system prompt that embeds the project's actual conventions, domain knowledge, and module context.

## Project
${exploration?.projectPurpose ?? `A ${analysis.summary.primaryLanguage} project with ${analysis.summary.totalFiles} files.`}

## Stack
- Language: ${analysis.summary.primaryLanguage}
- Frameworks: ${analysis.summary.frameworkList.join(", ") || "none"}
- Testing: ${analysis.frameworks.testing.join(", ") || "none"}
- Modules: ${analysis.summary.moduleCount}
- Complexity: avg ${analysis.summary.avgComplexity.toFixed(1)}`);

  if (exploration) {
    sections.push(`## Conventions
- Naming: variables=${exploration.conventions.naming.variables}, files=${exploration.conventions.naming.files}
- Error handling: ${exploration.conventions.errorHandling}
- Testing: ${exploration.conventions.testingPatterns}
- Imports: ${exploration.conventions.importStyle}${exploration.conventions.stateManagement ? `\n- State: ${exploration.conventions.stateManagement}` : ""}${exploration.conventions.apiPatterns ? `\n- API: ${exploration.conventions.apiPatterns}` : ""}
- Rules: ${exploration.conventions.customRules.join("; ") || "none"}`);

    if (exploration.domainConcepts.length > 0) {
      sections.push(`## Domain Concepts
${exploration.domainConcepts.map((c) => `- **${c.name}**: ${c.definition}`).join("\n")}`);
    }
  }

  // Agent candidates
  sections.push(`## Agent Candidates

Generate a .agent.md system prompt for EACH of the following agents. The system prompt should be 10-30 lines of markdown that a code-writing AI reads before starting work.

${candidates
  .map((c, i) => {
    let desc = `### Agent ${i + 1}: ${c.id} (${c.role})
- Rationale: ${c.rationale}`;
    if (c.tools) desc += `\n- Allowed tools: ${c.tools.join(", ")}`;
    if (c.moduleScope) {
      desc += `\n- Module scope: ${c.moduleScope.directory} (${c.moduleScope.files.length} files, cohesion: ${c.moduleScope.cohesion.toFixed(2)})`;
    }
    return desc;
  })
  .join("\n\n")}`);

  sections.push(`## Instructions

For each agent candidate, generate a complete .agent.md file. Respond with a JSON array of objects:

\`\`\`json
[
  {
    "id": "agent-id",
    "role": "role",
    "modelHint": "quality | capable | cheap",
    "tools": ["tool1", "tool2"] or "all",
    "maxSteps": 10,
    "budget": 5.0,
    "systemPrompt": "The full markdown system prompt content..."
  }
]
\`\`\`

Each systemPrompt MUST include:
1. A clear role definition (what this agent does)
2. Project-specific conventions (from the conventions section above)
3. Domain concepts relevant to this agent's scope
4. Specific do's and don'ts for this codebase
5. Module context if the agent has a module scope

Keep prompts actionable and specific. Avoid generic advice like "write clean code."
Respond ONLY with the JSON array, no markdown fencing or explanation.`);

  return sections.join("\n\n");
}
