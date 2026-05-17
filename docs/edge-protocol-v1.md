# Brainstorm Edge Protocol v1

**Status:** Canonical (locked 2026-05-17)
**Sibling of:** [Platform Contract v1](./platform-contract-v1.md)
**Conformance fixtures:** [`brainstormvm/contract-tests/edge-protocol-v1/`](https://github.com/justinjilg/brainstormvm/tree/main/contract-tests/edge-protocol-v1)
**Reference implementations:**

- [`brainstormmsp/app/api/edge/`](https://github.com/justinjilg/brainstormmsp/tree/main/app/api/edge) (Python, production)
- [`brainstormvm/internal/api/edge/`](https://github.com/justinjilg/brainstormvm/tree/main/internal/api/edge) (Go, P1/Wk2 of rev-2 plan)

## Purpose

The Brainstorm Edge Protocol is the wire contract between **brainstorm-agent** (the universal edge daemon) and any **edge-serving control plane**:

- **brainstormMSP cloud** — for agents running on customer endpoints (Windows/macOS/Linux)
- **brainstormVM CP** — for agents running inside HAI agent-VMs

brainstorm-agent is one binary; the cloud it talks to is selected by its `CloudURL` config (or enrollment-token override). Both clouds MUST implement this protocol identically — drift is caught by the shared conformance fixture pack.

This protocol is **separate** from the [Platform Contract v1](./platform-contract-v1.md):

| Concern                                                            | Protocol                        |
| ------------------------------------------------------------------ | ------------------------------- |
| Cloud ↔ cloud god-mode tool execution (operator surface)           | Platform Contract v1            |
| Agent ↔ cloud enrollment / heartbeat / brain decisions / telemetry | **Edge Protocol v1 (this doc)** |
| Agent ↔ agent communication (mesh)                                 | A2A Protocol v0.1               |

## Endpoints

| Method | Path                                   | Purpose                                                                            |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST` | `/api/v1/edge/enroll`                  | Agent enrollment — exchange enrollment token for an `agent_id` + cloud config      |
| `POST` | `/api/v1/edge/heartbeat`               | Periodic status update; cloud responds with command notifications + policy version |
| `POST` | `/api/v1/edge/brain/decide`            | Agent asks cloud brain to pre-approve a proposed action                            |
| `POST` | `/api/v1/edge/brain/escalation`        | Risk-tier escalation evaluation                                                    |
| `POST` | `/api/v1/edge/brain/autonomous-action` | Agent reports outcome of an autonomous action for the brain learning loop          |
| `POST` | `/api/v1/edge/events`                  | Telemetry + evidence envelope ingestion                                            |
| `WS`   | `/ws/v1/edge/agent`                    | Bidirectional: cloud-pushed commands + agent-pushed telemetry                      |

## Authentication

Three layers, in tightening order:

1. **Bearer API key** (enrollment-issued, all subsequent requests) — opaque token in the `Authorization: Bearer <key>` header. Tenant-scoped.
2. **Per-request body signature** — `X-Agent-Signature` header carries an Ed25519 signature over the canonical JSON body. Optionally accompanied by `X-Agent-Signature-PQC` carrying an ML-DSA-65 signature for hybrid verification. **Heartbeat, brain/\*, and events MUST reject requests missing `X-Agent-Signature`.** Enrollment is exempt because the agent does not yet have a signing key.
3. **Platform certificate** (post-enrollment) — when the cloud issues a platform certificate via `requestCertificate`, the agent uses its mTLS path for high-risk endpoints. Optional in v1.

## Body shapes

### POST /api/v1/edge/enroll

**Request:**

```json
{
  "enrollment_token": "<base64-json>",
  "hostname": "hai-researcher-bvm-2",
  "os": "linux",
  "os_version": "6.6.12-amd64",
  "arch": "amd64",
  "agent_version": "1.1.0",
  "deployment_context": "hai-agent-vm",
  "capabilities": ["agent.research_topic"]
}
```

- `enrollment_token`: base64-encoded JSON with `client_id`, `msp_tenant_id`, `cloud_url`, `api_key`, optional `token_id` (DB-backed revocation lookup), optional `exp`. Embedded expiry is advisory; the cloud's DB record is canonical when present.
- `deployment_context`: optional in v1.0, REQUIRED when running inside an HAI agent-VM. Behavior selection MUST key off this field, not `cloud_url`.
- `capabilities`: optional. Names from the Agent Capability Registry — separate namespace from god-mode tools.

**Response (200 OK):**

```json
{
  "agent_id": "<uuid>",
  "client_id": "<uuid>",
  "msp_tenant_id": "<uuid>",
  "cloud_url": "<url>",
  "policy_version": "1.0.0",
  "command_signing_pubkey": "<base64-ed25519>",
  "command_signing_pubkey_pqc": "<base64-mldsa65>",
  "identity_envelope": {
    /* IdentityEnvelope.v1 — see shared schema */
  }
}
```

`command_signing_pubkey_pqc` and `identity_envelope` are OPTIONAL in v1.0; when present the agent uses them for hybrid command verification and as its signed identity attestation.

**Failure modes:**

| Status | Code           | When                                                                  |
| ------ | -------------- | --------------------------------------------------------------------- |
| 400    | `VALIDATION`   | Missing required fields, malformed JSON, unknown `deployment_context` |
| 401    | `UNAUTHORIZED` | Token invalid (parse failure, expired, revoked)                       |
| 409    | `CONFLICT`     | Hostname already enrolled for this tenant (cloud-specific policy)     |
| 500    | `INTERNAL`     | Cloud-side persistence failure                                        |

### POST /api/v1/edge/heartbeat

Signed via `X-Agent-Signature` over the request body.

**Request:**

```json
{
  "agent_id": "<uuid>",
  "status": "online",
  "autonomy_enabled": true,
  "tools_available": ["system.info", "process.list"],
  "pending_evidence_count": 0,
  "policy_version": "1.0.0",
  "agent_version": "1.1.0",
  "uptime_seconds": 3600
}
```

`status` ∈ `{online, offline, degraded, starting, shutting_down}`.

**Response (200 OK):**

```json
{
  "acknowledged": true,
  "server_time": "2026-05-17T18:00:00Z",
  "commands_pending": 0,
  "policy_version": "1.0.0",
  "policy_bundle": null,
  "kill_switch": false
}
```

If the agent's `policy_version` differs from the server's, the server MUST include the current `policy_version` (and MAY inline the bundle). On `kill_switch: true`, the agent MUST immediately disable autonomy and refuse pending commands.

### POST /api/v1/edge/brain/decide / brain/escalation / brain/autonomous-action

Documented in detail in the conformance fixtures (`fixtures/brain-decide/`, etc.). Common shape: signed body containing `agent_id`, `tenant_id`, `rule_id`, `risk_level`, plus the action-type-specific payload. Response: `{ approved, decision_id, confidence, reasoning, alternative_action?, similar_past_decisions? }`.

### POST /api/v1/edge/events

Signed; carries telemetry events. The most important variant is `event_type: "evidence_envelope"` — the agent uploads a sealed evidence envelope. The cloud verifies the agent signature, persists, and adds a cloud counter-signature.

### WS /ws/v1/edge/agent

Authenticated by the API key in the `Authorization` header at handshake. Sub-protocol: `brainstorm-edge.v1`.

After upgrade:

1. Agent sends initial frame: `{ type: "hello", agent_id, last_seen_command_id, agent_version }`.
2. Server replies: `{ type: "hello_ack", server_time, commands_to_replay }`.
3. Server replays any commands issued after `last_seen_command_id` (delivery-once-acked semantics).
4. Steady state: server pushes `{ type: "command", ... }` frames; agent acks each by `command_id`.

**Reconnect semantics:** the server MUST replay un-acked commands. Lost commands lead to silent drift — never tolerate.

## Retry + idempotency semantics

- 5xx responses are retryable with exponential backoff. The agent SHOULD include an `Idempotency-Key` header on retryable POSTs (events / brain/autonomous-action) so the server can dedupe.
- 401 / 403 / 409 / 400 are NOT retryable — fix the underlying issue first.
- Clock-skew tolerance for time-bound checks (token expiry, signature timestamps): ±5 minutes.

## Versioning

This is `edge-protocol-v1`. Bumps happen in lockstep across MSP + brainstormVM. New optional fields are MINOR additions; breaking changes get a new path (`/api/v2/edge/...`) and a new fixture-pack directory.

## Conformance enforcement

Both servers MUST run the [shared fixture pack](https://github.com/justinjilg/brainstormvm/tree/main/contract-tests/edge-protocol-v1) in CI:

- **Structural mode** (default, CI): fixtures parse, schemas validate, every endpoint covered.
- **Live mode** (`EDGE_TARGET_URL` set): fixtures dispatched at the target; response status + body checked against expected.

If a server fails any case, the protocol contract is broken. Fix the server or bump the protocol version — never quietly diverge.
