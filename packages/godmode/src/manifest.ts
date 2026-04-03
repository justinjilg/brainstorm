/**
 * Product Manifest — schema, loader, and validator.
 *
 * Every product in the Brainstorm platform declares itself via a
 * product-manifest.yaml at its repo root. This module defines the
 * schema (Zod), loads/validates manifests, and provides a template
 * generator for bootstrapping new products.
 */

import { z } from "zod";

// ── Schema ──────────────────────────────────────────────────────

const securityAuthSchema = z.object({
  human: z.enum(["supabase-jwt", "none"]).default("supabase-jwt"),
  machine: z.enum(["mtls-spiffe", "api-key", "none"]).default("api-key"),
  tenant_claim: z.string().default("platform_tenant_id"),
});

const securityEncryptionSchema = z.object({
  credentials: z.enum(["aes-256-gcm", "fernet", "none"]).default("aes-256-gcm"),
  evidence: z.enum(["hybrid-pqc", "ed25519", "none"]).default("none"),
});

const securityAuditSchema = z.object({
  signing: z.enum(["hmac-sha256", "none"]).default("hmac-sha256"),
  retention: z.string().default("7y"),
});

const securitySchema = z.object({
  api_base: z.string().url(),
  health: z.string().default("/health"),
  auth: securityAuthSchema.default({}),
  encryption: securityEncryptionSchema.default({}),
  audit: securityAuditSchema.default({}),
});

const edgeSchema = z.object({
  plugins: z.array(z.string()).default([]),
});

const eventSchema = z.object({
  publishes: z.array(z.string()).default([]),
  subscribes: z.array(z.string()).default([]),
});

const capabilitySchema = z.object({
  domain: z.string(),
});

export const productManifestSchema = z.object({
  product: z.object({
    id: z
      .string()
      .regex(
        /^[a-z0-9-]+$/,
        "Product ID must be lowercase alphanumeric + hyphens",
      ),
    name: z.string(),
    version: z.string(),
  }),
  security: securitySchema,
  capabilities: z.array(capabilitySchema).default([]),
  events: eventSchema.default({}),
  edge: edgeSchema.default({}),
});

export type ProductManifest = z.infer<typeof productManifestSchema>;

// ── Loader ──────────────────────────────────────────────────────

/**
 * Parse and validate a product manifest from a YAML string.
 */
export function parseManifest(yamlContent: string): {
  ok: boolean;
  manifest?: ProductManifest;
  errors?: string[];
} {
  // Dynamic import of yaml would be needed, but for CLI context we parse JSON-compatible YAML
  // The CLI command handles the YAML parsing; this validates the parsed object.
  try {
    // Try JSON first (manifests can be JSON too)
    const data = JSON.parse(yamlContent);
    return validateManifestData(data);
  } catch {
    return {
      ok: false,
      errors: [
        "Invalid JSON/YAML. Use `brainstorm platform init` to generate a template.",
      ],
    };
  }
}

/**
 * Validate a parsed manifest object against the schema.
 */
export function validateManifestData(data: unknown): {
  ok: boolean;
  manifest?: ProductManifest;
  errors?: string[];
} {
  const result = productManifestSchema.safeParse(data);
  if (result.success) {
    return { ok: true, manifest: result.data };
  }
  const errors = result.error.issues.map(
    (i) => `${i.path.join(".")}: ${i.message}`,
  );
  return { ok: false, errors };
}

// ── Template ────────────────────────────────────────────────────

/**
 * Generate a product-manifest.yaml template for a new product.
 */
export function generateManifestTemplate(
  productId: string,
  productName: string,
  apiBase: string,
): string {
  return `# product-manifest.yaml — Brainstorm Platform Contract
# Docs: https://brainstorm.co/docs/platform-contract

product:
  id: "${productId}"
  name: "${productName}"
  version: "0.1.0"

# ── Security ──────────────────────────────────────────
security:
  api_base: "${apiBase}"
  health: "/health"
  auth:
    human: "supabase-jwt"
    machine: "api-key"              # Upgrade to mtls-spiffe when ready
    tenant_claim: "platform_tenant_id"
  encryption:
    credentials: "aes-256-gcm"
    evidence: "none"                # Set to hybrid-pqc when evidence chains are implemented
  audit:
    signing: "hmac-sha256"
    retention: "7y"

# ── Capabilities (God Mode) ───────────────────────────
capabilities: []
  # - domain: "endpoint-management"
  # - domain: "compliance"

# ── Events ────────────────────────────────────────────
events:
  publishes: []
    # - "${productId}.alert.created"
  subscribes: []
    # - "platform.tenant.created"

# ── Edge Agent Plugins ────────────────────────────────
edge:
  plugins: []
`;
}

