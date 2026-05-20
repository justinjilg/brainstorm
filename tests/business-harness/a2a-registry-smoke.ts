#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  isCapabilityStatusInvokable,
  parseProductFromDID,
} from "../../packages/cli/src/discovery/capability-registry.ts";
import { describeBusinessHarnessEnv, loadBusinessHarnessEnv } from "./env.ts";
import { redactForArtifact, safeSnippet, sha256Short } from "./redaction.ts";
import type {
  BusinessHarnessTrace,
  LiveDiscoveryProbeSummary,
} from "./trace-schema.ts";

const DEFAULT_VM_BASE_URL = "https://vm.brainstorm.co";
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const ARTIFACT_PATH = path.join(
  REPO_ROOT,
  "artifacts/br-a2a-registry-summary.json",
);

interface CapabilityRecord {
  agent_did?: unknown;
  name?: unknown;
  status?: unknown;
  risk_level?: unknown;
  autonomy_required?: unknown;
}

interface RegistryProbe {
  summary: LiveDiscoveryProbeSummary;
  body: unknown;
  text: string;
}

interface CapabilitySample {
  name: string;
  product: string;
  status: string;
  did_hash: string;
  has_risk_level: boolean;
  has_autonomy_required: boolean;
  invokable_by_default: boolean;
}

interface A2ARegistrySummary {
  schema_version: 1;
  generated_at: string;
  success: boolean;
  vm_base_url: string;
  strict_registry_assertions: boolean;
  warnings: string[];
  failures: string[];
  probes: LiveDiscoveryProbeSummary[];
  registry: {
    source: "vm" | "mixed";
    capabilities_seen: number;
    active_capabilities_seen: number;
    inactive_capabilities_seen: number;
    products_seen: string[];
    stale_or_ambiguous: string[];
    samples: CapabilitySample[];
  };
  trace: BusinessHarnessTrace;
}

function generateTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

function bodyKind(
  body: unknown,
  text: string,
): LiveDiscoveryProbeSummary["body_kind"] {
  if (Array.isArray(body)) return "array";
  if (body && typeof body === "object") return "object";
  if (text.trim().length === 0) return "empty";
  return "text";
}

function parseJsonMaybe(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function objectKeys(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>).sort();
}

function extractCapabilities(body: unknown): CapabilityRecord[] {
  if (!body || typeof body !== "object") return [];
  const capabilities = (body as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities)
    ? (capabilities as CapabilityRecord[])
    : [];
}

