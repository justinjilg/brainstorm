/**
 * Brainstorm Platform Contract v1 — canonical Zod schemas.
 *
 * Every endpoint described in `docs/platform-contract-v1.md` is defined
 * here as a typed Zod schema with a short prose summary. The contract
 * compiler (`compile.ts`) walks these declarations and emits:
 *
 *   - markdown spec sections (`generators/markdown.ts`)
 *   - JSON Schema (Draft 7) for third-party implementers (`generators/json-schema.ts`)
 *   - the TS validator consumed by `brainstorm platform verify` (`generators/validator.ts`)
 *   - (planned) pydantic models for Python product servers
 *   - (planned) Go structs for the BrainstormVM product server
 *
 * Why this file exists:
 *   The platform contract was previously a prose markdown spec plus a
 *   hand-coded `verifyProductContract` validator in `manifest.ts`. The
 *   two drifted: the spec said "Tools list returns array of
 *   ToolDefinition" but the validator only checked that `data` was an
 *   array, not that each element matched the ToolDefinition shape.
 *   Promoting the spec to Zod is the same "move lockstep from
 *   discipline to mechanism" play used in Stage 1 of the tool
 *   compiler (and originally in BrainstormRouter's contract compiler).
 *
 * Adding a new endpoint:
 *   1. Define request/response schemas below.
 *   2. Add an `EndpointDef` entry to `PLATFORM_ENDPOINTS`.
 *   3. Re-run the compiler (`npx tsx scripts/compile-contract.ts`).
 *   4. The generated outputs (markdown, JSON Schema, validator) update
 *      in lockstep. Golden test catches accidental shape drift.
 */

import { z } from "zod";

// ── Section 2: Health Endpoint ─────────────────────────────────────

export const healthStatusEnum = z.enum(["healthy", "degraded", "unhealthy"]);

export const healthResponseSchema = z
  .object({
    status: healthStatusEnum.describe(
      "Overall product health. Maps to HTTP 200 (healthy/degraded) or 503 (unhealthy).",
    ),
    version: z.string().describe("Product semver string (e.g. '2.1.0')."),
    product: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .describe("Lowercase product slug. MUST match product.id in manifest."),
    uptime_seconds: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Seconds since the process started."),
    checks: z
      .record(z.string(), z.string())
      .optional()
      .describe("Sub-system health states (database, cache, queues, ...)."),
  })
  .describe("Response body for GET /health. No auth required.");

// ── Section 3: Tool Discovery ──────────────────────────────────────

export const riskLevelEnum = z.enum([
  "read_only",
  "low",
  "medium",
  "high",
  "critical",
]);

export const evidenceTypeEnum = z.enum([
  "observation",
  "execution",
  "decision",
]);

export const toolDefinitionSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9_-]+\.[a-z0-9_-]+$/)
      .describe("Globally unique tool name in `{product}.{verb}_{noun}` form."),
    domain: z
      .string()
      .describe("Capability domain (see Domain Registry in the spec)."),
    product: z
      .string()
      .describe("Must match the response `product` field at the parent level."),
    description: z
      .string()
      .min(1)
      .describe("Human-readable, injected into LLM prompt."),
    parameters: z
      .object({
        type: z.literal("object"),
        properties: z.record(z.string(), z.unknown()).optional(),
        required: z.array(z.string()).optional(),
      })
      .passthrough()
      .describe("JSONSchema for the tool's input validation."),
    risk_level: riskLevelEnum.describe(
      "Drives CLI auto-approve vs ChangeSet flow.",
    ),
    requires_changeset: z
      .boolean()
      .describe("If true, mutating execution flows through ChangeSet."),
    evidence_type: evidenceTypeEnum
      .optional()
      .describe("What kind of audit evidence this tool emits when executed."),
  })
  .describe("A single God Mode tool entry in the discovery response.");

export const toolsListResponseSchema = z
  .object({
    product: z.string().describe("Product slug. Matches /health.product."),
    version: z.string().describe("Product semver."),
    tool_count: z.number().int().nonnegative(),
    tools: z.array(toolDefinitionSchema),
  })
  .describe(
    "Response body for GET /api/v1/god-mode/tools. Bearer auth required.",
  );

