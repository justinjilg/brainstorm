#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { redactForArtifact } from "./redaction.ts";
import type { BusinessHarnessTrace } from "./trace-schema.ts";

interface ScenarioPostureSummary {
  schema_version: 1;
  scenario: "platform_posture_read";
  generated_at: string;
  success: boolean;
  warnings: string[];
  failures: string[];
  inputs: Record<
    string,
    { path: string; present: boolean; generated_at?: string }
  >;
  posture: {
    br: {
      discovery_success: boolean;
      provider_envelope_success: boolean;
      model_count?: number;
      budget_status: "ok" | "degraded" | "missing";
      routed_models: string[];
      audit_hashes: string[];
      unknown_headers: string[];
    };
    registry: {
      source?: string;
      products_seen: string[];
      capabilities_seen: number;
      degraded: string[];
    };
    products: {
      health_ok: number;
      tools_ok: number;
      auth_blocked: string[];
      missing_or_unavailable: string[];
      invalid_shape: string[];
    };
  };
  trace: BusinessHarnessTrace;
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const INPUTS = {
  liveDiscovery: "artifacts/br-live-discovery-summary.json",
  providerEnvelope: "artifacts/br-provider-envelope-summary.json",
  a2aRegistry: "artifacts/br-a2a-registry-summary.json",
  productPlatform: "artifacts/product-platform-smoke-summary.json",
};
const ARTIFACT_PATH = path.join(
  REPO_ROOT,
  "artifacts/business-posture-trace.json",
);

function readJson<T>(relativePath: string): T | undefined {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  if (!existsSync(absolutePath)) return undefined;
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}

function observationsCount(probe: unknown, prefix: string): number | undefined {
  if (!probe || typeof probe !== "object") return undefined;
  const observations = (probe as { observations?: unknown }).observations;
  if (!Array.isArray(observations)) return undefined;
  const hit = observations.find(
    (observation): observation is string =>
      typeof observation === "string" && observation.startsWith(prefix),
  );
  const value = hit?.slice(prefix.length);
  const parsed = value ? Number(value) : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function uniqueStrings(values: unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === "string"),
    ),
  ].sort();
}

async function formatJson(text: string): Promise<string> {
  try {
    const prettier = await import("prettier");
    return await prettier.format(text, { parser: "json" });
  } catch {
    return text;
  }
}

async function writeSummary(summary: ScenarioPostureSummary) {
  mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  const json = `${JSON.stringify(redactForArtifact(summary), null, 2)}\n`;
  writeFileSync(ARTIFACT_PATH, await formatJson(json));
}

