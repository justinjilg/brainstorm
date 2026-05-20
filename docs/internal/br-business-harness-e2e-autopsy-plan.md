# BrainstormRouter Business Harness E2E Autopsy Plan

Date: 2026-05-19
Status: planning artifact
Scope: `brainstorm` as the business harness, BrainstormRouter as the nervous system

## Thesis

`brainstorm` should be tested as the harness that lets agents operate a business, not as a CLI that happens to call an AI gateway. BrainstormRouter is the nervous system: routing, memory, budget, identity hints, capability discovery, A2A dispatch, and cost/audit metadata. MSP, VM/HAI, backup, security, GTM, and endpoint agents are the actuators.

The end-to-end proof is a traceable business action:

```text
operator or agent intent
  -> brainstorm harness
  -> BrainstormRouter discovery, routing, memory, cost, identity
  -> product capability or endpoint agent
  -> ChangeSet or read-only execution
  -> evidence envelope
  -> correlated trace, cost, and audit record
```

This plan creates the autopsy and smoke-test structure needed to prove that loop repeatedly, safely, and with enough instrumentation that contract drift becomes visible before it reaches production use.

## Non-Goals

- Do not perform production write tests by default.
- Do not replace existing unit, preflight, provider, or dogfood tests.
- Do not require 1Password in CI. Local operator scripts may use existing environment variables or operator-provided secrets, but tests must redact everything they log.
- Do not make v0.5 frontend/domain consolidation changes in this plan.
- Do not collapse API endpoints under `brainstorm.co` yet.

## Safety Posture

All live tests are gated:

| Gate                                 | Meaning                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `RUN_LIVE_BR=1`                      | Allows read-only calls to live `api.brainstormrouter.com`.                               |
| `BRAINSTORM_API_KEY`                 | Uses the operator or sandbox BR key. If missing, only community-key-safe probes may run. |
| `RUN_LIVE_BR_WRITES=1`               | Allows write-shaped probes only against an explicit sandbox tenant. Not used in PR CI.   |
| `BRAINSTORM_SANDBOX_TENANT_ID`       | Required for any write-shaped or ChangeSet simulation probe.                             |
| `BRAINSTORM_BUSINESS_SMOKE_RECORD=1` | Allows redacted artifact recording under `artifacts/`.                                   |

Default behavior:

- Read-only first.
- Simulate writes before execute.
- Fail closed on ambiguous risk classification.
- Never log bearer tokens, API keys, service JWTs, cookies, private memory content, or raw customer data.
- Use short timeouts on every live call.
- Every live artifact is redacted before it is persisted.

## Current Contract Observations

These are the seams the plan must make measurable.

### 1. Discovery Is Documented As Authoritative, But The Harness Still Hardcodes

`docs/brainstormrouter-integration.md` says the authoritative BR discovery surfaces are:

- `https://api.brainstormrouter.com/openapi.json`
- `https://api.brainstormrouter.com/v1/discovery`
- `https://brainstormrouter.com/llms.txt`
- `https://api.brainstormrouter.com/attestation`

The native BR tools in `packages/tools/src/builtin/br-intelligence.ts` still hardcode REST paths:

- `GET /v1/self`
- `GET /v1/budget/status`
- `GET /v1/budget/forecast`
- `GET /v1/intelligence/rankings`
- `GET /v1/insights/optimize`
- `GET /v1/models`
- `POST /v1/memory/query`
- `POST /v1/memory/store`
- `GET /health`

This is not necessarily wrong, but it needs a ratchet. Every hardcoded path should be checked against BR OpenAPI and BR discovery.

### 2. Integration Docs And Code Already Drift In Endpoint Names

The integration doc still lists older paths like:

- `/v1/agent/status`
- `/v1/agent/memory`
- `/v1/intelligence/leaderboard`
- `/v1/intelligence/insights`
- `/v1/health`

The current native tool code uses:

- `/v1/self`
- `/v1/budget/status`
- `/v1/budget/forecast`
- `/v1/intelligence/rankings`
- `/v1/insights/optimize`
- `/v1/memory/query`
- `/v1/memory/store`
- `/health`

The autopsy must report doc-only, code-only, OpenAPI-only, and live-only paths.

### 3. Provider Envelope Tests Are Good, But Not Yet Business-Harness Tests

`packages/providers/src/cloud/brainstorm-saas.ts` captures the BR `x-br-*` envelope and filters guardian SSE events.

`packages/providers/src/__tests__/br-live-contract.live.test.ts` already checks:

