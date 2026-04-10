/**
 * Multi-Model Workflow Wizard — conversational team assembly.
 *
 * State machine that collects a task description, auto-detects the
 * workflow type, lets users assign models per pipeline step, shows
 * cost estimates, and executes via the workflow engine.
 */

import { ROLES, type RoleId, type ModelChoice } from "./roles.js";
import { autoSelectPreset, getPresetWorkflow } from "@brainst0rm/workflow";
import type { WorkflowDefinition, WorkflowStepDef } from "@brainst0rm/shared";

// ── Types ────────────────────────────────────────────────────────────

export type WizardStep =
  | "describe"
  | "confirm"
  | "assign-models"
  | "summary"
  | "executing"
  | "done";

export interface ModelAssignment {
  stepId: string;
  stepRole: string;
  modelId: string;
  modelLabel: string;
  estimatedCost: number;
}

export interface WizardState {
  step: WizardStep;
  description: string;
  detectedPreset: string | null;
  workflow: WorkflowDefinition | null;
  assignments: ModelAssignment[];
  currentAssignIdx: number;
  totalCost: number;
  complexity: string;
}

// ── Role mapping ─────────────────────────────────────────────────────

/** Map workflow agent roles to the role system's curated model lists. */
const ROLE_FOR_AGENT: Record<string, RoleId> = {
  architect: "architect",
  coder: "sr-developer",
  reviewer: "qa",
  debugger: "sr-developer",
  analyst: "architect",
  orchestrator: "architect",
  "product-manager": "product-manager",
};

// ── State machine ────────────────────────────────────────────────────

export function createWizardState(): WizardState {
  return {
    step: "describe",
    description: "",
    detectedPreset: null,
    workflow: null,
    assignments: [],
    currentAssignIdx: 0,
    totalCost: 0,
    complexity: "moderate",
  };
}

/**
 * Process the user's task description.
 * Auto-detects the workflow type and builds default model assignments.
 */
export function processDescription(
  state: WizardState,
  description: string,
  classify?: (text: string) => { complexity: string },
): WizardState {
  const detectedPreset = autoSelectPreset(description) ?? "implement-feature";
  const workflow = getPresetWorkflow(detectedPreset);

  if (!workflow) {
    return { ...state, step: "describe", description };
  }

  // Classify complexity for smart defaults
  let complexity = "moderate";
  if (classify) {
    try {
      const profile = classify(description);
      complexity = profile.complexity ?? "moderate";
    } catch {
      // fallback
    }
  }

  // Build default model assignments
  const assignments = workflow.steps.map((step) => {
    const roleId = ROLE_FOR_AGENT[step.agentRole] ?? "sr-developer";
    const defaultModel = getDefaultModelForStep(roleId, complexity);
    const pricing = getModelPricing(defaultModel.modelId);
    const estimatedCost = estimateStepCost(complexity, pricing);

    return {
      stepId: step.id,
      stepRole: step.agentRole,
      modelId: defaultModel.modelId,
      modelLabel: defaultModel.label,
      estimatedCost,
    };
  });

  const totalCost = assignments.reduce((sum, a) => sum + a.estimatedCost, 0);

  return {
    ...state,
    step: "confirm",
    description,
    detectedPreset,
    workflow,
    assignments,
    currentAssignIdx: 0,
    totalCost,
    complexity,
  };
}

/**
 * Get the curated model choices for a workflow step.
 */
export function getModelChoicesForStep(agentRole: string): ModelChoice[] {
  const roleId = ROLE_FOR_AGENT[agentRole] ?? "sr-developer";
  const role = ROLES[roleId];
  return role?.modelChoices ?? [];
}

/**
 * Get the default model for a step based on complexity.
 */
function getDefaultModelForStep(
  roleId: RoleId,
  complexity: string,
): ModelChoice {
  const role = ROLES[roleId];
  if (!role)
    return { modelId: "brainstormrouter/auto", label: "Auto", cost: "$0" };

  // High complexity → use the role's default (usually the best model)
  // Low complexity → use a cheaper option
  if (complexity === "trivial" || complexity === "simple") {
    // Pick the cheapest option for simple tasks
    return (
      role.modelChoices[role.modelChoices.length - 1] ?? role.modelChoices[0]
    );
  }

  // Default: use the role's default choice
  return role.modelChoices.find((m) => m.default) ?? role.modelChoices[0];
}

