# PRD: Brainstorm Business Harness as MSP Operating System

Date: 2026-05-08

Audience: Claude Code / Codex / implementing agents.

Status: research and planning artifact only. Do not implement from this file without a follow-up scoped PR brief.

## Executive Truth

Brainstorm is not vapor. The lower-level harness is real: business manifest, walk-up loading, archetype materialization, WAL-backed filesystem writes, SQLite indexing, drift records, durable loop events, BrainstormRouter strategies, God Mode ChangeSets, relay protocol, MSP executor, and a Desktop entity/verb shell all exist and pass targeted tests.

But it is not yet the MSP operating harness Justin wants. Today it is best described as:

- A credible harness/control-plane foundation.
- A thin Desktop business harness viewer/operator.
- A real but incomplete God Mode action framework.
- A model router that is powerful for AI model selection, but not yet a tenant/client/workflow-scoped business nervous system.
- An MSP archetype starter kit, not an MSP management product.

Current readiness estimate:

| Target                                           | Readiness | Confidence |
| ------------------------------------------------ | --------: | ---------- |
| Harness substrate for business-as-code           |    60-70% | High       |
| Desktop as Business Harness front end            |    35-45% | High       |
| Desktop as God Mode/MSP operating cockpit        |    20-30% | High       |
| BrainstormRouter as model-routing nervous system |    50-60% | High       |
| BrainstormRouter as business/MSP nervous system  |    20-30% | High       |
| Production MSP "manage everything" product       |    20-30% | Medium     |
| Justin-operated alpha for one MSP/business       |    40-50% | Medium     |

The highest-leverage work is not more abstraction. It is building the missing product-critical path: Connect MSP systems -> model clients/devices/tickets/alerts/backups -> show them in Desktop -> execute God Mode actions through durable ChangeSets -> route AI loops through BrainstormRouter with tenant/client/risk scoped memory -> capture evidence.

## Product Vision

Brainstorm Business Harness should become the operating shell for an MSP:

- `business.toml` and the seven-folder harness tree are the declarative source of truth.
- BrainstormRouter is the nervous system deciding which model/agent/tool path handles each task under budget, risk, tenant, and context constraints.
- God Mode is the action plane that invokes products and integrations through a standard contract.
- ChangeSets are the safety valve for all meaningful mutations.
- Desktop is the operator cockpit for planning, inspecting, operating, and configuring the MSP.
- Relay/server/MCP are protocol surfaces for other products and agents.
- Audit, traces, evidence, and evals prove that work happened correctly.

## Stochastic Review Verdict

Scores are calibrated against the desired end-state, not against a typical early repo.

| Dimension                           | Score | Evidence Summary                                                                                                        |
| ----------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------- |
| Business harness substrate          |   6.5 | Manifest, loader, FS, index, drift, loop, archetype materialization are present.                                        |
| MSP domain coverage                 |   2.5 | MSP archetype is mostly TODO/example-client scaffolding; no deep ticket/device/backup/SLA model in the harness.         |
| God Mode action plane               |   5.5 | ChangeSet engine, connectors, server routes, relay/MSP executor exist; durability and remote ChangeSet loop incomplete. |
| Desktop front end                   |   3.5 | Business Plan/Inspect/Operate exist; Configure and Platform Operate are placeholders; no MSP cockpit.                   |
| BrainstormRouter nervous-system fit |   4.0 | Excellent model-routing primitives; no tenant/client/risk scoped routing outcomes.                                      |
| Security and governance             |   5.0 | Good JWT/loopback guard and ChangeSet concept; lacks durable idempotency, policy-as-code, tenant-scoped authZ.          |
| Observability and evidence          |   4.5 | Correlation/idempotency concepts exist in protocol; no unified trace/evidence UI across harness/router/godmode.         |
| CI and test confidence              |   6.0 | Targeted suites pass; test coverage is broad but uneven and lacks full MSP journey tests.                               |
| Performance and operations          |   5.0 | Stat-diff indexer is sound; loop overlap/backpressure and live operational dashboards missing.                          |
| Architecture simplicity             |   4.5 | Many packages are useful but risk drift; next phase should extend existing packages before creating new ones.           |

