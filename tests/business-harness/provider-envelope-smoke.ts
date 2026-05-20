#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createGuardianFilterFetch,
  type BrEnvelope,
} from "../../packages/providers/src/cloud/brainstorm-saas.ts";
import { describeBusinessHarnessEnv, loadBusinessHarnessEnv } from "./env.ts";
import { redactForArtifact, safeSnippet, sha256Short } from "./redaction.ts";
import type {
  BusinessHarnessTrace,
  LiveDiscoveryProbeSummary,
} from "./trace-schema.ts";

interface ProviderEnvelopeSummary {
  schema_version: 1;
  generated_at: string;
  success: boolean;
  status: number;
  body_kind: "empty" | "json" | "text";
  completion_matched_expected: boolean;
  warnings: string[];
  failures: string[];
  envelope: {
    request_id_hash?: string;
    build?: string;
    envelope_mode?: string;
    routed_model?: string;
    actual_cost?: number;
    estimated_cost?: number;
    route_reason?: string;
    selection_method?: string;
    route_confidence?: number;
    audit_hash?: string;
    unknown_headers: string[];
  };
  trace: BusinessHarnessTrace;
  probe: LiveDiscoveryProbeSummary;
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const ARTIFACT_PATH = path.join(
  REPO_ROOT,
  "artifacts/br-provider-envelope-summary.json",
);

function generateTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

function expectedBodyKind(response: Response): "empty" | "json" | "text" {
  if (response.status === 204 || response.status === 304) return "empty";
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("json") ? "json" : "text";
}

function completionText(bodyText: string): string {
  try {
    const body = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { content?: string }; text?: string }>;
    };
    return (
      body.choices
        ?.map((choice) => choice.message?.content ?? choice.text ?? "")
        .join("") ?? ""
    );
  } catch {
    return bodyText;
  }
}

