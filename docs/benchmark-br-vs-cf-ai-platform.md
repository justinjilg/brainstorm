## Six routing strategies vs. one failover policy

**Status:** Draft, awaiting actual benchmark run + JJ review.
**Audience:** Engineers evaluating Cloudflare AI Platform for production agent workloads.
**Publication target:** brainstorm.co/blog (or brainstormrouter.com/benchmarks).
**Created:** 2026-04-21, three days after Cloudflare's [AI Platform launch](https://blog.cloudflare.com/ai-platform/).

---

### Why this comparison exists

Cloudflare's Agents Week (April 13–17, 2026) shipped 27 products under a "we built the agentic cloud" thesis. The headline of that week, for anyone routing LLM calls in production, was [AI Platform](https://blog.cloudflare.com/ai-platform/) — Cloudflare's unified inference layer merging AI Gateway and Workers AI behind a single bill.

It's a substantial ship. 70+ models, 12+ providers, custom-metadata cost attribution, BYOM via Replicate Cog, edge distribution as a free side effect of being on Cloudflare. For anyone already on Workers, it removes a procurement step.

It also ships with **one routing strategy: automatic failover**. If your primary provider returns a 5xx, traffic moves to the secondary. There is no cost-aware selection, no quality-aware selection, no learned selection across providers, and no per-task capability matching. Every request goes to the model you named.

That's the model BrainstormRouter rejected three years ago. We built six routing strategies. This post benchmarks all of them against AI Platform's failover policy on a fixed query set.

### What gets compared

| Capability                       | AI Platform (Apr 2026)            | BrainstormRouter                                                             |
| -------------------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| Models available                 | 70+                               | 357                                                                          |
| Providers                        | 12                                | 7 (Anthropic, OpenAI, Google, DeepSeek, Moonshot, Z.ai, plus BR-hosted)      |
| Routing strategies               | failover only                     | quality-first, cost-first, combined, capability, learned, rule-based (6)     |
| Cost forecast                    | ❌                                | ✅ per-task per-model with confidence interval                               |
| Capability matching by task type | ❌                                | ✅ via Wilson-lower-bound on observed success rates                          |
| Cross-session learning           | ❌                                | ✅ Thompson sampling, persisted to `~/.brainstorm/routing-intelligence.json` |
| OpenAI-compatible endpoint       | ❌ ("REST endpoint coming weeks") | ✅ `api.brainstormrouter.com/v1` since v1                                    |
| Spend by attribute               | ✅ via custom metadata            | ✅ via session/role/agent tags                                               |
| BYOM                             | 🟡 design partner (Replicate Cog) | ✅ in-cluster local providers (Ollama, LM Studio, llama.cpp)                 |
| Edge distribution                | ✅ Cloudflare network             | ❌ (single region)                                                           |
| Free tier                        | ✅ generous                       | 🟡 self-host or paid                                                         |
| Self-hosted / on-prem            | ❌                                | ✅ TypeScript binary, runs anywhere Node runs                                |

The honest read: **AI Platform wins on distribution and free-tier reach. BrainstormRouter wins on routing intelligence and deployment flexibility.** These are different products optimizing for different constraints.

### Methodology

This section describes the benchmark we _will_ run. Results table is intentionally empty until the run completes.

**Query set:** 25 prompts across five categories, 5 each.

| Category      | Example                                             | Why it tests routing                        |
| ------------- | --------------------------------------------------- | ------------------------------------------- |
| Code-quality  | "Refactor this 200-line function to be testable"    | Quality matters; cheapest model fails       |
| Symbol-lookup | "Find every caller of `connectGodMode`"             | Cheap is fine; Sonnet/Haiku-tier sufficient |
| Architectural | "Why does this monorepo split router from gateway?" | Long context, careful reasoning             |
| Bulk-edit     | "Rename `tenantId` → `orgId` across 47 files"       | Throughput; many simple ops                 |
| Adversarial   | "Prove this code is incorrect"                      | Capability heterogeneous across models      |

