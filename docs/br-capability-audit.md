# Brainstorm ↔ BrainstormRouter Capability Audit

**Date:** 2026-04-11
**Purpose:** Inventory every BR endpoint, cross-reference with brainstorm's gateway client, and identify the gap. Prioritize what to wire first.

## The headline number

```
BR endpoints total:                    587
Brainstorm gateway client methods:      22
Methods actually called from somewhere: 15
Raw fetches bypassing the client:        3

Effective API surface brainstorm uses:  18 / 587  ≈  3.1%
```

**Brainstorm is using roughly 3% of what BR already ships.** The rest is already built, already tested, already deployed, and waiting for a CLI consumer.

This audit is the concrete list of what to wire, in what order, and why.

## Coverage by category

| Category                                           | BR endpoints |                                                                Brainstorm uses | Coverage |
| -------------------------------------------------- | -----------: | -----------------------------------------------------------------------------: | -------: |
| Memory management                                  |           17 |                                     3 (storeMemory, queryMemory\*, listMemory) |      18% |
| Projects                                           |            9 |                                                                              0 |       0% |
| Agents (profiles, delegate, sub-agents, bootstrap) |           14 |                                                        1 (listAgentProfiles\*) |       7% |
| Completions & chat                                 |            2 |                                                        1 (via AI SDK provider) |      50% |
| Intelligence & rankings                            |           12 |                                                             1 (getLeaderboard) |       8% |
| Governance & audit                                 |           30 |                                         2 (governanceSummary, completionAudit) |       7% |
| Workspaces & account                               |            9 |                                                                              0 |       0% |
| Budget & cost management                           |           14 |                                                            1 (getUsageSummary) |       7% |
| API keys & auth                                    |            9 |                                                      2 (listKeys, createKey\*) |      22% |
| OAuth & SSO/SCIM                                   |           21 |                                                                              0 |       0% |
| MCP server management                              |            9 |                                                  0 (local MCP manager instead) |       0% |
| Guardrails & security                              |            6 |                                                                              0 |       0% |
| Webhooks                                           |            6 |                                                                              0 |       0% |
| Tasks & workflows                                  |           12 |                                                                              0 |       0% |
| Observability & telemetry                          |           10 |                                                                              0 |       0% |
| Content & embeddings                               |            8 |                                                          0 (local models only) |       0% |
| Admin & provisioning                               |           11 |                                                                              0 |       0% |
| Mesh & multi-agent coordination                    |           13 |                                                                              0 |       0% |
| Misc (models, prompts, presets, config, insights)  |          80+ | 7 (listModels, getConfig, setConfig, daily/waste/forecast insights, discovery) |      ~9% |
| Browser automation (non-API namespace)             |           47 |                                                           0 (separate concern) |      n/a |

_half-wired — method exists in gateway client, nothing calls it_

**The categories most dramatically under-wired**: projects (0%), workspaces/account (0%), budget (7%), OAuth/SSO/SCIM (0%), webhooks (0%), tasks/workflows (0%), observability (0%), mesh (0%).

## What brainstorm DOES use today

### Wired and working (15 methods)

```
getSelf              → GET  /v1/self                      (boot)
getDiscovery         → GET  /v1/discovery                 (boot)
getHealth            → GET  /health                       (boot)
listModels           → GET  /v1/models                    (models command)
getLeaderboard       → GET  /v1/models/leaderboard        (dashboard + /ms)
listKeys             → GET  /v1/api-keys                  (router status)
getConfig            → GET  /v1/config/{key}              (config get)
setConfig            → PUT  /v1/config/{key}              (config set)
getUsageSummary      → GET  /v1/usage/summary             (budget + dashboard)
getDailyInsights     → GET  /v1/insights/daily            (dashboard)
getWasteInsights     → GET  /v1/insights/waste            (dashboard + /waste)
getForecast          → GET  /v1/insights/forecast         (dashboard)
storeMemory          → POST /v1/memory/entries            (fire-and-forget from MemoryManager.save)
listMemory           → GET  /v1/memory/entries            (memory list fallback)
getGovernanceSummary → GET  /v1/governance/summary        (dashboard)
getCompletionAudit   → GET  /v1/governance/completion-audit (dashboard)
pushCapabilityScores → POST /v1/models/{id}/capabilities  (after eval)
```