- live `/v1/chat/completions` x-br headers are known
- `/openapi.json` has a route-count floor
- `/v1/discovery` memory blocks match the CLI enum
- canonical BR header count has not collapsed

That is a strong model-gateway ratchet. It does not yet prove:

- the harness turns envelope metadata into a business trace
- a routed call is connected to a tool invocation or product capability
- cost is attributed to a business action
- evidence hash and traceparent survive across BR and downstream products

### 4. Capability Registry And A2A Have A Source-Of-Truth Split

`packages/cli/src/discovery/capability-registry.ts` currently discovers products from VM CP:

```text
GET https://vm.brainstorm.co/api/v1/capabilities/list
```

`packages/cli/src/commands/a2a.ts` lists from VM CP, then invokes through BR's DID-keyed route:

```text
POST https://api.brainstormrouter.com/v1/mesh/invoke-did/{target_did}
```

In the BR repo, the DID-to-product path appears as:

```text
POST /v1/mesh/invoke-did/{target_did}
```

BR also has:

```text
POST /v1/mesh/invoke/{hostname}
```

That route is mTLS mesh-hostname oriented, not a DID route. A 2026-05-19 fix moved the CLI off the hostname route; the remaining contract obligation is to keep that regression covered and verify BR keeps the DID route stable.

### 5. The Product Platform Contract Is Broader Than The BR Gateway Contract

`docs/platform-contract-v1.md` defines the product protocol:

- `GET /health`
- `GET /api/v1/god-mode/tools`
- `POST /api/v1/god-mode/execute`
- `POST /api/v1/platform/events`
- `GET/POST /api/v1/platform/tenants`

The business harness test must bridge both worlds:

- BR as nervous system and broker
- product platform contract as actuator surface

Testing BR alone is not enough. Testing products alone is not enough. The harness is the thing that should make the seam disappear.

## Target Test Architecture

### Test Layers

| Layer | Name                            | Purpose                                                                                      | Live?         |
| ----- | ------------------------------- | -------------------------------------------------------------------------------------------- | ------------- |
| L0    | Static contract map             | Compare code, docs, OpenAPI, BR SDK, RBAC, and known CLI paths.                              | No            |
| L1    | Mocked module contract          | Validate harness modules against recorded BR fixtures.                                       | No            |
| L2    | Live BR discovery smoke         | Probe read-only BR discovery, auth, budget, models, memory, and attestation.                 | Gated         |
| L3    | Native BR tool smoke            | Execute the 8 native `br_*` tools through the actual tool layer.                             | Gated         |
| L4    | Provider envelope smoke         | Route one small completion through BR and capture typed cost/audit/routing metadata.         | Gated         |
| L5    | A2A and registry smoke          | Verify capability discovery, DID route choice, traceparent, idempotency, and status polling. | Gated         |
| L6    | Product platform smoke          | Verify product health/tool contracts through read-only or simulate-only execution.           | Gated         |
| L7    | Business harness workflow smoke | Produce one full `BusinessHarnessTrace` for a business scenario.                             | Gated         |
| L8    | Chaos and degradation           | Prove fail-closed behavior under BR/product failures and contract drift.                     | Mostly mocked |

### Artifact Model

The plan should introduce a redacted trace artifact, not just pass/fail logs.

```ts
export interface BusinessHarnessTrace {
  run_id: string;
  started_at: string;
  completed_at?: string;
  tenant: {
    id_hash: string;
    slug?: string;
  };
  actor: {
    kind: "operator" | "agent" | "ci";
    subject_hash: string;
    auth_mode:
      | "api_key"
      | "keycloak"
      | "service_jwt"
      | "community_key"
      | "unknown";
  };
  intent: {
    text_redacted: string;
    category:
      | "status"
      | "investigate"
      | "simulate_write"
      | "execute_write"
      | "backup"
      | "security";
  };
  br: {
    base_url: string;
    request_ids: string[];
    routed_models: string[];
    total_cost_usd?: number;
    audit_hashes: string[];
    envelope_modes: string[];
    unknown_headers: string[];
  };
  registry: {
    source: "br" | "vm" | "mixed";
    capabilities_seen: number;
    products_seen: string[];
    stale_or_ambiguous: string[];
  };
  actions: Array<{
    step: string;
    system:
      | "brainstorm"
      | "br"
      | "msp"
      | "vm"
      | "backup"
      | "gtm"
      | "security"
      | "endpoint_stub";
    mode: "read_only" | "simulate" | "execute";
    capability?: string;
    target_did_hash?: string;
    traceparent?: string;
    request_id_hash?: string;
    idempotency_key_hash?: string;
    evidence_hash?: string;
    changeset_id?: string;
    status: "ok" | "blocked" | "degraded" | "failed";
    error_code?: string;
  }>;
  result: {
    success: boolean;
    safety_outcome:
      | "no_writes"
      | "simulated_only"
      | "approved_write"
      | "blocked";
    notes: string[];
  };
}
```

