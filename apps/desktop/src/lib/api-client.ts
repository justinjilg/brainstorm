/**
 * BrainstormServer API Client — typed HTTP + SSE client for the desktop app.
 *
 * Wraps all 24 server endpoints. Chat streaming uses fetch + ReadableStream
 * to parse SSE events without external dependencies.
 */

const DEFAULT_BASE = "http://localhost:3100";

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
  conversationId?: string;
  modelId?: string;
}

export interface Conversation {
  id: string;
  name: string;
  projectPath: string;
  description?: string;
  tags: string[];
  modelOverride?: string;
  createdAt: string;
  lastMessageAt: string;
  isArchived: boolean;
}

export interface HealthResponse {
  status: "healthy" | "degraded";
  version: string;
  uptime_seconds: number;
  god_mode: { connected: number; tools: number };
  conversations: { active: number };
}

interface ApiEnvelope<T> {
  ok: true;
  data: T;
}

export class BrainstormClient {
  private base: string;

  constructor(baseUrl?: string) {
    this.base = baseUrl ?? DEFAULT_BASE;
  }

  // ── Health ──────────────────────────────────────────────────────

  async health(): Promise<HealthResponse | null> {
    try {
      const res = await fetch(`${this.base}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as ApiEnvelope<HealthResponse>;
      return body.ok ? body.data : null;
    } catch {
      return null;
    }
  }

  // ── Chat (non-streaming) ────────────────────────────────────────

  async chat(
    req: ChatRequest,
  ): Promise<{ response: string; sessionId: string; cost: number } | null> {
    try {
      const res = await fetch(`${this.base}/api/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as ApiEnvelope<{
        response: string;
        sessionId: string;
        cost: number;
      }>;
      return body.ok ? body.data : null;
    } catch {
      return null;
    }
  }

  // ── Chat (SSE streaming) ────────────────────────────────────────

  async *chatStream(
    req: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const res = await fetch(`${this.base}/api/v1/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });

    if (!res.ok || !res.body) {
      yield {
        type: "error",
        error: `Server returned ${res.status}: ${res.statusText}`,
      };
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

        // Parse SSE: lines starting with "data: "
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep incomplete last line

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;

          try {
            const event = JSON.parse(data) as AgentEvent;
            yield event;
          } catch {
            // Malformed JSON — skip
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── Conversations ───────────────────────────────────────────────

  async listConversations(project?: string): Promise<Conversation[]> {
    const params = new URLSearchParams();
    if (project) params.set("project", project);
    try {
      const res = await fetch(`${this.base}/api/v1/conversations?${params}`);
      if (!res.ok) return [];
      const body = (await res.json()) as ApiEnvelope<Conversation[]>;
      return body.ok ? body.data : [];
    } catch {
      return [];
    }
  }

  async createConversation(opts: {
    name?: string;
    description?: string;
    modelOverride?: string;
  }): Promise<Conversation | null> {
    try {
      const res = await fetch(`${this.base}/api/v1/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as ApiEnvelope<Conversation>;
      return body.ok ? body.data : null;
    } catch {
      return null;
    }
  }

  async forkConversation(
    id: string,
    name?: string,
  ): Promise<Conversation | null> {
    try {
      const res = await fetch(`${this.base}/api/v1/conversations/${id}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as ApiEnvelope<Conversation>;
      return body.ok ? body.data : null;
    } catch {
      return null;
    }
  }

  async handoff(id: string, modelId: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.base}/api/v1/conversations/${id}/handoff`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelId }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Tools ───────────────────────────────────────────────────────

  async listTools(): Promise<
    Array<{ name: string; description: string; permission: string }>
  > {
    try {
      const res = await fetch(`${this.base}/api/v1/tools`);
      if (!res.ok) return [];
      const body = (await res.json()) as ApiEnvelope<
        Array<{ name: string; description: string; permission: string }>
      >;
      return body.ok ? body.data : [];
    } catch {
      return [];
    }
  }

  // ── Models ──────────────────────────────────────────────────────

  async listModels(): Promise<
    Array<{
      id: string;
      name: string;
      provider: string;
      status: string;
      pricing: { inputPer1MTokens: number; outputPer1MTokens: number };
    }>
  > {
    // Models come from the health endpoint or a dedicated endpoint
    // For now, return empty — will wire to router in Phase 2
    return [];
  }
}

// Singleton client
let _client: BrainstormClient | null = null;

export function getClient(baseUrl?: string): BrainstormClient {
  if (!_client) {
    _client = new BrainstormClient(baseUrl);
  }
  return _client;
}
