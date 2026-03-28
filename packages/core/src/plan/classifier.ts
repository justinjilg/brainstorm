/**
 * Task classifier — maps plan task descriptions to subagent type + model hint.
 *
 * This is where the plan executor decides HOW to execute each task:
 * which subagent type, which model tier, and whether to verify after.
 */

import type { TaskDispatch, PlanTask } from "./types.js";

// ── Pattern Matchers ────────────────────────────────────────────────

const EXPLORE_PATTERNS =
  /\b(research|explore|find|search|understand|read|investigate|discover|scan|audit|analyze|check existing)\b/i;

const PLAN_PATTERNS =
  /\b(plan|design|architect|interface|schema|propose|outline|strategy|rfc|adr|spec)\b/i;

const REVIEW_PATTERNS =
  /\b(review|check|audit|verify|validate|inspect|critique|lint|security)\b/i;

const CODE_PATTERNS =
  /\b(implement|create|build|write|add|fix|update|refactor|migrate|wire|connect|configure|install|setup|modify|extend)\b/i;

const DEPLOY_PATTERNS = /\b(deploy|ship|release|merge|publish|push|promote)\b/i;

const TEST_PATTERNS =
  /\b(test|spec|coverage|e2e|integration test|unit test|snapshot)\b/i;

// ── Complexity Estimation ───────────────────────────────────────────

const COMPLEX_INDICATORS =
  /\b(entire|all|complete|comprehensive|overhaul|rewrite|major|architecture|migration|cross-cutting)\b/i;

const SIMPLE_INDICATORS =
  /\b(typo|rename|bump|version|minor|small|quick|simple|trivial|cleanup)\b/i;

// ── Classifier ──────────────────────────────────────────────────────

/**
 * Classify a plan task into a dispatch decision.
 *
 * Returns the subagent type, model hint, and whether to run build verification.
 */
export function classifyPlanTask(task: PlanTask): TaskDispatch {
  const desc = task.description;

  // Check for explicit skill assignment — skill overrides classification
  if (task.assignedSkill) {
    return {
      subagentType: "code",
      modelHint: "capable",
      requiresVerification: true,
      routingStrategy: "combined",
    };
  }

  // Explicit readonly flag
  if (task.readonly) {
    return {
      subagentType: "explore",
      modelHint: "cheap",
      requiresVerification: false,
      routingStrategy: "cost-first",
    };
  }

  // Pattern-based classification (order matters — more specific first)
  if (DEPLOY_PATTERNS.test(desc)) {
    return {
      subagentType: "code",
      modelHint: "capable",
      requiresVerification: true,
      routingStrategy: "quality-first",
    };
  }

  if (REVIEW_PATTERNS.test(desc)) {
    return {
      subagentType: "review",
      modelHint: "capable",
      requiresVerification: false,
      routingStrategy: "quality-first",
    };
  }

  if (TEST_PATTERNS.test(desc)) {
    return {
      subagentType: "code",
      modelHint: "capable",
      requiresVerification: true,
      routingStrategy: "combined",
    };
  }

  if (PLAN_PATTERNS.test(desc)) {
    return {
      subagentType: "plan",
      modelHint: isComplex(desc) ? "quality" : "capable",
      requiresVerification: false,
      routingStrategy: "quality-first",
    };
  }

  if (EXPLORE_PATTERNS.test(desc)) {
    return {
      subagentType: "explore",
      modelHint: "cheap",
      requiresVerification: false,
      routingStrategy: "cost-first",
    };
  }

  if (CODE_PATTERNS.test(desc)) {
    const complexity = isComplex(desc)
      ? "quality"
      : isSimple(desc)
        ? "cheap"
        : "capable";
    return {
      subagentType: "code",
      modelHint: complexity,
      requiresVerification: true,
      routingStrategy: complexity === "quality" ? "quality-first" : "combined",
    };
  }

  // Default: code subagent, capable model
  return {
    subagentType: "code",
    modelHint: "capable",
    requiresVerification: true,
    routingStrategy: "combined",
  };
}

function isComplex(desc: string): boolean {
  return COMPLEX_INDICATORS.test(desc);
}

function isSimple(desc: string): boolean {
  return SIMPLE_INDICATORS.test(desc);
}

/**
 * Estimate cost for a task based on its dispatch classification.
 */
export function estimateTaskCost(dispatch: TaskDispatch): number {
  const baseCosts: Record<string, number> = {
    explore: 0.02,
    plan: 0.08,
    review: 0.05,
    code: 0.15,
    general: 0.05,
    decompose: 0.03,
    external: 0.01,
  };

  const modelMultiplier: Record<string, number> = {
    cheap: 0.3,
    capable: 1.0,
    quality: 3.0,
  };

  const base = baseCosts[dispatch.subagentType] ?? 0.1;
  const mult = modelMultiplier[dispatch.modelHint] ?? 1.0;
  return base * mult;
}
