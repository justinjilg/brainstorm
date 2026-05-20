# Brainstorm A2A Protocol v0.1

**Status:** Canonical draft (locked 2026-05-17)
**Sibling of:** [Platform Contract v1](./platform-contract-v1.md), [Edge Protocol v1](./edge-protocol-v1.md)
**Conformance fixtures:** TBD (companion `brainstormvm/contract-tests/a2a-protocol-v01/` lands with the reference implementation)
**Reference implementation:** BrainstormRouter mesh-auth Phase 2 (`brainstorm/packages/godmode/src/mesh-invoke.ts`, P2/Wk5 of rev-2 plan)

## Purpose

A2A is the wire contract between **agents** that need to invoke capabilities on other agents. It sits one layer above Edge Protocol v1:

- **Edge Protocol v1**: agent ↔ cloud control plane (enroll, heartbeat, brain, telemetry)
- **A2A Protocol v0.1** (this doc): agent ↔ agent (workload capability invocation, evidence chain linkage)
- **Platform Contract v1**: cloud-to-cloud god-mode tools (operator-driven admin)

Participants:

- Any agent that runs brainstorm-agent in either deployment context (`msp-endpoint` or `hai-agent-vm`)
- brainstorm-gtm cloud agents (the 70-agent GTM system already has a MeshClient blocked on Phase 2 mesh-auth — this spec unblocks it)
- Future agent-bearing products (peer10 once it has workload agents, etc.)

A2A is brokered: agents do NOT establish direct peer connections in v0.1. Every invocation goes through **BrainstormRouter mesh-auth**, which authenticates the caller, replays-protects the request, and routes to the target agent's registered handler. The broker is also the single source of truth for trace propagation.

## Wire shape

### POST /v1/mesh/invoke-did/{target_did}

`target_did` is URL-encoded; format is the lineage DID per [project_lineage_identity_model](./..).

**Required headers:**

- `Authorization: Bearer <per-agent JWT>` — issued via existing `POST /v1/agent/bootstrap`. Carries the calling agent's lineage DID, tenant scope, and the capabilities it's authorized to invoke.
- `traceparent: <W3C Trace Context>` — REQUIRED. Format: `00-<32-hex-trace-id>-<16-hex-span-id>-<2-hex-flags>`. Receiver echoes in response + propagates to downstream evidence + ChangeSet records.
- `tracestate: <vendor=value,...>` — OPTIONAL. Vendor-specific trace metadata; brainstorm uses `bvm=<key=value,...>` for ecosystem-internal fields (lineage ancestry, autonomy tier).
- `Idempotency-Key: <uuid>` — REQUIRED. Distributed replay store keyed on this; duplicate keys within 10 minutes return `409 CONFLICT` with the original `task_id`.
- `Content-Type: application/json`

**Request body:**

```json
{
  "task_id": "<uuid>",
  "capability": "agent.summarize_text",
  "input": {
    /* schema-bound payload */
  },
  "deadline_iso": "2026-05-17T18:30:00Z"
}
```

- `task_id`: caller-generated UUID. Used in async responses (see below); MUST be unique per logical task.
- `capability`: name from the Agent Capability Registry (`agent.<verb>_<noun>`). MUST match an active registration for `target_did`; the router resolves via `agentcapability.Registry.Get(target_did, capability)`. Unknown / deprecated / removed → `404 NOT_FOUND`.
- `input`: validated against the registered capability's `input_schema` (JSON Schema). Validation failure → `400 VALIDATION`.
- `deadline_iso`: caller's deadline. Receivers SHOULD reject if they cannot meet it; the router enforces a 5-second clock-skew tolerance.

### Response — synchronous (200 OK)

When the target completes within ~30 seconds, the broker streams the response synchronously:

```json
{
  "task_id": "<uuid>",
  "output": {
    /* schema-bound payload */
  },
  "evidence_envelope_hash": "<sha256-hex>",
  "completed_at": "2026-05-17T18:00:42Z",
  "traceparent": "<downstream traceparent: same trace_id, new span_id>"
}
```

