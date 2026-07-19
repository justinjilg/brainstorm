// ── Task Classification ──────────────────────────────────────────────

export type TaskType =
  | "simple-edit"
  | "code-generation"
  | "refactoring"
  | "debugging"
  | "explanation"
  | "conversation"
  | "analysis"
  | "search"
  | "multi-file-edit"
  | "ingest"
  | "audit"
  | "migration"
  | "documentation";

export type Complexity =
  | "trivial"
  | "simple"
  | "moderate"
  | "complex"
  | "expert";

export interface TaskProfile {
  type: TaskType;
  complexity: Complexity;
  estimatedTokens: { input: number; output: number };
  requiresToolUse: boolean;
  requiresReasoning: boolean;
  language?: string;
  domain?: string;
}

// ── Model Registry ───────────────────────────────────────────────────

export type QualityTier = 1 | 2 | 3 | 4 | 5;
export type SpeedTier = 1 | 2 | 3 | 4 | 5;
export type ModelStatus = "available" | "degraded" | "unavailable";

/** Scored capability dimensions from the eval harness (0-1 scale). */
export interface CapabilityScores {
  toolSelection: number;
  toolSequencing: number;
  codeGeneration: number;
  multiStepReasoning: number;
  instructionFollowing: number;
  contextUtilization: number;
  selfCorrection: number;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  vision: boolean;
  reasoning: boolean;
  contextWindow: number;
  qualityTier: QualityTier;
  speedTier: SpeedTier;
  bestFor: TaskType[];
  /** Scored capability profile from eval harness. Populated by `brainstorm eval`. */
  capabilityScores?: CapabilityScores;
}

export interface ModelPricing {
  inputPer1MTokens: number;
  outputPer1MTokens: number;
  cachedInputPer1MTokens?: number;
}

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

export interface ModelEntry {
  id: string;
  provider: string;
  name: string;
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  limits: ModelLimits;
  status: ModelStatus;
  isLocal: boolean;
  lastHealthCheck: number;
}

// ── Routing ──────────────────────────────────────────────────────────

export type StrategyName =
  | "cost-first"
  | "quality-first"
  | "rule-based"
  | "combined"
  | "capability"
  | "learned"
  | "auto";

export interface RoutingDecision {
  model: ModelEntry;
  fallbacks: ModelEntry[];
  reason: string;
  estimatedCost: number;
  strategy: StrategyName;
}

export interface RoutingContext {
  budget: BudgetState;
  sessionCost: number;
  conversationTokens: number;
  userPreferences: UserModelPrefs;
  recentFailures: FailureRecord[];
}

export interface BudgetState {
  dailyUsed: number;
  dailyLimit?: number;
  monthlyUsed: number;
  monthlyLimit?: number;
  sessionUsed: number;
  sessionLimit?: number;
  hardLimit: boolean;
}

export interface UserModelPrefs {
  preferLocal: boolean;
  preferredProvider?: string;
  excludeModels?: string[];
}

export interface FailureRecord {
  modelId: string;
  timestamp: number;
  error: string;
}

// ── Cost Tracking ────────────────────────────────────────────────────

export interface CostRecord {
  id: string;
  timestamp: number;
  sessionId: string;
  modelId: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  taskType: TaskType;
  projectPath?: string;
}

// ── Sessions ─────────────────────────────────────────────────────────

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  projectPath: string;
  totalCost: number;
  messageCount: number;
  /** Daemon mode metadata — populated only for daemon sessions. */
  isDaemon?: boolean;
  tickCount?: number;
  lastTickAt?: number;
  isPaused?: boolean;
  tickIntervalMs?: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  modelId?: string;
  tokenCount?: number;
  timestamp: number;
}

// ── Events ───────────────────────────────────────────────────────────