### Half-wired (method exists, never called)

```
getRunnableModels   → GET  /v1/catalog/runnable
setAlias            → PUT  /v1/config/aliases/{alias}
createKey           → POST /v1/api-keys
listAgentProfiles   → GET  /v1/agent/profiles
queryMemory         → POST /v1/memory/query         ← semantic search, significant
reportOutcome       → POST /v1/feedback/{requestId} ← routing learning signal, significant
```

### Raw fetches bypassing the client

```
POST /v1/agent/trajectories  ← trajectory-capture.ts:240 (fire-and-forget per orchestration run)
GET  /health                 ← brainstorm.ts:5071 (duplicate)
POST /v1/community/patterns  ← br-intelligence.ts (separate client, not used)
```

### Parallel unused client

There's a separate `IntelligenceAPIClient` at `packages/gateway/src/intelligence-api.ts` with 6 methods — **all unused**:

```
submitTrajectory    → POST /v1/agent/trajectory
getRecommendations  → GET  /v1/agent/recommendations
rankForEnsemble     → POST /v1/agent/ensemble/rank
forecastCost        → GET  /v1/intelligence/cost-forecast
submitPattern       → POST /v1/community/patterns
getPatterns         → GET  /v1/community/patterns
```

Dead code. Should either be deleted or wired.

## Local brainstorm state that COULD sync but doesn't

From the brainstorm side inventory, here's what lives under `~/.brainstorm/` with no sync path:

### SQLite (`~/.brainstorm/brainstorm.db`) — 18 active tables, 0 synced

Big misses by volume:

| Table                                        | Rows (approx) | What's in it                                                         | Why sync matters                                                                 |
| -------------------------------------------- | ------------: | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `cost_records`                               |      100,000+ | Per-model token costs with task type                                 | Training signal for BR's router; currently only BR's own billing side knows cost |
| `model_performance_v2`                       |      100,000+ | Success/failure per model/task with BM25 shape keys, validity scores | The richest routing training data in the system — never leaves the laptop        |
| `messages`                                   |       10,000+ | Full conversation history                                            | Cross-device session resume, team audit                                          |
| `audit_log`                                  |       50,000+ | Tool invocation audit trail                                          | Governance compliance                                                            |
| `session_patterns`                           |        1,000+ | Learned tool success rates, user preferences                         | Personalization data stuck on one machine                                        |
| `orchestration_runs` + `orchestration_tasks` |          100+ | Multi-agent runs with worktree/files-touched/result                  | Team visibility into what workers did                                            |
| `daemon_daily_log`                           |       10,000+ | KAIROS daemon activity                                               | Fleet observability                                                              |
| `projects`                                   |           50+ | Registered project list with budgets                                 | Cross-device project registry (the spec P3 item)                                 |

### Filesystem state under `~/.brainstorm/` — partially synced

| Path                                     | Sync status                                     |
| ---------------------------------------- | ----------------------------------------------- |
| `projects/<hash>/memory/system/*.md`     | ✅ fire-and-forget push on save, no pull        |
| `projects/<hash>/memory/archive/*.md`    | ✅ fire-and-forget push on save, no pull        |
| `projects/<hash>/memory/quarantine/*.md` | ❌ intentionally never synced (low-trust)       |
| `projects/<hash>/memory/MEMORY.md`       | ❌ index file not synced                        |
| `projects/<hash>/code-graph.db`          | ❌ tree-sitter call graph, never synced         |
| `routing-intelligence.json`              | ❌ Wilson-bounded rankings, personal to machine |
| `eval/capability-scores.json`            | ✅ `pushCapabilityScores` after eval            |
| `eval/runs.jsonl`                        | ❌ evaluation transcripts, never synced         |
| `trajectories/*.jsonl`                   | ✅ fire-and-forget raw fetch, 1200+ files       |
| `config.toml`                            | ❌ project config                               |
| `.providers.cache.json`                  | ❌ one-way cache from BR, not pushed back       |