- `evidence_envelope_hash`: SHA-256 of the evidence envelope the target sealed for this task. Lets the caller link the response to a tamper-evident record via `brainstorm evidence verify --hash <hash>`.
- `output`: validated against the capability's `output_schema`.
- `traceparent`: carries the **downstream traceparent** the broker assigned for this hop (per the trace-propagation rules below) — same trace_id as the request, NEW span_id. Callers correlate via trace_id.

### Response — async (202 Accepted)

For long-running invocations, the broker returns 202 immediately:

```json
{
  "task_id": "<uuid>",
  "status_url": "/v1/mesh/task/<task_id>",
  "traceparent": "<downstream traceparent: same trace_id, new span_id>"
}
```

Callers `GET status_url` until it returns the synchronous 200 shape above (target completed) or 410 GONE (task expired without completion).

### Failure modes

| HTTP | Code           | When                                                                                                       |
| ---- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION`   | input fails capability `input_schema`; malformed body; bad headers                                         |
| 401  | `UNAUTHORIZED` | missing/invalid JWT; JWT signature fails; agent_id claim doesn't match a known agent                       |
| 403  | `FORBIDDEN`    | caller's JWT capabilities[] doesn't include the target capability; tenant mismatch between caller + target |
| 404  | `NOT_FOUND`    | `target_did` has no active capability registered with the given name                                       |
| 409  | `CONFLICT`     | `Idempotency-Key` was seen within freshness window; response body returns original `task_id`               |
| 410  | `GONE`         | async task expired (default 30-min cap) without completion                                                 |
| 422  | `INVARIANT`    | request semantically valid but target rejects (e.g. resource exhausted, autonomy tier mismatch)            |
| 429  | `RATE_LIMITED` | caller exceeded per-agent quota; `Retry-After` header set                                                  |
| 500  | `INTERNAL`     | broker-side persistence/routing failure                                                                    |
| 503  | `UNAVAILABLE`  | target reachable but not currently serving (cold start, deploying)                                         |

All non-2xx responses carry the canonical Platform Contract v1 error envelope:

```json
{
  "success": false,
  "error": {
    "code": "<error code from table above>",
    "message": "<human-readable detail>"
  }
}
```

Some codes carry additional fields (e.g. `409 CONFLICT` includes the original `task_id` at the top level; `429 RATE_LIMITED` MUST include a `Retry-After` HTTP header). Callers MUST route on `error.code`; unknown top-level fields are informational.

## Authentication: per-agent JWT

Issued via `POST /v1/agent/bootstrap` (existing API, predates this spec). Claims include:

- `sub`: caller's lineage DID
- `tenant_id`: caller's tenant scope
- `capabilities`: array of capability names the caller is authorized to invoke
- `iat` / `exp`: standard timing
- `key_id`: identifies the BrainstormRouter signing key used (rotation support)

The JWT signature uses the BR signing key set; verifiers MUST consult `key_id` to pick the right pubkey (cached, rotated independently of agent enrollment).

**Tenant isolation:** the broker rejects any invocation where caller `tenant_id` != target's owning tenant unless an explicit cross-tenant capability grant exists (v0.1: no such grant mechanism — strict same-tenant).

## Replay protection: distributed

`Idempotency-Key` is checked against a **distributed TTL store** (Upstash Redis in production; Redis-compatible in dev). This was the single most important hardening called out by the multi-model plan review: an in-memory LRU is unsafe on multi-instance BrainstormRouter (ECS) — a replay can route to a different task whose memory has never seen the key.

Semantics:

- `SET seen:{idempotency_key} <task_id> EX 600 NX`
- On `NX` succeeds: first time, accept request, dispatch to target
- On `NX` fails: duplicate, return `409 CONFLICT` using the canonical Platform Contract v1 error envelope, with the original `task_id` included for replay-safe client recovery:

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "duplicate Idempotency-Key"
  },
  "task_id": "<original task_id from first acceptance>"
}
```

The `task_id` field at the top level (alongside the canonical `error`) is an A2A-specific extension — callers MUST treat any unknown top-level field as informational and route only on `error.code`.

- Freshness window: 10 minutes (configurable via BR env)

## Trace propagation

