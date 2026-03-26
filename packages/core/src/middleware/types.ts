/**
 * Agent Middleware — composable interceptors for the agent loop.
 *
 * Inspired by DeerFlow's 12-middleware pipeline, adapted for Brainstorm's
 * TypeScript architecture. Each middleware handles one cross-cutting concern.
 */

export interface AgentMiddleware {
  /** Unique middleware name. */
  name: string;

  /** Called before each agent turn. Modify state or inject context. */
  beforeAgent?(state: MiddlewareState): MiddlewareState | void;

  /** Called after model response, before tool execution. Modify or filter the response. */
  afterModel?(message: MiddlewareMessage): MiddlewareMessage | void;

  /** Called before each tool execution. Can modify, block, or redirect. */
  wrapToolCall?(call: MiddlewareToolCall): MiddlewareToolCall | MiddlewareBlock | void;

  /** Called after each tool execution. Modify the result or trigger side effects. */
  afterToolResult?(result: MiddlewareToolResult): MiddlewareToolResult | void;
}

export interface MiddlewareState {
  turn: number;
  messages: Array<{ role: string; content: string }>;
  systemPrompt: string;
  toolNames: string[];
  metadata: Record<string, unknown>;
}

export interface MiddlewareMessage {
  text: string;
  toolCalls: MiddlewareToolCall[];
  model: string;
  tokens: { input: number; output: number };
}

export interface MiddlewareToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface MiddlewareToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  output: unknown;
  error?: string;
  durationMs: number;
}

export interface MiddlewareBlock {
  blocked: true;
  reason: string;
  middleware: string;
}

/** Type guard for blocked tool calls. */
export function isBlocked(result: MiddlewareToolCall | MiddlewareBlock | void): result is MiddlewareBlock {
  return result !== undefined && result !== null && 'blocked' in result && result.blocked === true;
}
