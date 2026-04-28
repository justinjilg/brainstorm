import type { AgentEvent } from "./lib/api-client";
import type { OpenDialogResult } from "./lib/harness-types";

// Result returned by detectHarness / parseHarness IPC routes.
// Matches the discriminated union main.ts emits — see harness-types.ts
// for the canonical OpenDialogResult; detect/parse omit the "cancel"
// variant since they don't open dialogs.
type DetectOrParseResult = Exclude<OpenDialogResult, { kind: "cancel" }>;

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
  /** Open folder picker → detect harness → return discriminated result. */
  openHarnessDialog(): Promise<OpenDialogResult>;
  /** Walk up from path looking for business.toml; return result. */
  detectHarness(path: string): Promise<DetectOrParseResult>;
  /** Re-parse a known harness's manifest. */
  parseHarness(root: string): Promise<DetectOrParseResult>;
  /** Open the index session for a harness; runs cold-open verify. */
  openHarnessSession(root: string): Promise<
    | {
        ok: true;
        harnessId: string;
        verify: {
          clean: number;
          stale: string[];
          missing: string[];
          unindexedCount: number;
        };
      }
    | { ok: false; error: string }
  >;
  /** Close the active index session. */
  closeHarnessSession(): Promise<{ ok: true }>;
  /** List indexed artifacts under a folder prefix (e.g. "team", "products"). */
  listHarnessFolder(folderSlug: string): Promise<{
    folder: string;
    artifacts: Array<{
      relative_path: string;
      artifact_kind: string;
      owner: string | null;
      status: string | null;
      reviewed_at: string | null;
      size_bytes: number;
      mtime_ms: number;
    }>;
  }>;
  /** Run the customer-account intent ↔ runtime drift detector. */
  detectCustomerDrift(): Promise<{
    drifts: Array<{
      id: string;
      relative_path: string;
      field_path: string;
      intent_value: string | null;
      observed_value: string | null;
      severity: string;
    }>;
    unobserved_accounts: string[];
  }>;
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