This trace is the proof object. It should be machine-readable, redacted, and safe to attach to CI or evidence docs.

## Phase 0: Grounding, Gates, And Harness Safety

Goal: make sure no smoke test can surprise production.

Deliverables:

- `docs/internal/br-business-harness-e2e-autopsy-plan.md` as the durable plan.
- `tests/business-harness/README.md` describing live-test gates and safety rules.
- `tests/business-harness/redaction.ts` with redactors for keys, JWTs, trace IDs when needed, tenant IDs, emails, and memory snippets.
- `tests/business-harness/env.ts` that centralizes gate checks.
- `tests/business-harness/trace-schema.ts` with `BusinessHarnessTrace`.

Checks:

- Running without env gates performs no network calls.
- Running with `RUN_LIVE_BR=1` performs only read-only calls.
- Running with `RUN_LIVE_BR_WRITES=1` fails unless sandbox tenant env vars are present.
- Artifact recording is opt-in and always redacted.

Exit criteria:

- One command explains exactly which live gates are active.
- No test has ad hoc direct access to `process.env.BRAINSTORM_API_KEY`.
- No test logs raw auth material.

## Phase 1: Static Contract Autopsy

Goal: produce a contract matrix that says what the harness believes, what BR exposes, and where they disagree.

Scope is intentionally bounded to routes `brainstorm` currently touches. This is not a 600-route BR inventory. Initial scope is roughly 20 routes:

- the 8 native `br_*` tool routes
- `/v1/chat/completions` and BR envelope headers
- A2A list/invoke/status paths the CLI uses
- VM CP capability-list path
- product platform-contract endpoints the harness consumes
- BR discovery/self/openapi/attestation surfaces used to validate the above

The matrix may cite the broader BR OpenAPI/RBAC/SDK surface as evidence, but only touched harness routes should become pass/fail obligations.

### Inputs

From this repo:

- `docs/brainstormrouter-integration.md`
- `docs/internal/br-api-spec.md`
- `docs/platform-contract-v1.md`
- `docs/a2a-protocol-v01.md`
- `docs/br-capability-audit.md`
- `packages/tools/src/builtin/br-intelligence.ts`
- `packages/providers/src/cloud/brainstorm-saas.ts`
- `packages/providers/src/cloud/br-envelope.ts`
- `packages/cli/src/commands/a2a.ts`
- `packages/cli/src/discovery/capability-registry.ts`
- `packages/core/src/plan/trajectory-capture.ts`
- `packages/core/src/memory/manager.ts`
- existing `scripts/contract-checks/*`

From the BR repo:

- `docs/openapi.yaml`
- runtime `GET /openapi.json` when live gate is enabled
- `src/api/middleware/rbac.ts`
- `src/api/capabilities/_registry.ts`
- `src/api/capabilities/system/discovery.ts`
- `src/api/capabilities/system/self.ts`
- `src/api/capabilities/system/mesh.ts`
- `src/api/capabilities/system/mesh-capability-routing.ts`
- `src/api/capabilities/system/tenant-context.ts`
- `packages/sdk-ts/src/resources/*`

### Script

Create:

```text
scripts/br-business-contract-map.mjs
```

Responsibilities:

1. Extract all BR-looking paths from harness code and docs.
2. Extract OpenAPI paths from local BR `docs/openapi.yaml` when the sibling repo exists.
3. Extract route permissions from BR `ROUTE_PERMISSIONS`.
4. Extract SDK resource paths from `brainstormrouter/packages/sdk-ts/src/resources`.
5. Classify each path:
   - `code_used`
   - `doc_mentioned`
   - `openapi_documented`
   - `rbac_mapped`
   - `sdk_exposed`
   - `live_confirmed`
   - `ambiguous`
   - `deprecated_or_alias`
6. Emit:
   - `artifacts/br-business-contract-map.json`
   - `docs/internal/br-business-harness-contract-matrix.md`

### Static Findings The Script Must Catch

