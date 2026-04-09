import type { AgentEvent } from "./lib/api-client";

interface BrainstormBridge {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  chatStream(params: Record<string, unknown>): Promise<void>;
  onChatEvent(callback: (event: AgentEvent) => void): () => void;
  openFolder(): Promise<string | null>;
}

declare global {
  interface Window {
    brainstorm?: BrainstormBridge;
  }
}