**Net: of the persistent state brainstorm creates, only 4 categories have any sync path (personal memory write, capability scores, trajectories, and the occasional one-off fetch).** None of it is bidirectional. Nothing reconciles conflicts. Nothing retries on failure.

## What BR has that's most under-utilized by brainstorm

Looking across the 587 - 18 = **569 unused BR endpoints**, the ones with the highest bang-for-buck if wired:

### Tier 1 — Critical gaps (wire these first)

| BR capability                                                                                     | Effort | Impact                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project registry** (`/v1/projects` CRUD, 9 endpoints)                                           | Small  | **Critical** — without this, no cross-machine project awareness, no team project visibility. Every other team feature depends on project scoping.                                                             |
| **Shared/team memory** (`/v1/memory/shared/*`, 2 endpoints)                                       | Small  | **Critical** — the team primitive. Shared context across teammates. The main thing Letta's announcement is built around, and BR already has it.                                                               |
| **Memory approval workflow** (`/v1/memory/pending/*` + `/v1/memory/approval-config`, 5 endpoints) | Small  | **High** — governance gate on team memory writes. Uniquely enterprise.                                                                                                                                        |
| **Memory init from documents** (`/v1/memory/init`, 1 endpoint)                                    | Small  | **High** — the Letta Code `/init` equivalent, already server-side. User-facing: `brainstorm memory init --from claude-code-session.jsonl`.                                                                    |
| **Memory query (semantic)** (`/v1/memory/query`, 1 endpoint)                                      | Tiny   | **High** — already half-wired. Just call it from the agent's memory tool instead of local-only search.                                                                                                        |
| **Institutional intelligence** (`/v1/intelligence/institutional`, 1 endpoint)                     | Tiny   | **High** — team-level routing learning. One line added to router startup. Your teammate running `brainstorm eval` makes your router smarter.                                                                  |
| **Account users** (`/v1/account/users` + invite + remove, 3 endpoints)                            | Small  | **Critical** — team member management. `brainstorm team list/invite/remove`.                                                                                                                                  |
| **Budget** (`/v1/budget/status`, `limits`, `alerts`, `agents`, 8 endpoints)                       | Medium | **Critical** — Dogfood #1 Bug 4 showed how confusing budget UX is. BR has proper budget API with per-agent limits and alert config. Wire these and the "budget cap hits pre-existing spend" story disappears. |

**Tier 1 subtotal: ~30 endpoints, ~4 days of focused wiring.**

### Tier 2 — High-value follow-ups

| BR capability                                                                                               | Effort       | Impact                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governance audit trail (`/v1/governance/memory/audit`, `stats`, `compliance`, `reconstruct`, 4 endpoints)   | Small        | Enterprise-grade memory audit. `brainstorm audit memory`, `brainstorm audit reconstruct --at 2026-03-01`. This is what makes the pitch land with regulated industries. |
| Intelligence advice (`/v1/intelligence/advise`, `compare`, `frontier`, `savings`, `benchmark`, 5 endpoints) | Small-Medium | Router improvements. Ask BR for a recommendation under constraints. Compare models. Get the cost-quality frontier.                                                     |
| Usage detail (`/v1/usage/spend`, `models`, `by-cost-center`, `by-owner`, `feedback`, 5 endpoints)           | Small        | Team cost visibility: who spent what on which model. Feedback loop for cost records.                                                                                   |
| Webhooks (`/v1/webhooks/*`, 6 endpoints)                                                                    | Medium       | Event notifications for failed runs, budget alerts, approval requests. Wires brainstorm into Slack/Discord/email via BR's webhook dispatcher.                          |
| Trajectories proper (`/v1/agent/trajectories`, 4 endpoints)                                                 | Small        | Already pushing via raw fetch; upgrade to use the proper client, pull stats, export.                                                                                   |
| Tasks & workflows (`/v1/tasks`, `/v1/workflow`, 12 endpoints)                                               | Medium       | BR has server-side task runner + workflow orchestration. Brainstorm could hand off long-running work to BR.                                                            |

**Tier 2 subtotal: ~35 endpoints, ~1 week of wiring.**

### Tier 3 — Enterprise / governance / compliance