- Docs mention `/v1/agent/status`, but native code uses `/v1/self`.
- Docs mention `/v1/agent/memory`, but native code uses `/v1/memory/query` and `/v1/memory/store`.
- Docs mention `/v1/intelligence/leaderboard`, but native code uses `/v1/intelligence/rankings`.
- Historical bug to prevent: native code must not invoke `/v1/mesh/invoke/{encodedTargetDID}` for DID targets. BR exposes `/v1/mesh/invoke-did/{target_did}` for DID routing and `/v1/mesh/invoke/{hostname}` for mTLS hostname routing.
- Capability list path is VM CP, not BR.
- Native BR tools use raw fetch instead of BR SDK resources.

### Exit Criteria

- Contract map runs without network.
- Matrix clearly lists every harness-to-BR endpoint and its source.
- Ambiguous route count is explicit.
- DID invoke path ambiguity is resolved in code and enforced as a regression.

## Phase 2: Live BR Discovery Smoke

Goal: prove the live BR surface is reachable, self-describing, and aligned with the harness assumptions.

Create:

```text
tests/business-harness/live-br-discovery.ts
```

Run command:

```bash
RUN_LIVE_BR=1 npx tsx tests/business-harness/live-br-discovery.ts
```

Read-only probes:

| Probe                                   | Auth        | Expected                                                    |
| --------------------------------------- | ----------- | ----------------------------------------------------------- |
| `GET /health`                           | none        | 200, stable product status shape                            |
| `GET /openapi.json`                     | none        | 200, path floor, paths include native tool paths            |
| `GET /llms.txt` or `GET /llms-full.txt` | none        | 200 text, mentions BR discovery                             |
| `GET /attestation`                      | none or key | 200 or documented auth behavior                             |
| `GET /v1/discovery`                     | key         | capabilities, memory blocks, endpoints                      |
| `GET /v1/self`                          | key         | identity, budget, suggestions, links                        |
| `GET /v1/models`                        | key         | non-empty model list or documented limited-community result |
| `GET /v1/budget/status`                 | key         | tenant/key budget shape                                     |
| `GET /v1/budget/forecast`               | key         | forecast shape or documented insufficient-data response     |
| `GET /v1/insights/optimize`             | key         | recommendations or empty list                               |
| `GET /v1/intelligence/rankings`         | key         | rankings or empty list                                      |
| `POST /v1/memory/query`                 | key         | query returns bounded entries without writing               |

Assertions:

- All code-used native tool paths are present in OpenAPI or explicitly marked as intentional aliases.
- Discovery memory blocks match `br_memory_store` enum.
- Discovery endpoint links do not point to removed paths.
- Response bodies validate minimal schemas.
- Errors are structured and include recovery hints where BR promises them.
- 401 behavior for missing/bad auth is stable.

Artifacts:

- Redacted JSON summary under `artifacts/br-live-discovery-summary.json` when recording is enabled.
- No raw memory content persisted unless explicitly allowed, and even then only redacted snippets.

Exit criteria:

- One read-only smoke command can say whether live BR is usable by the harness today.
- The smoke output identifies whether the active key is community, personal, sandbox, or unknown without printing it.

## Phase 3: Native BR Tool Smoke

Goal: prove the harness can use BR through its actual operator-facing tools, not just through raw HTTP.

Target tools:

- `br_health`
- `br_status`
- `br_budget`
- `br_models`
- `br_leaderboard`
- `br_insights`
- `br_memory_search`
- `br_memory_store`

Create tests near the tool layer:

```text
packages/tools/src/__tests__/br-intelligence-contract.test.ts
packages/tools/src/__tests__/br-intelligence-live.test.ts
```

Mocked assertions:

- Each tool has a stable name, description, permission, and Zod input schema.
- `br_memory_store` remains `permission: "confirm"`.
- Read-only tools remain `permission: "auto"`.
- Missing key returns a structured error, not an exception.
- Non-2xx BR response returns bounded error text.
- Timeout uses `AbortSignal.timeout`.
- Tool endpoint paths are included in the static contract map.

Live assertions:

- Execute all read-only tools with `RUN_LIVE_BR=1`.
- Execute `br_memory_search` with a harmless query.
- Do not execute `br_memory_store` live unless `RUN_LIVE_BR_WRITES=1` and sandbox tenant is set.
- Validate every tool output against a minimal expected shape.

Exit criteria:

- The harness can ask BR who it is, what models exist, what budget remains, what the leaderboard says, and what memory knows.
- Tool permission posture is part of the test, not assumed.

