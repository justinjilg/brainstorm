/**
 * BrainstormVM API Client — AI-native hypervisor control plane.
 *
 * HTTP REST API (port 9090) for compute, storage, network.
 * gRPC (port 9091, mTLS) for node coordination — not used in God Mode
 * tools directly, but available for future daemon integration.
 */

import type { ConnectorConfig, HealthResult } from "../../types.js";
import { encodePathSegment } from "../path-segment.js";

export class VMClient {
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
      process.env[`_GM_VM_KEY`] ?? process.env[this.apiKeyName] ?? null;

    if (!key) {
      return { error: `No API key for BrainstormVM (${this.apiKeyName})` };
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
        return {
          error: `BrainstormVM API ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      return res.json();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: `BrainstormVM API error: ${msg}` };
    }
  }

  // ── Compute ────────────────────────────────────────────────────

  async listVMs(filters?: Record<string, string>): Promise<any> {
    const params = new URLSearchParams(filters ?? {});
    return this.apiFetch(`/api/v1/resources?${params}`);
  }

  async getVM(id: string): Promise<any> {
    return this.apiFetch(`/api/v1/resources/${encodePathSegment(id)}`);
  }

  async createVM(spec: {
    name: string;
    template?: string;
    vcpus: number;
    memoryMb: number;
    diskGb: number;
    network?: string;
  }): Promise<any> {
    return this.apiFetch("/api/v1/resources", {
      method: "POST",
      body: JSON.stringify(spec),
    });
  }

  async destroyVM(id: string): Promise<any> {
    return this.apiFetch(`/api/v1/resources/${encodePathSegment(id)}`, {
      method: "DELETE",
    });
  }

  async migrateVM(id: string, targetNode: string): Promise<any> {
    return this.apiFetch(`/api/v1/live-migration`, {
      method: "POST",
      body: JSON.stringify({ resource_id: id, target_node: targetNode }),
    });
  }

  // ── Storage ────────────────────────────────────────────────────

  async createSnapshot(resourceId: string, name: string): Promise<any> {
    return this.apiFetch("/api/v1/snapshots", {
      method: "POST",
      body: JSON.stringify({ resource_id: resourceId, name }),
    });
  }

  async restoreSnapshot(snapshotId: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/snapshots/${encodePathSegment(snapshotId)}/restore`,
      {
        method: "POST",
      },
    );
  }

  // ── Network ────────────────────────────────────────────────────

  async getTopology(): Promise<any> {
    return this.apiFetch("/api/v1/topology");
  }

  // ── Monitoring ─────────────────────────────────────────────────

  async getClusterHealth(): Promise<any> {
    return this.apiFetch("/api/v1/monitoring/health");
  }

  async getAlerts(): Promise<any> {
    return this.apiFetch("/api/v1/monitoring/alerts");
  }

  // ── Compliance ─────────────────────────────────────────────────

  async runComplianceCheck(framework: string): Promise<any> {
    return this.apiFetch("/api/v1/compliance/evaluate", {
      method: "POST",
      body: JSON.stringify({ framework }),
    });
  }
}
