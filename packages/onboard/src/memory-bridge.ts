/**
 * Onboard → Memory Bridge
 *
 * Converts onboard pipeline exploration results into persistent memory entries.
 * After onboarding, conventions, domain concepts, and project purpose are
 * stored in the project's memory so agents have project expertise in their
 * system prompt from the first interaction.
 */

import { MemoryManager } from "@brainst0rm/core";
import type { OnboardResult, ExplorationResult } from "./types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("onboard-memory-bridge");

/**
 * Persist onboard exploration results into project memory.
 *
 * System-tier entries (always in prompt):
 * - conventions: naming, error handling, testing, import style
 * - domain-concepts: key terms and their definitions
 * - project-purpose: what the project does and why
 *
 * Archive-tier entries (searchable on demand):
 * - git-workflow: commit style, branch strategy, PR patterns
 * - ci-cd-profile: provider, stages, deploy target
 * - key-files-digest: important files and their purposes
 */
export function persistOnboardToMemory(
  result: OnboardResult,
  projectPath: string,
): number {
  const exploration = result.context.exploration;
  if (!exploration) {
    log.warn("No exploration results in onboard output — nothing to persist");
    return 0;
  }

  const memory = new MemoryManager(projectPath);
  let saved = 0;

  // ── System tier (always in prompt) ──

  if (exploration.conventions) {
    const conv = exploration.conventions;
    const content = [
      `## Naming: ${conv.naming.variables} (vars), ${conv.naming.files} (files), ${conv.naming.exports} (exports)`,
      conv.naming.components
        ? `Components: ${conv.naming.components}`
        : undefined,
      `## Error Handling: ${conv.errorHandling}`,
      `## Testing: ${conv.testingPatterns}`,
      `## Imports: ${conv.importStyle}`,
      conv.stateManagement
        ? `## State Management: ${conv.stateManagement}`
        : undefined,
      conv.apiPatterns ? `## API Patterns: ${conv.apiPatterns}` : undefined,
      conv.customRules.length > 0
        ? `## Custom Rules\n${conv.customRules.map((r) => `- ${r}`).join("\n")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    memory.save({
      name: "conventions",
      description: "Project coding conventions discovered by onboard pipeline",
      content,
      type: "project",
      tier: "system",
      source: "agent_extraction",
      author: "onboard-pipeline",
    });
    saved++;
  }

  if (exploration.domainConcepts?.length > 0) {
    const content = exploration.domainConcepts
      .map(
        (c) =>
          `**${c.name}**: ${c.definition}${c.relatedFiles.length > 0 ? ` (${c.relatedFiles.join(", ")})` : ""}`,
      )
      .join("\n");

    memory.save({
      name: "domain-concepts",
      description: "Key domain terms and their definitions",
      content,
      type: "project",
      tier: "system",
      source: "agent_extraction",
      author: "onboard-pipeline",
    });
    saved++;
  }

  if (exploration.projectPurpose) {
    memory.save({
      name: "project-purpose",
      description: "What this project does and why it exists",
      content: exploration.projectPurpose,
      type: "project",
      tier: "system",
      source: "agent_extraction",
      author: "onboard-pipeline",
    });
    saved++;
  }

  // ── Archive tier (searchable on demand) ──

  if (exploration.gitWorkflow) {
    const gw = exploration.gitWorkflow;
    const content = [
      `Commit style: ${gw.commitStyle}`,
      `Branch strategy: ${gw.branchStrategy}`,
      `PR patterns: ${gw.prPatterns}`,
      `Typical PR size: ${gw.typicalPRSize}`,
      `Active contributors: ${gw.activeContributors}`,
    ].join("\n");

    memory.save({
      name: "git-workflow",
      description: "Git workflow profile — commit style, branching, PRs",
      content,
      type: "project",
      tier: "archive",
      source: "agent_extraction",
      author: "onboard-pipeline",
    });
    saved++;
  }

  if (exploration.cicdSetup) {
    const ci = exploration.cicdSetup;
    const content = [
      `Provider: ${ci.provider}`,
      `Stages: ${ci.stages.join(" → ")}`,
      `Deploy target: ${ci.deployTarget}`,
      `Pre-commit hooks: ${ci.hasPreCommitHooks ? "yes" : "no"}`,
    ].join("\n");

    memory.save({
      name: "ci-cd-profile",
      description: "CI/CD pipeline profile — provider, stages, deploy target",
      content,
      type: "project",
      tier: "archive",
      source: "agent_extraction",
      author: "onboard-pipeline",
    });
    saved++;
  }

  if (exploration.keyFiles?.length > 0) {
    const content = exploration.keyFiles
      .map((f) => `**${f.path}**: ${f.purpose}\n${f.summary}`)
      .join("\n\n");

    memory.save({
      name: "key-files-digest",
      description: "Important files and their purposes",
      content,
      type: "reference",
      tier: "archive",
      source: "agent_extraction",
      author: "onboard-pipeline",
    });
    saved++;
  }

  log.info(
    { saved, projectPath },
    "Onboard results persisted to project memory",
  );
  return saved;
}