// ── Cost estimation ──────────────────────────────────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "anthropic/claude-opus-4-6": { input: 15, output: 75 },
  "anthropic/claude-sonnet-4-6": { input: 3, output: 15 },
  "anthropic/claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  "openai/gpt-5.4": { input: 2.5, output: 10 },
  "openai/gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "google/gemini-3.1-pro-preview": { input: 1.25, output: 5 },
  "google/gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "deepseek/deepseek-chat": { input: 0.27, output: 1.1 },
  "moonshot/kimi-k2.5": { input: 0.6, output: 2.4 },
};

function getModelPricing(modelId: string): { input: number; output: number } {
  return MODEL_PRICING[modelId] ?? { input: 1, output: 4 };
}

const COMPLEXITY_TOKENS: Record<string, { input: number; output: number }> = {
  trivial: { input: 500, output: 200 },
  simple: { input: 1000, output: 500 },
  moderate: { input: 3000, output: 1500 },
  complex: { input: 8000, output: 4000 },
  expert: { input: 15000, output: 8000 },
};

function estimateStepCost(
  complexity: string,
  pricing: { input: number; output: number },
): number {
  const tokens = COMPLEXITY_TOKENS[complexity] ?? COMPLEXITY_TOKENS.moderate;
  return (
    (tokens.input / 1_000_000) * pricing.input +
    (tokens.output / 1_000_000) * pricing.output
  );
}

/**
 * Update a model assignment for a specific step.
 */
export function updateAssignment(
  state: WizardState,
  stepIdx: number,
  modelChoice: ModelChoice,
): WizardState {
  const assignments = [...state.assignments];
  const pricing = getModelPricing(modelChoice.modelId);
  assignments[stepIdx] = {
    ...assignments[stepIdx],
    modelId: modelChoice.modelId,
    modelLabel: modelChoice.label,
    estimatedCost: estimateStepCost(state.complexity, pricing),
  };
  const totalCost = assignments.reduce((sum, a) => sum + a.estimatedCost, 0);
  return { ...state, assignments, totalCost };
}

// ── Pipeline visualization ───────────────────────────────────────────

const ROLE_ICONS: Record<string, string> = {
  architect: "🏗",
  coder: "👨‍💻",
  reviewer: "🔍",
  debugger: "🔧",
  analyst: "📊",
};

/**
 * Format the pipeline as a visual string for the terminal.
 */
export function formatPipeline(state: WizardState): string {
  if (!state.workflow || state.assignments.length === 0) return "";

  const lines: string[] = [];
  lines.push(`${state.detectedPreset}`);

  for (let i = 0; i < state.assignments.length; i++) {
    const a = state.assignments[i];
    const step = state.workflow.steps[i];
    const icon = ROLE_ICONS[a.stepRole] ?? "⚙";
    // Short model name (drop provider prefix)
    const shortModel = a.modelLabel
      .replace(/^Claude /, "")
      .replace(/^GPT-/, "GPT-");
    lines.push(
      `${i + 1}. ${icon} ${a.stepRole} → ${shortModel} ~$${a.estimatedCost.toFixed(3)}`,
    );

    if (step?.isReviewStep && step.loopBackTo) {
      lines.push(`   ↺ loops to ${step.loopBackTo}`);
    }
  }

  lines.push(`Total: ~$${state.totalCost.toFixed(3)}`);

  return lines.join("\n");
}

/**
 * Build the overrides for runWorkflow from wizard assignments.
 */
export function buildWorkflowOverrides(state: WizardState): {
  agentOverrides: Record<string, string>;
  stepModelOverrides: Record<string, string>;
} {
  const agentOverrides: Record<string, string> = {};
  const stepModelOverrides: Record<string, string> = {};

  for (const a of state.assignments) {
    stepModelOverrides[a.stepId] = a.modelId;
  }

  return { agentOverrides, stepModelOverrides };
}