function extractTenantProducts(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const products = (body as { products?: unknown }).products;
  if (Array.isArray(products)) {
    return [
      ...new Set(
        products
          .map((product) => {
            if (typeof product === "string") return product;
            if (!product || typeof product !== "object") return undefined;
            const record = product as Record<string, unknown>;
            return (
              asString(record.id) ??
              asString(record.product) ??
              asString(record.slug) ??
              asString(record.name)
            );
          })
          .filter((product): product is string => Boolean(product)),
      ),
    ].sort();
  }
  if (products && typeof products === "object") {
    return Object.keys(products as Record<string, unknown>).sort();
  }
  return [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isExpectedCommunityLimit(status: number, strict: boolean): boolean {
  return !strict && [401, 403, 429].includes(status);
}

async function fetchRegistryProbe(
  id: string,
  method: "GET",
  url: string,
  token: string | undefined,
  traceparent: string,
): Promise<RegistryProbe> {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      traceparent,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const body = parseJsonMaybe(text);
  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("x-amzn-requestid") ??
    response.headers.get("cf-ray");

  return {
    body,
    text,
    summary: {
      id,
      method,
      url: new URL(url).pathname,
      auth: token ? "bearer" : "none",
      status: response.status,
      ok: response.ok,
      body_kind: bodyKind(body, text),
      observations: [
        `body=${bodyKind(body, text)}`,
        objectKeys(body).length > 0
          ? `keys=${objectKeys(body).slice(0, 8).join(",")}`
          : "",
        `capabilities=${extractCapabilities(body).length}`,
      ].filter(Boolean),
      request_id_hash: requestId ? sha256Short(requestId) : undefined,
      unknown_headers: [],
    },
  };
}

function buildTrace(
  env: ReturnType<typeof loadBusinessHarnessEnv>,
  runId: string,
  startedAt: string,
  traceparent: string,
): BusinessHarnessTrace {
  return {
    run_id: runId,
    started_at: startedAt,
    tenant: {
      id_hash: sha256Short(
        env.sandboxTenantId ?? "unknown-a2a-registry-tenant",
      ),
    },
    actor: {
      kind: env.actorKind,
      subject_hash: sha256Short(env.apiKey ?? "no-key"),
      auth_mode: env.authMode,
    },
    intent: {
      text_redacted:
        "Read live A2A capability registry state for BR business harness seam.",
      category: "status",
    },
    br: {
      base_url: env.brBaseUrl,
      request_ids: [],
      routed_models: [],
      audit_hashes: [],
      envelope_modes: [],
      unknown_headers: [],
    },
    registry: {
      source: "mixed",
      capabilities_seen: 0,
      products_seen: [],
      stale_or_ambiguous: [],
    },
    actions: [
      {
        step: "a2a-registry-smoke",
        system: "brainstorm",
        mode: "read_only",
        traceparent,
        status: "ok",
      },
    ],
    result: {
      success: false,
      safety_outcome: "no_writes",
      notes: [],
    },
  };
}

function mergeProbeIntoTrace(
  trace: BusinessHarnessTrace,
  probe: LiveDiscoveryProbeSummary,
) {
  if (probe.request_id_hash) trace.br.request_ids.push(probe.request_id_hash);
  trace.actions.push({
    step: probe.id,
    system: probe.id.startsWith("vm_") ? "vm" : "br",
    mode: "read_only",
    status: probe.ok ? "ok" : probe.status >= 500 ? "failed" : "degraded",
    error_code: probe.ok ? undefined : `http_${probe.status}`,
  });
}

function summarizeCapabilities(capabilities: CapabilityRecord[]) {
  const products = new Set<string>();
  const staleOrAmbiguous: string[] = [];
  let active = 0;
  let inactive = 0;
  const samples: CapabilitySample[] = [];
  let missingCoreFields = 0;
  let missingRiskOrAutonomy = 0;

  for (const capability of capabilities) {
    const did = asString(capability.agent_did);
    const name = asString(capability.name);
    const status = asString(capability.status);
    const product = did ? parseProductFromDID(did) : undefined;
    const invokable = isCapabilityStatusInvokable(status);

    if (!did || !name || !status) missingCoreFields++;
    if (!product) staleOrAmbiguous.push(name ?? did ?? "unknown-capability");
    else products.add(product);
    if (invokable) active++;
    else inactive++;
    if (!capability.risk_level || !capability.autonomy_required) {
      missingRiskOrAutonomy++;
    }

    if (samples.length < 10) {
      samples.push({
        name: name ?? "unknown",
        product: product ?? "unknown",
        status: status ?? "unknown",
        did_hash: sha256Short(did ?? "unknown-did"),
        has_risk_level: Boolean(capability.risk_level),
        has_autonomy_required: Boolean(capability.autonomy_required),
        invokable_by_default: invokable,
      });
    }
  }

  return {
    active,
    inactive,
    products: [...products].sort(),
    staleOrAmbiguous: [...new Set(staleOrAmbiguous)].slice(0, 25),
    samples,
    missingCoreFields,
    missingRiskOrAutonomy,
  };
}

async function formatJson(text: string): Promise<string> {
  try {
    const prettier = await import("prettier");
    return await prettier.format(text, { parser: "json" });
  } catch {
    return text;
  }
}

async function writeSummary(summary: A2ARegistrySummary) {
  mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  const json = `${JSON.stringify(redactForArtifact(summary), null, 2)}\n`;
  writeFileSync(ARTIFACT_PATH, await formatJson(json));
}

async function main() {
  const env = loadBusinessHarnessEnv();
  const vmBaseUrl =
    process.env.BRAINSTORM_VM_URL?.replace(/\/$/, "") ?? DEFAULT_VM_BASE_URL;
  const vmToken = process.env.BRAINSTORM_VM_API_KEY?.trim() ?? env.apiKey;
  const strictRegistryAssertions =
    Boolean(process.env.BRAINSTORM_VM_API_KEY) ||
    env.authMode !== "community_key";
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const traceparent = generateTraceparent();
  const warnings = [...env.warnings];
  const failures: string[] = [];
  const probes: RegistryProbe[] = [];

  console.log("BR A2A registry smoke");
  for (const line of describeBusinessHarnessEnv(env)) console.log(`  ${line}`);
  console.log(`  vm_base_url=${vmBaseUrl}`);
  console.log(
    `  strict_registry_assertions=${strictRegistryAssertions ? "1" : "0"}`,
  );
  for (const warning of warnings) console.log(`  warning: ${warning}`);

  if (!env.liveBrEnabled) {
    console.log("  live gate disabled; no network calls performed.");
    console.log("  set RUN_LIVE_BR=1 to probe live A2A registry surfaces.");
    return;
  }

  const trace = buildTrace(env, runId, startedAt, traceparent);

  const specs = [
    {
      id: "vm_capability_registry",
      url: `${vmBaseUrl}/api/v1/capabilities/list?status=active`,
      token: vmToken,
    },
    {
      id: "br_tenant_context",
      url: `${env.brBaseUrl.replace(/\/$/, "")}/v1/tenant/context`,
      token: env.apiKey,
    },
  ];

  for (const spec of specs) {
    try {
      const probe = await fetchRegistryProbe(
        spec.id,
        "GET",
        spec.url,
        spec.token,
        traceparent,
      );
      probes.push(probe);
      mergeProbeIntoTrace(trace, probe.summary);
      console.log(
        `  ${probe.summary.ok ? "ok" : "warn"} GET ${probe.summary.url} -> ${probe.summary.status}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${spec.id}: network failure: ${safeSnippet(message)}`);
      trace.actions.push({
        step: spec.id,
        system: spec.id.startsWith("vm_") ? "vm" : "br",
        mode: "read_only",
        status: "failed",
        error_code: "network_error",
      });
    }
  }

  const vmRegistry = probes.find(
    (probe) => probe.summary.id === "vm_capability_registry",
  );
  const tenantContext = probes.find(
    (probe) => probe.summary.id === "br_tenant_context",
  );

  let capabilitySummary = summarizeCapabilities([]);
  let tenantProducts: string[] = [];
  if (vmRegistry?.summary.status === 200) {
    capabilitySummary = summarizeCapabilities(
      extractCapabilities(vmRegistry.body),
    );
    if (capabilitySummary.active === 0) {
      const message =
        "VM capability registry returned no active capabilities for A2A.";
      if (strictRegistryAssertions) failures.push(message);
      else warnings.push(message);
    }
    if (!capabilitySummary.products.includes("br")) {
      const message =
        "VM capability registry did not expose BR as a product in this pass.";
      if (strictRegistryAssertions) failures.push(message);
      else warnings.push(message);
    }
    if (capabilitySummary.missingCoreFields > 0) {
      failures.push(
        `Capability records missing DID/name/status: ${capabilitySummary.missingCoreFields}.`,
      );
    }
    if (capabilitySummary.missingRiskOrAutonomy > 0) {
      warnings.push(
        `Capability records missing risk_level/autonomy_required: ${capabilitySummary.missingRiskOrAutonomy}.`,
      );
    }
  } else if (vmRegistry) {
    const message = `VM capability registry returned HTTP ${vmRegistry.summary.status}.`;
    if (
      isExpectedCommunityLimit(
        vmRegistry.summary.status,
        strictRegistryAssertions,
      )
    ) {
      warnings.push(
        `${message} Set BRAINSTORM_VM_API_KEY for full registry verification.`,
      );
    } else {
      failures.push(message);
    }
  } else {
    failures.push("VM capability registry probe did not run.");
  }

  if (tenantContext) {
    if (tenantContext.summary.status === 200) {
      if (tenantContext.summary.body_kind !== "object") {
        failures.push("BR tenant context must return a JSON object on 200.");
      }
      tenantProducts = extractTenantProducts(tenantContext.body);
    } else if ([401, 403].includes(tenantContext.summary.status)) {
      warnings.push(
        `BR tenant context returned HTTP ${tenantContext.summary.status}; authorized tenant-context verification remains pending.`,
      );
    } else if (tenantContext.summary.status >= 500) {
      failures.push(
        `BR tenant context returned server status ${tenantContext.summary.status}.`,
      );
    } else {
      warnings.push(
        `BR tenant context returned HTTP ${tenantContext.summary.status}.`,
      );
    }
  }

  const productsSeen = [
    ...new Set([...capabilitySummary.products, ...tenantProducts]),
  ].sort();
  const registrySource = tenantProducts.length > 0 ? "mixed" : "vm";

  trace.registry.source = registrySource;
  trace.registry.capabilities_seen =
    capabilitySummary.active + capabilitySummary.inactive;
  trace.registry.products_seen = productsSeen;
  trace.registry.stale_or_ambiguous = capabilitySummary.staleOrAmbiguous;
  trace.br.request_ids = [...new Set(trace.br.request_ids)];
  trace.completed_at = new Date().toISOString();
  trace.result.success = failures.length === 0;
  trace.result.notes =
    failures.length === 0 ? ["a2a registry smoke passed"] : failures;
  trace.actions[0].status = failures.length === 0 ? "ok" : "failed";

  const summary: A2ARegistrySummary = {
    schema_version: 1,
    generated_at: trace.completed_at,
    success: failures.length === 0,
    vm_base_url: vmBaseUrl,
    strict_registry_assertions: strictRegistryAssertions,
    warnings,
    failures,
    probes: probes.map((probe) => probe.summary),
    registry: {
      source: registrySource,
      capabilities_seen: capabilitySummary.active + capabilitySummary.inactive,
      active_capabilities_seen: capabilitySummary.active,
      inactive_capabilities_seen: capabilitySummary.inactive,
      products_seen: productsSeen,
      stale_or_ambiguous: capabilitySummary.staleOrAmbiguous,
      samples: capabilitySummary.samples,
    },
    trace,
  };

  if (env.recordEnabled) {
    await writeSummary(summary);
    console.log(`  artifact: ${path.relative(REPO_ROOT, ARTIFACT_PATH)}`);
  }

  if (failures.length > 0) {
    console.error("\nBR A2A registry smoke failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(
    `\nBR A2A registry smoke passed: products=${productsSeen.join(",") || "none"}, active=${capabilitySummary.active}, warnings=${warnings.length}.`,
  );
}

main().catch((err) => {
  const message =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`BR A2A registry smoke crashed: ${safeSnippet(message, 500)}`);
  process.exit(2);
});
