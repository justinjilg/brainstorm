/**
 * Role-Based Workflow System — session presets that configure
 * model, system prompt, tools, output style, and routing strategy.
 *
 * Each role is like a team member: /architect thinks deeply in read-only mode,
 * /sr-developer codes with quality models, /jr-developer codes fast and cheap.
 */

import {
  type OutputStyle,
  getPersona,
  composePersonaPrompt,
} from "@brainst0rm/core";

export type RoleId =
  | "architect"
  | "product-manager"
  | "sr-developer"
  | "jr-developer"
  | "qa";

export interface ModelChoice {
  modelId: string;
  label: string;
  cost: string;
  default?: boolean;
}

export interface RoleDefinition {
  id: RoleId;
  displayName: string;
  icon: string;
  color: string;
  description: string;
  modelChoices: ModelChoice[];
  /** Static system prompt (fallback if no persona found) */
  systemPrompt: string;
  /** Persona ID for expert playbook (overrides systemPrompt when available) */
  personaId?: string;
  outputStyle: OutputStyle;
  permissionMode: "auto" | "confirm" | "plan";
  routingStrategy: string;
  /** If set, only these tools are allowed (whitelist) */
  allowedTools?: string[];
  /** If set, these tools are blocked (blacklist) */
  blockedTools?: string[];
}

const ARCHITECT_PROMPT = `You are a senior software architect. Your job is to DESIGN, not implement.

# Core Behaviors
1. Explore the codebase deeply before proposing anything. Read files, search patterns, understand structure.
2. Design with component boundaries, data flow diagrams, and interface contracts.
3. Present structured plans with specific files to modify, new files to create, and dependencies to add.
4. Consider trade-offs: performance vs maintainability, simplicity vs flexibility, consistency vs innovation.
5. Do NOT write implementation code. Design it. Show interfaces, type definitions, and pseudocode at most.
6. When uncertain, explore more. Better to spend time understanding than to design from assumptions.

# Output Format
Structure your response as:
- **Problem Analysis**: What are we solving and why
- **Proposed Architecture**: Components, boundaries, data flow
- **Key Interfaces**: TypeScript interfaces or type definitions
- **Implementation Plan**: Ordered steps with file paths
- **Risks & Trade-offs**: What could go wrong, alternatives considered`;

const PM_PROMPT = `You are a product manager helping define requirements and scope for a software project.

# Core Behaviors
1. Ask clarifying questions to understand the user's goals and constraints.
2. Write user stories with acceptance criteria in Given/When/Then format.
3. Identify edge cases, error scenarios, and potential scope creep early.
4. Explore the codebase to understand feasibility and existing patterns.
5. Prioritize features by impact and effort (MoSCoW or similar).
6. Never assume — validate requirements against the actual codebase.

# Output Format
- **User Stories**: As a [user], I want [feature] so that [benefit]
- **Acceptance Criteria**: Given/When/Then scenarios
- **Edge Cases**: What could go wrong
- **Scope Risks**: Where scope might expand
- **Priority**: Must have / Should have / Could have / Won't have`;

const SR_DEV_PROMPT = `You are a senior software developer. Write production-quality code.

# Core Behaviors
1. Read existing code before writing. Match established patterns exactly.
2. Implement with proper error handling, edge cases, and type safety.
3. Review your own code before presenting it — catch bugs before the user does.
4. Run build commands to verify compilation. Fix issues before moving on.
5. Write concise, focused code. No over-engineering or speculative features.
6. Consider performance, security, and maintainability in every change.
7. Self-verify: after making changes, run tests and builds to confirm nothing broke.

# Anti-patterns to Avoid
- Don't add features beyond what was asked
- Don't refactor surrounding code unless it's broken
- Don't add comments to code you didn't change
- Don't create abstractions for one-time operations`;

const JR_DEV_PROMPT = `You are a junior developer. Implement tasks quickly and follow patterns exactly.

# Core Behaviors
1. Follow existing patterns in the codebase precisely. Don't invent new patterns.
2. Implement the simplest solution that satisfies the requirement.
3. When uncertain about anything, ask for clarification before proceeding.
4. Focus on getting the task done — speed over perfection.
5. If you see code that looks wrong, flag it but don't fix it unless asked.
6. Run the build command after every change.`;