Weighted product score: 4.3/10 for the full MSP operating system.

This is early alpha product maturity on top of a stronger v1 platform substrate.

## Ranked Findings

### P0-1: Desktop Is Not Yet the God Mode/MSP Cockpit

Severity: Critical

Confidence: High

Evidence:

- `apps/desktop/src/components/workspaces/PlatformWorkspace.tsx:245` says connector invoke and scheduler queue surfaces land in Phase 2.
- `apps/desktop/src/components/business/BusinessOperateBody.tsx:79` only exposes manual indexer loop execution.
- `apps/desktop/src/components/business/BusinessOperateBody.tsx:153` exposes Open Drifts as the other primary operation.
- `apps/desktop/src/components/workspaces/BusinessWorkspace.tsx:78` renders Configure as a placeholder.

Impact:

An MSP cannot use the app to manage everything yet. They can inspect a harness and run lightweight harness maintenance, but they cannot operate devices, tickets, alerts, backup jobs, patches, incidents, client accounts, contracts, or SLAs from the cockpit.

Recommended fix:

Build a real God Mode Console and MSP Client 360 in Desktop before adding more abstract harness layers.

### P0-2: MSP Domain Model Is a Starter, Not an Operating System

Severity: Critical

Confidence: High

Evidence:

- `packages/archetype-msp/src/index.ts:11` defines `MSP_TEMPLATE`.
- The template contains one example client, a runbook, incidents `.gitkeep`, on-call, compliance, NOC/SOC docs, and TODOs.
- No first-class harness model was found for tickets, devices, users, assets, sites, contracts, SLAs, patch windows, backup jobs, alerts, incidents, licenses, vendors, QBRs, or service agreements.

Impact:

The harness cannot yet be the source of truth for an MSP. It is a place to put MSP-flavored files, not a governed MSP operating model.

Recommended fix:

Add an MSP domain schema and import model under the existing harness/config/archetype boundaries before building more UI.

### P0-3: BrainstormRouter Is Not Yet Scoped Like a Business Nervous System

Severity: Critical

Confidence: High

Evidence:

- `packages/router/src/strategies/learned.ts:29` stores learned stats in module memory.
- `packages/router/src/strategies/learned.ts:93` keys stats by `${taskType}:${modelId}`.
- `packages/router/src/strategies/learned.ts:108` records outcomes without tenant, business harness, client, connector, risk, budget, or workflow scope.

Impact:

One tenant/client/task class can poison or distort routing for another. The router can optimize "coding task model selection"; it cannot yet safely optimize MSP operations across clients, risk tiers, or business workflows.

Recommended fix:

Introduce a `RoutingScope` with `tenantId`, `harnessId`, `clientId`, `workflowKind`, `riskClass`, and `budgetClass`, then persist and query outcomes under that scope.

### P0-4: ChangeSets Are Safety-Critical but Not Durable Enough

Severity: Critical

Confidence: High

Evidence:

- `packages/godmode/src/changeset.ts:31` stores active ChangeSets in an in-memory `Map`.
- `packages/godmode/src/changeset.ts:43` only guards concurrent approval inside one process.
- `packages/godmode/src/changeset.ts:104` approves and executes drafts.
- `packages/godmode/src/changeset.ts:230` allows retry of failed/expired ChangeSets.

Impact:

Pending ChangeSets are lost on process restart. Duplicate/retry semantics are only partially protected. This is acceptable for local alpha; it is not acceptable for an MSP cockpit controlling infrastructure.

Recommended fix:

Persist draft/approved/executed/rejected ChangeSets in the DB or harness index, require idempotency keys on approval/execution, and make retry semantics explicit.

### P0-5: Remote MSP Execution Bypasses the Full ChangeSet Flow

Severity: Critical

Confidence: High

Evidence:

- `packages/msp-executor/src/msp-executor.ts:171` forwards command, idempotency, and correlation headers.
- `packages/msp-executor/src/msp-executor.ts:186` sends `simulate: false`.
- `packages/msp-executor/src/msp-executor.ts:189` states ChangeSet-gated tools are not handled in v1.
- `docs/platform-contract-v1.md:197` defines the expected simulation response for ChangeSet-required tools.

