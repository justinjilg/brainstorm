/**
 * Generic Product Connector — talks to ANY product implementing the platform contract.
 *
 * Replaces product-specific connectors (MSPConnector, EmailConnector, VMConnector).
 * Discovers tools at runtime by fetching GET /api/v1/god-mode/tools from the product.
 * Executes tools via POST /api/v1/god-mode/execute.
 *
 * Adding a new product to the platform = adding a config entry. Zero code changes.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { ToolPermission } from "@brainst0rm/shared";
import type {
  GodModeConnector,
  ConnectorCapability,
  ConnectorConfig,
  HealthResult,
} from "./types.js";
import { createChangeSet, registerExecutor } from "./changeset.js";

// ── JSONSchema → Zod Converter ──────────────────────────────────

/**
 * Convert a JSONSchema property to a Zod schema.
 * Handles the subset used by God Mode tool definitions.
 */
function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const type = prop.type as string | undefined;
  const description = prop.description as string | undefined;

  let schema: z.ZodTypeAny;

  if (prop.enum && Array.isArray(prop.enum)) {
    const values = prop.enum as [string, ...string[]];
    schema = z.enum(values);
  } else {
    switch (type) {
      case "string":
        schema = z.string();
        break;
      case "number":
      case "integer":
        schema = z.number();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "array": {
        const items = prop.items as Record<string, unknown> | undefined;
        schema = z.array(items ? jsonSchemaPropertyToZod(items) : z.any());
        break;
      }
      case "object": {
        const nested = prop.properties as
          | Record<string, Record<string, unknown>>
          | undefined;
        if (nested) {
          schema = jsonSchemaToZod(prop);
        } else {
          schema = z.record(z.any());
        }
        break;
      }
      default:
        schema = z.any();
    }
  }

  if (description) {
    schema = schema.describe(description);
  }

  if (prop.default !== undefined) {
    schema = schema.default(prop.default);
  }

  return schema;
}

/**
 * Convert a JSONSchema object definition to a Zod object schema.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodObject<any> {
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set((schema.required ?? []) as string[]);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    let fieldSchema = jsonSchemaPropertyToZod(prop);
    if (!required.has(key)) {
      fieldSchema = fieldSchema.optional();
    }
    shape[key] = fieldSchema;
  }

  return z.object(shape);
}

// ── Permission Mapping ──────────────────────────────────────────

function riskToPermission(
  riskLevel: string,
  requiresChangeset: boolean,
): ToolPermission {
  if (riskLevel === "read_only") return "auto";
  if (riskLevel === "low" && !requiresChangeset) return "auto";
  return "confirm";
}

// ── Product Connector ───────────────────────────────────────────

/**
 * Server tool shape from GET /api/v1/god-mode/tools.
 */
interface ServerTool {
  name: string;
  domain: string;
  product: string;
  description: string;
  parameters: Record<string, unknown>;
  risk_level: string;
  requires_changeset: boolean;
  evidence_type?: string;
}

export class ProductConnector implements GodModeConnector {
  name: string;
  displayName: string;
  capabilities: ConnectorCapability[] = [];

  private config: ConnectorConfig & { displayName?: string };
  private tools: BrainstormToolDef[] = [];
  private initialized = false;

  constructor(id: string, config: ConnectorConfig & { displayName?: string }) {
    this.name = id;
    this.displayName =
      config.displayName ?? id.charAt(0).toUpperCase() + id.slice(1);
    this.config = config;
  }

