#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describeBusinessHarnessEnv, loadBusinessHarnessEnv } from "./env.ts";
import {
  credentialSubjectMarker,
  redactForArtifact,
  safeSnippet,
  sha256Short,
} from "./redaction.ts";
import type {
  BusinessHarnessTrace,
  LiveDiscoveryProbeSummary,
} from "./trace-schema.ts";

type ProductId = "br" | "msp" | "vm" | "gtm" | "backup";
type ProductReadiness =
  | "ok"
  | "auth_blocked"
  | "missing"
  | "invalid_shape"
  | "unavailable"
  | "not_checked";

interface ProductSpec {
  id: ProductId;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
}

interface ProductProbe {
  summary: LiveDiscoveryProbeSummary;
  body: unknown;
  text: string;
}

interface ProductReadinessSummary {
  product: ProductId;
  base_url: string;
  health: ProductReadiness;
  tools: ProductReadiness;
  product_slug?: string;
  version?: string;
  tool_count?: number;
  read_only_tools: number;
  change_set_required_tools: number;
  high_or_critical_without_changeset: number;
  observations: string[];
}

interface ProductPlatformSummary {
  schema_version: 1;
  generated_at: string;
  success: boolean;
  strict_product_assertions: boolean;
  warnings: string[];
  failures: string[];
  products: ProductReadinessSummary[];
  probes: LiveDiscoveryProbeSummary[];
  trace: BusinessHarnessTrace;
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const ARTIFACT_PATH = path.join(
  REPO_ROOT,
  "artifacts/product-platform-smoke-summary.json",
);

const PRODUCT_SPECS: ProductSpec[] = [
  {
    id: "br",
    name: "BrainstormRouter",
    baseUrl:
      process.env.BRAINSTORM_BR_URL ?? "https://api.brainstormrouter.com",
    apiKeyEnv: "BRAINSTORM_BR_API_KEY",
  },
  {
    id: "msp",
    name: "BrainstormMSP",
    baseUrl: process.env.BRAINSTORM_MSP_URL ?? "https://brainstormmsp.ai",
    apiKeyEnv: "BRAINSTORM_MSP_API_KEY",
  },
  {
    id: "vm",
    name: "BrainstormVM",
    baseUrl: process.env.BRAINSTORM_VM_URL ?? "https://vm.brainstorm.co",
    apiKeyEnv: "BRAINSTORM_VM_API_KEY",
  },
  {
    id: "gtm",
    name: "BrainstormGTM",
    baseUrl: process.env.BRAINSTORM_GTM_URL ?? "https://catsfeet.com",
    apiKeyEnv: "BRAINSTORM_GTM_API_KEY",
  },
  {
    id: "backup",
    name: "BrainstormBackup",
    baseUrl:
      process.env.BRAINSTORM_BACKUP_URL ?? "https://backup.brainstorm.co",
    apiKeyEnv: "BRAINSTORM_BACKUP_API_KEY",
  },
];

function truthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function extractTools(body: unknown): Array<Record<string, unknown>> {
  const record = asRecord(body);
  if (!record) return [];
  const tools = record.tools;
  return Array.isArray(tools)
    ? tools.filter((tool): tool is Record<string, unknown> =>
        Boolean(asRecord(tool)),
      )
    : [];
}

function readinessForStatus(
  status: number,
  bodyValid: boolean,
): ProductReadiness {
  if (status === 0) return "unavailable";
  if ([401, 403].includes(status)) return "auth_blocked";
  if (status === 404 || status === 405) return "missing";
  if (status >= 500) return "unavailable";
  if (status >= 200 && status < 300) return bodyValid ? "ok" : "invalid_shape";
  return "invalid_shape";
}

function tokenForProduct(
  product: ProductSpec,
  env: ReturnType<typeof loadBusinessHarnessEnv>,
): string | undefined {
  const productToken = process.env[product.apiKeyEnv]?.trim();
  if (productToken) return productToken;

  const configuredSharedToken = process.env.BRAINSTORM_API_KEY?.trim();
  if (configuredSharedToken) return configuredSharedToken;

  // The public community key is BR-specific; avoid spraying it at product APIs.
  return product.id === "br" ? env.apiKey : undefined;
}

async function fetchProductProbe(
  product: ProductSpec,
  kind: "health" | "tools",
  token: string | undefined,
  traceparent: string,
): Promise<ProductProbe> {
  const pathName = kind === "health" ? "/health" : "/api/v1/god-mode/tools";
  const response = await fetch(
    `${product.baseUrl.replace(/\/$/, "")}${pathName}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        traceparent,
        ...(token && kind === "tools"
          ? { Authorization: `Bearer ${token}` }
          : {}),
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const text = await response.text();
  const body = parseJsonMaybe(text);
  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("x-amzn-requestid") ??
    response.headers.get("cf-ray");
  const tools = extractTools(body);

  return {
    body,
    text,
    summary: {
      id: `${product.id}_${kind}`,
      method: "GET",
      url: pathName,
      auth: token && kind === "tools" ? "bearer" : "none",
      status: response.status,
      ok: response.ok,
      body_kind: bodyKind(body, text),
      observations: [
        `product=${product.id}`,
        `body=${bodyKind(body, text)}`,
        objectKeys(body).length > 0
          ? `keys=${objectKeys(body).slice(0, 8).join(",")}`
          : "",
        tools.length > 0 ? `tools=${tools.length}` : "",
      ].filter(Boolean),
      request_id_hash: requestId ? sha256Short(requestId) : undefined,
      unknown_headers: [],
    },
  };
}

function summarizeProduct(
  product: ProductSpec,
  health: ProductProbe | undefined,
  toolsProbe: ProductProbe | undefined,
): ProductReadinessSummary {
  const healthRecord = asRecord(health?.body);
  const toolsRecord = asRecord(toolsProbe?.body);
  const tools = extractTools(toolsProbe?.body);
  const highWithoutChangeSet = tools.filter((tool) => {
    const risk = asString(tool.risk_level);
    return (
      (risk === "high" || risk === "critical") &&
      tool.requires_changeset !== true
    );
  }).length;

  return {
    product: product.id,
    base_url: product.baseUrl,
    health: health
      ? readinessForStatus(
          health.summary.status,
          Boolean(
            asString(healthRecord?.status) &&
            asString(healthRecord?.product) &&
            asString(healthRecord?.version),
          ),
        )
      : "not_checked",
    tools: toolsProbe
      ? readinessForStatus(
          toolsProbe.summary.status,
          Boolean(
            toolsRecord &&
            asString(toolsRecord.product) &&
            (asNumber(toolsRecord.tool_count) !== undefined ||
              Array.isArray(toolsRecord.tools)),
          ),
        )
      : "not_checked",
    product_slug:
      asString(healthRecord?.product) ?? asString(toolsRecord?.product),
    version: asString(healthRecord?.version) ?? asString(toolsRecord?.version),
    tool_count: asNumber(toolsRecord?.tool_count) ?? tools.length,
    read_only_tools: tools.filter((tool) => tool.risk_level === "read_only")
      .length,
    change_set_required_tools: tools.filter(
      (tool) => tool.requires_changeset === true,
    ).length,
    high_or_critical_without_changeset: highWithoutChangeSet,
    observations: [
      health?.summary.status !== undefined
        ? `health_http=${health.summary.status}`
        : "health_not_checked",
      toolsProbe?.summary.status !== undefined
        ? `tools_http=${toolsProbe.summary.status}`
        : "tools_not_checked",
      highWithoutChangeSet > 0
        ? `unsafe_high_tools=${highWithoutChangeSet}`
        : "",
    ].filter(Boolean),
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
      id_hash: sha256Short(env.sandboxTenantId ?? "unknown-product-tenant"),
    },
    actor: {
      kind: env.actorKind,
      subject_hash: credentialSubjectMarker(env.authMode),
      auth_mode: env.authMode,
    },
    intent: {
      text_redacted:
        "Read product platform contract readiness for business actuators.",
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
      products_seen: PRODUCT_SPECS.map((product) => product.id),
      stale_or_ambiguous: [],
    },
    actions: [
      {
        step: "product-platform-smoke",
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

function systemForProduct(
  product: ProductId,
): BusinessHarnessTrace["actions"][number]["system"] {
  return product;
}

function mergeProbeIntoTrace(
  trace: BusinessHarnessTrace,
  product: ProductId,
  probe: LiveDiscoveryProbeSummary,
) {
  if (product === "br" && probe.request_id_hash) {
    trace.br.request_ids.push(probe.request_id_hash);
  }
  trace.actions.push({
    step: probe.id,
    system: systemForProduct(product),
    mode: "read_only",
    request_id_hash: probe.request_id_hash,
    status: probe.ok ? "ok" : probe.status >= 500 ? "failed" : "degraded",
    error_code: probe.ok ? undefined : `http_${probe.status}`,
  });
}

async function formatJson(text: string): Promise<string> {
  try {
    const prettier = await import("prettier");
    return await prettier.format(text, { parser: "json" });
  } catch {
    return text;
  }
}

async function writeSummary(summary: ProductPlatformSummary) {
  mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  const json = `${JSON.stringify(redactForArtifact(summary), null, 2)}\n`;
  writeFileSync(ARTIFACT_PATH, await formatJson(json));
}

function warnOrFail(
  strict: boolean,
  warnings: string[],
  failures: string[],
  message: string,
) {
  if (strict) failures.push(message);
  else warnings.push(message);
}

async function main() {
  const env = loadBusinessHarnessEnv();
  const liveProductsEnabled =
    env.liveBrEnabled || truthy(process.env.RUN_LIVE_PRODUCTS);
  const strictProductAssertions = truthy(process.env.RUN_LIVE_PRODUCTS_STRICT);
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const traceparent = generateTraceparent();
  const warnings = [...env.warnings];
  const failures: string[] = [];
  const probes: ProductProbe[] = [];

  console.log("Product platform contract smoke");
  for (const line of describeBusinessHarnessEnv(env)) console.log(`  ${line}`);
  console.log(`  RUN_LIVE_PRODUCTS=${liveProductsEnabled ? "1" : "0"}`);
  console.log(
    `  strict_product_assertions=${strictProductAssertions ? "1" : "0"}`,
  );
  for (const warning of warnings) console.log(`  warning: ${warning}`);

  if (!liveProductsEnabled) {
    console.log("  live gate disabled; no network calls performed.");
    console.log(
      "  set RUN_LIVE_PRODUCTS=1 or RUN_LIVE_BR=1 to probe product actuator readiness.",
    );
    return;
  }

  const trace = buildTrace(env, runId, startedAt, traceparent);

  for (const product of PRODUCT_SPECS) {
    const token = tokenForProduct(product, env);
    for (const kind of ["health", "tools"] as const) {
      try {
        const probe = await fetchProductProbe(
          product,
          kind,
          token,
          traceparent,
        );
        probes.push(probe);
        mergeProbeIntoTrace(trace, product.id, probe.summary);
        console.log(
          `  ${probe.summary.ok ? "ok" : "warn"} ${product.id} GET ${probe.summary.url} -> ${probe.summary.status}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(
          `${product.id}_${kind}: network failure: ${safeSnippet(message)}`,
        );
        trace.actions.push({
          step: `${product.id}_${kind}`,
          system: systemForProduct(product.id),
          mode: "read_only",
          status: "failed",
          error_code: "network_error",
        });
      }
    }
  }

  const productSummaries = PRODUCT_SPECS.map((product) => {
    const health = probes.find(
      (probe) => probe.summary.id === `${product.id}_health`,
    );
    const tools = probes.find(
      (probe) => probe.summary.id === `${product.id}_tools`,
    );
    return summarizeProduct(product, health, tools);
  });

  for (const product of productSummaries) {
    if (product.health !== "ok") {
      warnOrFail(
        strictProductAssertions,
        warnings,
        failures,
        `${product.product}: platform health readiness=${product.health}.`,
      );
    }
    if (product.tools !== "ok" && product.tools !== "auth_blocked") {
      warnOrFail(
        strictProductAssertions,
        warnings,
        failures,
        `${product.product}: god-mode tools readiness=${product.tools}.`,
      );
    }
    if (product.high_or_critical_without_changeset > 0) {
      failures.push(
        `${product.product}: ${product.high_or_critical_without_changeset} high/critical tool(s) missing requires_changeset=true.`,
      );
    }
  }

  trace.br.request_ids = [...new Set(trace.br.request_ids)];
  trace.completed_at = new Date().toISOString();
  trace.result.success = failures.length === 0;
  trace.result.notes =
    failures.length === 0 ? ["product platform smoke completed"] : failures;
  trace.actions[0].status = failures.length === 0 ? "ok" : "failed";

  const summary: ProductPlatformSummary = {
    schema_version: 1,
    generated_at: trace.completed_at,
    success: failures.length === 0,
    strict_product_assertions: strictProductAssertions,
    warnings,
    failures,
    products: productSummaries,
    probes: probes.map((probe) => probe.summary),
    trace,
  };

  if (env.recordEnabled || truthy(process.env.RECORD_PRODUCT_PLATFORM_SMOKE)) {
    await writeSummary(summary);
    console.log(`  artifact: ${path.relative(REPO_ROOT, ARTIFACT_PATH)}`);
  }

  if (failures.length > 0) {
    console.error("\nProduct platform contract smoke failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  const okHealth = productSummaries.filter(
    (product) => product.health === "ok",
  ).length;
  const okTools = productSummaries.filter(
    (product) => product.tools === "ok",
  ).length;
  console.log(
    `\nProduct platform contract smoke completed: health_ok=${okHealth}/${productSummaries.length}, tools_ok=${okTools}/${productSummaries.length}, warnings=${warnings.length}.`,
  );
}

main().catch((err) => {
  const message =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `Product platform contract smoke crashed: ${safeSnippet(message, 500)}`,
  );
  process.exit(2);
});
