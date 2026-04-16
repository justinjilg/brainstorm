/**
 * BrainstormEmailSecurity API Client — communication trust graph.
 *
 * Provides message scanning, quarantine, trust graph analysis,
 * and cross-tenant campaign detection.
 */

import type { ConnectorConfig, HealthResult } from "../../types.js";
import { encodePathSegment } from "../path-segment.js";

export class EmailClient {
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
    if (result.error) return { ok: false, latencyMs, message: result.error };
    return { ok: true, latencyMs };
  }

  async apiFetch(path: string, options?: RequestInit): Promise<any> {
    const key =
      process.env[`_GM_EMAIL_KEY`] ?? process.env[this.apiKeyName] ?? null;

    if (!key) {
      return {
        error: `No API key for BrainstormEmailSecurity (${this.apiKeyName})`,
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
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          error: `EmailSecurity API ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      return res.json();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: `EmailSecurity API error: ${msg}` };
    }
  }

  // ── Message Operations ─────────────────────────────────────────

  async listMessages(filters?: Record<string, string>): Promise<any> {
    const params = new URLSearchParams(filters ?? {});
    return this.apiFetch(`/api/v1/email-security/messages?${params}`);
  }

  async getMessageDetail(messageId: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/email-security/messages/${encodePathSegment(messageId)}`,
    );
  }

  async submitFeedback(messageId: string, verdict: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/email-security/messages/${encodePathSegment(messageId)}/feedback`,
      {
        method: "POST",
        body: JSON.stringify({ verdict }),
      },
    );
  }

  // ── Quarantine Operations ──────────────────────────────────────

  async listQuarantine(): Promise<any> {
    return this.apiFetch("/api/v1/email-security/quarantine");
  }

  async releaseMessage(messageId: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/email-security/quarantine/${encodePathSegment(messageId)}/release`,
      {
        method: "POST",
      },
    );
  }

  async bulkQuarantine(messageIds: string[]): Promise<any> {
    return this.apiFetch("/api/v1/email-security/bulk/quarantine", {
      method: "POST",
      body: JSON.stringify({ message_ids: messageIds }),
    });
  }

  async blockSender(senders: string[]): Promise<any> {
    return this.apiFetch("/api/v1/email-security/bulk/block-sender", {
      method: "POST",
      body: JSON.stringify({ senders }),
    });
  }

  // ── Trust Graph Operations ─────────────────────────────────────

  async getTrustNeighborhood(email: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/email-security/graph/neighborhood/${encodeURIComponent(email)}`,
    );
  }

  async getAttackPaths(email: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/email-security/graph/attack-paths/${encodeURIComponent(email)}`,
    );
  }

  // ── Campaign Operations ────────────────────────────────────────

  async listCampaigns(): Promise<any> {
    return this.apiFetch("/api/v1/email-security/campaigns");
  }

  async respondToCampaign(campaignId: string, action: string): Promise<any> {
    return this.apiFetch("/api/v1/email-security/bulk/campaign-response", {
      method: "POST",
      body: JSON.stringify({ campaign_id: campaignId, action }),
    });
  }

  // ── Dashboard ──────────────────────────────────────────────────

  async getDashboard(clientId?: string): Promise<any> {
    if (clientId) {
      return this.apiFetch(
        `/api/v1/email-security/dashboard/${encodePathSegment(clientId)}`,
      );
    }
    return this.apiFetch("/api/v1/email-security/dashboard");
  }
}