async function main() {
  const generatedAt = new Date().toISOString();
  const warnings: string[] = [];
  const failures: string[] = [];
  const liveDiscovery = readJson<any>(INPUTS.liveDiscovery);
  const providerEnvelope = readJson<any>(INPUTS.providerEnvelope);
  const a2aRegistry = readJson<any>(INPUTS.a2aRegistry);
  const productPlatform = readJson<any>(INPUTS.productPlatform);

  const inputStatus = Object.fromEntries(
    Object.entries(INPUTS).map(([key, relativePath]) => {
      const payload = readJson<any>(relativePath);
      return [
        key,
        {
          path: relativePath,
          present: Boolean(payload),
          generated_at: payload?.generated_at,
        },
      ];
    }),
  );

  for (const [key, status] of Object.entries(inputStatus)) {
    if (!status.present) failures.push(`missing input artifact: ${key}`);
  }

  const liveProbes = Array.isArray(liveDiscovery?.probes)
    ? liveDiscovery.probes
    : [];
  const modelProbe = liveProbes.find((probe: any) => probe.id === "models");
  const budgetProbe = liveProbes.find(
    (probe: any) => probe.id === "budget_status",
  );
  const registryWarnings = Array.isArray(a2aRegistry?.warnings)
    ? a2aRegistry.warnings
    : [];
  const products = Array.isArray(productPlatform?.products)
    ? productPlatform.products
    : [];

  if (liveDiscovery && liveDiscovery.success !== true) {
    warnings.push("BR live discovery artifact is not fully successful.");
  }
  if (providerEnvelope && providerEnvelope.success !== true) {
    warnings.push("BR provider envelope artifact is not fully successful.");
  }
  if (a2aRegistry && a2aRegistry.success !== true) {
    warnings.push("A2A registry artifact is not fully successful.");
  }
  if (productPlatform && productPlatform.success !== true) {
    warnings.push("Product platform artifact is not fully successful.");
  }

  const authBlocked = products
    .filter((product: any) => product.tools === "auth_blocked")
    .map((product: any) => product.product);
  const missingOrUnavailable = products
    .filter((product: any) =>
      ["missing", "unavailable"].includes(product.health),
    )
    .map((product: any) => product.product);
  const invalidShape = products
    .filter((product: any) => product.health === "invalid_shape")
    .map((product: any) => product.product);

  const trace: BusinessHarnessTrace = {
    run_id: randomUUID(),
    started_at: generatedAt,
    completed_at: generatedAt,
    tenant: {
      id_hash:
        liveDiscovery?.trace?.tenant?.id_hash ??
        providerEnvelope?.trace?.tenant?.id_hash ??
        "sha256:none",
    },
    actor: {
      kind: "operator",
      subject_hash:
        liveDiscovery?.trace?.actor?.subject_hash ??
        providerEnvelope?.trace?.actor?.subject_hash ??
        "sha256:none",
      auth_mode:
        liveDiscovery?.trace?.actor?.auth_mode ??
        providerEnvelope?.trace?.actor?.auth_mode ??
        "unknown",
    },
    intent: {
      text_redacted: "Show me the current operating posture for this tenant.",
      category: "status",
    },
    br: {
      base_url:
        liveDiscovery?.trace?.br?.base_url ??
        "https://api.brainstormrouter.com",
      request_ids: uniqueStrings([
        ...(liveDiscovery?.trace?.br?.request_ids ?? []),
        ...(providerEnvelope?.trace?.br?.request_ids ?? []),
        ...(a2aRegistry?.trace?.br?.request_ids ?? []),
        ...(productPlatform?.trace?.br?.request_ids ?? []),
      ]),
      routed_models: uniqueStrings([
        ...(liveDiscovery?.trace?.br?.routed_models ?? []),
        ...(providerEnvelope?.trace?.br?.routed_models ?? []),
      ]),
      audit_hashes: uniqueStrings([
        ...(liveDiscovery?.trace?.br?.audit_hashes ?? []),
        ...(providerEnvelope?.trace?.br?.audit_hashes ?? []),
      ]),
      envelope_modes: uniqueStrings([
        ...(liveDiscovery?.trace?.br?.envelope_modes ?? []),
        ...(providerEnvelope?.trace?.br?.envelope_modes ?? []),
      ]),
      unknown_headers: uniqueStrings([
        ...(liveDiscovery?.trace?.br?.unknown_headers ?? []),
        ...(providerEnvelope?.trace?.br?.unknown_headers ?? []),
      ]),
      total_cost_usd: providerEnvelope?.trace?.br?.total_cost_usd,
    },
    registry: {
      source: a2aRegistry?.registry?.source ?? "mixed",
      capabilities_seen: a2aRegistry?.registry?.capabilities_seen ?? 0,
      products_seen: uniqueStrings([
        ...(a2aRegistry?.registry?.products_seen ?? []),
        ...(productPlatform?.trace?.registry?.products_seen ?? []),
      ]),
      stale_or_ambiguous: a2aRegistry?.registry?.stale_or_ambiguous ?? [],
    },
    actions: [
      {
        step: "platform-posture-read",
        system: "brainstorm",
        mode: "read_only",
        status: failures.length === 0 ? "ok" : "failed",
      },
      {
        step: "br-live-discovery",
        system: "br",
        mode: "read_only",
        status: liveDiscovery?.success ? "ok" : "degraded",
      },
      {
        step: "provider-envelope",
        system: "br",
        mode: "read_only",
        status: providerEnvelope?.success ? "ok" : "degraded",
        evidence_hash: providerEnvelope?.envelope?.audit_hash,
      },
      {
        step: "a2a-registry",
        system: "vm",
        mode: "read_only",
        status: a2aRegistry?.success ? "ok" : "degraded",
      },
      {
        step: "product-platform",
        system: "brainstorm",
        mode: "read_only",
        status: productPlatform?.success ? "ok" : "degraded",
      },
    ],
    result: {
      success: failures.length === 0,
      safety_outcome: "no_writes",
      notes:
        failures.length === 0
          ? [
              "Scenario A posture trace assembled from redacted smoke artifacts.",
            ]
          : failures,
    },
  };

  const summary: ScenarioPostureSummary = {
    schema_version: 1,
    scenario: "platform_posture_read",
    generated_at: generatedAt,
    success: failures.length === 0,
    warnings: [...warnings, ...registryWarnings],
    failures,
    inputs: inputStatus,
    posture: {
      br: {
        discovery_success: liveDiscovery?.success === true,
        provider_envelope_success: providerEnvelope?.success === true,
        model_count: observationsCount(modelProbe, "count="),
        budget_status: budgetProbe?.ok
          ? "ok"
          : budgetProbe
            ? "degraded"
            : "missing",
        routed_models: trace.br.routed_models,
        audit_hashes: trace.br.audit_hashes,
        unknown_headers: trace.br.unknown_headers,
      },
      registry: {
        source: a2aRegistry?.registry?.source,
        products_seen: trace.registry.products_seen,
        capabilities_seen: trace.registry.capabilities_seen,
        degraded: registryWarnings,
      },
      products: {
        health_ok: products.filter((product: any) => product.health === "ok")
          .length,
        tools_ok: products.filter((product: any) => product.tools === "ok")
          .length,
        auth_blocked: authBlocked,
        missing_or_unavailable: missingOrUnavailable,
        invalid_shape: invalidShape,
      },
    },
    trace,
  };

  await writeSummary(summary);

  console.log("Business posture trace");
  console.log(`  artifact: ${path.relative(REPO_ROOT, ARTIFACT_PATH)}`);
  console.log(`  success=${summary.success ? "1" : "0"}`);
  console.log(`  products=${summary.posture.registry.products_seen.join(",")}`);
  console.log(
    `  br_models=${summary.posture.br.model_count ?? "unknown"} routed=${summary.posture.br.routed_models.join(",") || "none"}`,
  );
  console.log(
    `  product_health_ok=${summary.posture.products.health_ok}/${products.length}`,
  );

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  failure: ${failure}`);
    process.exit(1);
  }
}

main().catch((err) => {
  const message =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`Business posture trace crashed: ${message}`);
  process.exit(2);
});
