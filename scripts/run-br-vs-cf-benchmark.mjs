#!/usr/bin/env node
/**
 * BR vs Cloudflare AI Platform — routing-strategy benchmark runner.
 *
 * Reads:  eval-data/br-vs-cf-ai-platform-queries.jsonl
 *         eval-data/br-vs-cf-ai-platform-rubric.md
 *
 * Writes: eval-data/br-vs-cf-ai-platform-2026-04.jsonl   (raw responses)
 *         eval-data/br-vs-cf-ai-platform-results.json    (aggregated table)
 *
 * Conditions:
 *   1. AI Platform / failover  (requires CLOUDFLARE_AI_PLATFORM_TOKEN, CF_ACCOUNT_ID)
 *   2. BR / quality-first      (requires BRAINSTORM_ROUTER_API_KEY)
 *   3. BR / cost-first
 *   4. BR / combined
 *   5. BR / capability
 *   6. BR / learned
 *   7. BR / rule-based
 *
 * Each condition runs every query once. Judge runs three times per response.
 *
 * Usage:
 *   node scripts/run-br-vs-cf-benchmark.mjs --dry-run        # validate plumbing, no API calls
 *   node scripts/run-br-vs-cf-benchmark.mjs --conditions=br  # BR strategies only (no CF)
 *   node scripts/run-br-vs-cf-benchmark.mjs                  # full run
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EVAL_DIR = join(ROOT, "eval-data");

const QUERIES_PATH = join(EVAL_DIR, "br-vs-cf-ai-platform-queries.jsonl");
const RUBRIC_PATH = join(EVAL_DIR, "br-vs-cf-ai-platform-rubric.md");
const RAW_OUT = join(EVAL_DIR, "br-vs-cf-ai-platform-2026-04.jsonl");
const RESULTS_OUT = join(EVAL_DIR, "br-vs-cf-ai-platform-results.json");

// ── CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const conditionsArg = args.find((a) => a.startsWith("--conditions="));
const conditionsFilter = conditionsArg
  ? conditionsArg.split("=")[1].split(",")
  : null;

// ── Conditions ────────────────────────────────────────────────────────

const CONDITIONS = [
  {
    id: "cf-failover",
    label: "AI Platform / failover",
    backend: "cloudflare",
    // Either a scoped bearer token OR (global key + email). Account ID always required.
    requiresAny: [
      ["CLOUDFLARE_AI_PLATFORM_TOKEN", "CF_ACCOUNT_ID"],
      ["CLOUDFLARE_GLOBAL_API_KEY", "CLOUDFLARE_EMAIL", "CF_ACCOUNT_ID"],
    ],
    requires: [], // back-compat with old check; the requirement check below handles requiresAny
  },
  // BR strategy names match the server-side enum exactly (see brainstormrouter
  // src/router/model-router-types.ts:94 — RoutingStrategy = "price" | "latency"
  // | "throughput" | "priority" | "quality" | "cascade"). Run 1 used client-side
  // names that don't exist server-side; the server fell back to default for all
  // 6 conditions, which is why they all converged on the same model.
  {
    id: "br-quality",
    label: "BR / quality",
    backend: "br",
    strategy: "quality",
    requires: ["BRAINSTORM_ROUTER_API_KEY"],
  },
  {
    id: "br-price",
    label: "BR / price",
    backend: "br",
    strategy: "price",
    requires: ["BRAINSTORM_ROUTER_API_KEY"],
  },
  {
    id: "br-latency",
    label: "BR / latency",
    backend: "br",
    strategy: "latency",
    requires: ["BRAINSTORM_ROUTER_API_KEY"],
  },
  {
    id: "br-throughput",
    label: "BR / throughput",
    backend: "br",
    strategy: "throughput",
    requires: ["BRAINSTORM_ROUTER_API_KEY"],
  },
  {
    id: "br-priority",
    label: "BR / priority",
    backend: "br",
    strategy: "priority",
    requires: ["BRAINSTORM_ROUTER_API_KEY"],
  },
  {
    id: "br-cascade",
    label: "BR / cascade",
    backend: "br",
    strategy: "cascade",
    requires: ["BRAINSTORM_ROUTER_API_KEY"],
  },
];

// ── Backends ──────────────────────────────────────────────────────────

async function callCloudflare(prompt, model = "@cf/meta/llama-3.1-70b-instruct") {
  const accountId = process.env.CF_ACCOUNT_ID;
  // Two auth patterns supported by CF Workers AI:
  //   1. Bearer token from a scoped API token with Workers AI permission
  //   2. Legacy X-Auth-Email + X-Auth-Key with the global API key
  // The legacy pattern works when only the Global API Key is provisioned.
  const bearer = process.env.CLOUDFLARE_AI_PLATFORM_TOKEN;
  const globalKey = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const headers = { "Content-Type": "application/json" };
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  } else if (globalKey && email) {
    headers["X-Auth-Email"] = email;
    headers["X-Auth-Key"] = globalKey;
  } else {
    return {
      ok: false,
      error:
        "CF auth missing: set CLOUDFLARE_AI_PLATFORM_TOKEN, or both CLOUDFLARE_GLOBAL_API_KEY and CLOUDFLARE_EMAIL",
      latencyMs: 0,
    };
  }

  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
  });
  const latencyMs = Date.now() - start;
  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: `HTTP ${res.status} (non-JSON body)`, latencyMs };
  }

  if (!res.ok || !json.success) {
    return {
      ok: false,
      error: json.errors?.[0]?.message ?? `HTTP ${res.status}`,
      latencyMs,
    };
  }

  return {
    ok: true,
    text: json.result?.response ?? "",
    model,
    latencyMs,
    // CF doesn't return per-call cost; usage tokens are returned and could be
    // priced from the Workers AI rate card later. For now leave null and rely
    // on output token count for relative comparison.
    cost: null,
    usageTokens: json.result?.usage?.total_tokens ?? null,
  };
}

async function callBR(prompt, strategy) {
  const key = process.env.BRAINSTORM_ROUTER_API_KEY;
  // OpenAI-compatible endpoint at api.brainstormrouter.com/v1.
  //
  // Real interface (verified against brainstormrouter src/, Run 2 onward):
  // - Strategy: body.route.strategy ∈ {price,latency,throughput,priority,quality,cascade}
  //   (NOT a header — server doesn't read X-BR-Routing-Strategy)
  // - Cache bypass: body.cache = false (NOT X-BR-Bypass-Cache header)
  // - Cost: usage.cost_usd in body, plus x-br-actual-cost header for back-compat
  // - Selected model: x-br-routed-model header
  //
  // Run 1 (2026-04-21) used header-based selection that the server ignored,
  // so all 7 BR conditions effectively ran with default strategy + cache on.
  // Postmortem: brainstormrouter/docs/benchmarks/2026-04-21-vs-cf-ai-platform-postmortem.md
  const url = "https://api.brainstormrouter.com/v1/chat/completions";

  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // X-BR-Cache-Privacy: private is the documented header-level bypass.
      // Belt-and-suspenders alongside body.cache:false and body.x_no_cache:true,
      // because smoke testing showed at least one strategy still hit the cache
      // when only body.cache was set.
      "X-BR-Cache-Privacy": "private",
    },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: prompt }],
      route: { strategy },
      cache: false,
      x_no_cache: true,
    }),
  });
  const latencyMs = Date.now() - start;

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: `HTTP ${res.status} (non-JSON body)`, latencyMs };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: json.error?.message ?? `HTTP ${res.status}`,
      latencyMs,
    };
  }

  // Cost: prefer body.usage.cost_usd (added in BR commit e22023e29), fall back
  // to x-br-actual-cost header for older deployments.
  const cost =
    json.usage?.cost_usd != null
      ? Number(json.usage.cost_usd)
      : parseFloat(res.headers.get("x-br-actual-cost") ?? "0");
  const model =
    res.headers.get("x-br-routed-model") ?? json.model ?? "unknown";
  const cacheHit = res.headers.get("x-br-cache") === "hit";

  return {
    ok: true,
    text: json.choices?.[0]?.message?.content ?? "",
    model,
    latencyMs,
    cost,
    cacheHit,
  };
}

// ── Judge ─────────────────────────────────────────────────────────────

const JUDGE_PROMPT_HEADER = (rubric) => `You are an LLM judge. You will read a rubric, a user QUERY, and a model RESPONSE. Score the RESPONSE on a 0-10 scale per the rubric.

CRITICAL: You are scoring the RESPONSE, NOT writing your own answer to the QUERY. Do NOT generate facts that are not present in the RESPONSE. If the RESPONSE is empty, blank, an error, or does not address the QUERY, score 0 with reasoning "empty/no response".

Return JSON only: {"score": N, "reasoning": "<one sentence about what's in the RESPONSE>"}.

RUBRIC:
${rubric}
`;

async function judge(rubric, query, response) {
  // Use BR for the judge call. Three runs, take the median.
  const key = process.env.BRAINSTORM_ROUTER_API_KEY;
  if (!key) {
    return { medianScore: null, scores: [], error: "BR key missing for judge" };
  }
  // Guard: if there's no response to judge, skip the judge calls and report 0
  // directly. Otherwise the judge often hallucinates a plausible score by
  // answering the QUERY itself instead of grading the empty RESPONSE.
  if (!response || response.trim().length === 0) {
    return { medianScore: 0, scores: [0, 0, 0], error: null };
  }
  const judgePrompt = `${JUDGE_PROMPT_HEADER(rubric)}

QUERY:
${query}

RESPONSE:
${response}`;

  const scores = [];
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(
        "https://api.brainstormrouter.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "X-BR-Bypass-Cache": "1",
          },
          body: JSON.stringify({
            // Pin a strong model in the body since X-BR-Model header may be
            // ignored. Using auto with a quality-first hint per call.
            model: "auto",
            messages: [{ role: "user", content: judgePrompt }],
            response_format: { type: "json_object" },
            max_tokens: 200,
          }),
        },
      );
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content);
      if (typeof parsed.score === "number") {
        scores.push(parsed.score);
      }
    } catch {
      // Skip bad judge runs; if all three fail we surface that
    }
  }

  if (scores.length === 0) {
    return { medianScore: null, scores: [], error: "all judge runs failed" };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { medianScore: median, scores, error: null };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  // Load queries + rubric
  if (!existsSync(QUERIES_PATH)) {
    console.error(`Missing: ${QUERIES_PATH}`);
    process.exit(1);
  }
  if (!existsSync(RUBRIC_PATH)) {
    console.error(`Missing: ${RUBRIC_PATH}`);
    process.exit(1);
  }

  const queries = readFileSync(QUERIES_PATH, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const rubric = readFileSync(RUBRIC_PATH, "utf-8");

  console.log(`Loaded ${queries.length} queries.`);

  // Filter conditions
  let conditions = CONDITIONS;
  if (conditionsFilter) {
    conditions = conditions.filter((c) =>
      conditionsFilter.some((f) => c.id.startsWith(f)),
    );
  }

  // Check requirements. Conditions may declare `requires` (all must be set)
  // or `requiresAny` (any one of N alternative env-var sets must be fully set).
  const skipped = [];
  const runnable = conditions.filter((c) => {
    if (c.requiresAny && c.requiresAny.length > 0) {
      const ok = c.requiresAny.some((set) => set.every((v) => process.env[v]));
      if (!ok) {
        const allMissing = Array.from(
          new Set(c.requiresAny.flat().filter((v) => !process.env[v])),
        );
        skipped.push({ condition: c.label, missing: allMissing });
        return false;
      }
      return true;
    }
    const missing = (c.requires ?? []).filter((r) => !process.env[r]);
    if (missing.length > 0) {
      skipped.push({ condition: c.label, missing });
      return false;
    }
    return true;
  });

  if (skipped.length > 0) {
    console.log("\nSkipped conditions (missing env):");
    for (const s of skipped) {
      console.log(`  - ${s.condition}: needs ${s.missing.join(", ")}`);
    }
  }

  if (runnable.length === 0) {
    console.log("\nNo runnable conditions. Set the env vars above and retry.");
    if (DRY_RUN) {
      console.log("\nDry-run mode — validating plumbing only:");
      console.log(`  ✓ Loaded ${queries.length} queries`);
      console.log(`  ✓ Loaded rubric (${rubric.length} chars)`);
      console.log(`  ✓ Output paths writable: ${EVAL_DIR}`);
      process.exit(0);
    }
    process.exit(2);
  }

  if (DRY_RUN) {
    console.log("\nDry-run mode — would execute:");
    for (const c of runnable) {
      console.log(
        `  ${c.label}: ${queries.length} queries × 1 response + 3 judge runs each`,
      );
    }
    const totalCalls = runnable.length * queries.length * 4;
    console.log(`\nTotal API calls: ${totalCalls}`);
    console.log("Run without --dry-run to execute. Costs real money.");
    process.exit(0);
  }

  // Execute
  const raw = [];
  for (const cond of runnable) {
    console.log(`\n=== ${cond.label} ===`);
    for (const q of queries) {
      const callFn =
        cond.backend === "cloudflare"
          ? () => callCloudflare(q.prompt)
          : () => callBR(q.prompt, cond.strategy);
      const resp = await callFn();
      const judgeResult = resp.ok
        ? await judge(rubric, q.prompt, resp.text)
        : { medianScore: null, scores: [], error: "no response to judge" };

      const row = {
        condition: cond.id,
        conditionLabel: cond.label,
        queryId: q.id,
        category: q.category,
        ok: resp.ok,
        error: resp.error ?? null,
        model: resp.model ?? null,
        latencyMs: resp.latencyMs,
        cost: resp.cost ?? null,
        cacheHit: resp.cacheHit ?? false,
        responseTextLen: resp.text?.length ?? 0,
        judgeMedian: judgeResult.medianScore,
        judgeScores: judgeResult.scores,
        judgeError: judgeResult.error,
        ts: new Date().toISOString(),
      };
      raw.push(row);

      const status = resp.ok ? `✓ score=${judgeResult.medianScore}` : `✗ ${resp.error}`;
      console.log(`  ${q.id}: ${status} (${resp.latencyMs}ms)`);
    }
  }

  // Persist raw
  writeFileSync(RAW_OUT, raw.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nWrote ${raw.length} rows to ${RAW_OUT}`);

  // Aggregate
  const aggregates = {};
  for (const cond of runnable) {
    const rows = raw.filter((r) => r.condition === cond.id && r.ok);
    const totalCost = rows.reduce((s, r) => s + (r.cost ?? 0), 0);
    const meanLatency = rows.reduce((s, r) => s + r.latencyMs, 0) / (rows.length || 1);
    const sortedLat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const p50 = sortedLat[Math.floor(sortedLat.length / 2)] ?? null;
    const p95 = sortedLat[Math.floor(sortedLat.length * 0.95)] ?? null;
    const validScores = rows.map((r) => r.judgeMedian).filter((s) => s != null);
    const meanQuality =
      validScores.reduce((s, q) => s + q, 0) / (validScores.length || 1);
    const failures = raw.filter((r) => r.condition === cond.id && !r.ok).length;

    aggregates[cond.id] = {
      label: cond.label,
      n: rows.length,
      totalCost: totalCost.toFixed(4),
      meanLatencyMs: Math.round(meanLatency),
      p50Ms: p50,
      p95Ms: p95,
      meanQuality: Number(meanQuality.toFixed(2)),
      costPerQualityPoint:
        meanQuality > 0 ? Number((totalCost / (meanQuality * rows.length)).toFixed(4)) : null,
      failures,
    };
  }

  writeFileSync(RESULTS_OUT, JSON.stringify(aggregates, null, 2) + "\n");
  console.log(`\nWrote results to ${RESULTS_OUT}\n`);
  console.log(JSON.stringify(aggregates, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
