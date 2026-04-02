/**
 * Exploration Prompt — the heart of deep-exploration.
 *
 * Constructs a structured prompt that includes actual file contents
 * and asks the LLM to discover conventions, domain concepts, and
 * workflow patterns. Returns JSON matching ExplorationResult.
 */

import type { ProjectAnalysis } from "@brainst0rm/ingest";

/**
 * Build the exploration prompt with file contents and git history.
 */
export function buildExplorationPrompt(
  analysis: ProjectAnalysis,
  fileContents: Map<string, string>,
  gitSummary: string,
): string {
  const sections: string[] = [];

  // Header
  sections.push(`You are analyzing a codebase to understand its conventions, domain concepts, and development workflow.
Your goal: produce a JSON object that captures everything a new AI agent would need to know before writing code in this project.

## Project Overview
- Path: ${analysis.projectPath}
- Primary language: ${analysis.summary.primaryLanguage}
- Frameworks: ${analysis.summary.frameworkList.join(", ") || "none detected"}
- Files: ${analysis.summary.totalFiles}, Lines: ${analysis.summary.totalLines.toLocaleString()}
- Modules: ${analysis.summary.moduleCount}
- Entry points: ${analysis.summary.entryPointCount}
- API routes: ${analysis.summary.apiRouteCount}
- Avg complexity: ${analysis.summary.avgComplexity.toFixed(1)}
- Hotspots: ${analysis.summary.hotspotCount}`);

  // File contents
  if (fileContents.size > 0) {
    sections.push("\n## Key Files\n");
    for (const [path, content] of fileContents) {
      sections.push(`### ${path}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  // Git history
  if (gitSummary) {
    sections.push(
      `## Recent Git History (last 30 commits)\n\`\`\`\n${gitSummary}\n\`\`\``,
    );
  }

  // Detected frameworks detail
  if (analysis.frameworks.frameworks.length > 0) {
    sections.push(`## Detected Stack
- Frameworks: ${analysis.frameworks.frameworks.join(", ")}
- Build tools: ${analysis.frameworks.buildTools.join(", ") || "none"}
- Databases: ${analysis.frameworks.databases.join(", ") || "none"}
- Testing: ${analysis.frameworks.testing.join(", ") || "none"}
- CI/CD: ${analysis.frameworks.ci?.join(", ") || "none"}
- Deployment: ${analysis.frameworks.deployment?.join(", ") || "none"}`);
  }

  // Entry points
  if (analysis.dependencies.entryPoints.length > 0) {
    sections.push(
      `## Entry Points\n${analysis.dependencies.entryPoints
        .slice(0, 10)
        .map((e) => `- ${e}`)
        .join("\n")}`,
    );
  }

  // Complexity hotspots
  if (analysis.complexity.summary.hotspots.length > 0) {
    sections.push(
      `## Complexity Hotspots\n${analysis.complexity.summary.hotspots
        .slice(0, 10)
        .map((h) => `- ${h}`)
        .join("\n")}`,
    );
  }

  // Instructions
  sections.push(`
## Instructions

Analyze all the information above and respond with a JSON object matching this exact schema:

\`\`\`json
{
  "conventions": {
    "naming": {
      "variables": "camelCase | snake_case | PascalCase",
      "files": "kebab-case | camelCase | PascalCase | snake_case",
      "components": "PascalCase (if applicable)",
      "exports": "named | default | barrel"
    },
    "errorHandling": "description of error handling patterns",
    "testingPatterns": "description of testing approach and file organization",
    "importStyle": "description of import patterns",
    "stateManagement": "description if frontend (null if not applicable)",
    "apiPatterns": "description of API design patterns (null if not applicable)",
    "customRules": ["any other conventions discovered"]
  },
  "domainConcepts": [
    {
      "name": "concept name",
      "definition": "what this concept means in the project",
      "relatedFiles": ["path/to/relevant/files"]
    }
  ],
  "gitWorkflow": {
    "commitStyle": "conventional commits | freeform | prefixed | etc.",
    "branchStrategy": "trunk-based | gitflow | github flow | unknown",
    "prPatterns": "squash merge | merge commits | rebase | unknown",
    "typicalPRSize": "small (<100 lines) | medium (100-500) | large (500+)",
    "activeContributors": 1
  },
  "cicdSetup": {
    "provider": "github-actions | vercel | circleci | none | etc.",
    "stages": ["lint", "test", "build", "deploy"],
    "deployTarget": "vercel | aws | docker | do-app-platform | none | etc.",
    "hasPreCommitHooks": false
  },
  "keyFiles": [
    {
      "path": "relative/path",
      "purpose": "what this file does",
      "summary": "2-3 sentence summary"
    }
  ],
  "projectPurpose": "One paragraph describing what this project does, its target users, and its primary value proposition."
}
\`\`\`

Important:
- Base ALL answers on the actual file contents and git history provided above
- For conventions, look at actual patterns in the code — don't guess
- For domain concepts, identify the core business/technical abstractions unique to this project
- For git workflow, analyze the commit messages and file change patterns
- Include 3-10 domain concepts and 5-15 key files
- Respond ONLY with the JSON object, no markdown fencing or explanation`);

  return sections.join("\n\n");
}
