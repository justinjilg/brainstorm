/**
 * Product Manifest — schema, loader, and validator.
 *
 * Every product in the Brainstorm platform declares itself via a
 * product-manifest.yaml at its repo root. This module defines the
 * schema (Zod), loads/validates manifests, and provides a template
 * generator for bootstrapping new products.
 */

import { z } from "zod";
import { compileContract } from "./contract/compile.js";

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
 *
 * Stage-2 of the contract compiler: the per-endpoint plan (which
 * method, which path, which response shape, which accept-statuses) is
 * generated from the canonical Zod schemas in `contract/schemas.ts`.
 * The hand-rolled `validate(body)` callbacks that used to live here
 * have been replaced with `safeParse` against the schema — so a
 * malformed-but-shape-passing response (e.g. tools list missing
 * `risk_level`) now fails the check instead of slipping through.
 *
 * If you're adding a new endpoint or changing a response shape, edit
 * `contract/schemas.ts`; this function picks up the change on next
 * run.
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

  // Sample requests for endpoints whose existence we test by posting
  // an intentionally-invalid payload (the API key has no permission to
  // create real tenants from this CLI, and we don't have a tenant
  // signing key to forge platform events). Accept-status sets in
  // `compileContract` allow 401/403/409 for exactly this case.
  const sampleBodies: Record<string, string> = {
    "platform-events": JSON.stringify({
      id: "00000000-0000-0000-0000-000000000000",
      type: "platform.verify",
      tenant_id: "verify",
      product: "verify",
      timestamp: new Date().toISOString(),
      data: {},
      schema_version: 1,
      signature: "test",
    }),
    "platform-tenants": JSON.stringify({
      tenant_id: "00000000-0000-0000-0000-000000000000",
      action: "provision",
      idempotency_key: "00000000-0000-0000-0000-000000000000",
    }),
    "god-mode-execute": JSON.stringify({
      tool: "verify.noop",
      params: {},
    }),
  };

  const plan = compileContract().validator;

  for (const ep of plan) {
    const url = `${apiBase}${ep.path}`;
    const body = sampleBodies[ep.id];
    const reqHeaders =
      ep.auth === "bearer"
        ? headers
        : { "Content-Type": headers["Content-Type"] };
    results.push(
      await checkEndpoint(ep.method, url, {
        timeout,
        headers: reqHeaders,
        body,
        acceptStatuses: ep.acceptStatuses,
        // The generated validator picks a response variant via
        // structural discriminator (success-literal / simulation-key)
        // and validates against the chosen shape. checkEndpoint just
        // surfaces the failure message.
        validate: (responseBody, status) => {
          const outcome = ep.validateResponseBody(responseBody, status);
          if (outcome.ok) return null;
          return outcome.message;
        },
      }),
    );
  }

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
    validate: (body: unknown, status: number) => string | null;
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
      // 404 means the endpoint doesn't exist. The Stage-2 spec is
      // explicit that "Unknown tool" returns 200 + error envelope, NOT
      // 404 — so 404 is never an accepted status for /execute.
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

    // Parse body. The Stage-2 review caught a real footgun: the prior
    // empty-`catch` silently swallowed JSON parse failures, letting a
    // non-JSON 4xx body (e.g. a static "Not Found" HTML page on a
    // missing route) reach the validator as `{}`. Fail loudly instead.
    let body: unknown;
    const contentType = res.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");
    const raw = await res.text();
    if (raw.length === 0) {
      // Empty body is acceptable for some endpoints (204-style). The
      // validator gets `null` and can decide.
      body = null;
    } else if (!isJson) {
      return {
        endpoint: `${method} ${endpointPath}`,
        status: "fail",
        message: `Non-JSON response (Content-Type: ${contentType || "missing"}, ${raw.length} bytes)`,
        latencyMs,
      };
    } else {
      try {
        body = JSON.parse(raw);
      } catch (parseErr) {
        return {
          endpoint: `${method} ${endpointPath}`,
          status: "fail",
          message: `Invalid JSON in response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          latencyMs,
        };
      }
    }

    const error = opts.validate(body, res.status);
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
    // AbortSignal.timeout throws a `TimeoutError`; cancelled signals
    // throw an `AbortError`. Reading `err.name` is more robust than
    // substring-matching the message across Node/runtime versions.
    const name = (err as { name?: string } | undefined)?.name ?? "";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "TimeoutError" || name === "AbortError") {
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