A2A is the layer where multi-hop tracing matters most — a single user intent may trigger researcher → writer → reviewer chains. We adopt **W3C Trace Context** (the same spec OpenTelemetry uses) so propagation is interoperable with existing observability tooling out of the box.

Receiver behavior:

1. Read `traceparent` from incoming request
2. Generate a NEW span ID for local work, keeping the trace ID
3. Echo the **updated** `traceparent` (same trace_id, new span_id) in synchronous responses
4. Stamp `traceparent` onto every evidence envelope sealed during the invocation
5. Stamp `traceparent` onto every ChangeSet generated during the invocation
6. Forward `traceparent` (with another new span_id) on any A2A invocations the receiver makes

This makes `brainstorm trace <traceparent>` a real query across all 4 layers (Edge / A2A / Evidence / ChangeSet).

## Capability resolution

Capabilities live in the **Agent Capability Registry** (`internal/agentcapability/registry.go` in brainstormVM, sibling Postgres table in brainstormMSP). The broker resolves:

```
agentcapability.Registry.Get(target_did, capability_name)
```

If the result is `(zero, false)` OR `status != "active"` → `404 NOT_FOUND`. The registry is the SOURCE OF TRUTH for what a target can do; the broker does NOT consult god-mode tools list (those are admin operations, different namespace).

**For unbound resolution** — when a caller wants any agent offering a capability — use the upcoming `POST /v1/mesh/resolve/{capability}` endpoint (lands in P2/Wk6). It returns ranked DIDs; caller picks one and invokes.

## Async semantics (202 + status_url)

Receivers that can't complete within ~30s SHOULD return 202 with a `status_url`. The broker tracks task state:

- `accepted` → `running` → `completed` | `failed` | `expired`
- Default expiry: 30 minutes from accept
- `GET status_url` returns the current state; on `completed`, body matches the synchronous 200 shape
- `cancel` semantics (POST status_url with `{"action": "cancel"}`) deferred to v0.2

## Per-agent budget

Today BR enforces budget at the **key** level, not the agent level. v0.1 workaround: provision **one BR API key per agent VM** so key-scoped budgets become effective per-agent budgets. The completions endpoint already enforces 402 BUDGET_EXCEEDED at the key level.

v0.2: when the completions endpoint gains per-agent budget enforcement, this workaround retires.

## Out of scope for v0.1

- Direct (non-brokered) A2A — every invocation goes through the BR broker in v0.1
- Cross-tenant invocation — strict same-tenant in v0.1
- Capability ranking (which DID to pick when many offer the same capability) — caller picks in v0.1; ranking comes with `/v1/mesh/resolve` in P2/Wk6
- Pub/sub event delivery — A2A is request/response in v0.1
- Streaming responses — async via 202+status_url; true streaming is v0.2
- WebSocket transport — HTTP only in v0.1
- Cancellation of in-flight tasks — v0.2

## Versioning

This is `a2a-protocol-v0.1`. Bumping a minor (additive optional fields) keeps the path stable. Breaking changes get a new path (`/v1/mesh/invoke-did/v2/{target_did}`) and a new fixture pack.

## Conformance enforcement

The companion fixture pack at `brainstormvm/contract-tests/a2a-protocol-v01/` lands with the reference implementation in P2/Wk5. Same structural-mode (parse + schema) and live-mode (`A2A_TARGET_URL` set → dispatch) treatment as Edge Protocol fixtures.

BR mesh-auth runs the harness in CI on every change to `packages/godmode/src/mesh-invoke.ts`. Any divergence between this doc and the running broker is a CI failure, not a runtime surprise.

## Reference: brainstorm-gtm MeshClient

`brainstorm-gtm/agents/_shared/mesh_client.py` is the existing client-side implementation that has been blocked on Phase 2 mesh-auth shipping. Once BR serves `/v1/mesh/invoke-did/{target_did}` per this spec, gtm's 70 agents are unblocked — this is the single biggest ecosystem win in the rev-2 plan.

The Go client side lands as `brainstormvm/pkg/a2a/` in P2/Wk6 (#67); it mirrors gtm's MeshClient interface so cross-language wire compatibility is built in.
