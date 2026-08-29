# Brainstorm Platform Contract Specification v1 — Orchestrator Variant

## Purpose

This is the canonical specification for **orchestrator products** in the Brainstorm ecosystem — products whose primary surface is workflows + step transitions, not discrete tools. Sibling spec to [`platform-contract-v1.md`](./platform-contract-v1.md) (the tool-product contract); both compose into the same harness.

**Audience**: Engineers building products like BrainstormGTM that don't fit the "tool registry + execute" model — products whose value is multi-step async orchestration, not atomic invocations.

**Languages**: HTTP + JSON, same as the tool contract. MCP JSON-RPC over stdio is accepted per `platform-contract-v1.md` §9.

**Validator**: `brainstorm platform verify <url> --variant=orchestrator` tests compliance.

---

## 1. When to use this contract

Use the orchestrator variant when your product:

- Runs **workflows** (multi-step, often long-running, frequently async)
- Has **state** that lives across invocations (e.g. campaign progress, attribution pipelines, training runs)
- Triggers via **events / schedules / external signals**, not just direct operator action
- Aggregates **outcomes** rather than returning data per call

Examples:

- **BrainstormGTM** — 70 agents running campaigns, lead scoring, attribution
- A hypothetical "Forensic Workflow" product that chains MSP+VM+Shield steps
- A scheduled compliance auditor product

Use the tool contract (`platform-contract-v1.md`) when your product is request-response, stateless-per-call, and operator-initiated.

Some products will implement **both** contracts (rare but allowed) — a hybrid that exposes atomic tools AND multi-step workflows. In that case, both endpoint sets must be present and discoverable via §5/§6.

---

## 2. Authentication

Identical to `platform-contract-v1.md` §1. Bearer token, JWT with `platform_tenant_id`, tenant scoping mandatory.

---

## 3. Health Endpoint

Identical to `platform-contract-v1.md` §2.

```
GET /health
→ 200
{
  "status": "healthy" | "degraded" | "unhealthy",
  "version": "0.7.0",
  "product": "gtm",
  "active_workflow_runs": 12,
  "checks": { "queue": "ok", "db": "ok" }
}
```

The `active_workflow_runs` field is orchestrator-specific (additive, optional).

---

## 4. Workflow Discovery

```
GET /api/v1/orchestrator/workflows
Authorization: Bearer <token>
→ 200
{
  "product": "gtm",
  "version": "0.7.0",
  "workflow_count": 8,
  "workflows": [ <WorkflowDefinition>, ... ]
}
```

### Workflow Definition

```json
{
  "id": "gtm.campaign.launch",
  "name": "Launch GTM Campaign",
  "domain": "campaigns",
  "product": "gtm",
  "description": "Multi-step workflow that prepares a campaign, validates targeting, gets approval, and launches across channels.",
  "inputs": {
    "type": "object",
    "properties": {
      "campaign_id": { "type": "string" },
      "channels": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["campaign_id"]
  },
  "outputs": {
    "type": "object",
    "properties": {
      "launched_at": { "type": "string", "format": "date-time" },
      "channel_results": { "type": "object" }
    }
  },
  "steps": [ <StepDefinition>, ... ],
  "triggers": ["manual", "event:gtm.campaign.scheduled", "schedule:cron"],
  "estimated_duration_seconds": 300,
  "risk_level": "medium",
  "requires_changeset": true
}
```

| Field                      | Type             | Required | Description                                                               |
| -------------------------- | ---------------- | -------- | ------------------------------------------------------------------------- |
| id                         | string           | Yes      | `{product}.{noun}.{verb}` — globally unique                               |
| name                       | string           | Yes      | Human-readable                                                            |
| domain                     | string           | Yes      | Capability domain (from `platform-contract-v1.md` §3 Domain Registry)     |
| product                    | string           | Yes      | Must match response `product` field                                       |
| description                | string           | Yes      | Operator-facing summary                                                   |
| inputs                     | JSONSchema       | Yes      | Workflow input schema                                                     |
| outputs                    | JSONSchema       | No       | Workflow output schema (when defined)                                     |
| steps                      | StepDefinition[] | Yes      | Ordered list of steps                                                     |
| triggers                   | string[]         | Yes      | What can start this workflow: `manual`, `event:<type>`, `schedule:<cron>` |
| estimated_duration_seconds | number           | No       | Rough wall-clock estimate                                                 |
| risk_level                 | enum             | Yes      | `read_only \| low \| medium \| high \| critical`                          |
| requires_changeset         | boolean          | Yes      | If true, START requires ChangeSet approval                                |

