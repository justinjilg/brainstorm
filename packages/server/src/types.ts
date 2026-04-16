/**
 * Server types — request/response shapes for the Brainstorm API.
 */

// ── API Envelope ────────────────────────────────────────────────────

export interface ApiEnvelope<T> {
  ok: true;
  data: T;
  request_id: string;
  timestamp: string;
}

export interface ApiError {
  ok: false;
  error: string;
  request_id: string;
  timestamp: string;
}

export type ApiResponse<T> = ApiEnvelope<T> | ApiError;

// ── Server Options ──────────────────────────────────────────────────

export interface ServerOptions {
  port?: number;
  host?: string;
  cors?: boolean;
  /**
   * Origins allowed when cors is enabled. If omitted or empty, no CORS
   * headers are emitted — this prevents a `*` wildcard from leaking
   * credentialed responses (e.g. SSE chat streams) to attacker origins.
   */
  allowedOrigins?: string[];
  /** JWT secret for auth. If not set, runs in dev mode (no auth). */
  jwtSecret?: string;
  /** Project path for the server context. */
  projectPath?: string;
}

// ── Chat ────────────────────────────────────────────────────────────

export interface ChatRequest {
  message: string;
  /** Resume an existing session. */
  sessionId?: string;
  /** Chat within a specific conversation. */
  conversationId?: string;
  /** Override model for this request. */
  modelId?: string;
}

export interface ChatResponse {
  response: string;
  sessionId: string;
  conversationId?: string;
  cost: number;
}

// ── Conversations ───────────────────────────────────────────────────

export interface CreateConversationRequest {
  name?: string;
  description?: string;
  tags?: string[];
  modelOverride?: string;
  memoryOverrides?: Record<string, string | null>;
  metadata?: Record<string, unknown>;
}

export interface UpdateConversationRequest {
  name?: string;
  description?: string;
  tags?: string[];
  modelOverride?: string | null;
  memoryOverrides?: Record<string, string | null>;
  metadata?: Record<string, unknown>;
  isArchived?: boolean;
}

export interface HandoffRequest {
  modelId: string;
}

// ── Health ───────────────────────────────────────────────────────────

export interface HealthResponse {
  status: "healthy" | "degraded";
  version: string;
  uptime_seconds: number;
  god_mode: {
    connected: number;
    tools: number;
  };
  conversations: {
    active: number;
  };
}

// ── Tool Execution ──────────────────────────────────────────────────

export interface ToolExecuteRequest {
  tool: string;
  params?: Record<string, unknown>;
}

export interface ToolExecuteResponse {
  tool: string;
  result: unknown;
  executed_at: string;
}