Impact:

The contract knows how to simulate dangerous actions, but the executor path does not perform that handshake. A real MSP flow needs: simulate -> show preview -> approve -> execute -> evidence.

Recommended fix:

Implement a remote ChangeSet handshake in the God Mode Console and MSP executor: if a tool requires ChangeSet, call `simulate=true`, persist preview, show it, approve locally, then execute with approved idempotency key.

### P1-6: Harness Loops Need Backpressure and Overlap Protection

Severity: High

Confidence: High

Evidence:

- `packages/harness-loop/src/index.ts:76` fires each loop immediately.
- `packages/harness-loop/src/index.ts:84` schedules recurring `runOnce()` via `setInterval`.
- No per-loop in-flight set/lock was found.

Impact:

If indexing, drift detection, or stale checks take longer than cadence, overlapping runs can race on the index and create confusing evidence. This gets worse with real MSP pollers.

Recommended fix:

Add per-loop in-flight guards, skipped-run events, and queue-depth/backpressure counters.

### P1-7: Security Posture Is Good for Local Dev, Not Full MSP SaaS

Severity: High

Confidence: Medium-High

Evidence:

- `packages/server/src/server.ts:109` refuses unauthenticated non-loopback start.
- `packages/server/src/server.ts:186` gates `/api/*` through JWT when configured.
- `packages/server/src/server.ts:352` blocks `confirm`/`deny` tools from REST.
- `packages/server/src/server.ts:491` and `:556` run chat loops with `permissionCheck: () => "allow"`.

Impact:

The server has sensible guardrails, but production MSP use needs tenant-scoped authorization, per-tool capability policy, rate limits, audit retention, idempotency, and approval delegation.

Recommended fix:

Introduce capability-based authZ and a policy layer around tool execution, chat tool use, ChangeSet approval, and tenant access.

### P1-8: Contract Drift Will Slow Implementation Agents

Severity: High

Confidence: High

Evidence:

- `README.md:75` says the platform contract has 3 endpoints.
- `docs/platform-contract-v1.md` defines at least four core routes.
- `packages/godmode/src/manifest.ts:192` verifies health, tools, platform events, and tenant provisioning.

Impact:

Agents will implement against inconsistent contract descriptions. That increases integration churn.

Recommended fix:

Make `docs/platform-contract-v1.md` canonical and update README/CLAUDE/package comments to point to it.

### P1-9: Tests Pass, but Product Journey Coverage Is Missing

Severity: High

Confidence: High

Evidence:

- Targeted suites passed for config/harness, router/godmode/relay/msp-executor, and server/gateway/core.
- 221 package/app test/spec files exist excluding `node_modules`.
- Several product-relevant packages have 0-1 tests.

Impact:

Unit confidence is decent. End-to-end confidence for "MSP operator opens Desktop, connects product, simulates ChangeSet, approves action, sees audit/evidence" is not there.

Recommended fix:

Add product journey tests before broadening features.

### P2-10: The Architecture Risks Package Proliferation

Severity: Medium

Confidence: Medium

Evidence:

The repo already has many packages with overlapping "harness", "godmode", "relay", "workflow", "router", "server", and "desktop" concerns.

Impact:

Adding new packages for every concept will make the operating system harder to finish. The next phase should consolidate and wire product paths.

Recommended fix:

Default to extending existing packages. Create a new package only when ownership, release cadence, or runtime boundaries require it.

## Product Requirements

### Personas

- MSP owner: wants one place to see clients, risk, work, cost, and AI actions.
- NOC operator: triages alerts, devices, incidents, backups, and service degradation.
- Technician: runs approved actions, follows runbooks, records evidence.
- Account manager: sees client health, contract/SLA/QBR status, open risks.
- AI operator: delegates safe work to agents and reviews ChangeSets.
- Customer stakeholder: receives evidence, reports, and approved summaries.

### Core User Journeys

