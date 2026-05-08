# Business Harness Research Log - 2026-05-08

Goal: assess how far Brainstorm is from a full business/MSP harness where BrainstormRouter is the nervous system, God Mode is the action plane, and Desktop is the operator front end.

Scope: no code changes. This log records what was read, what was verified, and the evidence behind the assessment in `docs/business-harness-prd-claude-code-2026-05-08.md`.

## Method

I used the repository's stochastic review pattern rather than a single-pass opinion:

- Evidence-first code reading across the product-critical path.
- Ten-perspective scoring: optimist, pessimist, architect, operator, security reviewer, performance reviewer, correctness reviewer, CI/test reviewer, simplifier, and competitor.
- Disagreement preservation: places where the code is stronger than the product surface, or where docs are stronger than implementation, are called out explicitly.
- Calibration audit: claims are tagged with confidence and tied to file evidence where possible.

Relevant local assessment references:

- `.claude/skills/phase-build/SKILL.md`
- `docs/assessment-synthesis.md`
- `docs/assessment-audit.md`
- `docs/forge-summary.md`
- `docs/full-review-journal.md`

## Critical Path Read

### Desktop / Business Harness Surface

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/lib/workspace.ts`
- `apps/desktop/src/components/workspaces/BusinessWorkspace.tsx`
- `apps/desktop/src/components/business/BusinessPlanBody.tsx`
- `apps/desktop/src/components/business/BusinessInspectBody.tsx`
- `apps/desktop/src/components/business/BusinessOperateBody.tsx`
- `apps/desktop/src/components/business/BusinessHarnessShared.tsx`
- `apps/desktop/src/components/workspaces/PlatformWorkspace.tsx`
- `apps/desktop/electron/main.ts`

Finding: Desktop has the correct entity/verb frame and real Business Plan/Inspect/Operate surfaces, but the God Mode/MSP operating cockpit is not yet there. Business Operate only exposes manual indexer loop execution and customer-drift apply. Platform Operate explicitly says connector invocation and scheduler queue are Phase 2.

Evidence:

- `apps/desktop/src/components/business/BusinessOperateBody.tsx:79` shows the only AI loop action is "Run indexer loop now".
- `apps/desktop/src/components/business/BusinessOperateBody.tsx:153` shows Open Drifts as the other main operation.
- `apps/desktop/src/components/workspaces/BusinessWorkspace.tsx:78` renders Configure as a placeholder telling users to edit `business.toml` directly.
- `apps/desktop/src/components/workspaces/PlatformWorkspace.tsx:245` says "Remaining Operate surfaces (run a God Mode connector, peek the scheduler queue, force model rotation) land in Phase 2."
- `apps/desktop/electron/main.ts:831` documents customer drift apply as a v1 stub runtime that writes intent into `runtime.toml` until a real poller is wired.

### Business Harness / Filesystem / Index / Loop

- `packages/config/src/business-schema.ts`
- `packages/config/src/business-loader.ts`
- `packages/harness-fs/src/init.ts`
- `packages/harness-fs/src/write-through.ts`
- `packages/harness-index/src/schema.ts`
- `packages/harness-index/src/index-store.ts`
- `packages/harness-drift/src/*`
- `packages/harness-loop/src/index.ts`
- `packages/archetype-msp/src/index.ts`

Finding: the harness substrate is credible. It has a manifest, walk-up loader, archetype materialization, WAL-backed write-through writer, SQLite index, drift state, changeset log, and durable loop events. The MSP archetype itself is still skeletal.

Evidence:

- `packages/config/src/business-schema.ts:20` defines schema version `1.0` and a real manifest schema.
- `packages/config/src/business-schema.ts:152` includes AI-loop budget fields.
- `packages/harness-loop/src/index.ts:23` defines three loops: indexer, customer-drift, stale-watchdog.
- `packages/harness-loop/src/index.ts:76` schedules loops immediately and on intervals.
- `packages/harness-loop/src/index.ts:101` allows manual `runOnce`.
- `packages/archetype-msp/src/index.ts:11` defines the MSP starter template, but most contents are TODOs and example-client scaffolding.

Risk note: `HarnessLoopRunner.start()` schedules `runOnce()` via `setInterval` without a per-loop in-flight guard. If a loop takes longer than its cadence, overlapping runs are possible.

### BrainstormRouter / Nervous System

- `packages/router/src/router.ts`
- `packages/router/src/strategies/learned.ts`
- `packages/router/src/cost-tracker.ts`
- `packages/router/src/team-optimizer.ts`

Finding: BrainstormRouter is a real model/task router with cost, quality, capability, learned, auto, and combined strategies. It is not yet the business/MSP nervous system because learned state is global by `taskType:modelId`, not scoped by tenant, business harness, MSP client, risk class, connector, or workflow.

Evidence:

- `packages/router/src/router.ts:27` defines `BrainstormRouter`.
- `packages/router/src/router.ts:60` wires cost-first, quality-first, rule-based, combined, capability, learned, and auto strategies.
- `packages/router/src/router.ts:120` checks budget before routing.
- `packages/router/src/strategies/learned.ts:29` stores learned model stats in module-level memory.
- `packages/router/src/strategies/learned.ts:93` keys stats as `${taskType}:${modelId}`.
- `packages/router/src/strategies/learned.ts:108` records outcomes with no tenant/harness/client/risk dimensions.

### God Mode / ChangeSet / MSP Action Plane

- `packages/godmode/src/changeset.ts`
- `packages/godmode/src/types.ts`
- `packages/godmode/src/connector-registry.ts`
- `packages/godmode/src/manifest.ts`
- `packages/godmode/src/connectors/msp/*`
- `packages/msp-executor/src/msp-executor.ts`
- `docs/platform-contract-v1.md`

Finding: the God Mode safety pattern is real, and there are real MSP connector primitives. The dangerous gap is durability and end-to-end orchestration: local ChangeSets are in-memory, remote MSP dispatch does not perform the full ChangeSet simulation/approval loop, and Desktop does not yet expose a mature ChangeSet center.

Evidence:

- `packages/godmode/src/changeset.ts:31` stores active ChangeSets in an in-memory `Map`.
- `packages/godmode/src/changeset.ts:43` has an in-process approval concurrency guard.
- `packages/godmode/src/changeset.ts:104` approves and executes a ChangeSet.
- `packages/godmode/src/changeset.ts:157` wraps execution with a 30s timeout.
- `packages/msp-executor/src/msp-executor.ts:171` sends command, idempotency, and correlation headers to the remote MSP endpoint.
- `packages/msp-executor/src/msp-executor.ts:186` sends `simulate: false`.
- `packages/msp-executor/src/msp-executor.ts:189` states ChangeSet-gated tools are not handled in v1.
- `docs/platform-contract-v1.md:171` defines `POST /api/v1/god-mode/execute` with `simulate`, `correlation_id`, and `idempotency_key`.
- `docs/platform-contract-v1.md:197` defines the simulation response path for ChangeSet-required actions.

### Server / API / Security

- `packages/server/src/server.ts`
- `packages/server/src/__tests__/auth.test.ts`
- `packages/server/src/__tests__/server.test.ts`
- `packages/server/src/__tests__/github-webhook.test.ts`

Finding: the HTTP server is more real than older assessments implied. It has auth tests, JWT verification, non-loopback auth refusal, tool execution routes, ChangeSet routes, audit routes, chat routes, and webhook tests. The production-hardening gaps are tool permission granularity, chat permission policy, idempotency, rate limits, and tenant-scoped authorization.

Evidence:

- `packages/server/src/server.ts:109` refuses to start without auth on non-loopback interfaces.
- `packages/server/src/server.ts:186` gates `/api/*` routes through JWT if configured.
- `packages/server/src/server.ts:352` blocks `confirm` and `deny` permission tools from REST execution.
- `packages/server/src/server.ts:411` approves ChangeSets through the server.
- `packages/server/src/server.ts:491` and `packages/server/src/server.ts:556` run chat and streaming chat with `permissionCheck: () => "allow"`.

### Contract / Documentation Drift

Finding: docs and implementation are close but not perfectly aligned. This matters because the product thesis depends on a stable platform contract.

Evidence:

- `README.md:75` says every product implements the same contract with 3 endpoints.
- `docs/platform-contract-v1.md:76`, `:171`, `:259`, and `:298` define tool discovery, tool execution, platform events, and tenant provisioning.
- `packages/godmode/src/manifest.ts:192` verifies health, tools, platform events, and tenant provisioning.

## Verification Run

Commands run on 2026-05-08:

```bash
node scripts/check-dep-cruiser.mjs
node scripts/check-as-any-budget.mjs
node scripts/check-ci-continue-on-error.mjs
npm run lint:abort-signal
npm run --workspace=@brainst0rm/tools export-catalog:check
npx turbo run test --filter=@brainst0rm/config --filter=@brainst0rm/harness-fs --filter=@brainst0rm/harness-index --filter=@brainst0rm/harness-drift --filter=@brainst0rm/harness-loop
npx turbo run test --filter=@brainst0rm/router --filter=@brainst0rm/godmode --filter=@brainst0rm/relay --filter=@brainst0rm/msp-executor
npx turbo run test --filter=@brainst0rm/server --filter=@brainst0rm/gateway --filter=@brainst0rm/core
```

Results:

- Dep-cruiser passed: `0/0`.
- as-any budget passed: `280/285`.
- CI continue-on-error budget passed: `0/0`.
- AbortSignal lint passed.
- Tool catalog check passed.
- Harness/config group passed: 11 tasks.
- Router/God Mode/Relay/MSP executor group passed: 15 tasks.
- Server/Gateway/Core group passed: 16 tasks.
- Core alone reported 33 test files and 421 tests passing.
- God Mode reported 10 test files and 105 tests passing.
- Relay reported 16 test files and 164 tests passing.
- Router reported 7 test files and 100 tests passing.
- Server reported 3 test files and 26 tests passing.

Coverage reality:

- There are 221 package/app test/spec files excluding `node_modules`.
- Test distribution is uneven. Some packages have 0-1 test files, including `@brainst0rm/archetype-msp`, `@brainst0rm/archetype-saas-platform`, `@brainst0rm/dispatch-sdk`, and `@brainst0rm/image-builder`.

## Stochastic Score Snapshot

Scores are 0-10 for the specific goal: "MSP uses this as the harness to manage everything; Desktop is the front end for God Mode; BrainstormRouter is the nervous system."

| Lens                 | Score | Rationale                                                                                                                     |
| -------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------- |
| Optimist             |   6.7 | Real substrate: router, ChangeSets, relay, harness FS/index/drift/loop, Desktop shell.                                        |
| Pessimist            |   3.1 | MSP product surface is not there; many key workflows are placeholders or stubs.                                               |
| Architect            |   5.6 | Good package boundaries, but control/evidence/tenancy are not unified.                                                        |
| MSP Operator         |   2.8 | Cannot yet run daily MSP work: tickets, devices, alerts, backups, patching, SLAs, QBRs.                                       |
| Security Reviewer    |   5.2 | Good JWT/loopback posture and ChangeSet intent; needs durable idempotency, tenant authZ, rate limits.                         |
| Performance Reviewer |   5.8 | Indexer is stat-diff-first; router is cheap; loop overlap and broad polling need guardrails.                                  |
| Correctness Reviewer |   5.0 | Tests pass and primitives are typed; end-to-end product invariants are not tested.                                            |
| CI/Test Reviewer     |   6.1 | Ratchets and targeted suites are healthy; coverage is uneven and lacks journey tests.                                         |
| Simplifier           |   4.7 | Many packages and docs can drift; next work should extend existing packages before adding new ones.                           |
| Competitor           |   3.4 | Compared to a real MSP dashboard/RMM/PSA cockpit, this is early alpha. Compared to agent harnesses, the foundation is strong. |

Mean: 4.84/10.

Calibrated interpretation: around 60-70% of a credible harness substrate, 25-35% of the MSP/God Mode desktop product, and 20-30% of a production MSP operating system.