function envelopeCost(envelope: BrEnvelope | undefined): number | undefined {
  return envelope?.actualCost ?? envelope?.estimatedCost;
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
      id_hash: sha256Short(env.sandboxTenantId ?? "unknown-provider-tenant"),
    },
    actor: {
      kind: env.actorKind,
      subject_hash: sha256Short(env.apiKey ?? "no-key"),
      auth_mode: env.authMode,
    },
    intent: {
      text_redacted:
        "Route one tiny completion through BR and capture envelope.",
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
        step: "provider-envelope-smoke",
        system: "br",
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

async function formatJson(text: string): Promise<string> {
  try {
    const prettier = await import("prettier");
    return await prettier.format(text, { parser: "json" });
  } catch {
    return text;
  }
}

async function writeSummary(summary: ProviderEnvelopeSummary) {
  mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  const json = `${JSON.stringify(redactForArtifact(summary), null, 2)}\n`;
  writeFileSync(ARTIFACT_PATH, await formatJson(json));
}

async function main() {
  const env = loadBusinessHarnessEnv();
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const traceparent = generateTraceparent();
  const warnings = [...env.warnings];
  const failures: string[] = [];

  console.log("BR provider envelope smoke");
  for (const line of describeBusinessHarnessEnv(env)) console.log(`  ${line}`);
  for (const warning of warnings) console.log(`  warning: ${warning}`);

  if (!env.liveBrEnabled) {
    console.log("  live gate disabled; no network calls performed.");
    console.log("  set RUN_LIVE_BR=1 to route one tiny completion through BR.");
    return;
  }

  const trace = buildTrace(env, runId, startedAt, traceparent);
  let capturedEnvelope: BrEnvelope | undefined;
  const wrappedFetch = createGuardianFilterFetch((envelope) => {
    capturedEnvelope = envelope;
  });

  const response = await wrappedFetch(`${env.brBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      "Content-Type": "application/json",
      traceparent,
    },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "Return the word pong." }],
      max_tokens: 8,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  // The wrapper invokes the envelope listener fire-and-forget.
  await Promise.resolve();
  await Promise.resolve();

  const text = await response.text();
  const content = completionText(text);
  const envelope = capturedEnvelope;

  if (response.status >= 500) {
    failures.push(
      `BR chat completion returned server status ${response.status}.`,
    );
  }
  if (!envelope) {
    failures.push("Provider wrapper did not capture a BR envelope.");
  }
  if (envelope?.unknownHeaders.length) {
    failures.push(
      `BR envelope had unknown headers: ${envelope.unknownHeaders.join(", ")}`,
    );
  }
  if (response.ok) {
    if (!envelope?.requestId) failures.push("BR envelope missing request id.");
    if (!envelope?.build) failures.push("BR envelope missing build.");
    if (!envelope?.envelope)
      failures.push("BR envelope missing envelope mode.");
    if (!envelope?.routedModel)
      failures.push("BR envelope missing routed model.");
    if (envelopeCost(envelope) === undefined) {
      failures.push("BR envelope missing actual or estimated cost.");
    }
    if (!envelope?.routeReason && !envelope?.selectionMethod) {
      failures.push("BR envelope missing route reason or selection method.");
    }
    if (!/pong/i.test(content)) {
      warnings.push(
        'Completion did not visibly contain expected "pong" marker.',
      );
    }
  } else if (response.status === 429 && env.authMode === "community_key") {
    warnings.push(
      "Community key hit BR rate limit; set BRAINSTORM_API_KEY for full provider-envelope verification.",
    );
  } else if (response.status >= 400) {
    failures.push(`BR chat completion returned status ${response.status}.`);
  }

  if (envelope?.requestId)
    trace.br.request_ids.push(sha256Short(envelope.requestId));
  if (envelope?.routedModel) trace.br.routed_models.push(envelope.routedModel);
  if (envelope?.auditHash) trace.br.audit_hashes.push(envelope.auditHash);
  if (envelope?.envelope) trace.br.envelope_modes.push(envelope.envelope);
  if (envelope?.unknownHeaders) {
    trace.br.unknown_headers.push(...envelope.unknownHeaders);
  }
  trace.br.total_cost_usd = envelopeCost(envelope);
  trace.completed_at = new Date().toISOString();
  trace.result.success = failures.length === 0;
  trace.result.notes =
    failures.length === 0 ? ["provider envelope smoke passed"] : failures;
  trace.actions[0].status =
    failures.length === 0
      ? "ok"
      : response.status >= 500
        ? "failed"
        : "degraded";
  trace.actions[0].error_code =
    failures.length === 0 ? undefined : `http_${response.status}`;

  const matchedExpectedCompletion = /pong/i.test(content);
  const persistedBodyKind = expectedBodyKind(response);
  const summary: ProviderEnvelopeSummary = {
    schema_version: 1,
    generated_at: trace.completed_at,
    success: failures.length === 0,
    status: response.status,
    body_kind: persistedBodyKind,
    completion_matched_expected: matchedExpectedCompletion,
    warnings,
    failures,
    envelope: {
      request_id_hash: envelope?.requestId
        ? sha256Short(envelope.requestId)
        : undefined,
      build: envelope?.build,
      envelope_mode: envelope?.envelope,
      routed_model: envelope?.routedModel,
      actual_cost: envelope?.actualCost,
      estimated_cost: envelope?.estimatedCost,
      route_reason: envelope?.routeReason,
      selection_method: envelope?.selectionMethod,
      route_confidence: envelope?.routeConfidence,
      audit_hash: envelope?.auditHash,
      unknown_headers: envelope?.unknownHeaders ?? [],
    },
    trace,
    probe: {
      id: "provider_envelope",
      method: "POST",
      url: "/v1/chat/completions",
      auth: "bearer",
      status: response.status,
      ok: response.ok,
      body_kind: persistedBodyKind === "json" ? "object" : persistedBodyKind,
      observations: [
        envelope?.routedModel ? `routed_model=${envelope.routedModel}` : "",
        envelopeCost(envelope) !== undefined
          ? `cost=${envelopeCost(envelope)}`
          : "",
      ].filter(Boolean),
      request_id_hash: envelope?.requestId
        ? sha256Short(envelope.requestId)
        : undefined,
      routed_model: envelope?.routedModel,
      audit_hash: envelope?.auditHash,
      envelope_mode: envelope?.envelope,
      unknown_headers: envelope?.unknownHeaders ?? [],
    },
  };

  if (env.recordEnabled) {
    await writeSummary(summary);
    console.log(`  artifact: ${path.relative(REPO_ROOT, ARTIFACT_PATH)}`);
  }

  if (failures.length > 0) {
    console.error("\nBR provider envelope smoke failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(
    `\nBR provider envelope smoke passed: status=${response.status}, routed=${envelope?.routedModel ?? "unknown"}, cost=${envelopeCost(envelope) ?? "unknown"}.`,
  );
}

main().catch((err) => {
  const message =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `BR provider envelope smoke crashed: ${safeSnippet(message, 500)}`,
  );
  process.exit(2);
});