1. Create or import an MSP harness.
2. Connect MSP systems: RMM, PSA/ticketing, backup, identity, email/security, billing, documentation, observability.
3. Normalize clients, sites, devices, users, contracts, SLAs, tickets, alerts, backup jobs, and runbooks into the harness/index.
4. Open a Client 360 page and see current runtime state versus intended state.
5. Ask Brainstorm to investigate or act.
6. BrainstormRouter selects the right model/agent/tool under tenant/client/risk/budget constraints.
7. God Mode simulates the action and creates a ChangeSet if needed.
8. Operator approves/rejects/forks the ChangeSet in Desktop.
9. Execution happens through the platform contract.
10. Evidence, audit logs, cost, outcome, and routing feedback are captured.
11. The harness updates intent/runtime/drift state.
12. Repeated outcomes improve routing and playbooks safely.

## Required Product Surfaces

### Surface 1: Business Plan

Current state: mostly present.

Required additions:

- Harness identity health.
- MSP archetype completeness checklist.
- Connected systems readiness.
- Client import status.
- Contract/SLA coverage summary.
- AI-loop budget and current spend.

### Surface 2: Business Inspect

Current state: partial.

Required additions:

- Client health matrix.
- Device/endpoint inventory.
- Ticket/incident queue.
- Backup status.
- Alert feed.
- Drift feed.
- Evidence/audit feed.
- Router decisions and cost feed.
- Integration health.

### Surface 3: Business Operate

Current state: minimal.

Required additions:

- God Mode tool console.
- ChangeSet center.
- Run AI loop by type.
- Client 360 action panel.
- Incident room.
- Backup remediation.
- Patch/remediation workflow.
- SLA breach workflow.
- QBR/report generation.

### Surface 4: Business Configure

Current state: placeholder.

Required additions:

- `business.toml` editor with schema validation.
- Access tiers editor.
- AI-loop budget editor.
- Connector credentials/status view.
- Tenant/client scoping.
- Approval delegation policy.
- Retention/audit policy.

### Surface 5: Platform Operate

Current state: placeholder beyond KAIROS start/stop.

Required additions:

- Connector invocation.
- Scheduler queue.
- Model/router control.
- Cost quota controls.
- Workflow run history.
- Trace/evidence search.

## Functional Requirements

### MSP Domain Model

BH-MSP-001: Define canonical MSP entities: client, site, contact, device, user, ticket, incident, alert, backup job, service, contract, SLA, license, vendor, runbook, evidence item.

BH-MSP-002: Add schema validation for MSP entity files under existing config/archetype/harness paths.

BH-MSP-003: Add importers for initial RMM/PSA/backup source snapshots.

BH-MSP-004: Record runtime observations separately from operator intent.

BH-MSP-005: Detect drift between intent and runtime observations.

BH-MSP-006: Support client-level and site-level health rollups.

### God Mode Front End

BH-GM-001: Add a Desktop God Mode Console listing connected systems and tools.

BH-GM-002: Show risk level, required approval, parameters, and evidence type for each tool.

BH-GM-003: Allow read-only tool invocation from Desktop with result rendering.

BH-GM-004: For mutating tools, always run simulation first.

BH-GM-005: Persist ChangeSet previews locally before approval.

BH-GM-006: Support approve, reject, expire, retry, and evidence review.

BH-GM-007: Support remote `CHANGESET_REQUIRED` responses instead of treating them as generic failures.

### BrainstormRouter Nervous System

BH-BR-001: Introduce `RoutingScope`.

Required fields:

```ts
interface RoutingScope {
  tenantId: string;
  harnessId: string;
  clientId?: string;
  projectId?: string;
  workflowKind?: string;
  connector?: string;
  riskClass?: "read_only" | "low" | "medium" | "high" | "critical";
  budgetClass?: "normal" | "constrained" | "emergency";
}
```

BH-BR-002: Scope learned routing outcomes by `RoutingScope`.

BH-BR-003: Scope cost budgets by tenant, harness, client, workflow, and agent.

BH-BR-004: Record model decision, prompt version, tool path, outcome, latency, cost, and operator override.

BH-BR-005: Add a Router panel in Desktop showing current decisions and why.

BH-BR-006: Add poisoning/convergence alerts scoped by tenant/client rather than globally.