// ── Contract Verification ───────────────────────────────────────

export interface VerifyResult {
  endpoint: string;
  status: "pass" | "fail" | "skip";
  message: string;
  latencyMs?: number;
}

/**
 * Verify that a product implements the required platform endpoints.
 * Hits each endpoint and checks the response shape.
 */
export async function verifyProductContract(
  apiBase: string,
  opts?: { timeout?: number; token?: string },
): Promise<VerifyResult[]> {
  const timeout = opts?.timeout ?? 10_000;
  const results: VerifyResult[] = [];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts?.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }

  // 1. Health check (no auth)
  results.push(
    await checkEndpoint("GET", `${apiBase}/health`, {
      timeout,
      validate: (body) => {
        if (!body.status) return "Missing 'status' field";
        if (!body.version) return "Missing 'version' field";
        return null;
      },
    }),
  );

  // 2. God Mode tools
  results.push(
    await checkEndpoint("GET", `${apiBase}/api/v1/god-mode/tools`, {
      timeout,
      headers,
      validate: (body) => {
        const data = body.data ?? body;
        if (!Array.isArray(data)) return "Expected array of tools";
        return null;
      },
    }),
  );

  // 3. Platform events receiver
  results.push(
    await checkEndpoint("POST", `${apiBase}/api/v1/platform/events`, {
      timeout,
      headers,
      body: JSON.stringify({
        id: "test-verify",
        type: "platform.verify",
        tenant_id: "verify",
        product: "verify",
        timestamp: new Date().toISOString(),
        data: {},
        schema_version: 1,
        signature: "test",
      }),
      // 401/403 is acceptable — means the endpoint exists but our test signature fails
      acceptStatuses: [200, 401, 403],
      validate: () => null,
    }),
  );

  // 4. Tenant provisioning
  results.push(
    await checkEndpoint("POST", `${apiBase}/api/v1/platform/tenants`, {
      timeout,
      headers,
      body: JSON.stringify({
        id: "verify-test",
        name: "Verify Test",
        slug: "verify",
      }),
      acceptStatuses: [200, 201, 400, 401, 403, 409],
      validate: () => null,
    }),
  );

  return results;
}

async function checkEndpoint(
  method: string,
  url: string,
  opts: {
    timeout: number;
    headers?: Record<string, string>;
    body?: string;
    acceptStatuses?: number[];
    validate: (body: any) => string | null;
  },
): Promise<VerifyResult> {
  const start = Date.now();
  const endpointPath = new URL(url).pathname;

  try {
    const res = await fetch(url, {
      method,
      headers: opts.headers,
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeout),
    });

    const latencyMs = Date.now() - start;
    const acceptable = opts.acceptStatuses ?? [200];

    if (!acceptable.includes(res.status)) {
      // 404 means the endpoint doesn't exist
      if (res.status === 404) {
        return {
          endpoint: `${method} ${endpointPath}`,
          status: "fail",
          message: "Not found (404)",
          latencyMs,
        };
      }
      return {
        endpoint: `${method} ${endpointPath}`,
        status: "fail",
        message: `HTTP ${res.status}`,
        latencyMs,
      };
    }

    let body: any = {};
    try {
      body = await res.json();
    } catch {
      // Some endpoints may return empty or non-JSON
    }

    const error = opts.validate(body);
    if (error) {
      return {
        endpoint: `${method} ${endpointPath}`,
        status: "fail",
        message: error,
        latencyMs,
      };
    }

    return {
      endpoint: `${method} ${endpointPath}`,
      status: "pass",
      message: `${res.status} OK`,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout") || msg.includes("abort")) {
      return {
        endpoint: `${method} ${endpointPath}`,
        status: "fail",
        message: `Timeout (${opts.timeout}ms)`,
        latencyMs,
      };
    }
    return {
      endpoint: `${method} ${endpointPath}`,
      status: "fail",
      message: msg,
      latencyMs,
    };
  }
}