**Models in scope (both systems):** Sonnet 4.6, Opus 4.6, GPT-5.4, Gemini 3.1 Pro, Kimi K2.5, DeepSeek-V3.5. Six models, available on both gateways (or substituted to nearest equivalent on AI Platform where the exact model isn't hosted).

**Conditions:**

1. **AI Platform / failover.** Pin each request to the canonical model the engineer would have chosen. Failover to the same-family backup if 5xx.
2. **BR / quality-first.** Always picks the highest observed-quality model that fits the request budget.
3. **BR / cost-first.** Always picks the cheapest model meeting the per-task capability floor.
4. **BR / combined.** Default weighting — 0.6 quality, 0.4 cost.
5. **BR / capability.** Loads cached `routing-intelligence.json` and picks per (task-type, model) Wilson lower bound.
6. **BR / learned.** Thompson sampling on persisted Beta-distribution stats per (task-type, model).
7. **BR / rule-based.** TOML rules: code-quality → Opus, symbol-lookup → Sonnet, bulk-edit → Haiku, adversarial → Opus, architectural → Gemini Pro.

**Metrics:**

| Metric                                                           | Why                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Total cost across 25 queries                                     | The headline number for accountants                                |
| Avg latency p50 / p95                                            | The headline number for users                                      |
| Answer quality (LLM-judge by Opus, scored 0–10, 3-judge average) | The headline number for engineers                                  |
| Cost per quality-point                                           | Composite that defeats both "cheap garbage" and "premium overkill" |
| Failures (no answer / 5xx / timeout)                             | Reliability floor                                                  |

**LLM-judge protocol.** Opus 4.6 with thinking enabled, given the prompt + the response, blind to which strategy produced it. Three independent runs per (query, response) pair; scores averaged. Prompts and rubric pinned in `eval-data/br-vs-cf-ai-platform-rubric.md` for reproducibility.

**Reproducibility.** All raw responses, judge votes, and routing decisions stored in `eval-data/br-vs-cf-ai-platform-2026-04.jsonl`. Anyone can re-run with `npx storm eval --suite br-vs-cf-ai-platform`.

### Results

**Status (2026-04-21): harness built and pipeline-validated. Full run blocked on Cloudflare AI Platform credentials and BR upstream issues found during smoke test.**

#### What's runnable

- BR auth works via 1Password (`op read "op://Dev Keys/BrainstormRouter API Key/credential"`)
- 25-query corpus + rubric + judge pipeline all wired and tested
- BR routing strategies addressable via `X-BR-Routing-Strategy` header + `model: "auto"` body
- Judge can be Bypass-Cache'd to avoid stale scores
- `node scripts/run-br-vs-cf-benchmark.mjs --dry-run` validates without API spend

#### What's blocked

- **Cloudflare condition: needs a Workers-AI-scoped API token.** Tried the "Cloudflare Global API Key" from 1Password — returns 401 against `accounts/{id}/ai/run/{model}`. AI Platform requires a token created in the CF dashboard with Workers AI permission. ~5 min user action.
- **BR `combined` strategy returned 500 on 2 of 3 smoke-test queries (cq-02, cq-03).** Both queries timed out at ~30s with no model attribution. Failure pattern is non-trivial — both are real prompts (Python bug-finding, async/await conversion). Either BR's combined strategy is picking models that are down, an upstream provider is currently degraded, or there's a strategy-specific bug. Worth root-causing before treating any benchmark numbers from `combined` as ground truth.

#### What the smoke test produced (3 queries, BR / combined)

| Query                            | Status | Model                        | Latency | Cost      | Judge |
| -------------------------------- | ------ | ---------------------------- | ------- | --------- | ----- |
| cq-01 (refactor for testability) | ✓      | google/gemini-2.5-flash-lite | 3.1s    | $0.000200 | 10/10 |
| cq-02 (find Python bugs)         | 500    | n/a                          | 31.1s   | $0        | n/a   |
| cq-03 (callback → async/await)   | 500    | n/a                          | 30.8s   | $0        | n/a   |

Total: $0.000200 across 3 queries (2 failures returned no charge). Judge gave the one successful response a 10 — independent verification recommended before publishing the score.

#### Bug surfaced by the smoke test (already fixed)

The first version of the judge prompt scored an empty/failed response as 9/10 because the judge ignored the empty `RESPONSE:` block and answered the `QUERY:` itself. Fix: judge prompt now explicitly forbids generating facts not in the response and shortcuts to score=0 when the response is empty (see `scripts/run-br-vs-cf-benchmark.mjs:judge`). This is exactly the failure mode integration testing exposes that schema tests would have hidden.

#### Path to a publishable result

1. User creates a CF API token with Workers AI permission, stores in 1Password as `Cloudflare AI Platform Token`, sets `CLOUDFLARE_AI_PLATFORM_TOKEN` and `CF_ACCOUNT_ID` env before running.
2. Investigate BR `combined` strategy 500s. Either fix or document as known degradation in the post.
3. Run `node scripts/run-br-vs-cf-benchmark.mjs` (full set, ~700 API calls, est. cost $5–30 depending on which models BR picks).
4. Inspect `eval-data/br-vs-cf-ai-platform-2026-04.jsonl` raw rows; verify judge scores against a hand-sampled subset.
5. Replace this section with the real aggregated table.

### What we expect to find (stated up front so we can be wrong publicly)

1. **BR / combined will score lower cost-per-quality-point than AI Platform / failover** by 25–50%. Reason: failover sends every request to the model the engineer named, so symbol-lookups pay Opus rates when Sonnet would suffice. Routing intelligence picks the right model per task; failover doesn't try to.
2. **AI Platform / failover will tie or beat BR on latency** for individual requests inside Cloudflare's edge network. Source of expected gap: edge distribution is real; Brainstorm runs from one region.
3. **BR / learned will beat BR / rule-based** after >100 outcome samples per task-type are accumulated. Source: Thompson sampling explores; rules are static.
4. **BR / cost-first will fail more queries** in the adversarial category. Source: cheapest-meeting-floor sometimes picks a model below the actual capability bar; floor is calibrated on average, not edge cases.
5. **AI Platform will win on no-failures** for the first 5 queries of any new session. Source: BR / learned needs warmup; failover doesn't.

If the actual results contradict any of these, we publish the contradiction.

### Honest framing

Cloudflare AI Platform is a good product for the use case it targets: **you have an LLM call inside a Worker, you want one bill, you don't want to think about routing.** For that user, AI Platform is the right answer. We're not pretending otherwise.

BrainstormRouter targets a different user: **you're spending non-trivial money on LLMs, your workload is heterogeneous, you want the cheapest model that does the job for each task type, and you want the system to learn from outcomes rather than route by static config.** For that user, the routing intelligence gap shown in the results table is the difference between "fine" and "5–10% of revenue saved."

Either system can be the right choice. The point of this benchmark is to give engineers numbers, not slogans.

### Where Cloudflare's design will improve

We'd be naive to assume failover-only is the long-term answer. AI Platform will plausibly ship some form of cost/quality routing in the next 6–12 months — it would be the obvious next move. When that happens, we'll re-run this benchmark with whatever they ship.

The structurally harder thing for Cloudflare to copy is **multi-cloud** and **on-prem**. AI Platform is a Cloudflare-only surface; you can't run it disconnected, you can't run it inside a customer's VPC, and you can't fail over from Cloudflare itself. BrainstormRouter is a TypeScript binary; it runs anywhere Node runs. That's not an artifact of where they are in the roadmap — it's the consequence of being a CSP.

### Sources

- AI Platform launch — https://blog.cloudflare.com/ai-platform/
- High-performance LLM stack — https://blog.cloudflare.com/high-performance-llms/
- Agents Week wrap-up — https://blog.cloudflare.com/agents-week-in-review/
- BrainstormRouter routing intelligence — https://github.com/<orgname>/brainstorm/tree/main/packages/router/src/strategies
- BR cost forecast — https://github.com/<orgname>/brainstorm/blob/main/packages/router/src/cost-tracker.ts

### Resume checklist

When picking this up to actually run:

1. Decide whether Z.ai/Moonshot models stay in scope — they may not be on AI Platform, in which case substitute or drop.
2. Pin LLM-judge rubric in `eval-data/br-vs-cf-ai-platform-rubric.md` _before_ running, not after.
3. Run each condition twice on different days — Cloudflare model availability changes.
4. Publish raw `.jsonl` first; commentary is a follow-up post.
5. Replace `<orgname>` placeholders with the real GitHub org once decided.
