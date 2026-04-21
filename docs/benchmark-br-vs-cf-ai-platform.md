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

This section describes the planned shape of the benchmark. **Run 1 (results below) deviated from the plan in two material ways:** (a) on Cloudflare we ran every query against a single pinned model (`@cf/meta/llama-3.1-70b-instruct`) rather than the planned multi-model swap, because that's the realistic default for a "pick a model and use AI Platform's failover" user; (b) on BR, instead of pinning models per condition, we sent `model: "auto"` with the strategy header so each strategy's auto-router picked. Run 2 should narrow these.

**Query set:** 25 prompts across five categories, 5 each.

| Category      | Example                                             | Why it tests routing                        |
| ------------- | --------------------------------------------------- | ------------------------------------------- |
| Code-quality  | "Refactor this 200-line function to be testable"    | Quality matters; cheapest model fails       |
| Symbol-lookup | "Find every caller of `connectGodMode`"             | Cheap is fine; Sonnet/Haiku-tier sufficient |
| Architectural | "Why does this monorepo split router from gateway?" | Long context, careful reasoning             |
| Bulk-edit     | "Rename `tenantId` → `orgId` across 47 files"       | Throughput; many simple ops                 |
| Adversarial   | "Prove this code is incorrect"                      | Capability heterogeneous across models      |

**Models in scope (planned, both systems):** Sonnet 4.6, Opus 4.6, GPT-5.4, Gemini 3.1 Pro, Kimi K2.5, DeepSeek-V3.5. **In Run 1, the actual models that handled traffic were `@cf/meta/llama-3.1-70b-instruct` (CF, pinned) and `deepseek/deepseek-reasoner` (BR auto-router, ~95% of successful BR responses).** Run 2 should compare frontier-tier models on both gateways for a more interesting capability-quality tradeoff.

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

### Results — Run 1 (2026-04-21)

