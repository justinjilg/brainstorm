/**
 * Shared chat types — extracted from useChat.ts so the pure
 * finalize-turn module (and its protocol-tier trap) can import
 * them without depending on the React hook runtime.
 */

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "routing";
  content: string;
  model?: string;
  provider?: string;
  cost?: number;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  reasoning?: string;
  /**
   * True if the assistant message was cut short by a user abort OR
   * by a backend-side error that arrived mid-stream. UI should render
   * this with a "— stopped" marker so the user knows the response is
   * incomplete (previously partial outputs were silently appended as
   * if complete).
   */
  aborted?: boolean;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  status: "running" | "success" | "error";
  durationMs?: number;
  input?: Record<string, unknown>;
  output?: unknown;
}
