/**
 * Workflow Prompt — customizes recipe step descriptions.
 *
 * Takes heuristic recipe templates and asks the LLM to customize
 * step descriptions with project-specific conventions.
 */

import type { ExplorationResult, GeneratedRecipe } from "../types.js";
import type { ProjectAnalysis } from "@brainst0rm/ingest";

export function buildWorkflowPrompt(
  analysis: ProjectAnalysis,
  exploration: ExplorationResult | undefined,
  heuristicRecipes: GeneratedRecipe[],
): string {
  return `You are customizing workflow recipes for a project. Each recipe defines a multi-step workflow where AI agents collaborate.

## Project
- Language: ${analysis.summary.primaryLanguage}
- Frameworks: ${analysis.summary.frameworkList.join(", ") || "none"}
- Testing: ${analysis.frameworks.testing.join(", ") || "none"}
${
  exploration
    ? `- Conventions: ${exploration.conventions.testingPatterns}
- Error handling: ${exploration.conventions.errorHandling}
- Commit style: ${exploration.gitWorkflow.commitStyle}
- CI stages: ${exploration.cicdSetup.stages.join(" → ") || "unknown"}`
    : ""
}

## Heuristic Recipes
These recipes were auto-generated. Customize the step descriptions to match this project's conventions.

${heuristicRecipes.map((r) => `### ${r.filename}\n\`\`\`yaml\n${r.content}\n\`\`\``).join("\n\n")}

## Instructions

Return a JSON array of customized recipes. Keep the same structure but improve the step descriptions to be project-specific.

\`\`\`json
[
  {
    "filename": "recipe-name.yaml",
    "content": "full YAML content",
    "description": "what this recipe does"
  }
]
\`\`\`

Guidelines:
- Reference actual testing frameworks (${analysis.frameworks.testing.join(", ") || "none"})
- Reference actual build tools (${analysis.frameworks.buildTools.join(", ") || "none"})
- Step descriptions should be actionable and project-specific
- Keep YAML syntax valid
- Respond ONLY with the JSON array`;
}