| BR capability                                                                                                                                                                                          | Effort       | Impact                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------- |
| Full governance suite (agent manifests, behavioral profiles, anomaly detection, audit chain verify, policy dry-run, lineage, credentials, sovereignty, compliance autopilot, EU AI Act — 23 endpoints) | Medium-Large | SOC 2 / HIPAA / EU AI Act-ready. Not blocking for indie users, critical for enterprise. |
| SSO / SCIM / OAuth (tenant IdP config, SCIM user/group sync, OAuth apps, device auth — 21 endpoints)                                                                                                   | Large        | Enterprise identity. Brainstorm CLI probably consumes this rather than drives it.       |
| Guardrails & security (content filtering, moderation, red team — 6 endpoints)                                                                                                                          | Medium       | Content safety gates.                                                                   |
| A2A mTLS certificates (4 endpoints)                                                                                                                                                                    | Medium       | Agent-to-agent TLS for cross-tenant work.                                               |
| Mesh coordination (policies, forensics, execute — 13 endpoints)                                                                                                                                        | Large        | Federated multi-tenant agent networks.                                                  |
| Observability (destinations, otel-config, provider health — 6 endpoints)                                                                                                                               | Medium       | Datadog/OTLP export.                                                                    |

**Tier 3 subtotal: ~75 endpoints, 2-3 weeks of wiring. Defer until Tier 1+2 shipped.**

## The sync protocol problem

Wiring the endpoints is only half the job. The other half is **how state reconciles.** Today every push is fire-and-forget with no retry, no conflict detection, no pull. That's fine for write-only telemetry (trajectories, capability scores) but not for anything users edit on multiple machines.

### What's needed

1. **Retry queue**: Failed pushes need to be persisted and retried, not lost. New SQLite table: `sync_queue (id, endpoint, method, body, attempts, next_retry_at, last_error)`. Simple worker flushes on boot and on interval.

2. **Pull path on construction**: `MemoryManager` already pushes on write. It needs to pull on boot and merge with local. Strategy: last-writer-wins by `updatedAt`, with tombstones for deletes.

3. **Conflict resolution**: For memory entries (additive), last-writer-wins is fine. For project config, routing intelligence, or anything with structure, CRDT-ish merging. For now, document the choice per state type.

4. **Sync status UI**: A `brainstorm sync status` command showing what's pending, failed, last-synced timestamps. Essential for debugging and user trust.

5. **Project scope everywhere**: The spec doc already calls this out — memory needs a `project` parameter. Half the BR endpoints accept it; brainstorm never sends it. Without project scope, team memory pollutes across projects.

### Sync infrastructure estimate

```
packages/db/migrations/031_sync_queue.sql           ~15 lines
packages/gateway/src/sync-queue.ts                  ~150 lines  (new module: enqueue, dequeue, retry loop, backoff)
packages/gateway/src/client.ts                      ~60 lines   (add project param to memory calls, add queue hook)
packages/core/src/memory/manager.ts                 ~100 lines  (pull on boot, merge strategy, sync status)
packages/cli/src/bin/brainstorm.ts                  ~40 lines   (brainstorm sync status command)
Tests                                                ~200 lines

Total: ~565 lines for the sync foundation, before any new endpoints get wired.
```

This is the hidden cost of the wiring work. Factor it in.

## Recommended execution order

### Week 1 — Sync foundation + memory completion

1. Build sync queue infrastructure (migration 031, sync-queue module, client integration)
2. Wire `/v1/memory/query` (semantic search) into the memory tool — already half-wired
3. Add `project` param to every memory client call; store project scope in entries
4. Implement pull-path in `MemoryManager` (fetch on boot, merge last-writer-wins)
5. Wire `/v1/memory/shared/*` — team shared memory CRUD
6. Wire `/v1/memory/approval-config` + `/v1/memory/pending/*` — approval workflow
7. Wire `/v1/memory/init` — `brainstorm memory init --from <file>` with Claude Code session import
8. Add `brainstorm sync status` command

**Outcome:** Memory is fully synced, team-shared with approval gate, importable from Claude Code. This alone matches Letta Code and adds the approval-workflow differentiator.

### Week 2 — Projects + budget + intelligence