### Step Definition

```json
{
  "id": "validate_targeting",
  "name": "Validate audience targeting",
  "type": "tool" | "transform" | "wait" | "approval" | "branch",
  "tool_ref": "msp.list_audiences",   // for type="tool"
  "input_map": { "audience_id": "$.inputs.campaign_id" },
  "output_path": "$.steps.validate_targeting.result",
  "on_failure": "abort" | "continue" | "retry:3",
  "timeout_seconds": 30
}
```

Step types:

- **`tool`**: invoke a god-mode tool from any product (the orchestrator becomes a client of the tool contract)
- **`transform`**: pure-function step over prior outputs (no side effects)
- **`wait`**: pause for an external signal, time, or event
- **`approval`**: pause for a human approval — implemented via ChangeSet flow (§7 below)
- **`branch`**: conditional fork over prior outputs

JSONPath references (`$.inputs.foo`, `$.steps.bar.result`) wire data between steps.

---

## 5. Workflow Execution

### 5.1 Start a workflow

```
POST /api/v1/orchestrator/workflows/{workflow_id}/start
Authorization: Bearer <token>
Content-Type: application/json

{
  "inputs": { "campaign_id": "camp_abc", "channels": ["email", "linkedin"] },
  "correlation_id": "uuid",
  "idempotency_key": "uuid"
}
```

### Success response

```json
{
  "success": true,
  "workflow_id": "gtm.campaign.launch",
  "run_id": "run_xyz123",
  "status": "running" | "pending_approval",
  "started_at": "2026-05-21T03:42:00Z",
  "estimated_completion": "2026-05-21T03:47:00Z",
  "trace_id": "srv-203"
}
```

### ChangeSet flow (when requires_changeset=true OR a step is type="approval")

Identical to `platform-contract-v1.md` §4 simulation response shape. The orchestrator returns a ChangeSet shape with the proposed workflow run as the "change", and the brainstorm desktop renderer presents it to the operator for approval before the workflow actually starts.

### 5.2 Query run state

```
GET /api/v1/orchestrator/runs/{run_id}
→ 200
{
  "run_id": "run_xyz123",
  "workflow_id": "gtm.campaign.launch",
  "tenant_id": "acme",
  "status": "running" | "completed" | "failed" | "cancelled" | "pending_approval",
  "started_at": "...",
  "completed_at": null,
  "inputs": { ... },
  "outputs": { ... },
  "step_states": [
    {
      "step_id": "validate_targeting",
      "status": "completed",
      "started_at": "...",
      "completed_at": "...",
      "output": { ... }
    },
    ...
  ],
  "correlation_id": "uuid",
  "trace_id": "srv-203"
}
```

### 5.3 List runs (filterable)

```
GET /api/v1/orchestrator/runs?workflow_id=...&status=running&since=...
→ 200
{ "runs": [ <RunSummary>, ... ], "cursor": "..." }
```

### 5.4 Cancel a run

```
POST /api/v1/orchestrator/runs/{run_id}/cancel
→ { "success": true, "run_id": "...", "status": "cancelled" }
```

---

## 6. Federation Events

Orchestrator products publish workflow lifecycle events to the `brainstorm.events` EventBridge bus (see BrainstormOps `terraform/modules/eventbridge-bus`).

Event types:

| DetailType                | When                                         |
| ------------------------- | -------------------------------------------- |
| `workflow.run.started`    | After successful start                       |
| `workflow.step.entered`   | Each step begins                             |
| `workflow.step.completed` | Each step finishes                           |
| `workflow.step.failed`    | Each step fails (whether retried or aborted) |
| `workflow.run.completed`  | Whole run succeeded                          |
| `workflow.run.failed`     | Whole run failed                             |
| `workflow.run.cancelled`  | Run cancelled via §5.4                       |

