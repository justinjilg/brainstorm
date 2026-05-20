#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseBrEnvelope } from "../../packages/providers/src/cloud/br-envelope.ts";
import { describeBusinessHarnessEnv, loadBusinessHarnessEnv } from "./env.ts";
import { redactForArtifact, safeSnippet, sha256Short } from "./redaction.ts";
import type {
  BusinessHarnessTrace,
  LiveDiscoveryProbeSummary,
  LiveDiscoverySummary,
} from "./trace-schema.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const ARTIFACT_PATH = path.join(
  REPO_ROOT,
  "artifacts/br-live-discovery-summary.json",
);
const CONTRACT_MAP_PATH = path.join(
  REPO_ROOT,
  "artifacts/br-business-contract-map.json",
);
const CLI_MEMORY_BLOCKS = ["human", "system", "project", "general"];
const STALE_DISCOVERY_LINKS = [
  "/v1/agent/status",
  "/v1/agent/memory",
  "/v1/intelligence/leaderboard",
  "/v1/intelligence/insights",
];

interface ProbeSpec {
  id: string;
  method: "GET" | "POST";
  url: string;
  auth: "none" | "bearer";
  body?: unknown;
  timeoutMs?: number;
}

interface ProbeResult {
  summary: LiveDiscoveryProbeSummary;
  body: unknown;
  text: string;
  headers: Headers;
}

function assertOk(condition: unknown, failures: string[], message: string) {
  if (!condition) failures.push(message);
}

function communityRateLimited(
  authMode: string,
  probe: ProbeResult | undefined,
): boolean {
  return authMode === "community_key" && probe?.summary.status === 429;
}

function assertLiveEndpointOk(
  env: ReturnType<typeof loadBusinessHarnessEnv>,
  probe: ProbeResult | undefined,
  failures: string[],
  warnings: string[],
  id: string,
) {
  if (probe?.summary.status === 200) return;
  if (communityRateLimited(env.authMode, probe)) {
    warnings.push(
      `${id}: community key hit BR rate limit; set BRAINSTORM_API_KEY for full verification.`,
    );
    return;
  }
  failures.push(`${id} must return 200 with the active key.`);
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

function objectKeys(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>).sort();
}