1. Wire `/v1/projects/*` CRUD → `ProjectManager.register/update/list/delete` calls BR, pulls tenant project list on boot
2. Wire `/v1/budget/*` → replace local budget warnings with BR-backed budget state, agent-level limits, alert config
3. Wire `/v1/intelligence/institutional` — one-line pull in router startup
4. Wire `/v1/intelligence/advise` into capability strategy as an advisory input
5. Wire `/v1/intelligence/frontier`, `savings`, `benchmark` into dashboard views
6. Wire `/v1/usage/{spend,models,by-cost-center,by-owner}` into budget and reporting commands

**Outcome:** Project registry and budget follow the user across machines. Team routing intelligence aggregates. Cost attribution by user and cost center works.

### Week 3 — Team & governance CLI surface

1. Wire `/v1/account/users` + invite + remove → `brainstorm team list/invite/remove`
2. Wire `/v1/governance/memory/audit` → `brainstorm audit memory`
3. Wire `/v1/governance/memory/reconstruct` → `brainstorm audit reconstruct --at <timestamp>`
4. Wire `/v1/governance/memory/compliance` → `brainstorm audit compliance`
5. Wire `/v1/webhooks/*` → `brainstorm webhook add/list/remove/test`
6. Wire `/v1/agent/trajectories/*` → replace raw fetch with proper client, add pull for stats

**Outcome:** Team management, audit trails, compliance reports, webhook notifications — all from the CLI. The "governed control plane" framing becomes literal.

### Week 4 — Cleanup + polish

1. Delete or wire the unused `IntelligenceAPIClient`
2. Clean up duplicate `/health` calls (gateway client + raw fetch)
3. Delete the 6 half-wired methods (`getRunnableModels`, `setAlias`, `createKey`, `listAgentProfiles`, `reportOutcome`, and anything else unused)
4. Document the wired surface in `packages/gateway/README.md`
5. Add a `brainstorm router coverage` command that reports which BR endpoints the CLI uses vs available, for future gap tracking

**Outcome:** No dead code, no duplicate paths, discoverable coverage report.

## What to defer

- **Tier 3 governance** (SOC 2 / HIPAA-specific, EU AI Act, W3C verifiable credentials, knowledge snapshots, sovereignty) — massive endpoint count, mostly relevant for regulated industries. Wait for a specific customer ask.
- **Mesh multi-agent coordination** — 13 endpoints for federated tenant networks. Defer until the single-tenant story is complete.
- **SCIM user provisioning** — 15 endpoints. Enterprise IdP integration. Defer until there's SSO demand.
- **Content APIs** (embeddings, audio, images, moderations) — brainstorm is a coding tool, not a general-purpose AI app. Skip.
- **Browser automation** (47 endpoints at `/act`, `/snapshot`, etc.) — separate concern, different product line.
- **Model/prompt/preset CRUD** (~15 endpoints) — local config works fine for these.

## Verdict

**BR is ~30x bigger than brainstorm uses it.** Wiring even 5-10% more of the surface unlocks:

1. Cross-machine memory, projects, routing intelligence (Weeks 1-2)
2. Team shared memory with approval workflow (Week 1)
3. Team member management + cost attribution (Week 2)
4. Audit trails, compliance reports, point-in-time memory reconstruction (Week 3)
5. Webhook event notifications (Week 3)

That's 3 weeks to turn brainstorm from "single-laptop CLI with fire-and-forget telemetry" into "governed team control plane with cross-machine state, audit trails, and governance gates" — using endpoints that **are already shipped on the BR side.**

The bottleneck isn't BR. The bottleneck is brainstorm client wiring. That's actually the best possible position — all the hard work (multi-tenant RLS, Postgres schema, approval queues, audit crypto, SCIM, OAuth flows) is already done and battle-tested. The remaining work is mostly HTTP client methods, CLI subcommands, and a sync protocol.

## Next action

Pick the week you want to do first. If it were me, I'd do **Week 1 (sync foundation + memory completion)** because:

- Lowest coordination risk (pure client work, no BR-side changes)
- Validates the sync architecture against a real BR tenant
- Delivers the Letta Code-equivalent story immediately
- Unblocks every subsequent week

The sync queue + memory pull path + project-scoped writes is maybe 800 lines + tests. One focused session. Let me know when you want to start.