  /**
   * Fetch tool definitions from the product server.
   * Must be called before getTools(). Failures are non-fatal.
   */
  async initialize(): Promise<void> {
    try {
      const res = await this.apiFetch("/api/v1/god-mode/tools");

      if (res.error) {
        console.warn(
          `[godmode] ${this.displayName}: tools endpoint unavailable — ${res.error}`,
        );
        this.initialized = true;
        return;
      }

      // Server may return { tools: [...] } or { data: [...] } or just [...]
      const serverTools: ServerTool[] =
        res.tools ?? res.data ?? (Array.isArray(res) ? res : []);

      // Derive capabilities from tool domains
      const domains = new Set(serverTools.map((t) => t.domain));
      this.capabilities = [...domains] as ConnectorCapability[];

      // Update display name from server if available
      if (res.product) {
        this.displayName = `Brainstorm${res.product.charAt(0).toUpperCase() + res.product.slice(1)}`;
      }

      // Convert each server tool to a BrainstormToolDef
      this.tools = serverTools.map((st) => this.convertTool(st));
      this.initialized = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[godmode] ${this.displayName}: initialization failed — ${msg}`,
      );
      this.initialized = true;
    }
  }

  async healthCheck(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const res = await this.apiFetch("/health");
      const latencyMs = Date.now() - start;

      if (res.error) {
        return { ok: false, latencyMs, message: res.error };
      }

      return {
        ok: res.status === "healthy" || res.status === "ok" || !!res.status,
        latencyMs,
        message: res.version ? `v${res.version}` : undefined,
      };
    } catch {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        message: "Unreachable",
      };
    }
  }

  getTools(): BrainstormToolDef[] {
    return this.tools;
  }

  // ── Tool Conversion ─────────────────────────────────────────

  private convertTool(serverTool: ServerTool): BrainstormToolDef {
    // Convert dots to underscores for AI SDK compatibility
    const toolName = serverTool.name.replace(/\./g, "_");
    const inputSchema = jsonSchemaToZod(serverTool.parameters);
    const permission = riskToPermission(
      serverTool.risk_level,
      serverTool.requires_changeset,
    );
    const readonly = serverTool.risk_level === "read_only";
    const connector = this;

    if (serverTool.requires_changeset) {
      return this.createChangeSetTool(
        toolName,
        serverTool,
        inputSchema,
        permission,
      );
    }

    return defineTool({
      name: toolName,
      description: serverTool.description,
      permission,
      readonly,
      inputSchema,
      async execute(params) {
        const result = await connector.apiFetch("/api/v1/god-mode/execute", {
          method: "POST",
          body: JSON.stringify({
            tool: serverTool.name,
            params,
          }),
        });

        if (result.error) return { error: result.error };
        return result.data ?? result;
      },
    });
  }

  private createChangeSetTool(
    toolName: string,
    serverTool: ServerTool,
    inputSchema: z.ZodObject<any>,
    permission: ToolPermission,
  ): BrainstormToolDef {
    const connector = this;

    // Register a generic executor for when changesets are approved
    registerExecutor(toolName, async (cs) => {
      // Extract original params from the changeset's simulation statePreview
      const originalParams = (cs.simulation.statePreview as any)
        ?.originalParams;
      const result = await connector.apiFetch("/api/v1/god-mode/execute", {
        method: "POST",
        body: JSON.stringify({
          tool: serverTool.name,
          params: originalParams ?? {},
          simulate: false,
        }),
      });

      if (result.error) return { success: false, message: result.error };
      return {
        success: true,
        message: result.message ?? `Executed ${serverTool.name}`,
        rollbackData: result.rollbackData,
      };
    });

    return defineTool({
      name: toolName,
      description: serverTool.description,
      permission,
      inputSchema,
      async execute(params) {
        // Step 1: Simulate
        const simResult = await connector.apiFetch("/api/v1/god-mode/execute", {
          method: "POST",
          body: JSON.stringify({
            tool: serverTool.name,
            params,
            simulate: true,
          }),
        });

        if (simResult.error) return { error: simResult.error };

        // Step 2: Create ChangeSet from simulation
        const simulation = simResult.simulation ?? {
          success: true,
          statePreview: { ...simResult.data, originalParams: params },
          cascades: simResult.cascades ?? [],
          constraints: simResult.constraints ?? [],
          estimatedDuration: simResult.estimatedDuration ?? "< 1 minute",
        };

        // Preserve original params in simulation for the executor
        if (
          simulation.statePreview &&
          typeof simulation.statePreview === "object"
        ) {
          (simulation.statePreview as any).originalParams = params;
        }

        const changeset = createChangeSet({
          connector: connector.name,
          action: toolName,
          description: simResult.description ?? `Execute ${serverTool.name}`,
          changes: simResult.changes ?? [
            {
              system: connector.name,
              entity: `${serverTool.domain}:${JSON.stringify(params).slice(0, 50)}`,
              operation: "execute",
            },
          ],
          simulation,
        });

        return {
          changeset_id: changeset.id,
          status: "pending_approval",
          risk_score: changeset.riskScore,
          risk_factors: changeset.riskFactors,
          description: changeset.description,
          message:
            "ChangeSet created. Present the simulation to the user and wait for approval before calling gm_changeset_approve.",
        };
      },
    });
  }

  // ── HTTP Client ─────────────────────────────────────────────

  private async apiFetch(
    path: string,
    options?: RequestInit & { timeout?: number },
  ): Promise<any> {
    const key = this.resolveApiKey();
    if (!key) {
      return {
        error: `No API key for ${this.displayName} (${this.config.apiKeyName})`,
      };
    }

    const url = `${this.config.baseUrl}${path}`;

    // Enforce HTTPS for non-local connections
    if (
      !url.startsWith("https://") &&
      !url.startsWith("http://localhost") &&
      !url.startsWith("http://127.0.0.1")
    ) {
      return {
        error: `${this.displayName}: HTTPS required for non-local connections`,
      };
    }

    const timeout = options?.timeout ?? 10_000;

    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...((options?.headers as Record<string, string>) ?? {}),
        },
        signal: AbortSignal.timeout(timeout),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          error: `${this.displayName} API ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      return res.json();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: `${this.displayName} API error: ${msg}` };
    }
  }

  private resolveApiKey(): string | null {
    return (
      process.env[`_GM_${this.name.toUpperCase()}_KEY`] ??
      process.env[this.config.apiKeyName] ??
      null
    );
  }
}