## Phase 4: Provider Routing, Envelope, Cost, And Audit Smoke

Goal: prove BR routing metadata becomes business-harness evidence rather than disappearing after the model call.

Existing base:

- `packages/providers/src/cloud/brainstorm-saas.ts`
- `packages/providers/src/cloud/br-envelope.ts`
- `packages/providers/src/__tests__/br-live-contract.live.test.ts`
- `packages/db/src/routing-audit-writer.ts`
- `packages/db/src/__tests__/routing-audit-writer*.test.ts`

New live smoke:

```text
tests/business-harness/provider-envelope-smoke.ts
```

Probe:

```text
POST /v1/chat/completions
model: auto
messages: [{ role: "user", content: "Return the word pong." }]
max_tokens: 8
```

Assertions:

- HTTP status below 500.
- `parseBrEnvelope` returns no unknown headers.
- At least these are present when BR returns a successful response:
  - request id
  - build
  - envelope mode
  - routed model
  - actual or estimated cost
  - route reason or selection method
  - audit hash when available
- Guardian SSE filtering still preserves model output.
- Envelope listener cannot break the fetch path.
- Business trace records:
  - BR request id
  - routed model
  - cost
  - audit hash
  - route confidence if present

Follow-on:

- Add an agent-loop smoke that executes one tiny prompt through `brainstorm run --pipe --json` and confirms the envelope is persisted into the local routing audit store.

Exit criteria:

- A BR-routed LLM call has a traceable cost and audit pointer inside the harness.
- Header drift is caught both live and statically.

## Phase 5: Registry And A2A Autopsy

Goal: settle how the harness discovers capabilities and how it invokes them through BR.

This is the highest-value phase for the business-harness vision.

### 5.1 Static Route Resolution

Create:

```text
packages/cli/src/__tests__/a2a.test.ts
```

Assertions:

- CLI list path is documented as VM CP until BR proxy is implemented.
- CLI invoke path is compared against BR OpenAPI.
- CLI invoke uses `/v1/mesh/invoke-did/{target_did}` for DID targets.
- CLI invoke must not send encoded DIDs to `/v1/mesh/invoke/{hostname}`.
- BR OpenAPI/RBAC must continue to expose `/v1/mesh/invoke-did/{target_did}` or an explicitly coordinated replacement.
- `traceparent` and `Idempotency-Key` are always sent.
- Invalid JSON input fails before network.
- Missing `BRAINSTORM_API_KEY` fails before network.

### 5.2 Live Registry Read

Read-only probes:

- `brainstorm a2a list --json` against VM CP.
- `GET /v1/tenant/context` through BR when authorized.
- Future BR `system.registry.list` or `/v1/registry/list` when v0.5 lands.

Assertions:

- Products include at least BR and any live product with active capabilities.
- Capability records include DID, name, status, risk/autonomy if available.
- DID parser can classify product.
- Registry source is recorded as `vm`, `br`, or `mixed`.
- Stale/offline capabilities are visible and not silently treated as invokable.

### 5.3 Safe Invoke Smoke

Preferred order:

1. Use a local endpoint stub or sandbox target.
2. Use a live read-only capability with explicit safe classification.
3. Use simulate-only product execution.
4. Never execute production writes in this phase.

Probe requirements:

- Generate W3C `traceparent`.
- Generate idempotency key.
- Invoke one safe capability.
- If BR returns 202, poll `status_url`.
- Validate 200, 202, 400, 401, 403, 404, 409, 410, 429, 500, and 503 error handling through mocked tests.

Assertions:

- Response traceparent keeps the same trace id when present.
- Evidence hash is captured when present.
- 409 idempotency conflict is not retried as a new action.
- 404 unknown capability is shown as a capability mismatch, not a generic failure.
- 403 is shown as scope/tenant/auth failure.

Exit criteria:

- The harness knows whether it can invoke a listed capability through BR.
- The DID route ambiguity is resolved.
- Capability discovery and invocation are tested as one seam.

## Phase 6: Product Platform Contract Smoke

Goal: prove the actuators speak the platform contract well enough for BR-mediated business operations.

Products in scope:

- BR
- MSP
- VM/HAI
- GTM
- backup
- security/Shield when available
- endpoint stub or agent harness

Read-only probes per product:

| Product Probe       | Endpoint                                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| health              | `GET /health`                                                                     |
| tool discovery      | `GET /api/v1/god-mode/tools`                                                      |
| tenant context      | `GET /api/v1/platform/tenants` or BR tenant context where canonical               |
| read-only execution | `POST /api/v1/god-mode/execute` with known read-only tool                         |
| simulate write      | `POST /api/v1/god-mode/execute` with `simulate: true` for ChangeSet-required tool |