**Headline: Cloudflare Workers AI returned a response for every query (25/25). BrainstormRouter strategies completed 7–11 of 25.** Quality on completed responses favored BR (mean 7.78–9.14 vs CF's 6.48), but the failure rate (56–72%) overwhelms that lead in this snapshot.

The pre-stated hypotheses were largely wrong. Stating that up front — that's what `feedback_completeness_over_dopamine.md` requires.

#### Aggregate table

| Strategy               | n successful | failures (of 25) |   Total cost | p50 latency | p95 latency | Mean quality |
| ---------------------- | -----------: | ---------------: | -----------: | ----------: | ----------: | -----------: |
| AI Platform / failover |       **25** |            **0** | $0.00 (note) |       10.2s |       13.0s |         6.48 |
| BR / quality-first     |            7 |               18 |      $0.0075 |       21.0s |       29.0s |     **9.14** |
| BR / cost-first        |            9 |               16 |      $0.0082 |        1.3s |       28.5s |         8.78 |
| BR / combined          |            9 |               16 |      $0.0008 |        0.8s |       15.2s |         8.22 |
| BR / capability        |            9 |               16 |      $0.0021 |        0.9s |       23.8s |         7.78 |
| BR / learned           |            9 |               16 |      $0.0017 |        0.8s |       18.7s |         9.00 |
| BR / rule-based        |           11 |               14 |      $0.0128 |       18.8s |       28.6s |         8.36 |

Total benchmark cost: **~$0.04 inference** + **~$0.09 judge calls**. Reproducible from `eval-data/br-vs-cf-ai-platform-2026-04.jsonl`.

#### Success rate by category (5 queries each)

| Strategy           | code-quality | symbol-lookup | architectural | bulk-edit | adversarial |
| ------------------ | :----------: | :-----------: | :-----------: | :-------: | :---------: |
| CF / failover      |     5/5      |      5/5      |      5/5      |    5/5    |     5/5     |
| BR / quality-first |     1/5      |      3/5      |      2/5      |  **0/5**  |     1/5     |
| BR / cost-first    |     2/5      |      4/5      |      2/5      |  **0/5**  |     1/5     |
| BR / combined      |     2/5      |      2/5      |      2/5      |  **0/5**  |     3/5     |
| BR / capability    |     2/5      |      3/5      |      2/5      |    1/5    |     1/5     |
| BR / learned       |     1/5      |      4/5      |      1/5      |    1/5    |     2/5     |
| BR / rule-based    |     1/5      |      5/5      |      3/5      |  **0/5**  |     2/5     |

**The bulk-edit column is the most concerning pattern.** 5 of 7 BR strategies returned 0/5 successes on bulk-edit prompts. These are the longest, reasoning-heaviest prompts in the corpus (47-file rename plans, license-header sed scripts, codemod approaches). BR routes them to DeepSeek-Reasoner (visible in the raw rows), which then times out at the 30-second ceiling. CF / failover hit Llama 3.1 70b for every one and got an answer in time.

#### Quality where both succeeded — symbol-lookup

The most apples-to-apples slice: short factual queries, both gateways completed all five. CF mean = 8.2; BR strategy means = 8.0 (quality-first), 8.3 (cost-first), 8.6 (rule-based). **No meaningful quality difference.** This contradicts the pre-stated hypothesis that BR routing would dominate; for cheap factual queries, llama-3.1-70b is fine.

Where BR quality leads genuinely stand out, on completed responses — code-quality and architectural categories, means 7.0–10.0 — the n is 1–3 per BR condition. Not statistically meaningful. Needs a re-run with higher completion rate before publishing those differences as signal.

### Caveats — three that change what this run can claim

1. **Cost data is incomplete.** Cloudflare Workers AI doesn't return per-call cost in response headers; the table reads "$0.00" for CF, but the Workers AI rate card applies. Reconcile from billing dashboard before publishing any cost-per-quality-point number.

2. **The cache-bypass header probably didn't work.** ~70% of "successful" BR responses came back with a `cache/` prefix on the model name (e.g. `cache/deepseek/deepseek-reasoner`). The script set `X-BR-Bypass-Cache: 1` on every call. Sub-second p50 latencies on BR combined/capability/learned (786ms, 887ms, 796ms) corroborate cache hits. **A re-run with verified cache bypass is required before treating BR strategy differences as real.** Until then, the BR strategies in this table are partially measuring BR's cache hit rate, not its routing intelligence.

3. **Routing diversity was thin.** Despite invoking 6 different strategies, the model attributions show BR converged on DeepSeek-Reasoner for almost every successful query. Only ~3 queries across the whole run hit Gemini variants. The strategies aren't being differentiated by this corpus + auto-router combo — they're effectively picking the same model. A corpus that pushes BR into different cost/quality regimes (force-quality prompts for capability, force-cheap prompts for cost-first) would actually compare the strategies.

### What the prior hypotheses got wrong (and right)

| Hypothesis                                                      | Actual                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| BR / combined will score lower cost-per-quality-point by 25–50% | **Not measurable** — CF cost not returned and BR responses mostly cache-hit            |
| CF will tie or beat BR on individual-request latency            | **Mostly true.** CF p50 10.2s; BR p50 0.8–21s. BR wins on cache-hit; CF on consistency |
| BR / learned will beat BR / rule-based after >100 samples       | Not measurable on n=9                                                                  |
| BR / cost-first will fail more on adversarial                   | **No clear pattern** — all BR strategies failed similarly across categories            |
| CF will win on no-failures for first 5 queries                  | **CF won on no-failures for all 25 queries.** Hypothesis was much too weak             |

### What this run actually says — one paragraph

For a workload of mid-difficulty real coding prompts hitting both gateways with defaults, **Cloudflare Workers AI with Llama 3.1 70b was the most reliable choice in this snapshot** — every response, 10s p50, 6.48/10 quality. BrainstormRouter's intelligent routing produced higher-quality responses on the slice it completed, but the failure rate negates the win. Correct next step: re-run with verified cache bypass, raise the per-call timeout above 30s (or drop DeepSeek-Reasoner from routable pool for long prompts), and diversify the corpus so strategies actually differentiate. Without those, the current benchmark can only say "CF was more reliable today; BR quality is real but conditional on completion."

### Action items before Run 2

1. **Confirm the right cache-bypass mechanism.** Check BR docs or headers on `api.brainstormrouter.com` for the canonical header name and set it properly.
2. **Investigate BR timeout on bulk-edit.** Either exclude DeepSeek-Reasoner from the routable pool for long prompts, raise the per-call timeout above 30s in the runner, or document as a known limitation.
3. **Reconcile CF cost from Workers AI billing.** Record the pricing reference alongside the results.
4. **Diversify the corpus.** Add prompts that distinctly favor cheap-fast vs slow-thorough model selection so the strategies actually pick different models.
5. **Re-run weekly until results stabilize.** Single snapshots lie.

### Postmortem — what investigation found after Run 1

The runner sent `X-BR-Routing-Strategy` and `X-BR-Bypass-Cache` headers. **Neither header exists in the BR server source.** Strategy is set via `body.route.strategy`; cache bypass via `body.cache = false` or `body.x_no_cache = true`. The strategy names the runner used (`quality-first`, `cost-first`, `combined`, `capability`, `learned`, `rule-based`) also don't exist server-side — the real `RoutingStrategy` enum is `price | latency | throughput | priority | quality | cascade`, and 4 of the 6 client-side names have no server counterpart at all.

So all 7 BR conditions in Run 1 were effectively the same configuration: **default strategy, cache enabled.** The CF result (25/25, 6.48 mean quality) is real. The BR-side strategy-comparison story is unproven and the table cannot be used to differentiate strategies.

Full postmortem (with code-level pointers) lives in the brainstormrouter project:
**`~/Projects/brainstormrouter/docs/benchmarks/2026-04-21-vs-cf-ai-platform-postmortem.md`**

That postmortem documents 5 actionable bugs in BR (naming drift between client and server packages, missing public API docs for strategy/cache bypass, no fallback when DeepSeek-Reasoner times out, cost not in response body, cache key may not include strategy) plus the path to Run 2. The work belongs in that repo, not this one.

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
