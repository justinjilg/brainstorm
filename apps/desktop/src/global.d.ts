import type { AgentEvent } from "./lib/api-client";

interface BrainstormBridge {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  chatStream(params: Record<string, unknown>): Promise<void>;
  onChatEvent(callback: (event: AgentEvent) => void): () => void;
  /**
   * Fires when the backend child process is ready. `recovery: true`
   * indicates a respawn after a crash — hooks that hold cached data
   * should refetch. `recovery: false` is the initial boot (the hook's
   * mount-time fetch already covers that case).
   */
  onBackendReady(
    callback: (payload: { recovery: boolean }) => void,
  ): () => void;
  openFolder(): Promise<string | null>;
  /**
   * Query main for the current sticky backendReady flag. Used at mount
   * to resolve the race where main emits "backend-ready" before React
   * attaches its onBackendReady subscription.
   */
  getBackendReady(): Promise<boolean>;
}

declare global {
  interface Window {
    brainstorm?: BrainstormBridge;
  }
}
