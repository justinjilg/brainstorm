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
import { randomUUID } from "node:crypto";
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
    if (
      prop.enum.length === 0 ||
      !prop.enum.every((value) => typeof value === "string")
    ) {
      throw new Error("enum properties must contain at least one string value");
    }
    const values = prop.enum as [string, ...string[]];
    schema = z.enum(values);
  } else {
    switch (type) {
      case undefined:
        if (prop.properties) {
          schema = jsonSchemaToZod(prop);
          break;
        }
        throw new Error("JSON Schema property missing explicit type");
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
        if (!items || typeof items !== "object") {
          throw new Error("array properties must define an items schema");
        }
        schema = z.array(jsonSchemaPropertyToZod(items));
        break;
      }
      case "object": {
        const nested = prop.properties as
          | Record<string, Record<string, unknown>>
          | undefined;
        if (nested) {
          schema = jsonSchemaToZod(prop);
        } else if (prop.additionalProperties === false) {
          schema = z.object({}).strict();
        } else if (prop.additionalProperties === true) {
          schema = z.record(z.string(), z.unknown());
        } else if (
          typeof prop.additionalProperties === "object" &&
          prop.additionalProperties !== null
        ) {
          schema = z.record(
            z.string(),
            jsonSchemaPropertyToZod(
              prop.additionalProperties as Record<string, unknown>,
            ),
          );
        } else {
          throw new Error(
            "object properties without nested properties must define additionalProperties",
          );
        }
        break;
      }
      default:
        throw new Error(`unsupported JSON Schema type: ${type}`);
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
  const type = schema.type as string | undefined;
  if (type !== undefined && type !== "object") {
    throw new Error(`tool parameters must be an object schema, got ${type}`);
  }

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

  const objectSchema = z.object(shape);
  if (schema.additionalProperties === true) {
    return objectSchema.catchall(z.unknown());
  }
  if (
    typeof schema.additionalProperties === "object" &&
    schema.additionalProperties !== null
  ) {
    return objectSchema.catchall(
      jsonSchemaPropertyToZod(
        schema.additionalProperties as Record<string, unknown>,
      ),
    );
  }
  return objectSchema.strict();
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

interface ExecutionBinding {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  traceId: string;
  idempotencyKey: string;
  tenantId: string;
}

interface SimulationExecutionBinding {
  tenant_id?: unknown;
  trace_id?: unknown;
  simulation_idempotency_key?: unknown;
  simulation_token?: unknown;
}

type BoundStatePreview = Record<string, unknown> & {
  originalParams?: unknown;
  executionBinding?: SimulationExecutionBinding;
};

function boundStatePreview(value: unknown): BoundStatePreview | null {
  if (!value || typeof value !== "object") return null;
  return value as BoundStatePreview;
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

      // Convert each server tool to a BrainstormToolDef. Quarantine unsafe or
      // unsupported schemas instead of widening them to z.any().
      const convertedTools: BrainstormToolDef[] = [];
      for (const st of serverTools) {
        try {
          convertedTools.push(this.convertTool(st));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[godmode] ${this.displayName}: skipped unsafe tool schema for ${st.name} — ${msg}`,
          );
        }
      }
      this.tools = convertedTools;
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
        const binding = connector.buildExecutionBinding(serverTool, params, {
          simulate: false,
        });
        if ("error" in binding) return { error: binding.error };

        const result = await connector.apiFetch("/api/v1/god-mode/execute", {
          method: "POST",
          headers: binding.headers,
          body: JSON.stringify(binding.payload),
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
    // Namespace executor key by connector to prevent cross-product collision
    const executorKey = `${this.name}:${toolName}`;

    // Register a generic executor for when changesets are approved
    registerExecutor(executorKey, async (cs) => {
      // Extract original params from the changeset's simulation statePreview
      const statePreview = boundStatePreview(cs.simulation.statePreview);
      const originalParams = statePreview?.originalParams;
      const simulationBinding = statePreview?.executionBinding;
      if (typeof simulationBinding?.simulation_token !== "string") {
        return {
          success: false,
          message:
            "Product simulation did not return a simulation_token; refusing unbound execution.",
        };
      }

      const binding = connector.buildExecutionBinding(
        serverTool,
        originalParams ?? {},
        {
          simulate: false,
          traceId:
            typeof simulationBinding.trace_id === "string"
              ? simulationBinding.trace_id
              : undefined,
          changesetId: cs.id,
          simulationToken: simulationBinding.simulation_token,
        },
      );
      if ("error" in binding) return { success: false, message: binding.error };

      const result = await connector.apiFetch("/api/v1/god-mode/execute", {
        method: "POST",
        headers: binding.headers,
        body: JSON.stringify(binding.payload),
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
        const binding = connector.buildExecutionBinding(serverTool, params, {
          simulate: true,
        });
        if ("error" in binding) return { error: binding.error };

        // Step 1: Simulate
        const simResult = await connector.apiFetch("/api/v1/god-mode/execute", {
          method: "POST",
          headers: binding.headers,
          body: JSON.stringify(binding.payload),
        });

        if (simResult.error) return { error: simResult.error };

        const simulationToken =
          simResult.simulation_token ??
          simResult.simulationToken ??
          simResult.binding?.simulation_token;
        if (
          typeof simulationToken !== "string" ||
          simulationToken.length === 0
        ) {
          return {
            error:
              "Product simulation did not return a simulation_token; refusing to create an unbound ChangeSet.",
          };
        }

        // Step 2: Create ChangeSet from simulation
        const simulation = simResult.simulation ?? {
          success: true,
          statePreview: { ...simResult.data, originalParams: params },
          cascades: simResult.cascades ?? [],
          constraints: simResult.constraints ?? [],
          estimatedDuration: simResult.estimatedDuration ?? "< 1 minute",
        };

        // Preserve original params in simulation for the executor
        const statePreview = boundStatePreview(simulation.statePreview);
        if (statePreview) {
          statePreview.originalParams = params;
          statePreview.executionBinding = {
            tenant_id: binding.tenantId,
            trace_id: binding.traceId,
            simulation_idempotency_key: binding.idempotencyKey,
            simulation_token: simulationToken,
          };
        }

        const changeset = createChangeSet({
          tenantId: binding.tenantId,
          connector: connector.name,
          action: executorKey, // Namespaced to prevent cross-product collision
          description: simResult.description ?? `Execute ${serverTool.name}`,
          changes: simResult.changes ?? [
            {
              system: connector.name,
              entity: `${serverTool.domain}:${JSON.stringify(params).slice(0, 50)}`,
              operation: "execute",
            },
          ],
          simulation,
          ...(binding.traceId ? { traceId: binding.traceId } : {}),
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

  private buildExecutionBinding(
    serverTool: ServerTool,
    params: unknown,
    opts: {
      simulate: boolean;
      traceId?: string;
      changesetId?: string;
      simulationToken?: string;
    },
  ): ExecutionBinding | { error: string } {
    const tenantId = this.resolveTenantId();
    if (!tenantId) {
      return {
        error: `No tenant_id for ${this.displayName}; set tenantId in connector config or _GM_${this.name.toUpperCase()}_TENANT_ID.`,
      };
    }

    const traceId = opts.traceId ?? `trace_${randomUUID()}`;
    const idempotencyKey = `${this.name}:${serverTool.name}:${opts.simulate ? "simulate" : "execute"}:${randomUUID()}`;
    const payload: Record<string, unknown> = {
      tool: serverTool.name,
      params,
      simulate: opts.simulate,
      tenant_id: tenantId,
      trace_id: traceId,
      idempotency_key: idempotencyKey,
    };

    if (opts.changesetId) payload.changeset_id = opts.changesetId;
    if (opts.simulationToken) payload.simulation_token = opts.simulationToken;

    return {
      payload,
      traceId,
      idempotencyKey,
      tenantId,
      headers: {
        "Idempotency-Key": idempotencyKey,
        "X-Brainstorm-Trace-Id": traceId,
        "X-Brainstorm-Tenant-Id": tenantId,
      },
    };
  }

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

  private resolveTenantId(): string | null {
    return (
      this.config.tenantId ??
      process.env[`_GM_${this.name.toUpperCase()}_TENANT_ID`] ??
      process.env.BRAINSTORM_TENANT_ID ??
      process.env.PLATFORM_TENANT_ID ??
      null
    );
  }
}