Assertions:

- Product reports product slug and version.
- Tools have names, schemas, risk levels, and `requires_changeset`.
- Any high or critical tool requires ChangeSet.
- Simulate response returns preview and no mutation.
- Trace ids and evidence ids are returned where promised.
- Tenant scoping comes from auth context, not user input.

Exit criteria:

- Product readiness is no longer anecdotal. The harness can say exactly which actuators are callable, safe, stale, or missing.

## Phase 7: Business Workflow Smoke Scenarios

Goal: run realistic business-harness flows that make the vision visible.

Each scenario produces a `BusinessHarnessTrace`.

### Scenario A: Platform Posture Read

Intent:

```text
Show me the current operating posture for this tenant.
```

Steps:

1. `br_status`
2. `br_budget`
3. `br_models`
4. BR discovery
5. product registry read
6. product health reads
7. summarize products, budget, routing posture, degraded services, and available capabilities

Success:

- No writes.
- BR cost and request ids captured.
- Products and capabilities shown with source and freshness.

### Scenario B: Incident Investigation Read

Intent:

```text
Investigate high-severity alerts for this tenant in the last hour.
```

Steps:

1. BR routes the reasoning call.
2. Harness discovers relevant MSP/security capabilities.
3. Execute read-only alert/list capabilities.
4. Correlate product results.
5. Emit evidence/trace references.

Success:

- No writes.
- Every queried product is tenant-scoped.
- Missing security product degrades gracefully.

### Scenario C: Endpoint Remediation Simulation

Intent:

```text
Prepare to isolate device X, but do not execute until approved.
```

Steps:

1. Discover MSP endpoint capability.
2. Call simulate path.
3. Render ChangeSet preview.
4. Record blocked or pending approval state.

Success:

- No production mutation.
- ChangeSet preview includes before/after, cascades, constraints, and duration estimate.
- Trace records why execution stopped.

### Scenario D: Backup Drill Planning

Intent:

```text
Show backup schedules and simulate a restore drill for the riskiest one.
```

Steps:

1. Discover backup product.
2. List schedules.
3. Pick a safe sandbox or fixture schedule.
4. Simulate drill or run against sandbox only.
5. Capture evidence hash when available.

Success:

- Live production schedules are read-only unless sandbox gate is active.
- Drill write path is blocked by default.

### Scenario E: Endpoint Agent Stub Action

Intent:

```text
Verify an endpoint agent can receive a BR-mediated task and return evidence.
```

Steps:

1. Start local endpoint stub.
2. Register/discover capability.
3. Invoke through BR or local BR-compatible broker fixture.
4. Capture traceparent and evidence hash.

Success:

- Proves agent actuator shape without risking production.
- Demonstrates the business harness analogy to Claude Code tools.

Exit criteria:

- At least one scenario produces a redacted trace artifact that can be shown as the canonical demo.

## Phase 8: Chaos, Degradation, And Fail-Closed Tests

Goal: prove the harness is trustworthy when BR or a product is wrong, slow, down, stale, or drifting.

Chaos cases:

| Failure                                                         | Expected Harness Behavior                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| BR DNS/network failure                                          | Clear BR-unreachable error, no unhandled rejection.         |
| BR 401                                                          | Auth guidance, no retry storm.                              |
| BR 403                                                          | Scope/role explanation, no fallback to unsafe path.         |
| BR 429                                                          | Honor `Retry-After` when present.                           |
| BR 500/503                                                      | Degraded state, no writes.                                  |
| malformed JSON                                                  | Bounded error, no crash.                                    |
| unknown `x-br-*` header                                         | Drift test fails with exact header.                         |
| missing required envelope fields                                | Live smoke warns or fails depending on endpoint class.      |
| OpenAPI path removed                                            | Static contract failure.                                    |
| discovery omits native tool path                                | Static or live contract warning/failure.                    |
| VM registry stale                                               | Product marked stale, not invokable by default.             |
| listed capability invoke 404                                    | Registry/invocation seam failure, not generic tool failure. |
| 202 missing `status_url`                                        | Error with no blind polling.                                |
| idempotency 409                                                 | Report duplicate, do not regenerate action automatically.   |
| evidence hash missing on execution                              | Business trace marks evidence gap.                          |
| ChangeSet-required tool returns executable path without preview | Fail closed.                                                |