// ── Section 4: Tool Execution ──────────────────────────────────────

export const executeRequestSchema = z
  .object({
    tool: z.string().describe("Fully-qualified tool name."),
    params: z
      .record(z.string(), z.unknown())
      .describe("Tool-specific parameter object."),
    simulate: z
      .boolean()
      .optional()
      .describe(
        "When true and the tool requires_changeset, returns a simulation rather than executing.",
      ),
    correlation_id: z
      .string()
      .uuid()
      .optional()
      .describe("Optional client-provided UUID for request correlation."),
    idempotency_key: z
      .string()
      .uuid()
      .optional()
      .describe(
        "If present, repeated requests with the same key return cached result or 409.",
      ),
  })
  .describe("Request body for POST /api/v1/god-mode/execute.");

export const executeErrorCodeEnum = z.enum([
  "VALIDATION",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "RATE_LIMITED",
  "CONFLICT",
  "INTERNAL",
  "UNAVAILABLE",
]);

export const executeSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    tool: z.string(),
    data: z.unknown().describe("Tool-specific success payload."),
    risk_level: riskLevelEnum,
    trace_id: z.string().describe("Server-side trace identifier for audit."),
    evidence_id: z
      .string()
      .optional()
      .describe("Reference to a stored evidence record, when applicable."),
  })
  .describe("Successful execution response.");

export const changeSchema = z.object({
  system: z.string().describe("Product slug owning the entity."),
  entity: z
    .string()
    .describe("Entity reference like `device:abc` or `user:todd@example.com`."),
  operation: z.enum(["create", "update", "delete", "execute"]),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

export const simulationDetailSchema = z.object({
  success: z.boolean(),
  statePreview: z.unknown(),
  cascades: z.array(z.string()),
  constraints: z.array(z.string()),
  estimatedDuration: z.string(),
});

export const executeSimulationResponseSchema = z
  .object({
    success: z.literal(true),
    tool: z.string(),
    simulation: simulationDetailSchema,
    changes: z.array(changeSchema),
    description: z.string(),
    risk_level: riskLevelEnum,
    trace_id: z.string(),
  })
  .describe("Simulation response when request.simulate=true.");

export const executeErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: executeErrorCodeEnum,
      message: z.string(),
    }),
    tool: z.string(),
    trace_id: z.string(),
  })
  .describe("Error response shape for every failure path.");

// ── Section 5: Platform Events ─────────────────────────────────────