### ChangeSet Durability and Idempotency

BH-CS-001: Persist ChangeSets before user approval.

BH-CS-002: Require idempotency key for every mutating execution.

BH-CS-003: Treat retry as a new attempt linked to the original ChangeSet.

BH-CS-004: Store terminal status and evidence.

BH-CS-005: Support remote simulation/approval/execution handshake.

BH-CS-006: Include blast radius, reversibility, affected client/site/device, rollback, and evidence requirements.

### Observability and Evidence

BH-OBS-001: Standardize existing correlation IDs into trace context.

BH-OBS-002: Capture parent-child causality across Desktop -> server/relay -> God Mode -> connector -> audit.

BH-OBS-003: Store wide events for actions.

BH-OBS-004: Show trace/evidence in Desktop.

BH-OBS-005: Export audit/evidence for client reporting.

BH-OBS-006: Preserve evidence before retention cleanup.

### Security and Governance

BH-SEC-001: Enforce tenant-scoped authorization on every API route.

BH-SEC-002: Add capability-based policy for tool execution.

BH-SEC-003: Add approval delegation policy.

BH-SEC-004: Add rate limits and quota checks.

BH-SEC-005: Require JWT/auth for any non-loopback production mode.

BH-SEC-006: Add policy checks for high/critical actions.

BH-SEC-007: Make chat tool permissions configurable rather than unconditional allow.

### Test and CI Requirements

BH-TST-001: Add a Desktop-less integration test for import -> simulate -> approve -> execute -> audit.

BH-TST-002: Add a mocked MSP endpoint that returns `CHANGESET_REQUIRED`.

BH-TST-003: Add router scope isolation tests.

BH-TST-004: Add ChangeSet restart/durability tests.

BH-TST-005: Add harness loop overlap/backpressure tests.

BH-TST-006: Add one Playwright/Electron smoke test for the Business workspace.

## Recommended Build Sequence

### Phase 0: Contract and Evidence Cleanup

Goal: stop agents from building on inconsistent assumptions.

PRs:

1. Make `docs/platform-contract-v1.md` canonical and update README/CLAUDE references.
2. Document actual Desktop Business/Platform surface status.
3. Add a product journey test plan under docs.
4. Add loop overlap guard to `packages/harness-loop`.

Acceptance:

- No docs claim a 3-endpoint contract unless they explain the subset.
- Product gaps are listed as Phase 2, not implied complete.
- Loop runner emits skipped/overlap events.

### Phase 1: God Mode Console and ChangeSet Center

Goal: make Desktop the real front end for God Mode.

PRs:

1. Add God Mode connected systems/tools panel to Platform Operate.
2. Add tool detail and parameter form.
3. Add read-only execution results.
4. Add ChangeSet Center with list/preview/approve/reject.
5. Wire server routes to Desktop IPC/HTTP client.

Acceptance:

- Operator can discover tools from Desktop.
- Operator can run read-only tools.
- Operator can simulate a mutating tool and see the ChangeSet.
- Operator can approve/reject and see audit output.

### Phase 2: MSP Client 360

Goal: make the MSP archetype operational, not decorative.

PRs:

1. Add MSP entity schemas.
2. Add client/site/device/user/ticket/alert/backup files to template.
3. Add index extraction for MSP entities.
4. Add Client 360 Desktop view.
5. Add integration import snapshots.

Acceptance:

- A test harness can model at least two clients, five devices, tickets, alerts, and backups.
- Desktop shows client health and open work.
- Drift can be detected between intent and imported runtime state.

### Phase 3: Router as Scoped Nervous System

Goal: make BrainstormRouter govern business/MSP work safely.

PRs:

1. Add `RoutingScope` types.
2. Scope learned strategy persistence by tenant/harness/client/risk/workflow.
3. Scope cost budgets.
4. Add router decision records to evidence/audit.
5. Add Desktop Router panel.

Acceptance:

- Tenant A outcomes do not affect Tenant B routing.
- Client A high-risk workflow does not reuse Client B low-risk learned state.
- Desktop can explain why a model/tool path was chosen.

### Phase 4: Durable ChangeSets and Remote Simulation

