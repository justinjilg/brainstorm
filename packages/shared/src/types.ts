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
      type: "daemon-tick";
      tickNumber: number;
      idleSeconds: number;
      cost: number;
    }
  | { type: "daemon-sleep"; sleepMs: number; reason: string }
  | { type: "daemon-wake"; trigger: "timer" | "user" | "scheduler" }
  | { type: "daemon-stopped"; tickCount: number; totalCost: number }
  | { type: "interrupted" }
  | { type: "error"; error: Error }
  | {
      type: "done";
      totalCost: number;
      totalTokens?: { input: number; output: number };
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
  | "cancelled";
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
  | "failed"
  | "cancelled";
export type OrchTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
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
}
