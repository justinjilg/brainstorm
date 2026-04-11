/**
 * Onboard Types — LLM-driven autonomous project ingestion.
 *
 * The pipeline enriches an OnboardContext through 7 phases:
 * Phase 0 (static) → Phase 1 (explore) → Phase 2 (agents) →
 * Phase 3 (routing) → Phase 4 (workflows) → Phase 5 (BRAINSTORM.md) →
 * Phase 6 (verify)
 *
 * Each phase receives the accumulated context and returns its contribution.
 * OnboardEvents stream progress for real-time CLI rendering.
 */

import type { ProjectAnalysis } from "@brainst0rm/ingest";
import type { AgentRole } from "@brainst0rm/shared";

// ── Pipeline Options ─────────────────────────────────────────────

export interface OnboardOptions {
  /** Absolute path to the project root. */
  projectPath: string;
  /** Total budget cap in USD. Default auto-inferred from project size. */
  budget?: number;
  /** Skip LLM phases — equivalent to old setup-infra. */
  staticOnly?: boolean;
  /** Ask user for confirmation between phases. */
  interactive?: boolean;
  /** Show what would happen without writing files or calling LLMs. */
  dryRun?: boolean;
  /** Specific phases to run (default: all). */
  phases?: OnboardPhase[];
}

export type OnboardPhase =
  | "static-analysis"
  | "code-graph-build"
  | "deep-exploration"
  | "team-assembly"
  | "routing-rules"
  | "workflow-gen"
  | "brainstorm-md"
  | "verification";

export const ALL_PHASES: OnboardPhase[] = [
  "static-analysis",
  "code-graph-build",
  "deep-exploration",
  "team-assembly",
  "routing-rules",
  "workflow-gen",
  "brainstorm-md",
  "verification",
];

export const PHASE_LABELS: Record<OnboardPhase, string> = {
  "static-analysis": "Static Analysis",
  "code-graph-build": "Code Graph",
  "deep-exploration": "Deep Exploration",
  "team-assembly": "Team Assembly",
  "routing-rules": "Routing Rules",
  "workflow-gen": "Workflow Generation",
  "brainstorm-md": "BRAINSTORM.md",
  verification: "Verification",
};

// ── Dispatcher (LLM interface) ───────────────────────────────────

export interface OnboardDispatcher {
  /** Read-heavy analysis — sends file contents for the LLM to analyze. */
  explore(
    prompt: string,
    budget: number,
  ): Promise<{ text: string; cost: number }>;

  /** Structured output — returns parsed JSON matching the prompt's schema. */
  generate(
    prompt: string,
    budget: number,
  ): Promise<{ text: string; cost: number }>;
}

// ── Accumulating Context ─────────────────────────────────────────

export interface OnboardContext {
  analysis: ProjectAnalysis;
  exploration?: ExplorationResult;
  agents?: GeneratedAgent[];
  routingRules?: GeneratedRoutingRule[];
  recipes?: GeneratedRecipe[];
  brainstormMd?: string;
  verification?: VerificationResult;
}

// ── Phase 1: Deep Exploration ────────────────────────────────────

export interface ExplorationResult {
  conventions: ConventionSet;
  domainConcepts: DomainConcept[];
  gitWorkflow: GitWorkflowProfile;
  cicdSetup: CICDProfile;
  keyFiles: KeyFileDigest[];
  projectPurpose: string;
}

export interface ConventionSet {
  /** Variable/function naming: camelCase, snake_case, PascalCase, etc. */
  naming: NamingConvention;
  /** Error handling approach: try/catch, Result type, error boundaries, etc. */
  errorHandling: string;
  /** Test patterns: colocated __tests__, test/ dir, naming convention, etc. */
  testingPatterns: string;
  /** Import style: barrel exports, direct imports, path aliases, etc. */
  importStyle: string;
  /** State management (frontend): zustand, redux, context, signals, etc. */
  stateManagement?: string;
  /** API patterns: REST, tRPC, GraphQL, route handlers, etc. */
  apiPatterns?: string;
  /** Any other conventions discovered. */
  customRules: string[];
}

export interface NamingConvention {
  variables: string;
  files: string;
  components?: string;
  exports: string;
}

export interface DomainConcept {
  name: string;
  definition: string;
  relatedFiles: string[];
}

export interface GitWorkflowProfile {
  commitStyle: string;
  branchStrategy: string;
  prPatterns: string;
  typicalPRSize: string;
  activeContributors: number;
}

export interface CICDProfile {
  provider: string;
  stages: string[];
  deployTarget: string;
  hasPreCommitHooks: boolean;
}

export interface KeyFileDigest {
  path: string;
  purpose: string;
  summary: string;
}

// ── Phase 2: Team Assembly ───────────────────────────────────────

export interface GeneratedAgent {
  id: string;
  role: AgentRole;
  /** Where the .agent.md will be written. */
  filePath: string;
  /** Full .agent.md content (frontmatter + body). */
  content: string;
  /** Why this agent was created. */
  rationale: string;
}

// ── Phase 3: Routing Rules ───────────────────────────────────────

export interface GeneratedRoutingRule {
  /** Task type or keyword pattern this rule matches. */
  match: string;
  /** Agent to route matching tasks to. */
  agentId: string;
  /** Model tier hint: quality, capable, cheap. */
  modelHint?: string;
  /** Why this rule exists. */
  rationale: string;
}

// ── Phase 4: Workflow Recipes ────────────────────────────────────

export interface GeneratedRecipe {
  /** Recipe filename (e.g., "pr-ready.yaml"). */
  filename: string;
  /** Full YAML content. */
  content: string;
  /** What this recipe does. */
  description: string;
}

// ── Phase 6: Verification ────────────────────────────────────────

export interface VerificationResult {
  agentsValid: boolean;
  agentErrors: string[];
  routingValid: boolean;
  routingErrors: string[];
  recipesValid: boolean;
  recipeErrors: string[];
  brainstormMdValid: boolean;
  brainstormMdErrors: string[];
}

// ── Pipeline Events (streaming) ──────────────────────────────────

export type OnboardEvent =
  | {
      type: "onboard-started";
      options: OnboardOptions;
      estimatedBudget: number;
    }
  | { type: "phase-started"; phase: OnboardPhase; description: string }
  | {
      type: "phase-progress";
      phase: OnboardPhase;
      message: string;
      percent?: number;
    }
  | {
      type: "phase-completed";
      phase: OnboardPhase;
      cost: number;
      durationMs: number;
      summary: string;
    }
  | { type: "phase-failed"; phase: OnboardPhase; error: string }
  | { type: "phase-skipped"; phase: OnboardPhase; reason: string }
  | { type: "file-written"; path: string; description: string }
  | { type: "budget-warning"; spent: number; remaining: number }
  | { type: "onboard-completed"; result: OnboardResult };

export interface OnboardResult {
  context: OnboardContext;
  filesWritten: string[];
  totalCost: number;
  totalDurationMs: number;
  phasesRun: OnboardPhase[];
  phasesSkipped: OnboardPhase[];
}
