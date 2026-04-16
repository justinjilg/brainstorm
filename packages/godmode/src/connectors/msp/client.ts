/**
 * BrainstormMSP API Client — typed wrapper for the MSP REST API.
 *
 * Provides device management, user management, backup monitoring,
 * and service discovery. All methods return structured results
 * following the ConnectorResult pattern (never silent failures).
 */

import type {
  ConnectorConfig,
  HealthResult,
  SimulationResult,
  Change,
} from "../../types.js";
import { encodePathSegment } from "../path-segment.js";

/**
 * MSP HTTP Client — thin typed wrapper around BrainstormMSP's REST API.
 * Used by the MSPConnector but not a connector itself.
 */
export class MSPClient {
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

  /** Authenticated fetch with vault key resolution. */
  async apiFetch(path: string, options?: RequestInit): Promise<any> {
    const key =
      process.env[`_GM_MSP_KEY`] ?? process.env[this.apiKeyName] ?? null;

    if (!key) {
      return { error: `No API key for BrainstormMSP (${this.apiKeyName})` };
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
          error: `BrainstormMSP API ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      return res.json();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: `BrainstormMSP API error: ${msg}` };
    }
  }

  // ── Device Operations ──────────────────────────────────────────

  async searchDevices(query: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/discovery/assets?search=${encodeURIComponent(query)}&asset_type=endpoint`,
    );
  }

  async getDevice(id: string): Promise<any> {
    return this.apiFetch(`/api/v1/discovery/assets/${encodePathSegment(id)}`);
  }

  async getDeviceSoftware(id: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/discovery/assets/${encodePathSegment(id)}/software`,
    );
  }

  /**
   * Simulate protection changes on a device.
   * If the MSP has a /simulate endpoint, use it.
   * Otherwise, fetch current state and compute diff client-side.
   */
  async simulateProtect(
    deviceId: string,
    level: string,
  ): Promise<{ simulation: SimulationResult; changes: Change[] }> {
    const encodedId = encodePathSegment(deviceId);
    // Try server-side simulation first
    const simResult = await this.apiFetch(
      `/api/v1/rmm/devices/${encodedId}/protect/simulate`,
      { method: "POST", body: JSON.stringify({ level }) },
    );

    if (!simResult.error && simResult.simulation) {
      return simResult;
    }

    // Client-side simulation: fetch current state, compute diff
    const device = await this.getDevice(deviceId);
    if (device.error) {
      return {
        simulation: {
          success: false,
          statePreview: null,
          cascades: [],
          constraints: [device.error],
          estimatedDuration: "unknown",
        },
        changes: [],
      };
    }

    const changes: Change[] = [];
    const cascades: string[] = [];

    // Simulate protection changes based on level
    if (level === "maximum" || level === "standard") {
      changes.push({
        system: "msp",
        entity: `device:${device.hostname ?? deviceId}`,
        operation: "update",
        before: { firewall: device.firewall_status ?? "unknown" },
        after: { firewall: level === "maximum" ? "strict" : "standard" },
      });
      changes.push({
        system: "msp",
        entity: `device:${device.hostname ?? deviceId}`,
        operation: "update",
        before: { encryption: device.encryption_status ?? "unknown" },
        after: { encryption: "enabled" },
      });
      changes.push({
        system: "msp",
        entity: `device:${device.hostname ?? deviceId}`,
        operation: "update",
        before: { edr: device.edr_status ?? "unknown" },
        after: { edr: "active" },
      });
    }

    if (changes.some((c) => (c.after as any)?.encryption === "enabled")) {
      cascades.push("Encryption may require restart");
    }

    return {
      simulation: {
        success: true,
        statePreview: {
          firewall: level === "maximum" ? "strict" : "standard",
          encryption: "enabled",
          edr: "active",
        },
        cascades,
        constraints: [],
        estimatedDuration: "~45 seconds",
      },
      changes,
    };
  }

  async executeProtect(deviceId: string, level: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/rmm/devices/${encodePathSegment(deviceId)}/protect`,
      {
        method: "POST",
        body: JSON.stringify({ level }),
      },
    );
  }

  async isolateDevice(deviceId: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/rmm/devices/${encodePathSegment(deviceId)}/isolate`,
      {
        method: "POST",
      },
    );
  }

  async scanDevice(deviceId: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/rmm/devices/${encodePathSegment(deviceId)}/scan`,
      {
        method: "POST",
      },
    );
  }

  // ── User Operations ────────────────────────────────────────────

  async searchUsers(query: string): Promise<any> {
    return this.apiFetch(`/api/v1/clients?search=${encodeURIComponent(query)}`);
  }

  async getUser(id: string): Promise<any> {
    return this.apiFetch(`/api/v1/clients/${encodePathSegment(id)}`);
  }

  async disableUser(userId: string): Promise<any> {
    return this.apiFetch(`/api/v1/clients/${encodePathSegment(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ status: "disabled" }),
    });
  }

  // ── Backup Operations ──────────────────────────────────────────

  async getBackupCoverage(): Promise<any> {
    return this.apiFetch("/api/v1/backups/coverage");
  }

  async getBackupStatus(agentId?: string): Promise<any> {
    if (agentId) {
      return this.apiFetch(
        `/api/v1/backups/status/${encodePathSegment(agentId)}`,
      );
    }
    return this.apiFetch("/api/v1/backups/status");
  }

  async retryBackup(jobId: string): Promise<any> {
    return this.apiFetch(
      `/api/v1/backups/jobs/${encodePathSegment(jobId)}/retry`,
      {
        method: "POST",
      },
    );
  }

  // ── Discovery Operations ───────────────────────────────────────

  async discoverAssets(filters?: Record<string, string>): Promise<any> {
    const params = new URLSearchParams(filters ?? {});
    return this.apiFetch(`/api/v1/discovery/assets?${params}`);
  }

  async getDiscoveryStats(): Promise<any> {
    return this.apiFetch("/api/v1/discovery/stats");
  }
}
