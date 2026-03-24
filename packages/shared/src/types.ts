// ── Task Classification ──────────────────────────────────────────────

export type TaskType =
  | 'simple-edit'
  | 'code-generation'
  | 'refactoring'
  | 'debugging'
  | 'explanation'
  | 'conversation'
  | 'analysis'
  | 'search'
  | 'multi-file-edit';

export type Complexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';

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
export type ModelStatus = 'available' | 'degraded' | 'unavailable';

export interface ModelCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  vision: boolean;
  reasoning: boolean;
  contextWindow: number;
  qualityTier: QualityTier;
  speedTier: SpeedTier;
  bestFor: TaskType[];
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

export type StrategyName = 'cost-first' | 'quality-first' | 'rule-based' | 'combined';

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
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  modelId?: string;
  tokenCount?: number;
  timestamp: number;
}

// ── Events ───────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'routing'; decision: RoutingDecision }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call-start'; toolName: string; args: unknown }
  | { type: 'tool-call-result'; toolName: string; result: unknown }
  | { type: 'step-complete'; text: string; toolCalls: unknown[] }
  | { type: 'error'; error: Error }
  | { type: 'done'; totalCost: number };

// ── Tool System ──────────────────────────────────────────────────────

export type ToolPermission = 'auto' | 'confirm' | 'deny';
export type PermissionMode = 'auto' | 'confirm' | 'plan';

export interface ToolDefinition {
  name: string;
  description: string;
  permission: ToolPermission;
}

// ── Agent Profiles ──────────────────────────────────────────────────

export type AgentRole = 'architect' | 'coder' | 'reviewer' | 'debugger' | 'analyst' | 'custom';
export type AgentLifecycle = 'active' | 'suspended';

export interface AgentGuardrails {
  pii?: boolean;
  topicRestriction?: string;
}

export interface AgentBudgetConfig {
  perWorkflow?: number;
  daily?: number;
  exhaustionAction: 'downgrade' | 'stop';
  downgradeModelId?: string;
}

export interface AgentProfile {
  id: string;
  displayName: string;
  role: AgentRole;
  description: string;
  modelId: string;
  systemPrompt?: string;
  allowedTools: string[] | 'all';
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

export type WorkflowStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type CommunicationMode = 'handoff' | 'shared';

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
}

export interface Artifact {
  id: string;
  stepId: string;
  agentId: string;
  content: string;
  contentType: 'text' | 'code' | 'json' | 'markdown';
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
  | { type: 'workflow-started'; run: WorkflowRun }
  | { type: 'step-started'; step: WorkflowStepRun; agent: AgentProfile }
  | { type: 'step-progress'; stepId: string; event: AgentEvent }
  | { type: 'step-completed'; step: WorkflowStepRun; artifact: Artifact }
  | { type: 'step-failed'; step: WorkflowStepRun; error: Error }
  | { type: 'review-rejected'; step: WorkflowStepRun; reason: string; loopingBackTo: string }
  | { type: 'confidence-escalation'; step: WorkflowStepRun; confidence: number; action: string }
  | { type: 'budget-warning'; agent: AgentProfile; remaining: number; action: string }
  | { type: 'model-fallback'; originalModel: string; fallbackModel: string; reason: string; costImpact: number }
  | { type: 'provider-degraded'; provider: string; errorCount: number; resumeAt: number }
  | { type: 'cost-forecast'; estimated: number; breakdown: Array<{ step: string; cost: number }> }
  | { type: 'workflow-completed'; run: WorkflowRun }
  | { type: 'workflow-failed'; run: WorkflowRun; error: Error };

// ── Enhanced Intelligence ──────────────────────────────────────────

export interface ComplexityAssessment {
  score: number;
  level: 'simple' | 'moderate' | 'complex';
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