function arrayCount(body: unknown): number | undefined {
  if (Array.isArray(body)) return body.length;
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of [
    "data",
    "models",
    "results",
    "entries",
    "memories",
    "rankings",
  ]) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function parseJsonMaybe(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function generateTraceparent(): string {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}-01`;
}

function loadRequiredOpenApiPaths(): string[] {
  try {
    const raw = readFileSync(CONTRACT_MAP_PATH, "utf8");
    const map = JSON.parse(raw) as {
      routes?: Array<{ target?: string; contract?: string; path?: string }>;
    };
    return [
      ...new Set(
        (map.routes ?? [])
          .filter(
            (route) => route.target === "br" && route.contract === "br-openapi",
          )
          .map((route) => route.path)
          .filter((route): route is string => Boolean(route)),
      ),
    ];
  } catch {
    return [
      "/health",
      "/attestation",
      "/v1/discovery",
      "/v1/self",
      "/v1/chat/completions",
      "/v1/budget/status",
      "/v1/budget/forecast",
      "/v1/intelligence/rankings",
      "/v1/insights/optimize",
      "/v1/models",
      "/v1/memory/query",
      "/v1/memory/store",
      "/v1/mesh/invoke-did/{target_did}",
      "/v1/mesh/invoke/{hostname}",
    ];
  }
}

async function fetchProbe(
  spec: ProbeSpec,
  apiKey: string | undefined,
  traceparent: string,
): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    traceparent,
  };
  if (spec.auth === "bearer" && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (spec.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(spec.url, {
    method: spec.method,
    headers,
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    signal: AbortSignal.timeout(spec.timeoutMs ?? 20_000),
  });
  const text = await response.text();
  const body = parseJsonMaybe(text);
  const envelope = parseBrEnvelope(response.headers);
  const observations = [
    `body=${bodyKind(body, text)}`,
    objectKeys(body).length > 0
      ? `keys=${objectKeys(body).slice(0, 8).join(",")}`
      : "",
    arrayCount(body) !== undefined ? `count=${arrayCount(body)}` : "",
  ].filter(Boolean);

  return {
    body,
    text,
    headers: response.headers,
    summary: {
      id: spec.id,
      method: spec.method,
      url: new URL(spec.url).pathname,
      auth: spec.auth,
      status: response.status,
      ok: response.ok,
      body_kind: bodyKind(body, text),
      observations,
      request_id_hash: envelope.requestId
        ? sha256Short(envelope.requestId)
        : undefined,
      routed_model: envelope.routedModel,
      audit_hash: envelope.auditHash,
      envelope_mode: envelope.envelope,
      unknown_headers: envelope.unknownHeaders,
    },
  };
}

function memoryBlocksFromDiscovery(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as {
    capabilities?: { memory?: { blocks?: unknown } };
    memory?: { blocks?: unknown };
  };
  const blocks = record.capabilities?.memory?.blocks ?? record.memory?.blocks;
  return Array.isArray(blocks)
    ? blocks.filter((block): block is string => typeof block === "string")
    : [];
}

function pathSetFromOpenApi(body: unknown): Set<string> {
  if (!body || typeof body !== "object") return new Set();
  const paths = (body as { paths?: unknown }).paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths))
    return new Set();
  return new Set(Object.keys(paths));
}

function stringContainsAnyJson(body: unknown, needles: string[]): string[] {
  const text = JSON.stringify(body ?? {});
  return needles.filter((needle) => text.includes(needle));
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
      id_hash: sha256Short(env.sandboxTenantId ?? "unknown-live-br-tenant"),
    },
    actor: {
      kind: env.actorKind,
      subject_hash: sha256Short(env.apiKey ?? "no-key"),
      auth_mode: env.authMode,
    },
    intent: {
      text_redacted:
        "Read-only live BR discovery smoke for the business harness seam.",
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
      source: "br",
      capabilities_seen: 0,
      products_seen: [],
      stale_or_ambiguous: [],
    },
    actions: [
      {
        step: "initialize-live-br-discovery",
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
  if (probe.routed_model) trace.br.routed_models.push(probe.routed_model);
  if (probe.audit_hash) trace.br.audit_hashes.push(probe.audit_hash);
  if (probe.envelope_mode) trace.br.envelope_modes.push(probe.envelope_mode);
  trace.br.unknown_headers.push(...probe.unknown_headers);
  trace.actions.push({
    step: probe.id,
    system: "br",
    mode: "read_only",
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

async function writeSummary(summary: LiveDiscoverySummary) {
  mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  const json = `${JSON.stringify(redactForArtifact(summary), null, 2)}\n`;
  writeFileSync(ARTIFACT_PATH, await formatJson(json));
}

async function main() {
  const env = loadBusinessHarnessEnv();
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const traceparent = generateTraceparent();

  console.log("BR live discovery smoke");
  for (const line of describeBusinessHarnessEnv(env)) console.log(`  ${line}`);
  for (const warning of env.warnings) console.log(`  warning: ${warning}`);

  if (!env.liveBrEnabled) {
    console.log("  live gate disabled; no network calls performed.");
    console.log("  set RUN_LIVE_BR=1 to probe live BR read-only surfaces.");
    return;
  }

  const trace = buildTrace(env, runId, startedAt, traceparent);
  const failures: string[] = [];
  const warnings = [...env.warnings];
  const probes: ProbeResult[] = [];
  const api = (pathName: string) => `${env.brBaseUrl}${pathName}`;
  const site = (pathName: string) => `${env.brSiteUrl}${pathName}`;

  const probeSpecs: ProbeSpec[] = [
    { id: "health", method: "GET", url: api("/health"), auth: "none" },
    {
      id: "openapi",
      method: "GET",
      url: api("/openapi.json"),
      auth: "none",
    },
    { id: "llms", method: "GET", url: site("/llms.txt"), auth: "none" },
    {
      id: "attestation",
      method: "GET",
      url: api("/attestation"),
      auth: "none",
    },
    {
      id: "self_missing_auth",
      method: "GET",
      url: api("/v1/self"),
      auth: "none",
    },
    {
      id: "discovery",
      method: "GET",
      url: api("/v1/discovery"),
      auth: "bearer",
    },
    { id: "self", method: "GET", url: api("/v1/self"), auth: "bearer" },
    {
      id: "models",
      method: "GET",
      url: api("/v1/models"),
      auth: "bearer",
    },
    {
      id: "budget_status",
      method: "GET",
      url: api("/v1/budget/status"),
      auth: "bearer",
    },
    {
      id: "budget_forecast",
      method: "GET",
      url: api("/v1/budget/forecast"),
      auth: "bearer",
    },
    {
      id: "insights_optimize",
      method: "GET",
      url: api("/v1/insights/optimize"),
      auth: "bearer",
    },
    {
      id: "intelligence_rankings",
      method: "GET",
      url: api("/v1/intelligence/rankings"),
      auth: "bearer",
    },
    {
      id: "memory_query",
      method: "POST",
      url: api("/v1/memory/query"),
      auth: "bearer",
      body: {
        query: "business harness live discovery smoke",
        limit: 3,
      },
    },
  ];

  for (const spec of probeSpecs) {
    try {
      const probe = await fetchProbe(spec, env.apiKey, traceparent);
      probes.push(probe);
      mergeProbeIntoTrace(trace, probe.summary);
      console.log(
        `  ${probe.summary.ok ? "ok" : "warn"} ${spec.method} ${probe.summary.url} -> ${probe.summary.status}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(
        `${spec.id}: network/probe failure: ${safeSnippet(message)}`,
      );
      trace.actions.push({
        step: spec.id,
        system: "br",
        mode: "read_only",
        status: "failed",
        error_code: "network_error",
      });
    }
  }

  const byId = new Map(probes.map((probe) => [probe.summary.id, probe]));
  const health = byId.get("health");
  assertOk(
    health?.summary.status === 200,
    failures,
    "GET /health must return 200.",
  );
  assertOk(
    health?.summary.body_kind === "object",
    failures,
    "GET /health must return a JSON object.",
  );

  const openapi = byId.get("openapi");
  const openapiPaths = pathSetFromOpenApi(openapi?.body);
  assertOk(
    openapi?.summary.status === 200,
    failures,
    "GET /openapi.json must return 200.",
  );
  assertOk(
    openapiPaths.size >= 100,
    failures,
    `GET /openapi.json path floor failed: saw ${openapiPaths.size}, expected >=100.`,
  );
  for (const requiredPath of loadRequiredOpenApiPaths()) {
    assertOk(
      openapiPaths.has(requiredPath),
      failures,
      `OpenAPI missing harness-used BR path ${requiredPath}.`,
    );
  }

  const llms = byId.get("llms");
  if (!llms?.summary.ok) {
    const fallback = await fetchProbe(
      {
        id: "llms_full",
        method: "GET",
        url: site("/llms-full.txt"),
        auth: "none",
      },
      env.apiKey,
      traceparent,
    );
    probes.push(fallback);
    mergeProbeIntoTrace(trace, fallback.summary);
    assertOk(
      fallback.summary.ok,
      failures,
      "GET /llms.txt or /llms-full.txt must return 200.",
    );
    assertOk(
      /brainstormrouter/i.test(fallback.text) &&
        /(discovery|openapi|capabilit)/i.test(fallback.text),
      failures,
      "llms-full.txt must mention BrainstormRouter discovery/OpenAPI/capabilities.",
    );
  } else {
    assertOk(
      /brainstormrouter/i.test(llms.text) &&
        /(discovery|openapi|capabilit)/i.test(llms.text),
      failures,
      "llms.txt must mention BrainstormRouter discovery/OpenAPI/capabilities.",
    );
  }

  const attestation = byId.get("attestation");
  assertOk(
    attestation !== undefined &&
      [200, 401, 403].includes(attestation.summary.status),
    failures,
    "GET /attestation must return 200 or documented auth behavior (401/403).",
  );

  const selfMissingAuth = byId.get("self_missing_auth");
  assertOk(
    selfMissingAuth !== undefined &&
      [401, 403].includes(selfMissingAuth.summary.status),
    failures,
    "GET /v1/self without auth must return stable 401/403 behavior.",
  );

  const discovery = byId.get("discovery");
  assertOk(
    discovery?.summary.status === 200,
    failures,
    "GET /v1/discovery with key must return 200.",
  );
  const liveBlocks = memoryBlocksFromDiscovery(discovery?.body);
  assertOk(
    JSON.stringify([...liveBlocks].sort()) ===
      JSON.stringify([...CLI_MEMORY_BLOCKS].sort()),
    failures,
    `Discovery memory blocks drifted: saw [${liveBlocks.join(",")}], expected [${CLI_MEMORY_BLOCKS.join(",")}].`,
  );
  const staleLinks = stringContainsAnyJson(
    discovery?.body,
    STALE_DISCOVERY_LINKS,
  );
  assertOk(
    staleLinks.length === 0,
    failures,
    `Discovery still references removed paths: ${staleLinks.join(", ")}`,
  );
  const discoveryCapabilities = (() => {
    const body = discovery?.body;
    if (!body || typeof body !== "object") return 0;
    const capabilities = (body as { capabilities?: unknown }).capabilities;
    if (!capabilities || typeof capabilities !== "object") return 0;
    return Object.keys(capabilities as Record<string, unknown>).length;
  })();
  trace.registry.capabilities_seen = discoveryCapabilities;

  for (const id of [
    "self",
    "models",
    "budget_status",
    "insights_optimize",
    "intelligence_rankings",
  ]) {
    const probe = byId.get(id);
    assertLiveEndpointOk(env, probe, failures, warnings, id);
    if (probe?.summary.status === 200) {
      assertOk(
        probe.summary.body_kind === "object" ||
          probe.summary.body_kind === "array",
        failures,
        `${id} must return JSON object/array.`,
      );
    }
  }

  const models = byId.get("models");
  if (!communityRateLimited(env.authMode, models)) {
    assertOk(
      (arrayCount(models?.body) ?? 0) > 0,
      failures,
      "GET /v1/models must return a non-empty model list.",
    );
  }

  const forecast = byId.get("budget_forecast");
  assertOk(
    forecast !== undefined &&
      (forecast.summary.status === 200 ||
        [400, 401, 403, 422].includes(forecast.summary.status) ||
        communityRateLimited(env.authMode, forecast)),
    failures,
    "GET /v1/budget/forecast must return 200 or documented limited-data/auth behavior.",
  );

  const memory = byId.get("memory_query");
  assertOk(
    memory !== undefined &&
      (memory.summary.status === 200 ||
        [401, 403].includes(memory.summary.status) ||
        communityRateLimited(env.authMode, memory)),
    failures,
    "POST /v1/memory/query must return 200 or documented auth behavior.",
  );
  if (communityRateLimited(env.authMode, memory)) {
    warnings.push(
      "memory_query: community key hit BR rate limit; set BRAINSTORM_API_KEY for full memory-query verification.",
    );
  }

  trace.br.request_ids = [...new Set(trace.br.request_ids)];
  trace.br.routed_models = [...new Set(trace.br.routed_models)];
  trace.br.audit_hashes = [...new Set(trace.br.audit_hashes)];
  trace.br.envelope_modes = [...new Set(trace.br.envelope_modes)];
  trace.br.unknown_headers = [...new Set(trace.br.unknown_headers)];
  trace.completed_at = new Date().toISOString();
  trace.result.success = failures.length === 0;
  trace.result.notes =
    failures.length === 0 ? ["live BR discovery smoke passed"] : failures;

  const summary: LiveDiscoverySummary = {
    schema_version: 1,
    generated_at: trace.completed_at,
    success: failures.length === 0,
    probes: probes.map((probe) => probe.summary),
    failures,
    warnings,
    trace,
  };

  if (env.recordEnabled) {
    await writeSummary(summary);
    console.log(`  artifact: ${path.relative(REPO_ROOT, ARTIFACT_PATH)}`);
  }

  if (failures.length > 0) {
    console.error("\nBR live discovery smoke failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(
    `\nBR live discovery smoke passed: ${probes.length} probes, auth=${env.authMode}, writes=none.`,
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("RUN_LIVE_BR_WRITES")) {
    console.error(`BR live discovery smoke refused to run: ${message}`);
  } else {
    const detail = err instanceof Error ? (err.stack ?? err.message) : message;
    console.error(
      `BR live discovery smoke crashed: ${safeSnippet(detail, 500)}`,
    );
  }
  process.exit(2);
});
