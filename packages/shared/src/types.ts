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

export interface ToolDefinition {
  name: string;
  description: string;
  permission: ToolPermission;
}
