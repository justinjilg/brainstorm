/**
 * Enrichment Prompt — generates prose sections for BRAINSTORM.md.
 *
 * Takes the accumulated context (analysis + exploration) and asks
 * the LLM to write architecture description, gotchas, and anti-patterns.
 * The frontmatter and structured sections are built deterministically;
 * only the prose needs LLM generation.
 */

import type { ProjectAnalysis } from "@brainst0rm/ingest";
import type { ExplorationResult, GeneratedAgent } from "../types.js";

export function buildEnrichmentPrompt(
  analysis: ProjectAnalysis,
  exploration: ExplorationResult | undefined,
  agents: GeneratedAgent[] | undefined,
): string {
  const sections: string[] = [];

  sections.push(`You are writing the prose sections of a BRAINSTORM.md file — a context document that AI agents read before working on this project. Write concise, actionable content.

## Project
${exploration?.projectPurpose ?? `A ${analysis.summary.primaryLanguage} project with ${analysis.summary.totalFiles} files.`}

## Stack
- Language: ${analysis.summary.primaryLanguage}
- Frameworks: ${analysis.summary.frameworkList.join(", ") || "none"}
- ${analysis.summary.totalFiles} files, ${analysis.summary.totalLines.toLocaleString()} lines, ${analysis.summary.moduleCount} modules`);

  if (exploration) {
    sections.push(`## Discovered Conventions
- Naming: variables=${exploration.conventions.naming.variables}, files=${exploration.conventions.naming.files}, exports=${exploration.conventions.naming.exports}
- Error handling: ${exploration.conventions.errorHandling}
- Testing: ${exploration.conventions.testingPatterns}
- Imports: ${exploration.conventions.importStyle}${exploration.conventions.stateManagement ? `\n- State management: ${exploration.conventions.stateManagement}` : ""}${exploration.conventions.apiPatterns ? `\n- API patterns: ${exploration.conventions.apiPatterns}` : ""}
- Custom rules: ${exploration.conventions.customRules.join("; ") || "none"}`);

    if (exploration.domainConcepts.length > 0) {
      sections.push(`## Domain Concepts
${exploration.domainConcepts.map((c) => `- **${c.name}**: ${c.definition}`).join("\n")}`);
    }

    sections.push(`## Development Workflow
- Commits: ${exploration.gitWorkflow.commitStyle}
- Branching: ${exploration.gitWorkflow.branchStrategy}
- PRs: ${exploration.gitWorkflow.prPatterns}
- CI/CD: ${exploration.cicdSetup.provider}, stages: ${exploration.cicdSetup.stages.join(" → ") || "unknown"}
- Deploy target: ${exploration.cicdSetup.deployTarget}`);
  }

  if (agents && agents.length > 0) {
    sections.push(`## Generated Agents
${agents.map((a) => `- **${a.id}** (${a.role}): ${a.rationale}`).join("\n")}`);
  }

  sections.push(`## Instructions

Write THREE sections as markdown. Each section should be 2-5 paragraphs of actionable content.

**Section 1: Architecture**
Describe the project's architecture: how modules relate, data flow, key abstractions, and the overall design philosophy. Reference specific directories and files.

**Section 2: Gotchas**
List 3-8 things a new developer (or AI agent) would trip over. Include non-obvious conventions, surprising behaviors, common mistakes, and "don't do X, do Y instead" guidance.

**Section 3: Anti-Patterns**
List 2-5 patterns to avoid in this codebase, with brief explanations of why.

Respond with ONLY the three markdown sections (with ## headers), no JSON, no code fences around the whole response.`);

  return sections.join("\n\n");
}