Goal: make action safety production-grade.

PRs:

1. Persist ChangeSet drafts and terminal states.
2. Add idempotency key storage and replay protection.
3. Implement remote `simulate=true` handshake.
4. Add retry-attempt lineage.
5. Add evidence and rollback metadata.

Acceptance:

- Restart does not lose pending ChangeSets.
- Duplicate approval does not double-execute.
- Remote MSP ChangeSet-required actions work end-to-end.

### Phase 5: MSP AI Loops

Goal: make the harness actively manage MSP work under human control.

PRs:

1. Add alert triage loop.
2. Add backup remediation loop.
3. Add patch window loop.
4. Add SLA breach loop.
5. Add QBR/report loop.
6. Add per-loop budgets, schedules, and approval policies.

Acceptance:

- Each loop has schedule, budget, evidence, and stop conditions.
- Each loop creates ChangeSets for mutations.
- Desktop can pause/resume and inspect loop history.

### Phase 6: Production Hardening

Goal: move from Justin-operated alpha to customer-grade MSP product.

PRs:

1. Tenant-scoped authorization.
2. Capability policy.
3. Audit retention/export.
4. Rate limits and circuit breakers.
5. OTel-compatible trace context.
6. Playwright/Electron smoke tests.
7. MSP journey eval harness.

Acceptance:

- Multi-tenant isolation tests pass.
- High-risk tools require policy approval.
- Evidence can be exported for a client.
- End-to-end MSP journey test passes in CI.

## Claude Code Implementation Rules

Before implementing any PR from this plan:

1. Read the exact files listed below.
2. Preserve existing package boundaries unless the PR explicitly creates a new boundary.
3. Prefer extending Desktop Business/Platform surfaces over adding new abstract docs.
4. Add tests for every behavior that changes product-critical paths.
5. Run the verification commands listed for the PR.
6. Report before/after status with evidence paths.

Critical files:

- `apps/desktop/src/components/workspaces/BusinessWorkspace.tsx`
- `apps/desktop/src/components/workspaces/PlatformWorkspace.tsx`
- `apps/desktop/src/components/business/BusinessPlanBody.tsx`
- `apps/desktop/src/components/business/BusinessInspectBody.tsx`
- `apps/desktop/src/components/business/BusinessOperateBody.tsx`
- `apps/desktop/electron/main.ts`
- `packages/config/src/business-schema.ts`
- `packages/config/src/business-loader.ts`
- `packages/archetype-msp/src/index.ts`
- `packages/harness-index/src/schema.ts`
- `packages/harness-index/src/index-store.ts`
- `packages/harness-loop/src/index.ts`
- `packages/router/src/router.ts`
- `packages/router/src/strategies/learned.ts`
- `packages/router/src/cost-tracker.ts`
- `packages/godmode/src/changeset.ts`
- `packages/godmode/src/types.ts`
- `packages/godmode/src/connector-registry.ts`
- `packages/godmode/src/connectors/msp/client.ts`
- `packages/msp-executor/src/msp-executor.ts`
- `packages/server/src/server.ts`
- `docs/platform-contract-v1.md`

Baseline verification commands:

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

## Definition of Done for "Full Business Harness"

The project can credibly claim "full MSP business harness" when all of these are true:

- An MSP can import/connect clients, devices, tickets, alerts, backups, users, contracts, and SLAs.
- Desktop has Plan, Inspect, Operate, and Configure surfaces that are not placeholders.
- God Mode tools are discoverable and invocable from Desktop.
- Mutating actions simulate, produce ChangeSets, require approval based on risk, execute idempotently, and produce evidence.
- BrainstormRouter decisions are scoped by tenant, harness, client, workflow, risk, and budget.
- The system captures routing outcomes and learns without cross-tenant contamination.
- Business harness drift is computed from real runtime observations, not only stub `runtime.toml` writes.
- Audit/evidence can answer: who did what, why, through which model/tool, under which approval, to which client, with what result.
- CI includes an end-to-end MSP journey test.

Until then, the honest label is:

> Brainstorm is a promising governed AI control-plane and business-harness alpha. It is not yet a complete MSP operating harness.