export interface GatewayFeedbackData {
  guardianStatus?: string;
  estimatedCost?: number;
  actualCost?: number;
  efficiency?: number;
  overheadMs?: number;
  cacheHit?: string;
  budgetRemaining?: number;
  selectedModel?: string;
  selectionMethod?: string;
  complexityScore?: number;
  requestId?: string;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AgentTask {
  id: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

// ── Execution Outcome Contract ───────────────────────────────────────
// One aggregate RunOutcome composed of one or more ModelAttemptOutcomes, with
// explicit termination, recovery, artifacts, checks, and cost. Two levels
// because a single logical run can span multiple model attempts (fallback:
// model A fails empty → model B succeeds): routing (Thompson/quarantine) needs
// per-attempt evidence, while surfaces (workflow/pipeline/UI/trajectory) need
// one aggregate. A flat outcome would erase model A's failure.

/** Why a single model attempt (or the aggregate run) stopped producing. */
export type StopCause =
  | "natural_stop" // model finished on its own
  | "step_cap_reached" // hit the max-steps budget mid-work
  | "empty_output" // produced no usable text
  | "truncated_tool_call" // stream ended mid tool-call assembly
  | "output_limit" // provider length / max_tokens
  | "content_filtered" // provider content filter
  | "error" // threw
  | "budget_exhausted" // cost ceiling
  | "fallback_exhausted" // all fallback models tried, none succeeded
  | "aborted"; // cancelled by signal

/**
 * Tri-state gate result. `not_run` (gate was skipped) and `unknown` (gate ran
 * but couldn't decide) are distinct from `failed` — an optional boolean can't
 * express that. Security especially: BLOCKING a dangerous action means the
 * security CONTROL succeeded while the requested execution failed; a single
 * `false` conflates the two.
 */
export type CheckStatus = "passed" | "failed" | "not_run" | "unknown";

/** Outcome of one model attempt within a run. Feeds routing learning. */
export interface ModelAttemptOutcome {
  modelId: string;
  taskType: TaskType;
  status: "succeeded" | "failed" | "aborted";
  stopCause: StopCause;
  /** Raw provider finish_reason, when available (diagnostics). */
  providerFinishReason?: string;
  latencyMs: number;
  costUsd: number;
}

/** Aggregate outcome of a logical run. Feeds surfaces + momentum + trajectory. */
export interface RunOutcome {
  status: "succeeded" | "failed" | "partial" | "aborted";
  /** Every model attempt this run made, in order. At least one. */
  attempts: ModelAttemptOutcome[];
  /** The model whose output the run ultimately used (if it succeeded). */
  finalModelId?: string;
  /** How the FIRST attempt terminated — preserved even after recovery, so a
   *  step-capped-then-synthesized run doesn't masquerade as a clean stop. */
  initialStopCause: StopCause;
  /**
   * Ordered sequence of recovery actions the run took, in the order they
   * happened. A single tag can't represent a run that both fell back AND then
   * synthesized (e.g. A-empty → B-tool-only → synthesis) — that erased the
   * fallback. Empty/absent = no recovery (clean run).
   */
  recovery?: Array<
    "fallback" | "forced_synthesis" | "tool_nudge" | "verification_retry"
  >;
  /** Did the run produce usable final text? (distinct from making changes) */
  hasFinalResponse: boolean;
  /** Artifact references produced (files written, etc.), if tracked. */
  producedArtifacts?: string[];
  /** Did the run mutate the workspace? (a coder can edit files yet emit no
   *  final text — it made changes but still needs synthesis) */
  madeChanges?: boolean;
  verification: CheckStatus;
  security: CheckStatus;
  judge: CheckStatus;
  costUsd: number;
}

export type AgentEvent =
  | {
      type: "thinking";
      phase: "classifying" | "routing" | "connecting" | "streaming";
    }
  | { type: "routing"; decision: RoutingDecision }
  | { type: "text-delta"; delta: string }
  | { type: "tool-call-start"; toolName: string; args: unknown }
  | { type: "tool-call-result"; toolName: string; result: unknown }
  | { type: "step-complete"; text: string; toolCalls: unknown[] }
  | { type: "gateway-feedback"; feedback: GatewayFeedbackData }
  | {
      type: "compaction";
      removed: number;
      tokensBefore: number;
      tokensAfter: number;
    }
  | { type: "tool-output-partial"; toolName: string; chunk: string }
  | { type: "task-created"; task: AgentTask }
  | { type: "task-updated"; task: AgentTask }
  | {
      type: "subagent-result";
      subagentType: string;
      model: string;
      cost: number;
      toolCalls: string[];
    }
  | { type: "reasoning"; content: string }
  | {
      type: "background-complete";
      taskId: string;
      command: string;
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | { type: "model-retry"; fromModel: string; toModel: string; reason: string }
  | { type: "fallback-exhausted"; modelsTried: string[]; reason: string }
  | { type: "budget-warning"; used: number; limit: number; remaining: number }
  | { type: "empty-response"; modelId: string }
  | { type: "context-budget"; used: number; limit: number; percent: number }
  | { type: "loop-warning"; message: string }
  | {
      type: "verify-passed";
      iteration: number;
      mode: "typecheck" | "full";
    }
  | {
      type: "verify-failed";
      iteration: number;
      maxIterations: number;
      diagnostics: string;
    }
  | {
      type: "tool-nudge";
      iteration: number;
      maxNudges: number;
    }
  | {
      type: "daemon-tick";
      tickNumber: number;
      idleSeconds: number;
      cost: number;
    }
  | { type: "daemon-sleep"; sleepMs: number; reason: string }
  | { type: "daemon-wake"; trigger: "timer" | "user" | "scheduler" }
  | { type: "daemon-stopped"; tickCount: number; totalCost: number }
  | { type: "interrupted" }
  | {
      type: "error";
      error: Error;
      category?: "model-api" | "database" | "middleware" | "unknown";
    }
  | {
      type: "done";
      totalCost: number;
      totalTokens?: { input: number; output: number };
      /** The canonical run outcome. Additive: existing consumers keep reading
       *  totalCost/totalTokens while surfaces migrate to `outcome`. */
      outcome?: RunOutcome;
    };

// ── Turn Context ─────────────────────────────────────────────────────

/** Per-turn state injected between turns so the agent knows what just happened. */
export interface TurnContext {
  turn: number;
  model: string;
  strategy: string;
  toolCalls: Array<{ name: string; ok: boolean }>;
  turnCost: number;
  budgetRemaining: number;
  budgetPercent: number;
  filesRead: string[];
  filesWritten: string[];
  sessionMinutes: number;
  unhealthyTools: Array<{ name: string; error: string }>;
  buildStatus: "passing" | "failing" | "unknown";
  buildWarning: string;
  costPerHour: number;
}

/** Format TurnContext as a compact one-line summary for system message injection. */
export function formatTurnContext(ctx: TurnContext): string {
  const tools =
    ctx.toolCalls.length > 0
      ? ctx.toolCalls.map((t) => `${t.name}${t.ok ? "" : "✗"}`).join(" ")
      : "none";
  const files = [
    ...ctx.filesRead.map((f) => `${basename(f)}↓`),
    ...ctx.filesWritten.map((f) => `${basename(f)}↑`),
  ];
  const fileStr = files.length > 0 ? files.slice(0, 6).join(" ") : "";
  const parts = [
    `Turn ${ctx.turn}`,
    ctx.model,
    `tools: ${tools}`,
    `$${ctx.turnCost.toFixed(3)}`,
    `budget ${ctx.budgetPercent}%`,
  ];
  if (fileStr) parts.push(`files: ${fileStr}`);
  if (ctx.unhealthyTools.length > 0) {
    parts.push(`unhealthy: ${ctx.unhealthyTools.map((t) => t.name).join(",")}`);
  }
  if (ctx.buildStatus !== "unknown") {
    parts.push(`build: ${ctx.buildStatus}`);
  }
  parts.push(`${ctx.sessionMinutes}min`);
  if (ctx.costPerHour > 0) parts.push(`$${ctx.costPerHour.toFixed(2)}/hr`);
  let result = `[${parts.join(" | ")}]`;
  if (ctx.buildWarning) result += `\n${ctx.buildWarning}`;
  return result;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

// ── Tool System ──────────────────────────────────────────────────────

export type ToolPermission = "auto" | "confirm" | "deny";
export type PermissionMode = "auto" | "confirm" | "plan";

export interface ToolDefinition {
  name: string;
  description: string;
  permission: ToolPermission;
}

// ── Agent Profiles ──────────────────────────────────────────────────

export type AgentRole =
  | "architect"
  | "coder"
  | "reviewer"
  | "debugger"
  | "analyst"
  | "orchestrator"
  | "product-manager"
  | "security-reviewer"
  | "code-reviewer"
  | "style-reviewer"
  | "qa"
  | "compliance"
  | "devops"
  | "custom";
export type AgentLifecycle = "active" | "suspended";

export interface AgentGuardrails {
  pii?: boolean;
  topicRestriction?: string;
}

export interface AgentBudgetConfig {
  perWorkflow?: number;
  daily?: number;
  exhaustionAction: "downgrade" | "stop";
  downgradeModelId?: string;
}

export interface AgentProfile {
  id: string;
  displayName: string;
  role: AgentRole;
  description: string;
  modelId: string;
  systemPrompt?: string;
  allowedTools: string[] | "all";
  outputFormat?: string;
  budget: AgentBudgetConfig;
  confidenceThreshold: number;
  maxSteps: number;
  fallbackChain: string[];
  guardrails: AgentGuardrails;
  lifecycle: AgentLifecycle;
  createdAt: number;
  updatedAt: number;
}

// ── Workflow Engine ─────────────────────────────────────────────────

export type WorkflowStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";
export type CommunicationMode = "handoff" | "shared" | "parallel";

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStepDef[];
  communicationMode: CommunicationMode;
  maxIterations: number;
}

export interface WorkflowStepDef {
  id: string;
  agentRole: AgentRole;
  agentId?: string;
  description: string;
  inputArtifacts: string[];
  outputArtifact: string;
  outputSchema?: string;
  isReviewStep: boolean;
  loopBackTo?: string;
  skipCondition?: string;
  /** Shell commands that must exit 0 before proceeding to the next step. */
  killGates?: string[];
}

export interface Artifact {
  id: string;
  stepId: string;
  agentId: string;
  content: string;
  contentType: "text" | "code" | "json" | "markdown";
  metadata: Record<string, unknown>;
  confidence: number;
  cost: number;
  timestamp: number;
  diskPath?: string;
  iteration: number;
  /**
   * DeerFlow-style output/scratch separation. "output" (the default when
   * omitted) means the artifact is a finished, user-facing deliverable;
   * "scratch" means it's working/intermediate material (e.g. a
   * review-loop iteration that got superseded) kept for traceability but
   * not meant to be surfaced as a final result.
   */
  kind?: "output" | "scratch";
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  description: string;
  status: WorkflowStatus;
  steps: WorkflowStepRun[];
  artifacts: Artifact[];
  totalCost: number;
  estimatedCost: number;
  iteration: number;
  maxIterations: number;
  communicationMode: CommunicationMode;
  continueFromRunId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStepRun {
  id: string;
  stepDefId: string;
  agentId: string;
  status: StepStatus;
  artifactId?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  cost: number;
  iteration: number;
}

// ── Workflow Events ─────────────────────────────────────────────────

export type WorkflowEvent =
  | { type: "workflow-started"; run: WorkflowRun }
  | { type: "step-started"; step: WorkflowStepRun; agent: AgentProfile }
  | { type: "step-progress"; stepId: string; event: AgentEvent }
  | { type: "step-completed"; step: WorkflowStepRun; artifact: Artifact }
  | { type: "step-failed"; step: WorkflowStepRun; error: Error }
  | {
      type: "review-rejected";
      step: WorkflowStepRun;
      reason: string;
      loopingBackTo: string;
    }
  | {
      type: "confidence-escalation";
      step: WorkflowStepRun;
      confidence: number;
      action: string;
    }
  | {
      type: "budget-warning";
      agent: AgentProfile;
      remaining: number;
      action: string;
    }
  | {
      type: "model-fallback";
      originalModel: string;
      fallbackModel: string;
      reason: string;
      costImpact: number;
    }
  | {
      type: "provider-degraded";
      provider: string;
      errorCount: number;
      resumeAt: number;
    }
  | {
      type: "cost-forecast";
      estimated: number;
      breakdown: Array<{ step: string; cost: number }>;
    }
  | { type: "gate-passed"; step: WorkflowStepRun; gate: string }
  | { type: "gate-failed"; step: WorkflowStepRun; gate: string; output: string }
  | { type: "workflow-paused"; reason: string; run: WorkflowRun }
  | { type: "workflow-completed"; run: WorkflowRun }
  | { type: "workflow-failed"; run: WorkflowRun; error: Error };

// ── Enhanced Intelligence ──────────────────────────────────────────

export interface ComplexityAssessment {
  score: number;
  level: "simple" | "moderate" | "complex";
  signals: Record<string, number>;
}

export interface RequestShape {
  hasTools: boolean;
  hasImages: boolean;
  hasSystem: boolean;
  messageCountBucket: number;
  estimatedTokensBucket: number;
  contentComplexityScore: number;
  isWindingDown: boolean;
  taskType: string;
}

export interface BanditArm {
  modelKey: string;
  rewardMean: number;
  rewardVar: number;
  sampleCount: number;
  validityMean: number;
  qualityMean: number | null;
}

// ── Projects ────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string;
  customInstructions?: string;
  knowledgeFiles: string[];
  budgetDaily?: number;
  budgetMonthly?: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMemoryEntry {
  id: number;
  projectId: string;
  key: string;
  value: string;
  category: "general" | "decision" | "convention" | "warning";
  createdAt: number;
  updatedAt: number;
}

// ── Scheduled Tasks ─────────────────────────────────────────────────

export type ScheduledTaskStatus = "active" | "paused" | "expired" | "deleted";
export type TaskRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "budget_exceeded"
  | "timeout"
  | "cancelled"
  | "crashed";
export type ExecutionMode = "daemon" | "trigger";
export type TriggerType = "cron" | "manual" | "daemon";

export interface ScheduledTask {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  cronExpression?: string;
  executionMode: ExecutionMode;
  allowMutations: boolean;
  budgetLimit?: number;
  maxTurns: number;
  timeoutMs: number;
  modelId?: string;
  status: ScheduledTaskStatus;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  sessionId?: string;
  status: TaskRunStatus;
  triggerType: TriggerType;
  outputSummary?: string;
  cost: number;
  turnsUsed: number;
  error?: string;
  trajectoryPath?: string;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
}

// ── Platform Contract ───────────────────────────────────────────────

export type RiskLevel = "read_only" | "low" | "medium" | "high" | "critical";
export type EvidenceType = "observation" | "execution" | "decision";

/** Tool schema exposed by a product through the God Mode contract. */
export interface GodModeTool {
  name: string;
  domain: string;
  product: string;
  description: string;
  parameters: Record<string, unknown>;
  risk_level: RiskLevel;
  requires_changeset: boolean;
  evidence_type?: EvidenceType;
}

/** Cross-product event with tamper-evident signing. */
export interface PlatformEvent {
  id: string;
  type: string;
  tenant_id: string;
  product: string;
  timestamp: string;
  data: Record<string, unknown>;
  schema_version: number;
  correlation_id?: string;
  signature: string;
}

/** Platform tenant record. */
export interface PlatformTenant {
  id: string;
  name: string;
  slug: string;
  plan: "starter" | "professional" | "enterprise";
  status: "active" | "suspended" | "deprovisioned";
  products: Record<string, { enabled: boolean; role: string }>;
  created_at: string;
}

/** Product health as reported by the platform. */
export interface ProductHealth {
  product: string;
  status: "healthy" | "degraded" | "unreachable";
  latency_ms: number;
  tool_count: number;
  capabilities: string[];
  last_checked: string;
}

/** API response envelope for the serve command. */
export interface PlatformApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  request_id: string;
  timestamp: string;
}

// ── Orchestration ───────────────────────────────────────────────────

export type OrchestrationStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial" // some tasks succeeded, some failed
  | "failed"
  | "cancelled";
export type OrchTaskStatus =
  | "pending"
  | "in_progress"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

export interface OrchestrationRun {
  id: string;
  name: string;
  description: string;
  leadSessionId?: string;
  status: OrchestrationStatus;
  projectIds: string[];
  budgetLimit?: number;
  totalCost: number;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestrationTask {
  id: string;
  runId: string;
  projectId: string;
  prompt: string;
  status: OrchTaskStatus;
  subagentType: string;
  resultSummary?: string;
  cost: number;
  sessionId?: string;
  dependsOn: string[];
  startedAt?: number;
  completedAt?: number;
  /** Worker process ID that has claimed this task. Set by claimNext().
   * Added in migration 029 for the Planner/Worker/Judge MVP. */
  assignedWorker?: string;
  /** Path to the git worktree this task is operating in. */
  worktreePath?: string;
  /** Files this task has modified, captured at completion. Used by the
   * Judge for conflict detection across parallel workers. */
  filesTouched?: string[];
  /** Error message if status === 'failed'. */
  error?: string;
  /** Optional AgentContract this task executes against (contract layer). When
   * set, the worker renders the contract instead of the freeform prompt.
   * Added in migration 035; undefined for pre-contract rows. */
  contractId?: string;
  /** Revise-loop attempt number. 0 (or undefined) = the original attempt;
   * N>0 = the Nth revise re-enqueue. Added in migration 037. */
  attempt?: number;
  /** For a revise re-enqueue: the id of the superseded task row this one
   * retries. Forms the lineage chain original → retry → retry. */
  retryOf?: string;
  /** Model-rotation outcome stamped on a revise attempt:
   * 'rotated:<modelId>' | 'degraded-same-model' | 'pinned-global-model'. */
  rotation?: string;
}

/**
 * Transient corrective feedback threaded into a revise re-attempt. Built from
 * the prior gate's PanelDecision and rendered as a deterministic "Prior
 * attempt" section by renderContractPrompt(priorAttempt). NEVER mutates the
 * contract — it is render-time context only, like producerConfidence.
 */
export interface PriorAttemptFeedback {
  /** 1-based revise attempt number. */
  attempt: number;
  /** Acceptance criteria the prior panel judged unmet, with evidence. */
  failedCriteria: { criterion: string; evidence?: string }[];
  /** Top findings from the prior panel, highest severity first. */
  findings: { severity: string; description: string; file?: string }[];
  /** Losing-side judge rationales from the prior panel (judgeId: rationale). */
  dissent: string[];
  /** One-paragraph combined rationale from the prior panel. */
  summary: string;
}

// ── Contract layer ───────────────────────────────────────────────────
//
// The AgentContract is the persisted, typed interface that crosses a model
// boundary. Where the freeform path passes a prose prompt (whose intent lives
// only in the producing model's context window and is lost on compaction /
// model switch), the contract serializes the load-bearing intent, deliverable
// shape, acceptance gates, and authority at authoring time. Plain interfaces
// only — the behaviour (Zod validation, rendering, gates) lives in
// @brainst0rm/contracts.

/**
 * A machine-checkable acceptance criterion for a contract. Deterministic kinds
 * (schema/command/files_touched_within) are evaluated for free by
 * runAcceptanceGates; panel/criterion kinds are dispatched to a JudgePanel.
 */
export type AcceptanceGate =
  | { kind: "schema" }
  | { kind: "command"; cmd: string; timeoutMs?: number }
  | { kind: "files_touched_within"; paths: string[] }
  | { kind: "panel"; panelConfigRef?: string; quorum?: QuorumSpec }
  | { kind: "criterion"; text: string };

/**
 * The durable interface object that crosses an agent-to-agent boundary.
 */
export interface AgentContract {
  id: string; // ct_<ulid-ish>
  version: 1;
  // WHY — the piece lost first in freeform handoffs.
  intent: string; // one-paragraph rationale: what problem, why now
  context: string; // durable background the consumer needs (survives compaction)
  nonGoals?: string[]; // explicit "do not do"
  // WHAT IN
  inputs: {
    task: string; // the imperative instruction (replaces the freeform prompt)
    artifacts?: string[]; // named input artifact ids / file paths
    inputSchemaRef?: string; // optional OUTPUT_SCHEMAS key describing structured input
    inputData?: unknown; // validated against inputSchemaRef if both present
  };
  // WHAT OUT
  output: {
    schemaRef?: string; // key into OUTPUT_SCHEMAS
    inlineSchemaJson?: string; // escape hatch: serialized JSON-Schema for ad-hoc shapes
    contentType: "json" | "text" | "code" | "markdown";
  };
  // HOW WE KNOW IT'S DONE
  acceptance: AcceptanceGate[];
  // AUTHORITY — what the consumer may do (maps onto the narrowing chain).
  authority: {
    toolAllowlist?: string[];
    maxSteps?: number;
    budgetLimitUsd?: number;
    readOnly?: boolean;
    scopePaths?: string[]; // advisory path fence (worktree path for orchestrator tasks)
  };
  // PROVENANCE — who wrote it, who executed against it.
  provenance: {
    producerAgentId?: string;
    producerModelId?: string;
    runId?: string;
    taskId?: string;
    parentContractId?: string;
    createdAt: number;
  };
  status:
    | "draft"
    | "issued"
    | "executing"
    | "fulfilled"
    | "failed"
    | "rejected";
}

// ── Judge panels ─────────────────────────────────────────────────────
//
// Decorrelated verification as a first-class primitive: N judges across
// distinct provider families and lenses review the same artifact in isolation
// (no anchoring), and a pure aggregation function decides the outcome. Plain
// types only; dispatch/aggregation behaviour lives in @brainst0rm/contracts.

export interface PanelJudgeSpec {
  lens:
    | "correctness"
    | "security"
    | "performance"
    | "reproducibility"
    | "contract-fit"
    | string;
  modelId?: string; // pinned; else selected by the diversity selector
  weight?: number; // default 1; deterministic lenses may get weight 2
  systemPromptRef?: string; // lens prompt template; defaults per lens
}

export type QuorumSpec =
  | { kind: "majority" }
  | { kind: "threshold"; passFraction: number }
  | { kind: "weighted"; passWeightFraction: number }
  | { kind: "unanimous-veto"; vetoLenses: string[] };

export interface PanelConfig {
  judges: PanelJudgeSpec[]; // N >= 0
  diversity: "provider" | "model" | "none"; // provider = distinct provider families REQUIRED
  quorum: QuorumSpec;
  budgetLimitUsd?: number; // hard cap across all judges
  includeDeterministic?: boolean; // fold the build/test verdict in as a weighted panelist
}

/**
 * A single reviewer finding. Mirrors the orchestration pipeline's ReviewFinding
 * shape so structured verdicts can replace the pipeline's regex scanning.
 */
export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  file?: string;
  line?: number;
  reviewer: string;
}

/** One judge's structured verdict on an artifact. */
export interface Verdict {
  judgeId: string; // `${lens}:${modelId}`
  lens: string;
  modelId: string;
  provider: string; // recorded for decorrelation audit
  pass: boolean;
  score?: number; // 0-1
  confidence: number; // judge's own, 0-1
  rationale: string;
  findings: ReviewFinding[];
  criteriaResults?: {
    criterion: string;
    pass: boolean;
    evidence?: string;
  }[]; // per acceptance 'criterion' gate
  cost: number;
  durationMs: number;
  error?: string; // judge failed to run — excluded from quorum denominator, recorded
}

/** The aggregated outcome of a panel of judges. */
export interface PanelDecision {
  panelId: string;
  decision: "approve" | "revise" | "reject";
  verdicts: Verdict[];
  quorum: { required: number; achieved: number; rule: string };
  dissent: string[]; // rationales of losing-side judges — surfaced, never discarded
  combinedRationale: string; // deterministic template: tally + top findings + dissent
  totalCost: number;
}
