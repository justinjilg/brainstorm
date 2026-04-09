/**
 * IPC Client — communicates with the Brainstorm backend.
 *
 * Two modes (auto-detected):
 * 1. Electron: window.brainstorm.request() — direct IPC to main process
 * 2. Browser: HTTP fetch to localhost:3100 — dev mode fallback
 */

import type { AgentEvent } from "./api-client";

// Re-export types that components depend on
export type { AgentEvent, Conversation, HealthResponse } from "./api-client";

/** Detect runtime environment. */
function getRuntime(): "electron" | "browser" {
  if (typeof window !== "undefined" && "brainstorm" in window)
    return "electron";
  return "browser";
}

/**
 * Send a request-response IPC call to the backend.
 */
export async function request<T>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const runtime = getRuntime();

  if (runtime === "electron") {
    return window.brainstorm!.request(method, params) as Promise<T>;
  }

  return httpFallback<T>(method, params);
}

/**
 * Start a streaming chat and receive events via callback.
 */
export async function streamChat(
  params: {
    message: string;
    conversationId?: string;
    modelId?: string;
    role?: string;
    activeSkills?: string[];
  },
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const runtime = getRuntime();

  if (runtime === "electron") {
    const unlisten = window.brainstorm!.onChatEvent(onEvent);
    try {
      await window.brainstorm!.chatStream(params);
    } finally {
      unlisten();
    }
    return;
  }

  await httpStreamFallback(params, onEvent, signal);
}

/**
 * Abort the current chat stream.
 */
export async function abortChat(): Promise<void> {
  // Abort handled by AbortController signal
}

/**
 * Check if the backend is alive.
 */
export async function isBackendAlive(): Promise<boolean> {
  const runtime = getRuntime();

  if (runtime === "electron") {
    try {
      await window.brainstorm!.request("health");
      return true;
    } catch {
      return false;
    }
  }

  try {
    const res = await fetch("http://localhost:3100/health", {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── HTTP Fallback (browser dev mode) ─────────────────────────────

const HTTP_BASE = "http://localhost:3100";

async function httpFallback<T>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const urlMap: Record<string, { url: string; httpMethod: string }> = {
    // Tools
    "tools.list": { url: "/api/v1/tools", httpMethod: "GET" },
    // Memory
    "memory.list": { url: "/api/v1/memory", httpMethod: "GET" },
    "memory.create": { url: "/api/v1/memory", httpMethod: "POST" },
    "memory.update": {
      url: `/api/v1/memory/${params?.id ?? ""}`,
      httpMethod: "PATCH",
    },
    "memory.delete": {
      url: `/api/v1/memory/${params?.id ?? ""}`,
      httpMethod: "DELETE",
    },
    // Skills
    "skills.list": { url: "/api/v1/skills", httpMethod: "GET" },
    // Models
    "models.list": { url: "/api/v1/models", httpMethod: "GET" },
    // Conversations
    "conversations.list": { url: "/api/v1/conversations", httpMethod: "GET" },
    "conversations.create": {
      url: "/api/v1/conversations",
      httpMethod: "POST",
    },
    "conversations.fork": {
      url: `/api/v1/conversations/${params?.id ?? ""}/fork`,
      httpMethod: "POST",
    },
    "conversations.handoff": {
      url: `/api/v1/conversations/${params?.id ?? ""}/handoff`,
      httpMethod: "POST",
    },
    "conversations.messages": {
      url: `/api/v1/conversations/${params?.sessionId ?? ""}/messages`,
      httpMethod: "GET",
    },
    // Config
    "config.get": { url: "/api/v1/config", httpMethod: "GET" },
    // KAIROS
    "kairos.status": { url: "/api/v1/kairos/status", httpMethod: "GET" },
    "kairos.start": { url: "/api/v1/kairos/start", httpMethod: "POST" },
    "kairos.stop": { url: "/api/v1/kairos/stop", httpMethod: "POST" },
    "kairos.pause": { url: "/api/v1/kairos/pause", httpMethod: "POST" },
    "kairos.resume": { url: "/api/v1/kairos/resume", httpMethod: "POST" },
    // Security
    "security.redteam": {
      url: "/api/v1/security/red-team",
      httpMethod: "POST",
    },
    // Workflows
    "workflow.presets": { url: "/api/v1/workflows/presets", httpMethod: "GET" },
    "workflow.run": { url: "/api/v1/workflows/run", httpMethod: "POST" },
    // Health
    health: { url: "/health", httpMethod: "GET" },
  };

  const route = urlMap[method];
  if (!route) throw new Error(`Unknown IPC method: ${method}`);

  const opts: RequestInit = { method: route.httpMethod };
  if (route.httpMethod !== "GET" && params) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(params);
  }

  const res = await fetch(`${HTTP_BASE}${route.url}`, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const body = await res.json();
  return body.ok ? body.data : body;
}

async function httpStreamFallback(
  params: { message: string; conversationId?: string; modelId?: string },
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${HTTP_BASE}/api/v1/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal,
  });

  if (!res.ok || !res.body) {
    onEvent({
      type: "error",
      error: `Server returned ${res.status}: ${res.statusText}`,
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        try {
          onEvent(JSON.parse(data) as AgentEvent);
        } catch {
          // Malformed JSON — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