const QA_PROMPT = `You are a QA engineer. Find bugs, plan tests, and verify quality.

# Core Behaviors
1. Think adversarially — what inputs would break this? What edge cases were missed?
2. Read the code deeply to understand logic before testing.
3. Plan test coverage: unit tests, integration tests, edge cases, error paths.
4. Generate test matrices for complex features (input combinations × expected outcomes).
5. Run existing tests and report results. Suggest new tests for uncovered paths.
6. Look for security issues: injection, auth bypass, data leaks, race conditions.
7. Check for regressions: does the change break anything that was working before?

# Output Format
- **Test Plan**: What to test, in priority order
- **Test Matrix**: Input combinations × expected outcomes (table format)
- **Findings**: Issues found with severity (Critical/High/Medium/Low)
- **Coverage Gaps**: What's not tested and should be`;

export const ROLES: Record<RoleId, RoleDefinition> = {
  architect: {
    id: "architect",
    displayName: "Architect",
    icon: "🏗",
    color: "magenta",
    description: "Deep thinking, system design, read-only exploration",
    modelChoices: [
      {
        modelId: "anthropic/claude-opus-4-6",
        label: "Claude Opus 4.6",
        cost: "$15/$75",
        default: true,
      },
      { modelId: "openai/gpt-5.4", label: "GPT-5.4", cost: "$2.50/$10" },
      {
        modelId: "google/gemini-3.1-pro",
        label: "Gemini 3.1 Pro",
        cost: "$1.25/$5",
      },
      {
        modelId: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        cost: "$3/$15",
      },
    ],
    systemPrompt: ARCHITECT_PROMPT,
    personaId: "architect",
    outputStyle: "detailed",
    permissionMode: "plan",
    routingStrategy: "quality-first",
    blockedTools: [
      "file_write",
      "file_edit",
      "multi_edit",
      "batch_edit",
      "shell",
      "git_commit",
    ],
  },
  "product-manager": {
    id: "product-manager",
    displayName: "Product Manager",
    icon: "📋",
    color: "blue",
    description: "Requirements, user stories, acceptance criteria",
    modelChoices: [
      {
        modelId: "anthropic/claude-opus-4-6",
        label: "Claude Opus 4.6",
        cost: "$15/$75",
        default: true,
      },
      { modelId: "openai/gpt-5.4", label: "GPT-5.4", cost: "$2.50/$10" },
      {
        modelId: "google/gemini-3.1-pro",
        label: "Gemini 3.1 Pro",
        cost: "$1.25/$5",
      },
    ],
    systemPrompt: PM_PROMPT,
    personaId: "product-manager",
    outputStyle: "detailed",
    permissionMode: "plan",
    routingStrategy: "quality-first",
  },
  "sr-developer": {
    id: "sr-developer",
    displayName: "Sr. Developer",
    icon: "👨‍💻",
    color: "green",
    description: "Quality implementation with best models",
    modelChoices: [
      {
        modelId: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        cost: "$3/$15",
        default: true,
      },
      { modelId: "openai/gpt-5.4", label: "GPT-5.4", cost: "$2.50/$10" },
      {
        modelId: "deepseek/deepseek-chat",
        label: "DeepSeek V3",
        cost: "$0.27/$1.10",
      },
      {
        modelId: "google/gemini-3.1-pro",
        label: "Gemini 3.1 Pro",
        cost: "$1.25/$5",
      },
    ],
    systemPrompt: SR_DEV_PROMPT,
    personaId: "sr-developer",
    outputStyle: "concise",
    permissionMode: "confirm",
    routingStrategy: "quality-first",
  },
  "jr-developer": {
    id: "jr-developer",
    displayName: "Jr. Developer",
    icon: "🧑‍💻",
    color: "yellow",
    description: "Fast, cheap implementation for well-specified tasks",
    modelChoices: [
      {
        modelId: "anthropic/claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        cost: "$0.80/$4",
        default: true,
      },
      {
        modelId: "openai/gpt-4.1-mini",
        label: "GPT-4.1 Mini",
        cost: "$0.40/$1.60",
      },
      {
        modelId: "google/gemini-3.1-flash",
        label: "Gemini 3.1 Flash",
        cost: "$0.15/$0.60",
      },
      {
        modelId: "deepseek/deepseek-chat",
        label: "DeepSeek V3",
        cost: "$0.27/$1.10",
      },
    ],
    systemPrompt: JR_DEV_PROMPT,
    personaId: "jr-developer",
    outputStyle: "concise",
    permissionMode: "confirm",
    routingStrategy: "cost-first",
    blockedTools: ["git_commit", "git_branch", "process_spawn"],
  },
  qa: {
    id: "qa",
    displayName: "QA Engineer",
    icon: "🔍",
    color: "red",
    description: "Testing, code review, edge case discovery",
    modelChoices: [
      {
        modelId: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        cost: "$3/$15",
        default: true,
      },
      { modelId: "openai/gpt-5.4", label: "GPT-5.4", cost: "$2.50/$10" },
      {
        modelId: "google/gemini-3.1-pro",
        label: "Gemini 3.1 Pro",
        cost: "$1.25/$5",
      },
      {
        modelId: "anthropic/claude-opus-4-6",
        label: "Claude Opus 4.6",
        cost: "$15/$75",
      },
    ],
    systemPrompt: QA_PROMPT,
    personaId: "qa",
    outputStyle: "detailed",
    permissionMode: "plan",
    routingStrategy: "quality-first",
    allowedTools: [
      "file_read",
      "grep",
      "glob",
      "shell",
      "git_status",
      "git_diff",
    ],
  },
};

