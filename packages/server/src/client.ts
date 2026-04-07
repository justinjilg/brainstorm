/**
 * BrainstormClient — typed HTTP+SSE client for brainstorm server.
 *
 * Used by:
 * - CLI (`brainstorm chat` when connecting to a running server)
 * - Web UI
 * - Other agents (agent-to-agent communication)
 * - MCP bridges
 *
 * Supports both request/response and streaming (SSE) patterns.
 */

import type {
  ApiEnvelope,
  ChatRequest,
  ChatResponse,
  CreateConversationRequest,
  UpdateConversationRequest,
  HandoffRequest,
  HealthResponse,
  ToolExecuteRequest,
  ToolExecuteResponse,
} from "./types.js";
import type { Conversation } from "@brainst0rm/db";

export interface ClientOptions {
  /** Base URL of the brainstorm server (e.g. "http://localhost:8000"). */
  baseUrl: string;
  /** JWT token for authenticated requests. */
  token?: string;
  /** Request timeout in ms. Default: 120000. */
  timeout?: number;
}

export class BrainstormClient {
  private baseUrl: string;
  private token: string | null;
  private timeout: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token ?? null;
    this.timeout = opts.timeout ?? 120_000;
  }

  // ── Health ────────────────────────────────────────────────────────

  async health(): Promise<HealthResponse> {
    return this.get("/health");
  }

  // ── Chat ──────────────────────────────────────────────────────────

  /** Send a chat message and get a complete response. */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const envelope = await this.post<ApiEnvelope<ChatResponse>>(
      "/api/v1/chat",
      request,
    );
    return envelope.data;
  }

  /**
   * Send a chat message and stream events via SSE.
   * Yields parsed AgentEvent objects from the server.
   */
  async *chatStream(
    request: ChatRequest,
  ): AsyncGenerator<Record<string, unknown>> {
    const response = await this.fetchRaw("/api/v1/chat/stream", {
      method: "POST",
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Chat stream failed (${response.status}): ${text}`);
    }

    if (!response.body) throw new Error("No response body for SSE stream");

    const reader = response.body.getReader();
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
            yield JSON.parse(data);
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── Tools ─────────────────────────────────────────────────────────

  /** List all available tools. */
  async listTools(): Promise<unknown[]> {
    const envelope = await this.get<ApiEnvelope<unknown[]>>("/api/v1/tools");
    return envelope.data;
  }

  /** Execute a tool directly. */
  async executeTool(request: ToolExecuteRequest): Promise<ToolExecuteResponse> {
    const envelope = await this.post<ApiEnvelope<ToolExecuteResponse>>(
      "/api/v1/tools/execute",
      request,
    );
    return envelope.data;
  }

  // ── Products ──────────────────────────────────────────────────────

  async listProducts(): Promise<unknown[]> {
    const envelope = await this.get<ApiEnvelope<unknown[]>>("/api/v1/products");
    return envelope.data;
  }

  // ── ChangeSets ────────────────────────────────────────────────────

  async listChangeSets(): Promise<unknown[]> {
    const envelope =
      await this.get<ApiEnvelope<unknown[]>>("/api/v1/changesets");
    return envelope.data;
  }

  async approveChangeSet(id: string): Promise<unknown> {
    const envelope = await this.post<ApiEnvelope<unknown>>(
      `/api/v1/changesets/${id}/approve`,
      {},
    );
    return envelope.data;
  }

  async rejectChangeSet(id: string): Promise<unknown> {
    const envelope = await this.post<ApiEnvelope<unknown>>(
      `/api/v1/changesets/${id}/reject`,
      {},
    );
    return envelope.data;
  }

  // ── Conversations ─────────────────────────────────────────────────

  /** List conversations, optionally filtered by project. */
  async listConversations(opts?: {
    project?: string;
    archived?: boolean;
    limit?: number;
  }): Promise<Conversation[]> {
    const params = new URLSearchParams();
    if (opts?.project) params.set("project", opts.project);
    if (opts?.archived) params.set("archived", "true");
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const envelope = await this.get<ApiEnvelope<Conversation[]>>(
      `/api/v1/conversations${qs ? `?${qs}` : ""}`,
    );
    return envelope.data;
  }

  /** Create a new conversation. */
  async createConversation(
    request: CreateConversationRequest,
  ): Promise<Conversation> {
    const envelope = await this.post<ApiEnvelope<Conversation>>(
      "/api/v1/conversations",
      request,
    );
    return envelope.data;
  }

  /** Get a conversation by ID (includes cost/message totals). */
  async getConversation(
    id: string,
  ): Promise<Conversation & { totalCost: number; totalMessages: number }> {
    const envelope = await this.get<
      ApiEnvelope<Conversation & { totalCost: number; totalMessages: number }>
    >(`/api/v1/conversations/${id}`);
    return envelope.data;
  }

  /** Update a conversation. */
  async updateConversation(
    id: string,
    request: UpdateConversationRequest,
  ): Promise<Conversation> {
    const envelope = await this.fetchJson<ApiEnvelope<Conversation>>(
      `/api/v1/conversations/${id}`,
      { method: "PATCH", body: JSON.stringify(request) },
    );
    return envelope.data;
  }

  /** Delete a conversation. */
  async deleteConversation(id: string): Promise<void> {
    await this.fetchJson(`/api/v1/conversations/${id}`, {
      method: "DELETE",
    });
  }

  /** Fork a conversation. */
  async forkConversation(id: string, name?: string): Promise<Conversation> {
    const envelope = await this.post<ApiEnvelope<Conversation>>(
      `/api/v1/conversations/${id}/fork`,
      { name },
    );
    return envelope.data;
  }

  /** Handoff: switch a conversation to a different model. */
  async handoff(id: string, modelId: string): Promise<Conversation> {
    const envelope = await this.post<ApiEnvelope<Conversation>>(
      `/api/v1/conversations/${id}/handoff`,
      { modelId } satisfies HandoffRequest,
    );
    return envelope.data;
  }

  /** List sessions within a conversation. */
  async listConversationSessions(id: string): Promise<unknown[]> {
    const envelope = await this.get<ApiEnvelope<unknown[]>>(
      `/api/v1/conversations/${id}/sessions`,
    );
    return envelope.data;
  }

  // ── Chat within Conversation ──────────────────────────────────────

  /** Send a message within a conversation context. */
  async conversationChat(
    conversationId: string,
    message: string,
    opts?: { modelId?: string },
  ): Promise<ChatResponse> {
    return this.chat({
      message,
      conversationId,
      modelId: opts?.modelId,
    });
  }

  /** Stream a chat within a conversation. */
  async *conversationChatStream(
    conversationId: string,
    message: string,
    opts?: { modelId?: string },
  ): AsyncGenerator<Record<string, unknown>> {
    yield* this.chatStream({
      message,
      conversationId,
      modelId: opts?.modelId,
    });
  }

  // ── HTTP Layer ────────────────────────────────────────────────────

  private async get<T = any>(path: string): Promise<T> {
    return this.fetchJson(path, { method: "GET" });
  }

  private async post<T = any>(path: string, body: unknown): Promise<T> {
    return this.fetchJson(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async fetchJson<T = any>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await this.fetchRaw(path, init);
    const text = await response.text();

    if (!response.ok) {
      let errorMsg = `Request failed (${response.status})`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) errorMsg = parsed.error;
      } catch {
        errorMsg = text || errorMsg;
      }
      throw new Error(errorMsg);
    }

    return JSON.parse(text);
  }

  private async fetchRaw(path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string>) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