Detail envelope (matches the bus's `brainstorm.events.envelope` schema):

```json
{
  "tenant_id": "acme",
  "ts": 1716220800000,
  "payload": {
    "product": "gtm",
    "workflow_id": "gtm.campaign.launch",
    "run_id": "run_xyz123",
    "step_id": "validate_targeting",  // only on step.* events
    "status": "completed",
    "result": { ... },
    "error": "..."  // only on failed events
  },
  "correlation_id": "uuid",
  "trace_id": "srv-203"
}
```

Schemas for these events go in the BrainstormOps `eventbridge-bus` module — opening as a follow-up PR (1.7.1) to add `brainstorm.events.workflow.*` schemas to the registry.

---

## 7. Self + Discovery

Identical to `platform-contract-v1.md` §5.5 (Self) and §5.6 (Discovery), except `/api/v1/self` should report:

```json
{
  "product": "gtm",
  "version": "0.7.0",
  "variant": "orchestrator", // <-- distinguishing field
  "capabilities": ["campaigns", "lead-management", "analytics"],
  "schema_version": 1
}
```

And `/api/v1/discovery` should publish:

```json
{
  "workflows_url": "/api/v1/orchestrator/workflows",
  "runs_url": "/api/v1/orchestrator/runs",
  "self_url": "/api/v1/self",
  "events_url": "/api/v1/platform/events",
  "openapi_url": "/api/v1/openapi.json"
}
```

Note `workflows_url` and `runs_url` replace the tool contract's `tools_url`.

---

## 8. Product Manifest

The repo-root `product-manifest.yaml` adds an orchestrator section:

```yaml
product:
  id: "gtm"
  name: "BrainstormGTM"
  version: "0.7.0"
  variant: "orchestrator" # <-- distinguishing field
security:
  api_base: "https://gtm.brainstorm.example.com"
  health: "/health"
  auth:
    human: "keycloak-oidc"
    machine: "api-key"
    tenant_claim: "platform_tenant_id"
capabilities:
  - domain: "campaigns"
  - domain: "lead-management"
workflows:
  count: 8
  endpoint: "/api/v1/orchestrator/workflows"
events:
  publishes:
    - type: "gtm.workflow.run.started"
      schema_version: 1
    - type: "gtm.workflow.step.completed"
      schema_version: 1
  subscribes:
    - "platform.tenant.created"
    - "msp.alert.created" # GTM may react to MSP alerts
```

---

## 9. Implementation Checklist

```
□ workflows/ module with WorkflowDefinition + StepDefinition types
□ Routes:
    GET  /api/v1/orchestrator/workflows
    POST /api/v1/orchestrator/workflows/{id}/start
    GET  /api/v1/orchestrator/runs
    GET  /api/v1/orchestrator/runs/{run_id}
    POST /api/v1/orchestrator/runs/{run_id}/cancel
    GET  /api/v1/self  (with variant="orchestrator")
    GET  /api/v1/discovery
    GET  /health
□ Run state persistence (DB or durable queue)
□ EventBridge publisher wired for workflow lifecycle events
□ ChangeSet flow for workflows where requires_changeset=true
□ Rate limiting: 30 starts/min per tenant (lower than tool contract — workflows are heavier)
□ All queries scoped to platform_tenant_id
□ product-manifest.yaml updated with variant + workflows section
□ Verify: brainstorm platform verify <url> --variant=orchestrator
```

400-600 lines per system. 1-2 days (more than tool-contract products because workflow state + lifecycle eventing add complexity).

---

## 10. Why this sibling spec exists

The audit at `docs/business-harness/contract-gap-inventory-2026-05.md` flagged GTM as 0% compliant against `platform-contract-v1.md` — but the audit's recommendation was Option B: don't force tool framing on a workflow engine; author a sibling contract that honors the architectural difference.

This is that sibling. GTM (and future orchestrator-class products) become operable from brainstorm desktop via the workflows surface, alongside the tools surface, with the same auth + tenant + federation guarantees.

---

## 11. Brainstorm desktop integration

When a product reports `variant: "orchestrator"` from `/api/v1/self`, brainstorm desktop renders an additional pane in that product's workspace:

- **Workflows** tab: lists workflow definitions, lets operators trigger start (gated by ChangeSet if requires_changeset)
- **Runs** tab: real-time view of in-flight workflow runs, with step-level progress

For products that implement BOTH contracts (e.g., a future hybrid), both panes render. For tool-only products (MSP, BR), only the Tools pane renders.

The renderer treats the two contracts as composition, not branching — the same workspace shell, different inner content based on what `/api/v1/self` advertises.

---

## 12. Relation to the federation bus

Workflow lifecycle events on the bus (`workflow.run.started` etc.) compose with ChangeSet lifecycle events (`changeset.executed` etc.) in the operator's unified timeline. A workflow that includes a ChangeSet-gated step will publish both kinds of events — first `workflow.step.entered`, then `changeset.proposed/simulated/approved/executed`, then `workflow.step.completed`. The `correlation_id` ties them together.

This is by design: orchestrator products are clients of the tool contract internally (their `type: "tool"` steps call other products' god-mode tools), so they generate events from both sides.