Existing tests to reuse:

- `packages/providers/src/__tests__/br-down-chaos.test.ts`
- `packages/providers/src/__tests__/br-envelope.test.ts`
- `packages/db/src/__tests__/concurrent-sessions-load.test.ts`
- `packages/cli/src/__tests__/a2a.test.ts`
- `packages/godmode/src/__tests__/mesh.test.ts`

Exit criteria:

- Reads degrade gracefully.
- Writes do not proceed when classification, auth, registry, ChangeSet, or evidence is ambiguous.

## Phase 9: CI, Commands, And Release Gates

Goal: make the suite easy to run and hard to bypass accidentally.

Proposed scripts:

```json
{
  "br:contract-map": "node scripts/br-business-contract-map.mjs",
  "test:br-contract": "npm run br:contract-map && npm run contract-check",
  "test:br-smoke": "npx tsx tests/business-harness/live-br-discovery.ts",
  "test:business-harness": "npx tsx tests/business-harness/run-business-smoke.ts"
}
```

CI shape:

| Workflow                  | Trigger             | Live? | Writes?        |
| ------------------------- | ------------------- | ----- | -------------- |
| Static BR contract        | PR                  | No    | No             |
| Mocked business harness   | PR                  | No    | No             |
| Live BR read-only smoke   | nightly and manual  | Yes   | No             |
| Sandbox business smoke    | manual              | Yes   | Sandbox only   |
| Production observer smoke | manual operator run | Yes   | Read-only only |

Gate policy:

- `npm run build` continues to run existing contract check.
- Static BR contract should be added to build only after the first matrix is stable.
- Once stable, promote the static BR route contract into the structural preflight as gate #17 (`br-route-contract`) so touched-route drift is caught on every CI run.
- Live smoke should not be required for every PR.
- Manual sandbox smoke can fail without blocking unrelated PRs, but failures should create a visible follow-up.

Exit criteria:

- One developer command for static confidence.
- One operator command for live read-only confidence.
- One sandbox command for full business-loop confidence.

## Phase 10: Documentation And Runbooks

Goal: make the contract understandable to future agents and humans.

Create or update:

- `docs/internal/br-business-harness-contract-matrix.md`
- `docs/runbooks/br-business-smoke-failure.md`
- `docs/runbooks/a2a-registry-invoke-mismatch.md`
- `docs/runbooks/br-contract-drift.md`
- `docs/brainstormrouter-integration.md`
- `.codex/business-harness-vision.md` only if the plan changes the durable vision

Docs must answer:

- What BR endpoints does the harness use?
- Which discovery surfaces are authoritative?
- Which endpoints are hardcoded and why?
- What is the capability registry source of truth today?
- What will be the source of truth in v0.5?
- How do we run live smoke safely?
- How do we interpret a failed business trace?
- Which failures block writes?

Exit criteria:

- A new agent can read the docs and know how to test the BR seam without guessing.

## Phase 11: Milestone Plan

### M0: Planning Artifact

Deliver:

- This plan.

### M1: Static Contract Matrix

Deliver:

- `scripts/br-business-contract-map.mjs`
- `docs/internal/br-business-harness-contract-matrix.md`
- JSON artifact output
- test coverage for path extraction and classification

Success:

- DID invoke route ambiguity is explicitly reported.
- Docs-code drift is explicitly reported.

### M2: Live BR Discovery Smoke

Deliver:

- `tests/business-harness/live-br-discovery.ts`
- redaction helpers
- gated command

Success:

- Read-only live BR status can be verified in one command.

### M3: Native Tool Contract Tests

Deliver:

- mocked BR tool tests
- gated live tool smoke

Success:

- All 8 native BR tools are tested through the tool layer.
- `br_memory_store` cannot silently become auto-approved.

### M4: Provider Envelope Business Trace

Deliver:

- provider live smoke captures a `BusinessHarnessTrace`
- routing audit persistence check where feasible

Success:

- A model call has request id, routed model, cost, and audit hash captured.

### M5: A2A Path Resolution

Deliver:

- static route contract test for CLI invoke path versus BR OpenAPI
- CLI fix to call `/v1/mesh/invoke-did/{target_did}` for DID targets
- protocol-doc update so `docs/a2a-protocol-v01.md` no longer teaches the stale hostname-shaped DID route

Success:

- A listed DID has one canonical BR invocation path.

### M6: Registry Read Smoke

Deliver:

- VM registry read smoke
- BR tenant/context smoke
- future hook for BR `system.registry.list`

