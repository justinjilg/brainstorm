/**
 * Abstract God Mode Connector — base class for all external system integrations.
 *
 * Provides authenticated HTTP client (same pattern as brFetch in br-intelligence.ts),
 * tool registration, and health checking. Subclasses implement getTools() and
 * healthCheck() for their specific system.
 *
 * To add a new system (CrowdStrike, Veeam, HaloPSA, etc.):
 * 1. Create a new directory under connectors/
 * 2. Extend BaseConnector
 * 3. Implement getTools() returning defineTool() calls
 * 4. Implement healthCheck() hitting the system's health endpoint
 * 5. Register in connectors/index.ts
 */

import type { BrainstormToolDef } from "@brainst0rm/tools";
import type {
  GodModeConnector,
  ConnectorCapability,
  ConnectorConfig,
  HealthResult,
} from "./types.js";

export abstract class BaseConnector implements GodModeConnector {
  abstract name: string;
  abstract displayName: string;
  abstract capabilities: ConnectorCapability[];

  constructor(protected config: ConnectorConfig) {}

  abstract getTools(): BrainstormToolDef[];

  abstract healthCheck(): Promise<HealthResult>;

  /**
   * Authenticated fetch against the connector's base URL.
   * Resolves API key from environment (vault puts it there).
   * Same pattern as brFetch() in packages/tools/src/builtin/br-intelligence.ts.
   */
  protected async apiFetch(
    path: string,
    options?: RequestInit & { timeout?: number },
  ): Promise<any> {
    const key = this.resolveApiKey();
    if (!key) {
      return {
        error: `No API key for ${this.displayName} (${this.config.apiKeyName})`,
      } as any;
    }

    const url = `${this.config.baseUrl}${path}`;

    // Enforce HTTPS for non-local connections
    if (
      !url.startsWith("https://") &&
      !url.startsWith("http://localhost") &&
      !url.startsWith("http://127.0.0.1")
    ) {
      return {
        error: `${this.displayName}: HTTPS required for non-local connections (got ${this.config.baseUrl})`,
      } as any;
    }

    const timeout = options?.timeout ?? 10_000;

    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...options?.headers,
        },
        signal: AbortSignal.timeout(timeout),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          error: `${this.displayName} API ${res.status}: ${body.slice(0, 200)}`,
        } as any;
      }

      return res.json();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: `${this.displayName} API error: ${msg}` } as any;
    }
  }

  /**
   * Resolve the API key from environment.
   * The vault system (packages/vault) puts resolved keys into process.env
   * with a _GM_ prefix or the raw apiKeyName.
   */
  private resolveApiKey(): string | null {
    return (
      process.env[`_GM_${this.name.toUpperCase()}_KEY`] ??
      process.env[this.config.apiKeyName] ??
      null
    );
  }
}
