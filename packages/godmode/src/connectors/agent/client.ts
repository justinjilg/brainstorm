/**
 * Edge Agent API Client — talks to BrainstormMSP's agent management API.
 *
 * The edge agent connects outbound to MSP via WebSocket. This client
 * uses MSP's REST API to list agents, dispatch commands, and read
 * OODA events. MSP relays commands over the WebSocket as signed
 * CommandEnvelopes.
 *
 * Verified MSP routes (from app/api/edge/core.py):
 *   GET  /api/v1/edge/agents                     — list enrolled agents
 *   GET  /api/v1/edge/agents/:id                 — agent detail
 *   GET  /api/v1/edge/agents/:id/trust-score     — trust score
 *   POST /api/v1/edge/agents/:id/command          — dispatch command (creates workflow)
 *   GET  /api/v1/edge/ooda-events                 — OODA events (filterable by agent_id)
 *   GET  /api/v1/edge/ooda-events/stats           — 24h OODA summary
 *   GET  /api/v1/edge/signals                     — signals list
 *   POST /api/v1/edge/signals/:id/acknowledge     — ack signal
 *   GET  /api/v1/edge/evidence                    — evidence chain
 *   GET  /api/v1/edge/workflows                   — workflow list
 *
 * Auth: Bearer token (Supabase JWT or bsm_svc_* service API key)
 */

import type { ConnectorConfig, HealthResult } from "../../types.js";
import { encodePathSegment } from "../path-segment.js";

export interface AgentSummary {
  id: string;
  hostname: string;
  client_id: string;
  os_type: string;
  os_version: string;
  version: string;
  status: string;
  last_heartbeat: string;
  autonomy_enabled: boolean;
  enrolled_at: string;
  tools_available: string[] | null;
  client_name: string;
  pending_actions: number;
  ooda_cycle_status: string;
}

export interface CommandDispatch {
  tool: string;
  params: Record<string, unknown>;
  reason?: string;
}

export interface CommandResponse {
  workflow_id: string;
  status: "dispatched" | "queued" | "pending_approval";
  approval_required: boolean;
}

export interface OODAEvent {
  id: string;
  event_type: string;
  agent_id: string;
  client_id: string;
  risk_level: string;
  severity: string;
  data: Record<string, unknown>;
  created_at: string;
  agent_hostname: string;
  client_name: string;
}

export class AgentClient {
  private baseUrl: string;
  private apiKeyName: string;

  constructor(private config: ConnectorConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKeyName = config.apiKeyName;
  }

  async healthCheck(): Promise<HealthResult> {
    const start = Date.now();
    const result = await this.apiFetch("/health");
    const latencyMs = Date.now() - start;

    if (result.error) {
      return { ok: false, latencyMs, message: result.error };
    }
    return { ok: true, latencyMs };
  }

  // ── Agent Discovery ──────────────────────────────────────────

  async listAgents(filters?: {
    status?: string;
    client_id?: string;
    name?: string;
  }): Promise<{ agents: AgentSummary[]; count: number } | { error: string }> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.client_id) params.set("client_id", filters.client_id);
    if (filters?.name) params.set("name", filters.name);
    const qs = params.toString();
    return this.apiFetch(`/api/v1/edge/agents${qs ? `?${qs}` : ""}`);
  }

  async getAgent(agentId: string): Promise<any> {
    return this.apiFetch(`/api/v1/edge/agents/${encodePathSegment(agentId)}`);
  }

  async getAgentTrustScore(agentId: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/edge/agents/${encodePathSegment(agentId)}/trust-score`,
    );
  }

  // ── Command Dispatch ─────────────────────────────────────────

  async sendCommand(
    agentId: string,
    command: CommandDispatch,
  ): Promise<CommandResponse | { error: string }> {
    return this.apiFetch(
      `/api/v1/edge/agents/${encodePathSegment(agentId)}/command`,
      {
        method: "POST",
        body: JSON.stringify(command),
      },
    );
  }

  // ── OODA Events & Telemetry ──────────────────────────────────

  async getOODAEvents(opts?: {
    agent_id?: string;
    event_type?: string;
    risk_level?: string;
    severity?: string;
    limit?: number;
  }): Promise<
    { events: OODAEvent[]; count: number; total: number } | { error: string }
  > {
    const params = new URLSearchParams();
    if (opts?.agent_id) params.set("agent_id", opts.agent_id);
    if (opts?.event_type) params.set("event_type", opts.event_type);
    if (opts?.risk_level) params.set("risk_level", opts.risk_level);
    if (opts?.severity) params.set("severity", opts.severity);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this.apiFetch(`/api/v1/edge/ooda-events${qs ? `?${qs}` : ""}`);
  }

  async getOODAStats(): Promise<any> {
    return this.apiFetch("/api/v1/edge/ooda-events/stats");
  }

  // ── Signals ──────────────────────────────────────────────────

  async listSignals(): Promise<any> {
    return this.apiFetch("/api/v1/edge/signals");
  }

  // ── Evidence ─────────────────────────────────────────────────

  async listEvidence(): Promise<any> {
    return this.apiFetch("/api/v1/edge/evidence");
  }

  async verifyEvidenceChain(): Promise<any> {
    return this.apiFetch("/api/v1/edge/evidence/verify-chain");
  }

  // ── Workflows ────────────────────────────────────────────────

  async listWorkflows(opts?: {
    state?: string;
    agent_id?: string;
    pending_approval?: boolean;
  }): Promise<any> {
    const params = new URLSearchParams();
    if (opts?.state) params.set("state", opts.state);
    if (opts?.agent_id) params.set("agent_id", opts.agent_id);
    if (opts?.pending_approval) params.set("pending_approval", "true");
    const qs = params.toString();
    return this.apiFetch(`/api/v1/edge/workflows${qs ? `?${qs}` : ""}`);
  }

  async approveWorkflow(
    workflowId: string,
    opts: { approved: boolean; notes?: string; mfa_token?: string },
  ): Promise<any> {
    return this.apiFetch(
      `/api/v1/edge/workflows/${encodePathSegment(workflowId)}/approve`,
      {
        method: "POST",
        body: JSON.stringify(opts),
      },
    );
  }

  // ── Kill Switch ──────────────────────────────────────────────

  async killSwitch(agentId: string, reason: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/edge/agents/${encodePathSegment(agentId)}/kill`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
      },
    );
  }

  // ── HTTP Client ──────────────────────────────────────────────

  async apiFetch(path: string, options?: RequestInit): Promise<any> {
    // Resolve key from the configured apiKeyName only — no global override
    const key = process.env[this.apiKeyName] ?? null;

    if (!key) {
      return {
        error: `No API key for Edge Agent management (${this.apiKeyName})`,
      };
    }

    const url = `${this.baseUrl}${path}`;
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...options?.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { error: `Agent API ${res.status}: ${body.slice(0, 200)}` };
      }

      return res.json();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: `Agent API error: ${msg}` };
    }
  }
}