/**
 * Get the system prompt for a role, composed from expert persona when available.
 * Falls back to the static systemPrompt if no persona is registered.
 */
export function getRolePrompt(roleId: RoleId, modelId?: string): string {
  const role = ROLES[roleId];
  if (!role) return "";

  // Try persona-based composition (model-tuned expert playbook)
  if (role.personaId) {
    const persona = getPersona(role.personaId);
    if (persona) {
      return composePersonaPrompt(persona, modelId);
    }
  }

  // Fallback to static prompt
  return role.systemPrompt;
}

/**
 * Format the model selection menu for a role.
 */
export function formatModelMenu(roleId: RoleId): string {
  const role = ROLES[roleId];
  if (!role) return `Unknown role: ${roleId}`;

  const header = `${role.icon} ${role.displayName} Mode — select model:`;
  const choices = role.modelChoices.map((m, i) => {
    const num = String(i + 1);
    const def = m.default ? "  ← default" : "";
    return `  ${num}. ${m.label.padEnd(22)} (${m.cost} per 1M)${def}`;
  });

  return `\n${header}\n${choices.join("\n")}\n\nUse: /${roleId} 1  (or 2, 3, etc.)`;
}

/**
 * Get the model ID for a role given a selection index (1-based).
 * Returns default if index is 0 or out of range.
 */
export function getModelForRole(roleId: RoleId, index: number): string {
  const role = ROLES[roleId];
  if (!role) return "brainstormrouter/auto";

  if (index >= 1 && index <= role.modelChoices.length) {
    return role.modelChoices[index - 1].modelId;
  }
  const defaultChoice =
    role.modelChoices.find((m) => m.default) ?? role.modelChoices[0];
  return defaultChoice.modelId;
}

/**
 * Format the confirmation message after a role is applied.
 */
export function formatRoleConfirmation(
  roleId: RoleId,
  modelId: string,
): string {
  const role = ROLES[roleId];
  if (!role) return "Role applied.";

  const model = role.modelChoices.find((m) => m.modelId === modelId);
  const modelName = model?.label ?? modelId;
  const toolsLabel = role.permissionMode === "plan" ? "read-only" : "all";

  return `${role.icon} ${role.displayName} mode active\n  Model: ${modelName} │ Tools: ${toolsLabel} │ Style: ${role.outputStyle}`;
}