Success:

- Harness reports capability source as `vm`, `br`, or `mixed`.

### M7: Safe A2A Invoke Smoke

Deliver:

- local endpoint-stub or sandbox target
- safe invoke flow with traceparent and idempotency

Success:

- Invocation and status polling are proven without production writes.

### M8: Product Platform Read-Only Smoke

Deliver:

- health/tools/read-only execution probes for MSP, VM, GTM, backup, BR, and available security product

Success:

- The harness can classify product actuator readiness.

### M9: Business Workflow Trace

Deliver:

- at least Scenario A and Scenario C
- redacted trace artifact

Success:

- The trace becomes the demo and the test fixture.

### M10: Chaos Suite

Deliver:

- mocked chaos cases for BR, registry, product, A2A, evidence, and ChangeSet failures

Success:

- Writes fail closed under every ambiguous condition.

### M11: CI Integration

Deliver:

- scripts
- PR static workflow
- nightly read-only workflow
- manual sandbox workflow

Success:

- Contract drift is visible before a release.

### M12: Ratification

Deliver:

- final autopsy report:
  - contract map
  - live smoke result
  - business trace
  - open gaps
  - recommended code fixes

Success:

- The next implementation goal can be set from evidence, not intuition.

## Autopsy Questions

The plan is not complete until it can answer these directly.

1. Which BR endpoint list is authoritative for the harness today: docs, OpenAPI, discovery, SDK, or code?
2. Which harness calls are hardcoded, and are they all documented in BR OpenAPI?
3. Which documented BR paths are stale?
4. Does the harness still call `/v1/mesh/invoke-did/{target_did}` for DID targets, and does BR still expose that route?
5. Is VM CP or BR the current source of truth for capability discovery?
6. What is the intended v0.5 source of truth?
7. Can the harness invoke a capability it just discovered?
8. Does traceparent survive from harness to BR to product and back?
9. Does an evidence hash survive the same trip?
10. Does cost attribution attach to the business action, not just the LLM call?
11. Which identity is used at each hop: API key, Keycloak JWT, service JWT, agent JWT, or mTLS?
12. Are writes blocked unless ChangeSet preview exists?
13. Are high-risk tools impossible to auto-approve by accident?
14. Does a BR outage prevent unsafe fallback behavior?
15. Does a product outage show as degraded actuator state rather than harness failure?
16. Can a future agent run the suite without knowing any of the backstory?

## Definition Of Perfect For This Seam

The BR seam is perfect enough for v0.5 work when:

- `brainstorm` has one command that proves live BR discovery, routing, memory, budget, and health.
- `brainstorm` has one command that proves the business action loop in sandbox.
- Every hardcoded BR path is in the contract matrix.
- Every native BR tool is tested through the actual tool layer.
- The DID invoke route is canonical and unambiguous.
- Capability discovery and invocation are tested together.
- BR routing metadata becomes local business-trace metadata.
- Cost is attributable to a business action.
- Evidence is linked to the same trace.
- Writes fail closed when ChangeSet, identity, capability risk, or evidence is ambiguous.
- Drift is a test failure, not a surprise in an operator session.

## Recommended First Implementation Slice

Start with the smallest slice that creates leverage:

1. Fix `packages/cli/src/commands/a2a.ts` so DID invocations use `/v1/mesh/invoke-did/{target_did}`.
2. Update `docs/a2a-protocol-v01.md` to name the same DID route.
3. Add or update the A2A route regression in `packages/cli/src/__tests__/a2a.test.ts`.
4. Add `scripts/br-business-contract-map.mjs`.
5. Add `docs/internal/br-business-harness-contract-matrix.md`.
6. Add `tests/business-harness/env.ts`, `redaction.ts`, and `trace-schema.ts`.
7. Add `tests/business-harness/live-br-discovery.ts`.
8. Add mocked tests for `br-intelligence.ts`.
9. Add package scripts for static map and live smoke.

Why this first:

- The only behavior mutation is the corrective A2A route change; the rest is visibility and regression coverage.
- It immediately exposes docs-code-BR drift.
- It directly targets the most important seam: the harness-to-BR contract.
- It gives future implementation work a reliable fact base.

## Long-Term Payoff

Once this suite exists, every future platform consolidation task can ask:

```text
Did this tighten or loosen the business harness loop?
```

The answer should be visible in one of three places:

- contract matrix
- live smoke result
- business harness trace

That is the path from "we think the platform is converging" to "we can prove the harness operates the platform."