export const platformEventSchema = z
  .object({
    id: z.string().describe("UUIDv7 event identifier."),
    type: z
      .string()
      .regex(/^[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/)
      .describe("`{product}.{noun}.{past_verb}` event type."),
    tenant_id: z.string(),
    product: z.string(),
    timestamp: z.string().datetime({ offset: true }),
    data: z.record(z.string(), z.unknown()).describe("Event-specific payload."),
    schema_version: z.number().int().positive(),
    correlation_id: z.string().uuid().optional(),
    signature: z
      .string()
      .describe(
        "HMAC-SHA256 of canonical JSON (event minus signature field) signed with the per-tenant derived key.",
      ),
  })
  .describe(
    "Platform event envelope. Posted to /api/v1/platform/events; receiver MUST verify the signature.",
  );

export const platformEventAckSchema = z.object({
  accepted: z.boolean(),
  handled: z.boolean(),
});

// ── Section 6: Tenant Lifecycle ────────────────────────────────────

export const tenantActionEnum = z.enum(["provision", "deprovision"]);
export const tenantStateEnum = z.enum([
  "provisioned",
  "deprovisioned",
  "pending",
]);

export const tenantLifecycleRequestSchema = z
  .object({
    tenant_id: z.string(),
    action: tenantActionEnum,
    product_config: z.record(z.string(), z.unknown()).optional(),
    idempotency_key: z.string().uuid(),
  })
  .describe("POST /api/v1/platform/tenants request body.");

export const tenantLifecycleResponseSchema = z.object({
  success: z.boolean(),
  tenant_id: z.string(),
  state: tenantStateEnum,
});

// ── Endpoint registry ──────────────────────────────────────────────

/**
 * Single declaration of every endpoint the platform contract specifies.
 * The compiler walks this array; ordering here drives ordering in the
 * generated markdown spec.
 */
export interface EndpointDef {
  /** Stable identifier used in generated artifact paths and snapshot keys. */
  id: string;
  /** Human-readable name for documentation headers. */
  title: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Auth requirement summary for the generated spec. */
  auth: "none" | "bearer";
  /** Short prose summary rendered into the markdown spec. */
  summary: string;
  /** Request body schema, when applicable. */
  request?: z.ZodTypeAny;
  /** Primary response schema (success path). */
  response: z.ZodTypeAny;
  /** Alternate response schemas (simulation, error, ack). Order preserved. */
  alternateResponses?: Array<{ name: string; schema: z.ZodTypeAny }>;
}

/**
 * Construct PLATFORM_ENDPOINTS with module-load-time uniqueness
 * assertions on `id` and on each endpoint's `alternateResponses[].name`.
 * The type-design review flagged these as silent-overwrite footguns —
 * duplicate IDs map-overwrite each other in the compiler's downstream
 * Record-keyed structures (JSON Schema bundle, accept-status table).
 */
function defineEndpoints(defs: EndpointDef[]): EndpointDef[] {
  const seenIds = new Set<string>();
  for (const ep of defs) {
    if (seenIds.has(ep.id)) {
      throw new Error(
        `PLATFORM_ENDPOINTS: duplicate endpoint id "${ep.id}". Each endpoint must have a unique id.`,
      );
    }
    seenIds.add(ep.id);

    if (ep.alternateResponses) {
      const seenAlts = new Set<string>();
      for (const alt of ep.alternateResponses) {
        if (seenAlts.has(alt.name)) {
          throw new Error(
            `PLATFORM_ENDPOINTS["${ep.id}"]: duplicate alternateResponse name "${alt.name}".`,
          );
        }
        seenAlts.add(alt.name);
      }
    }
  }
  return defs;
}

export const PLATFORM_ENDPOINTS: EndpointDef[] = defineEndpoints([
  {
    id: "health",
    title: "Health",
    method: "GET",
    path: "/health",
    auth: "none",
    summary:
      "Liveness + identity probe. Always available, no auth. Returns 200 for healthy/degraded, 503 for unhealthy.",
    response: healthResponseSchema,
  },
  {
    id: "god-mode-tools",
    title: "Tool Discovery",
    method: "GET",
    path: "/api/v1/god-mode/tools",
    auth: "bearer",
    summary:
      "Lists every God Mode tool this product exposes. Brainstorm CLI calls this at boot to register tools with the agent loop and MCP server.",
    response: toolsListResponseSchema,
  },
  {
    id: "god-mode-execute",
    title: "Tool Execution",
    method: "POST",
    path: "/api/v1/god-mode/execute",
    auth: "bearer",
    summary:
      "Invokes a single God Mode tool. If the tool requires a ChangeSet and the request has simulate=true, returns the simulation; otherwise executes and returns the result.",
    request: executeRequestSchema,
    response: executeSuccessResponseSchema,
    alternateResponses: [
      { name: "simulation", schema: executeSimulationResponseSchema },
      { name: "error", schema: executeErrorResponseSchema },
    ],
  },
  {
    id: "platform-events",
    title: "Platform Events Receiver",
    method: "POST",
    path: "/api/v1/platform/events",
    auth: "bearer",
    summary:
      "Inbound platform event endpoint. Receiver MUST verify the HMAC signature against the per-tenant derived key before processing.",
    request: platformEventSchema,
    response: platformEventAckSchema,
  },
  {
    id: "platform-tenants",
    title: "Tenant Lifecycle",
    method: "POST",
    path: "/api/v1/platform/tenants",
    auth: "bearer",
    summary:
      "Tenant provisioning + deprovisioning. Deprovision is a soft-delete with 30-day retention.",
    request: tenantLifecycleRequestSchema,
    response: tenantLifecycleResponseSchema,
  },
]);
