/**
 * Role-to-Skill Mapping — 1:1 mapping of agent roles to Osmani + brainstorm skills.
 *
 * Each agent role has a curated set of skills that define its expertise.
 * When building the system prompt for an agent, only the skills for its
 * role are injected — preventing prompt bloat from all 28 skills.
 *
 * Skills are referenced by name (matching SKILL.md filenames).
 * The caller resolves names to content via the skill loader.
 */

import type { AgentRole } from "@brainst0rm/shared";

/**
 * Maps each AgentRole to its skill set.
 * Skills listed in priority order — most relevant first.
 */
export const ROLE_SKILLS: Record<AgentRole, string[]> = {
  architect: [
    "planning-and-task-breakdown",
    "spec-driven-development",
    "api-and-interface-design",
    "context-engineering",
    "documentation-and-adrs",
  ],

  coder: [
    "incremental-implementation",
    "test-driven-development",
    "context-engineering",
    "frontend-ui-engineering",
    "api-and-interface-design",
    "debugging-and-error-recovery",
  ],

  reviewer: [
    "code-review-and-quality",
    "code-simplification",
    "security-and-hardening",
    "performance-optimization",
  ],

  debugger: [
    "debugging-and-error-recovery",
    "browser-testing-with-devtools",
    "performance-optimization",
    "context-engineering",
  ],

  analyst: [
    "context-engineering",
    "documentation-and-adrs",
    "code-review-and-quality",
    "planning-and-task-breakdown",
  ],

  orchestrator: [
    "using-agent-skills",
    "planning-and-task-breakdown",
    "daemon-operations",
    "multi-model-routing",
    "godmode-operations",
  ],

  "product-manager": [
    "idea-refine",
    "spec-driven-development",
    "planning-and-task-breakdown",
    "documentation-and-adrs",
    "shipping-and-launch",
  ],

  "security-reviewer": [
    "security-and-hardening",
    "code-review-and-quality",
    "performance-optimization",
    "debugging-and-error-recovery",
  ],

  "code-reviewer": [
    "code-review-and-quality",
    "code-simplification",
    "security-and-hardening",
    "test-driven-development",
  ],

  "style-reviewer": [
    "code-simplification",
    "code-review-and-quality",
    "documentation-and-adrs",
    "frontend-ui-engineering",
  ],

  qa: [
    "test-driven-development",
    "browser-testing-with-devtools",
    "debugging-and-error-recovery",
    "security-and-hardening",
    "ci-cd-and-automation",
  ],

  compliance: [
    "security-and-hardening",
    "documentation-and-adrs",
    "code-review-and-quality",
    "deprecation-and-migration",
  ],

  devops: [
    "ci-cd-and-automation",
    "git-workflow-and-versioning",
    "shipping-and-launch",
    "performance-optimization",
    "daemon-operations",
  ],

  custom: [],
};

/** Get skill names for an agent role. Custom roles return empty (caller provides skills). */
export function getSkillsForRole(role: AgentRole): string[] {
  return ROLE_SKILLS[role] ?? [];
}

/** Get all unique skill names across all roles. */
export function getAllMappedSkills(): string[] {
  const all = new Set<string>();
  for (const skills of Object.values(ROLE_SKILLS)) {
    for (const s of skills) all.add(s);
  }
  return Array.from(all);
}
