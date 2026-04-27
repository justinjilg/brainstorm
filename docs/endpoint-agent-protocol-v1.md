# Brainstorm Endpoint Agent Protocol v1

**Status:** DRAFT v3 (post-crd4sdom-cross-review) — 2026-04-26
**Scope:** Wire protocol for Brainstorm endpoint agent dispatch (Operator ↔ Relay ↔ Endpoint ↔ Sandbox)
**Spec freeze gate:** orchestrator draft → Codex adversarial review (v1→v2) → crd4sdom cross-review (v2→v3) → 0bz7aztr cross-review tomorrow → re-Codex on v3 → mark FROZEN

**Revision history:**

- **v1 → v2** addressed 20 Codex findings (6 blocking + 13 important + 1 nit). See §16.
- **v2 → v3** (this version) addresses 8 cross-review findings from crd4sdom: ACK message structural gap (Q4-main), NFC ordering ambiguity (Q1), chunk_data base64-vs-bytes hashing (Q2-hash), length-prefix size pinning (Q2-prefix), GuestQuery message type for integrity monitor (TM-Touchpoint-2), common vmm_api_state vocabulary (TM-Touchpoint-1), persistent-nonce-store implementation cost honestly disclosed (Q3), `delegating_principal_id` chain semantics verification (Q4-secondary). Plan v3.2 estimate bumps reflect Q3.
- **v3 + Codex re-verification** (post-application of crd4sdom findings): 5 important + 1 nit findings, no new blocking. Fixes applied: ACK timer relay-observable (V3-ACK-01), CommandAck full JSON Schema (V3-ACK-02), GuestQuery `query_id` UUIDv4 + uniqueness (V3-GQ-01), GuestResponse per-kind result schemas + timeout consequence (V3-GQ-02), vmm_api_state lowercase examples (V3-VMM-01), changelog count reconciliation (V3-MAP-01).

---

## 1. Overview

This document specifies the wire protocol for the Brainstorm endpoint-agent dispatch system. Three independent transports compose the system:

| Transport              | Endpoints                               | Format                                                               |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| **Operator ↔ Relay**   | brainstorm CLI / SDK ↔ brainstorm-relay | WebSocket text frames, JSON                                          |
| **Relay ↔ Endpoint**   | brainstorm-relay ↔ brainstorm-agent     | **WebSocket text frames, JSON only** (no binary frames; see F18 fix) |
| **Endpoint ↔ Sandbox** | brainstorm-agent ↔ microVM (CHV or VF)  | vsock, length-prefixed binary frames with bounded size               |

All three carry the same logical primitive: dispatch a tool, get a result. Wire shapes differ because trust models differ.

### Design principles (from plan v3.1)

1. **Anti-contamination via structural audit wrapper** — operator-payload bytes kept verbatim; relay metadata in sidecar; channel-of-origin enforced at the AuditLogEntry layer (§8) not at wire-layer.
2. **Per-envelope signing with domain separation** — every Relay→Endpoint envelope is independently Ed25519-signed using a domain-prefixed canonical form (§3.3).
3. **Audience-bound envelopes** — every CommandEnvelope includes signed `target_endpoint_id`. Endpoints reject envelopes not addressed to them.
4. **End-to-end correlation** — `command_id` minted at relay, threaded through every component, echoed by endpoint and sandbox.
5. **7-state lifecycle vocabulary** — `pending | dispatched | started | progress | completed | failed | timed_out`. With explicit reject-before-start transitions (§7).
6. **Discriminated-union types** — `auth_proof` and other variant fields use explicit `kind` discriminators with `additionalProperties: false`.
7. **Identifier normalization** — all string identifiers (tool names, operator IDs, etc.) MUST be NFC-normalized before signing or storing (§12).

---

## 2. Connection Model

### Operator → Relay

- **Transport:** WebSocket over TLS (`wss://`)
- **Endpoint:** `wss://<relay-host>/v1/operator`
- **Frame format:** WebSocket TEXT frames only (opcode 0x1). JSON messages.
- **Authentication:** initial frame `OperatorHello` (§4.0) carries `auth_proof`. Relay validates before accepting subsequent frames.
- **Connection lifetime:** per-dispatch (open, dispatch, stream result, close) OR persistent (open, multi-dispatch). CLI: per-dispatch by default; SDK: persistent for streaming agents.
- **Keepalive:** WebSocket Ping/Pong every 30s (RFC 6455 control frames). 60s without Pong → connection considered dead.

### Relay → Endpoint

- **Transport:** WebSocket over TLS (`wss://`)
- **Direction:** endpoint initiates. No listening ports on endpoint.
- **Endpoint:** `wss://<relay-host>/v1/endpoint/connect`
- **Frame format:** WebSocket TEXT frames only (opcode 0x1). JSON messages. **No binary frames.**
- **Authentication:** endpoint presents `endpoint_id` + Ed25519-signed connection proof during WS upgrade (§3.1).
- **Connection lifetime:** persistent. Endpoint reconnects with exponential backoff (1s, 2s, 4s, 8s, 16s, 32s, 60s max) on drop.
- **Session model (NEW v2 — F12 fix):** every successful connection establishes a `session_id` (UUID, relay-issued). Endpoint includes `session_id` in every frame it sends. Relay rejects frames whose `session_id` doesn't match the current connection's session. Stale-session results (e.g., from before reconnect) are rejected with `SESSION_STALE`.
- **Keepalive:** WebSocket Ping/Pong every 30s. 60s without Pong → endpoint reconnects.

### Endpoint → Sandbox

- **Transport:** vsock (Linux) or VF vsock equivalent (macOS)
- **Endpoint:** vsock CID = sandbox VM, port 9000
- **Authentication:** N/A — vsock is intra-host
- **Connection lifetime:** persistent for sandbox VM lifetime (between resets)
- **Frame format (NEW v2 — F9 fix; v3 length-prefix size pinned per crd4sdom Q2):**
  - **uint32 big-endian** unsigned length prefix (4 bytes; max value `MAX_VSOCK_FRAME_SIZE = 16 MiB`; chosen because 16 MiB fits cleanly in uint32 and is sufficient for all expected payloads)
  - Followed by exactly `length` bytes of UTF-8 JSON payload
  - Reader behavior: read length prefix in one call; if `length > MAX_VSOCK_FRAME_SIZE` → close vsock with `FRAME_TOO_LARGE`; allocate buffer of exact size; read body in loop until full OR `PARTIAL_FRAME_TIMEOUT = 30s` since last byte → close with `FRAME_MALFORMED`
  - Writer behavior: write length prefix + body atomically (single `write()` if possible; OK to retry on `EINTR`)
  - On EOF mid-frame: close with `FRAME_MALFORMED`; do NOT attempt to recover

---

## 3. Identity & Authentication

### 3.1 Endpoint enrollment

```
┌──────────┐                              ┌─────────┐                 ┌─────────────┐
│ operator │                              │  relay  │                 │  endpoint   │
└─────┬────┘                              └────┬────┘                 └──────┬──────┘
      │  POST /v1/admin/endpoint/enroll        │                             │
      │  (admin auth, returns bootstrap_token) │                             │
      │ ───────────────────────────────────────►                             │
      │                                        │                             │
      │  bootstrap_token (24h TTL,             │                             │
      │  scoped to tenant_id, endpoint_id)     │                             │
      │ ◄──────────────────────────────────────┤                             │
      │                                        │                             │
      │  (out-of-band, ships token to host)    │                             │
      │ ─────────────────────────────────────────────────────────────────────►│
      │                                        │                             │
      │                                        │  POST /v1/endpoint/enroll   │
      │                                        │  Authorization: Bearer <bt> │
      │                                        │  body: {public_key, os,     │
      │                                        │         arch, agent_version}│
      │                                        │ ◄───────────────────────────┤
      │                                        │                             │
      │                                        │  endpoint registered;       │
      │                                        │  bootstrap_token consumed   │
      │                                        │  (atomic INSERT/CONSUMED;   │
      │                                        │   second use → 409 CONFLICT)│
      │                                        │ ────────────────────────────►│
```

**Enrollment method (F6 fix):** `POST /v1/endpoint/enroll`. The earlier draft had a `GET` reference in the diagram which was an error.

**Bootstrap token format:**

```typescript
{
  bootstrap_token: string; // opaque, 32 bytes random base64url-encoded
  tenant_id: string; // UUID
  endpoint_id: string; // UUID, generated by relay
  issued_at: string; // ISO8601
  expires_at: string; // issued_at + 24h
  signature: string; // base64 Ed25519 over canonical(tenant_id, endpoint_id, issued_at, expires_at, bootstrap_token)
}
```

**Token consumption atomicity (F6 fix):** relay records token in `bootstrap_tokens` table with status `issued`. On `POST /v1/endpoint/enroll`, relay performs atomic compare-and-set: WHERE token = X AND status = 'issued' → UPDATE to 'consumed'. If 0 rows updated → 409 CONFLICT (already consumed) or 410 GONE (expired).

**Re-enrollment for lost keys (F6 fix):**

- Operator calls `POST /v1/admin/endpoint/<endpoint_id>/rotate`
- Relay marks current public_key as `revoked`, issues new bootstrap_token scoped to same `endpoint_id` + `tenant_id` (this is the only flow that can re-issue for an existing endpoint_id)
- Endpoint receives new bootstrap_token out-of-band, re-enrolls with new keypair
- Old key revocation is permanent; revoked keys never re-accepted
- Audit entry `endpoint_key_rotated` recorded with operator identity and timestamp

### 3.2 Operator authentication

**Human operators:**

- API key resolved from `brainstorm` CLI's vault (existing surface)
- Auth proof = HMAC-SHA-256 over canonical-form-of-DispatchRequest with domain separator (§3.3)
- Key never sent over wire; relay holds shared HMAC secret per operator

**Autonomous-agent operators:**

- Per-agent API key issued by relay during agent provisioning
- Provisioning: `POST /v1/admin/agent/provision`, returns `agent_id` + API key
- Same HMAC scheme as humans

**Operator key derivation (F19/§14.1 fix — was implementer choice, now mandated):**

The HMAC key for an operator is derived as:

```
hmac_key = HKDF-SHA-256(
  ikm = api_key_bytes,
  salt = "brainstorm-relay-operator-hmac-v1",
  info = canonical("operator_id|" + operator_id + "|tenant_id|" + tenant_id),
  length = 32
)
```

This is mandatory; implementations MUST use this exact derivation. Cross-implementation interop depends on it.

### 3.3 Per-envelope signing (with domain separation)

Every Relay → Endpoint envelope is independently signed using **algorithm `ed25519-jcs-sha256-v1`** (F7 fix).

**Signing context (NEW v2):**

The signed bytes are:

```
SIGN_CONTEXT_PREFIX || JCS(envelope_minus_signature)
```

Where `SIGN_CONTEXT_PREFIX` is one of (domain-separated; F7 fix; byte counts corrected in v3 per Codex review):

- For CommandEnvelope (relay→endpoint): `"brainstorm-cmd-envelope-v1\x00"` (27 bytes including null terminator)
- For ConnectionProof (endpoint WS upgrade): `"brainstorm-conn-proof-v1\x00"` (25 bytes)
- For BootstrapToken: `"brainstorm-bootstrap-token-v1\x00"` (30 bytes)
- For OperatorHmac (over DispatchRequest, used inside HMAC's data input): `"brainstorm-operator-hmac-v1\x00"` (28 bytes)
- For EvidenceChunk hash-chain (§6.3, hash-domain prefix not signing-context): `"brainstorm-evidence-chunk-v1\x00"` (29 bytes)

Cross-context signature replay (e.g., trying to use an envelope signature as a connection proof) fails because the prefix differs. The EvidenceChunk prefix is for hash-chain domain separation (used in §6.3 chunk_hash[seq] formula) rather than signing, but follows the same `domain-prefix || canonical-bytes → SHA-256` pattern; listed here for completeness.

**Signature procedure:**

1. Construct envelope JSON object, leaving `signature` field as empty string `""`.
2. **NFC-normalize each string value** within the envelope object **prior to JCS serialization** (F20 fix; v3 ordering tightened per crd4sdom Q1 — "NFC each string value during/before JCS serialization, never after JCS produces canonical bytes." NFC-then-JCS is correct; JCS-then-NFC would mutate already-canonical bytes and break verification.)
3. Serialize the (NFC-normalized) envelope via [RFC 8785 JCS](https://datatracker.ietf.org/doc/html/rfc8785) (deterministic key ordering, normalized number representation).
4. Prepend `SIGN_CONTEXT_PREFIX` bytes to the JCS canonical bytes.
5. Hash the prefixed bytes with SHA-256.
6. Sign hash with Ed25519 (tenant key).
7. Base64-encode signature; place in `signature` field of envelope.

**Verification (endpoint side):**

1. Extract `signature`, `signing_key_id`, `signature_algo` from envelope.
2. Reject if `signature_algo != "ed25519-jcs-sha256-v1"` (F7 — explicit algorithm name).
3. Look up tenant public key for `signing_key_id`. Reject if revoked.
4. Verify `target_endpoint_id` matches local endpoint_id. Reject `WRONG_AUDIENCE` if not (F5 fix).
5. Reconstruct canonical form (envelope with `signature` field set to `""`); NFC-normalize strings; serialize via JCS; prepend `SIGN_CONTEXT_PREFIX`; SHA-256 hash.
6. Verify Ed25519 signature against hash.
7. Reject on failure → `SIGNATURE_INVALID` ErrorEvent (§5.5, F3 fix).

**Replay prevention (F8 fix):**

- `nonce` (32 bytes random, base64url) per envelope
- `issued_at`, `expires_at` (ISO8601); `expires_at - issued_at <= 5 minutes`
- Endpoint rejects: `now > expires_at + 60s_clock_skew` → `ENVELOPE_EXPIRED`
- Endpoint rejects: `now < issued_at - 60s_clock_skew` → `ENVELOPE_FUTURE_DATED`
- Endpoint maintains nonce-replay store with these MUST-have properties:
  - **Persistent across endpoint restarts** (SQLite or equivalent durable store; in-memory-only is forbidden)
  - **Minimum capacity 100,000 nonces** retained for the longest possible `expires_at` window (5 min + clock skew = 6 min)
  - **Eviction policy:** entries older than `max(expires_at) + 60s_clock_skew` are eligible for eviction; otherwise FIFO under capacity pressure
  - **Fail-closed under capacity pressure:** if capacity is fully occupied with non-evictable entries, endpoint REJECTS new envelopes with `NONCE_CACHE_FULL` rather than evicting
  - Duplicate `nonce` within retention window → `NONCE_REPLAY`

### 3.4 Auth proof types (D27)

Discriminated union with `additionalProperties: false` (F15 fix). MVP relay accepts only HMAC; JWT and CAF mTLS are reserved for v1.0+ but defined here for forward compatibility (F19 fix).

```typescript
type AuthProof =
  | { kind: "hmac_signed_envelope"; signature: string } // MVP supported
  | { kind: "jwt"; token: string } // v1.0+ — relay rejects with "AUTH_MODE_NOT_SUPPORTED" in MVP
  | { kind: "caf_mtls"; cert_fingerprint: string }; // v1.0+ — same MVP rejection
```

For HMAC mode: signature is HMAC-SHA-256 over `OperatorHmac` domain prefix + RFC 8785 canonical-form of the request, EXCLUDING the `auth_proof.signature` field itself (set `signature: ""` during canonicalization). Schema must enforce `additionalProperties: false` at the auth_proof level so unsigned extra fields cannot be smuggled.

---

## 4. Message Types: Operator ↔ Relay

All operator↔relay frames are JSON text frames (WebSocket opcode 0x1). Each frame has `type` discriminator field as first key.

### 4.0 OperatorHello (operator → relay, initial frame)

Sent immediately after WS upgrade. Relay validates auth before accepting any other frame.

```json
{
  "type": "OperatorHello",
  "operator": {
    "kind": "human",
    "id": "user@example.com",
    "auth_proof": { "kind": "hmac_signed_envelope", "signature": "..." }
  },
  "tenant_id": "tenant-xyz-...",
  "client_protocol_version": "v1",
  "session_token_request": true
}
```

Relay responds with `OperatorHelloAck` containing `operator_session_id` (used to scope rate limits and audit). Bad auth → `ErrorEvent { code: "AUTH_INVALID_PROOF" }` then close 1008.

### 4.1 DispatchRequest (operator → relay)

```json
{
  "type": "DispatchRequest",
  "request_id": "req-7f8a-...",
  "tool": "echo",
  "params": { "message": "hello" },
  "target_endpoint_id": "endpoint-abc-...",
  "tenant_id": "tenant-xyz-...",
  "correlation_id": "corr-456-...",
  "operator": {
    "kind": "human",
    "id": "user@example.com",
    "auth_proof": { "kind": "hmac_signed_envelope", "signature": "..." },
    "originating_human_id": "user@example.com"
  },
  "options": {
    "auto_confirm": false,
    "stream_progress": true,
    "deadline_ms": 30000
  }
}
```

`correlation_id` and `tenant_id` are **mandatory** (F2 fix). Schema enforces both in `required[]`.

`target_endpoint_id` is mandatory; relay binds it into the signed CommandEnvelope (F5 fix).

### 4.2 ChangeSetPreview (relay → operator)

Sidecar metadata; relay-internal channel. Includes a `preview_hash` so the subsequent ConfirmRequest can bind to it (F16 fix).

```json
{
  "type": "ChangeSetPreview",
  "request_id": "req-7f8a-...",
  "command_id": "cmd-99b-...",
  "preview_summary": "Will execute tool 'echo' with params {message: \"hello\"} on endpoint endpoint-abc-... as human:user@example.com",
  "preview_hash": "sha256:1c3d4e5f...",
  "blast_radius": "low",
  "reversibility": "trivial"
}
```

`preview_hash = SHA-256(NFC-normalized JCS-canonical(DispatchRequest minus operator.auth_proof) || "|" || preview_summary)`.

### 4.3 ConfirmRequest (operator → relay)

```json
{
  "type": "ConfirmRequest",
  "request_id": "req-7f8a-...",
  "command_id": "cmd-99b-...",
  "preview_hash": "sha256:1c3d4e5f...",
  "confirm": true
}
```

Relay rejects ConfirmRequest with `PREVIEW_HASH_MISMATCH` if `preview_hash` differs from the one issued in ChangeSetPreview (F16 fix).

If `confirm: false`, relay emits `ErrorEvent { code: "OPERATOR_DECLINED" }`.

### 4.4 ProgressEvent (relay → operator)

```json
{
  "type": "ProgressEvent",
  "request_id": "req-7f8a-...",
  "command_id": "cmd-99b-...",
  "lifecycle_state": "started",
  "progress": { "fraction": 0.4, "message": "executing..." },
  "ts": "2026-04-26T22:00:00.000Z"
}
```

(`channel_of_origin` lives on the AuditLogEntry wrapper, §8, NOT on the wire frame itself; F1 fix.)

### 4.5 ResultEvent (relay → operator) — terminal

```json
{
  "type": "ResultEvent",
  "request_id": "req-7f8a-...",
  "command_id": "cmd-99b-...",
  "lifecycle_state": "completed",
  "payload": { "stdout": "hello", "stderr": "", "exit_code": 0 },
  "evidence_hash": "sha256:abc...",
  "ts": "2026-04-26T22:00:01.234Z"
}
```

### 4.6 ErrorEvent (relay → operator) — terminal

```json
{
  "type": "ErrorEvent",
  "request_id": "req-7f8a-...",
  "command_id": "cmd-99b-..." | null,
  "code": "...",
  "message": "human-readable error",
  "ts": "2026-04-26T22:00:01.234Z"
}
```

---

## 5. Message Types: Relay ↔ Endpoint

All frames are WebSocket text frames (opcode 0x1; F18 fix).

### 5.0 EndpointHello (endpoint → relay, initial frame post-upgrade)

```json
{
  "type": "EndpointHello",
  "endpoint_id": "endpoint-abc-...",
  "tenant_id": "tenant-xyz-...",
  "agent_version": "v0.1.0",
  "agent_protocol_version": "v1",
  "connection_proof": {
    "ts": "2026-04-26T22:00:00.000Z",
    "signature": "base64-ed25519-over-(SIGN_CONTEXT_PREFIX-conn-proof || JCS({endpoint_id, tenant_id, ts}))"
  }
}
```

Relay validates connection_proof signature against endpoint's registered public key.
Relay responds with `EndpointHelloAck { session_id, server_protocol_version }`.

### 5.1 CommandEnvelope (relay → endpoint, signed)

```json
{
  "type": "CommandEnvelope",
  "command_id": "cmd-99b-...",
  "tenant_id": "tenant-xyz-...",
  "target_endpoint_id": "endpoint-abc-...",
  "correlation_id": "corr-456-...",
  "session_id": "sess-789-...",
  "tool": "echo",
  "params": { "message": "hello" },
  "operator": {
    "kind": "human",
    "id": "user@example.com",
    "originating_human_id": "user@example.com"
  },
  "lifecycle_state": "dispatched",
  "issued_at": "2026-04-26T22:00:00.000Z",
  "expires_at": "2026-04-26T22:05:00.000Z",
  "nonce": "base64url-32-bytes",
  "signing_key_id": "tenant-xyz/key-v1",
  "signature_algo": "ed25519-jcs-sha256-v1",
  "signature": "base64-encoded-ed25519-signature"
}
```

`target_endpoint_id` (F5 fix) and `correlation_id` (F2 fix) are mandatory and signed.

`session_id` (F12 fix) binds the envelope to the endpoint's current connection. Endpoint rejects envelopes with stale session_id → `SESSION_STALE`.

`auth_proof` from operator side is NOT included in CommandEnvelope — relay vouched for the operator already.

### 5.1.5 CommandAck (endpoint → relay) — NEW v3, crd4sdom Q4 fix

**Mandatory.** Endpoint emits `CommandAck` immediately after verifying CommandEnvelope signature + audience + nonce, BEFORE sandbox dispatch. Relay receiving CommandAck transitions lifecycle `dispatched → started`. Without ACK, the joint MSP correlation position breaks and agent has to maintain two state machines.

```json
{
  "type": "CommandAck",
  "command_id": "cmd-99b-...",
  "endpoint_id": "endpoint-abc-...",
  "session_id": "sess-789-...",
  "track": "data_provider" | "mutator",
  "will_emit_progress": true,
  "estimated_duration_ms": 1500,
  "ts": "2026-04-26T22:00:00.020Z"
}
```

**Fields:**

- `track` — agent classifies the tool: `data_provider` (read-only DataProvider per Move-1 Dual-Track-Tools) or `mutator` (Mutator with side effects). Lets relay/operators apply different ChangeSet treatments.
- `will_emit_progress` — boolean; whether the agent will emit ProgressEvent frames. If `false`, relay/operator should not expect intermediate updates; only the terminal CommandResult.
- `estimated_duration_ms` — optional; agent's best estimate of how long the dispatch will take. Used by relay for adaptive timeouts and operator UX.

**Lifecycle relationship:** ACK is the explicit `dispatched → started` transition. Was implicit in v2 (first ProgressEvent triggered the transition); now explicit per crd4sdom Q4. ACK is mandatory; failure to emit within `T_ack_timeout = 5s` → relay transitions `dispatched → timed_out` with `ENDPOINT_NO_ACK` audit annotation.

**Relay-observable ACK timeout (Codex V3-ACK-01 fix):** the 5s timer starts at relay-side **`successful_ws_write` of CommandEnvelope** (i.e., when the WS frame has been written and flushed by the relay's WS lib), NOT at endpoint receipt (which relay cannot observe). This avoids false `ENDPOINT_NO_ACK` from network/backpressure paths the endpoint cannot influence.

**Connection loss before ACK:** if the WS connection drops between CommandEnvelope write and ACK receipt:

- Relay marks the connection-loss timestamp; if reconnect occurs within `T_ack_timeout`, the new session_id invalidates the in-flight envelope. Relay transitions `dispatched → failed` with `RELAY_ENDPOINT_DISCONNECTED_BEFORE_ACK`.
- If reconnect doesn't occur within `T_ack_timeout`: `dispatched → timed_out` with `ENDPOINT_NO_ACK`.
- If endpoint reconnects with new session_id and replays the envelope (resumed=true): treated as fresh dispatch with new command_id; old envelope state stays terminal.

**ACK arriving for unknown command_id** (e.g., relay restart between dispatch and ACK): relay rejects with `RELAY_UNKNOWN_COMMAND_ID`; endpoint records as `late_arrival` in its local journal.

### 5.2 CommandResult (endpoint → relay) — terminal

```json
{
  "type": "CommandResult",
  "command_id": "cmd-99b-...",
  "endpoint_id": "endpoint-abc-...",
  "session_id": "sess-789-...",
  "lifecycle_state": "completed",
  "payload": { "stdout": "hello", "stderr": "", "exit_code": 0 },
  "error": null,
  "evidence_hash": "sha256:abc...",
  "sandbox_reset_state": {
    "reset_at": "2026-04-26T22:00:01.500Z",
    "golden_hash": "sha256:def...",
    "verification_passed": true,
    "verification_details": {
      "fs_hash": "sha256:...",
      "fs_hash_match": true,
      "open_fd_count": 3,
      "open_fd_count_baseline": 3,
      "vmm_api_state": "running",
      "divergence_action": "none"
    }
  },
  "resumed": false,
  "ts": "2026-04-26T22:00:01.234Z"
}
```

`endpoint_id` (F13 fix) is mandatory and relay validates it matches the authenticated WS connection's endpoint.

`session_id` (F12 fix) bound to current session.

**Lifecycle-dependent shape (F11 fix):** schema's `oneOf` enforces:

- `lifecycle_state == "completed"` → `payload` non-null, `error == null`, `sandbox_reset_state` required, `verification_passed == true`
- `lifecycle_state == "failed"` → `error` non-null with `error.code`, `payload == null`, `sandbox_reset_state` may be present
- `lifecycle_state == "timed_out"` → emitted only by relay (endpoint never emits timed_out CommandResult)

**Reset verification (F4 fix):** `verification_details` is a fully typed required object (see §13.3).

**Common `vmm_api_state` vocabulary (NEW v3, crd4sdom TM-Touchpoint-1 fix):** to keep the cross-backend interface uniform, each backend translates its native VMM state to a common enum at the `Sandbox` impl boundary. Common values: `running` | `stopped` | `paused` | `error`. CHV's native `Running` → `running`; VF's `.running` → `running`; etc. Integrity monitor uses uniform vocabulary. Per-backend translation lives inside the Go impl, not in the wire schema.

**Divergence handling (F4 fix):** if any of `fs_hash_match`, `open_fd_count == open_fd_count_baseline`, or `vmm_api_state == expected_vmm_api_state` is FALSE:

- `verification_passed = false`
- `divergence_action = "halt"` (mandatory if any divergence) — endpoint enters degraded mode, refuses next dispatch, emits `ErrorEvent { code: "RESET_VERIFICATION_DIVERGENCE" }`
- Relay alerts; integrity-monitor records substrate-lying-attacker incident class

### 5.3 ProgressEvent (endpoint → relay)

```json
{
  "type": "ProgressEvent",
  "command_id": "cmd-99b-...",
  "endpoint_id": "endpoint-abc-...",
  "session_id": "sess-789-...",
  "lifecycle_state": "started" | "progress",
  "seq": 1,
  "progress": { "fraction": 0.4, "message": "..." },
  "ts": "2026-04-26T22:00:00.500Z"
}
```

`endpoint_id` (F13) + `session_id` (F12) bound.

### 5.4 HealthPing + HealthPong (bidirectional)

**Application-layer health (in addition to WebSocket Ping/Pong):**

```json
// HealthPing
{ "type": "HealthPing", "session_id": "sess-789-...", "ts": "2026-04-26T22:00:00.000Z", "ping_id": "p-7f-..." }

// HealthPong (response, F10 fix)
{ "type": "HealthPong", "session_id": "sess-789-...", "ts": "2026-04-26T22:00:00.020Z", "ping_id": "p-7f-...", "agent_health": "ok" | "degraded", "sandbox_state": "ready" | "resetting" | "failed" }
```

`agent_health` and `sandbox_state` are observability fields; relay uses `degraded`/`failed` to mark endpoint as not-dispatchable.

### 5.5 ErrorEvent (endpoint → relay) — NEW v2, F3 fix

Endpoint emits `ErrorEvent` for reject-before-start cases where no `CommandResult` will follow.

```json
{
  "type": "ErrorEvent",
  "command_id": "cmd-99b-...",
  "endpoint_id": "endpoint-abc-...",
  "session_id": "sess-789-...",
  "code": "SIGNATURE_INVALID" | "ENVELOPE_EXPIRED" | "ENVELOPE_FUTURE_DATED" | "NONCE_REPLAY" | "NONCE_CACHE_FULL" | "WRONG_AUDIENCE" | "TOOL_NOT_REGISTERED" | "SESSION_STALE" | "SCHEMA_INVALID",
  "message": "human-readable",
  "ts": "2026-04-26T22:00:00.020Z"
}
```

Relay receives endpoint-side ErrorEvent → transitions lifecycle from `dispatched` → `failed` (F3 fix; previously stuck at `dispatched` until timeout). Audit entry recorded with channel_of_origin = `endpoint`.

---

## 6. Message Types: Endpoint ↔ Sandbox (vsock)

Length-prefixed binary frames per §2 spec. Max frame size 16 MiB; 30s partial-frame timeout; `FRAME_TOO_LARGE` and `FRAME_MALFORMED` codes (F9 fix).

### 6.1 ToolDispatch (agent → sandbox)

```json
{
  "type": "ToolDispatch",
  "command_id": "cmd-99b-...",
  "tool": "echo",
  "params": { "message": "hello" },
  "deadline_ms": 30000
}
```

### 6.2 ToolResult (sandbox → agent) — terminal

```json
{
  "type": "ToolResult",
  "command_id": "cmd-99b-...",
  "exit_code": 0,
  "stdout": "hello\n",
  "stderr": "",
  "evidence_hash": "sha256:abc..."
}
```

### 6.3 EvidenceChunk (sandbox → agent) — F17 fix

```json
{
  "type": "EvidenceChunk",
  "command_id": "cmd-99b-...",
  "seq": 1,
  "chunk_data": "base64-encoded-bytes",
  "chunk_size": 4096,
  "is_terminal": false
}
```

**Hash-chain formula (F17 fix; v3 disambiguation per crd4sdom Q2):**

```
chunk_hash[seq] = SHA-256(
  "brainstorm-evidence-chunk-v1\x00" ||
  command_id_bytes ||
  uint64_be(seq) ||
  chunk_size_uint32_be ||
  chunk_data_decoded_bytes ||
  (seq == 1 ? zero_32_bytes : chunk_hash[seq-1])
)
```

**`chunk_data_decoded_bytes` clarification (v3, crd4sdom Q2):** the `chunk_data` field on the wire is base64-encoded JSON. The hash is computed over the **decoded bytes**, NOT over the base64 string representation. `chunk_size_uint32_be` records the length of the decoded byte sequence (in bytes), not the base64 string length. This disambiguation closes inter-implementation drift on hash computation.

**Sequence rules:**

- `seq` starts at 1, monotonically increasing by 1
- Gaps (e.g., 1, 2, 4) → agent rejects, emits `ErrorEvent { code: "EVIDENCE_GAP" }`, treats command as failed
- Duplicate seq (e.g., 1, 2, 2) → agent rejects, `EVIDENCE_DUPLICATE`
- Out-of-order (e.g., 1, 3, 2) → agent rejects, `EVIDENCE_OUT_OF_ORDER`
- Last chunk has `is_terminal: true`; agent finalizes evidence_hash = chunk_hash[final_seq]
- Max chunk_size = 1 MiB; chunks larger → `FRAME_TOO_LARGE` (per §2)

**Final evidence_hash** in ToolResult / CommandResult = `chunk_hash[final_seq]` from the chain above.

### 6.3.5 GuestQuery (agent → sandbox) — NEW v3, crd4sdom TM-Touchpoint-2 fix

The integrity monitor's Source 2 (open-fd count, mem usage, process list) requires querying inside the guest from the host. Without an explicit message type, each backend implementation would pick its own mechanism (sidechannel vsock port, magic tool name, etc.) — leading to interop drift.

```json
{
  "type": "GuestQuery",
  "query_id": "550e8400-e29b-41d4-a716-446655440000",
  "query_kind": "OpenFdCount" | "MemUsage" | "ProcessList",
  "ts": "2026-04-26T22:00:00.020Z"
}
```

**`query_id` rules (Codex V3-GQ-01 fix):**

- MUST be UUIDv4 (or 128-bit cryptographically random, base16-encoded)
- MUST be unique among inflight queries on the current vsock session
- Agent rejects duplicate inflight `query_id` with `GUEST_QUERY_DUPLICATE`
- Late `GuestResponse` (after timeout or after ResetSignal) is dropped on the agent side; logged as `late_arrival` in audit

**Defined query kinds (MVP):**

- `OpenFdCount` — number of open file descriptors held by guest processes (used by integrity monitor Source 2)
- `MemUsage` — bytes used / bytes total (observability)
- `ProcessList` — list of running processes by name (observability; bounded list, max 100 entries)

Additional query kinds may be added in v1.1+ via capability negotiation; agent advertises supported kinds in EndpointHello.

### 6.3.6 GuestResponse (sandbox → agent) — NEW v3

```json
{
  "type": "GuestResponse",
  "query_id": "550e8400-e29b-41d4-a716-446655440000",
  "query_kind": "OpenFdCount",
  "result": { "open_fd_count": 3 },
  "ts": "2026-04-26T22:00:00.025Z"
}
```

**Per-kind result schemas (Codex V3-GQ-02 fix; inline below):**

```typescript
type GuestResponseResult =
  | { open_fd_count: number /* integer >= 0 */ } // for OpenFdCount
  | { bytes_used: number; bytes_total: number /* both integer >= 0 */ } // for MemUsage
  | {
      processes: Array<{
        name: string;
        pid: number; /* integer >= 1 */
      }>; /* max 100 */
    }; // for ProcessList
```

**Timeout consequence (Codex V3-GQ-02 fix):**

- Sandbox MUST respond within 1s for OpenFdCount/MemUsage; 5s for ProcessList.
- If timeout exceeded: agent records `source2_status: "silent"` for that source.
- For integrity monitor evaluation (per threat model §5.1 settling-period rule): if Source 2 is silent at unanimity-evaluation time, treat as `RESET_VERIFICATION_TIMEOUT` (one retry permitted) NOT `RESET_VERIFICATION_DIVERGENCE` (would force halt). Distinguishes "guest agent slow to come up" from "active state lie."
- If retry also produces silence: agent enters degraded mode per threat model §4.4.

### 6.4 ResetSignal (agent → sandbox)

```json
{
  "type": "ResetSignal",
  "reset_id": "rst-456-...",
  "reason": "post_dispatch" | "on_suspicion" | "on_idle" | "on_command_id_mismatch"
}
```

### 6.5 ResetAck (sandbox → agent)

```json
{
  "type": "ResetAck",
  "reset_id": "rst-456-...",
  "reset_complete_at": "2026-04-26T22:00:01.500Z",
  "golden_hash": "sha256:def...",
  "verification_passed": true,
  "verification_details": {
    "fs_hash": "sha256:abc...",
    "fs_hash_baseline": "sha256:abc...",
    "fs_hash_match": true,
    "open_fd_count": 3,
    "open_fd_count_baseline": 3,
    "vmm_api_state": "running",
    "expected_vmm_api_state": "Running",
    "divergence_action": "none" | "halt"
  }
}
```

All `verification_details` fields are required (F4 fix). 3-source cross-check is structurally enforced.

---

## 7. Lifecycle State Machine

```
┌─────────┐  reserve_command_id   ┌──────────┐
│  (none) │ ────────────────────► │ pending  │
└─────────┘                        └────┬─────┘
                                        │ relay → endpoint dispatch (CommandEnvelope sent)
                                        ▼
                                  ┌──────────────┐
                                  │  dispatched  │
                                  └──────┬───────┘
                                         │
                          ┌──────────────┼──────────────────────┐
                          │              │                      │
                          │ endpoint     │ endpoint emits       │ relay-side
                          │ emits        │ ErrorEvent          │ deadline hit OR
                          │ CommandAck   │ (signature invalid, │ T_ack_timeout
                          │ (NEW v3)     │  expired, replay,   │ exceeded
                          │              │  wrong audience,    │ ▼
                          ▼              │  schema invalid,    │ ┌────────────┐
                  ┌──────────┐           │  session stale,     │ │ timed_out  │
                  │  started │           │  tool not reg)      │ │ (terminal) │
                  └─────┬────┘           │                      │ └────────────┘
                        │                │                      │
                        │ ProgressEvent  │                      │
                        │ w/ fraction    ▼                      │
                        ▼          ┌──────────┐                 │
                  ┌──────────┐     │  failed  │ ◄───────────────┘
                  │ progress │     │ (terminal)│   late ErrorEvent after timed_out
                  └────┬─────┘     └──────────┘   recorded as audit `late_arrival` flag,
                       │                          does NOT change row state
                       │ tool returns
                       ▼
              ┌────────┴─────────┐
              ▼                  ▼
      ┌────────────┐      ┌──────────┐
      │ completed  │      │  failed  │
      │ (terminal) │      │ (terminal)│
      └────────────┘      └──────────┘
```

**Reject-before-start transitions (NEW v2, F3 fix):** when endpoint emits ErrorEvent (signature invalid / expired / replay / wrong audience / schema invalid / session stale / tool not registered), relay transitions `dispatched → failed` immediately. No more "stuck at dispatched until timeout."

**ACK→started transition (NEW v3, crd4sdom Q4 fix):** when endpoint emits CommandAck (after envelope verification, before sandbox dispatch), relay transitions `dispatched → started` explicitly. Was implicit on first ProgressEvent in v2; now explicit. ACK is mandatory; if endpoint does not emit ACK within `T_ack_timeout = 5s`, relay treats as failure: transitions `dispatched → timed_out` with `ENDPOINT_NO_ACK` audit annotation.

**Authoritative state owner (F12 clarification):** relay is the source-of-truth for lifecycle state. Endpoint emits state transitions (via ProgressEvent / CommandResult / ErrorEvent), but relay's audit log is canonical. If endpoint and relay disagree (e.g., endpoint thinks completed, relay marked timed_out before result arrived), relay's state wins; endpoint's late result is recorded as `late_arrival` audit flag.

**Crash/resume (inherited from MSP correlation work):** if endpoint restarts mid-dispatch and replays journaled commands, RESULT carries `resumed: true`. State transitions to terminal per status; audit flag `resumed_from_crash` recorded.

---

## 8. Anti-Contamination Protocol + AuditLogEntry (F1 fix)

The anti-contamination discipline is enforced **at the audit layer via the `AuditLogEntry` wrapper schema**, not on every wire frame.

**Rule:** Every audit-bearing event in the system is recorded as an `AuditLogEntry`. The wrapper's `channel_of_origin` field is server-side stamped (relay or endpoint) and immutable.

### AuditLogEntry schema (NEW v2)

```typescript
type AuditLogEntry = {
  id: number; // auto-increment PK
  command_id: string | null; // UUID; null only for pre-dispatch errors
  ts: string; // ISO8601, server-stamped
  channel_of_origin: "operator" | "relay-internal" | "endpoint" | "sandbox";
  message_type: string; // e.g. "DispatchRequest", "CommandEnvelope", "CommandResult"
  payload_canonical_hash: string; // sha256 of JCS canonical form (NFC-normalized)
  payload_bytes_b64: string; // base64-encoded raw bytes; verbatim for operator origin
  metadata_sidecar: Record<string, unknown> | null; // relay-internal annotations
  endpoint_id: string | null; // for endpoint/sandbox origin entries
  session_id: string | null; // for endpoint/sandbox origin entries
};
```

**Channel taxonomy:**

| Channel          | Meaning                                                                                      | Stamper                                    |
| ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `operator`       | Bytes originated from operator                                                               | Relay (on receipt of operator frame)       |
| `relay-internal` | Relay-emitted metadata (command_id mint, ChangeSetPreview, ErrorEvent for relay-side errors) | Relay (self-stamped)                       |
| `endpoint`       | Endpoint-emitted (CommandResult, ProgressEvent, endpoint ErrorEvent)                         | Relay (on receipt of endpoint frame)       |
| `sandbox`        | Sandbox-emitted via vsock (EvidenceChunk, ResetAck)                                          | Endpoint agent (on receipt of vsock frame) |

**Anti-contamination invariants (structurally enforced):**

1. For `channel_of_origin = "operator"` rows: `metadata_sidecar` MUST NOT contain any field that exists in the operator-content payload. Relay-emitted fields (timestamps, command_id) live in `metadata_sidecar` or in their own columns; never injected into `payload_bytes_b64`.
2. The `payload_canonical_hash` is computed over the EXACT operator-emitted bytes (verbatim). Any mutation by relay invalidates the hash and is detectable on audit replay.
3. Relay's audit-log INSERT for `channel_of_origin = "operator"` MUST happen BEFORE any relay-internal annotation could occur.

### Audit storage (SQLite at relay)

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT,                            -- nullable for pre-dispatch
  ts TEXT NOT NULL,                            -- ISO8601
  channel_of_origin TEXT NOT NULL CHECK (channel_of_origin IN ('operator', 'relay-internal', 'endpoint', 'sandbox')),
  message_type TEXT NOT NULL,
  payload_canonical_hash TEXT NOT NULL,
  payload_bytes BLOB NOT NULL,                 -- verbatim for operator origin
  metadata_sidecar TEXT,                       -- JSON; relay-internal annotations
  endpoint_id TEXT,                            -- for endpoint/sandbox origin
  session_id TEXT                              -- for endpoint/sandbox origin
);

CREATE INDEX idx_audit_command_id ON audit_log(command_id);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_endpoint_id ON audit_log(endpoint_id);
```

---

## 9. Audit Chain

End-to-end command_id correlation. Each step records an AuditLogEntry. See §8 for AuditLogEntry shape.

```
operator                      relay                           endpoint                  sandbox
   │                            │                                │                          │
   │                            │ ┌──────────────────────────┐   │                          │
   │  DispatchRequest           │ │ AuditLogEntry            │   │                          │
   ├────────────────────────────► │ channel=operator         │   │                          │
   │                            │ │ payload_bytes verbatim   │   │                          │
   │                            │ └──────────────────────────┘   │                          │
   │                            │                                │                          │
   │                            │ ┌──────────────────────────┐   │                          │
   │                            │ │ AuditLogEntry            │   │                          │
   │                            │ │ channel=relay-internal   │   │                          │
   │                            │ │ msg=ChangeSetPreview     │   │                          │
   │                            │ └──────────────────────────┘   │                          │
   │  ChangeSetPreview          │                                │                          │
   │ ◄──────────────────────────┤                                │                          │
   │                            │ ┌──────────────────────────┐   │                          │
   │                            │ │ AuditLogEntry            │   │                          │
   │                            │ │ channel=relay-internal   │   │                          │
   │                            │ │ msg=CommandEnvelope      │   │                          │
   │                            │ │ (signed)                 │   │                          │
   │                            │ └──────────────────────────┘   │                          │
   │                            │  CommandEnvelope               │                          │
   │                            ├────────────────────────────────►                          │
   │                            │                                │ ┌──────────────────┐    │
   │                            │                                │ │ AuditLogEntry    │    │
   │                            │                                │ │ channel=sandbox  │    │
   │                            │                                │ │ msg=EvidenceChnk │    │
   │                            │                                │ └──────────────────┘    │
   │                            │  CommandResult                 │                          │
   │                            │ ┌──────────────────────────┐   │                          │
   │                            │ │ AuditLogEntry            │   │                          │
   │                            │ │ channel=endpoint         │   │                          │
   │                            │ │ msg=CommandResult        │   │                          │
   │                            │ │ payload_canonical_hash   │   │                          │
   │                            │ └──────────────────────────┘   │                          │
   │                            │ ◄──────────────────────────────┤                          │
   │  ResultEvent               │                                │                          │
   │ ◄──────────────────────────┤                                │                          │
```

**Cross-product join via `correlation_id`:** when endpoint LLM-calls back through BR, BR's `request_id` becomes the relay's `correlation_id`. Audit log queryable by correlation_id for cross-product traces.

---

## 10. Error Codes (F14 fix — namespace normalized, columns split)

Format: `{COMPONENT}_{CONDITION}` strictly enforced.

| Code                                     | Component | Recoverable? | Severity | Action                               |
| ---------------------------------------- | --------- | ------------ | -------- | ------------------------------------ |
| `AUTH_INVALID_PROOF`                     | relay     | no           | error    | reject + close 1008                  |
| `AUTH_TENANT_MISMATCH`                   | relay     | no           | error    | reject + close 1008                  |
| `AUTH_KEY_REVOKED`                       | relay     | no           | error    | reject + close 1008                  |
| `AUTH_MODE_NOT_SUPPORTED`                | relay     | no           | error    | reject (JWT/CAF in MVP)              |
| `RELAY_ENDPOINT_UNREACHABLE`             | relay     | yes          | warning  | retry-with-backoff                   |
| `RELAY_ENDPOINT_NOT_FOUND`               | relay     | no           | error    | reject                               |
| `RELAY_OPERATOR_DECLINED`                | relay     | n/a          | info     | n/a                                  |
| `RELAY_RATE_LIMITED`                     | relay     | yes          | warning  | backoff-and-retry                    |
| `RELAY_DEADLINE_EXCEEDED`                | relay     | n/a          | error    | n/a                                  |
| `RELAY_INTERNAL_ERROR`                   | relay     | n/a          | error    | escalate                             |
| `RELAY_PREVIEW_HASH_MISMATCH`            | relay     | no           | error    | reject + alert                       |
| `ENDPOINT_SIGNATURE_INVALID`             | endpoint  | no           | error    | reject + audit                       |
| `ENDPOINT_NONCE_REPLAY`                  | endpoint  | no           | error    | reject + audit                       |
| `ENDPOINT_NONCE_CACHE_FULL`              | endpoint  | no           | error    | reject + alert                       |
| `ENDPOINT_ENVELOPE_EXPIRED`              | endpoint  | no           | error    | reject + audit                       |
| `ENDPOINT_ENVELOPE_FUTURE_DATED`         | endpoint  | no           | error    | reject + audit                       |
| `ENDPOINT_WRONG_AUDIENCE`                | endpoint  | no           | error    | reject + audit                       |
| `ENDPOINT_TOOL_NOT_REGISTERED`           | endpoint  | no           | error    | reject                               |
| `ENDPOINT_SCHEMA_INVALID`                | endpoint  | no           | error    | reject + audit                       |
| `ENDPOINT_SESSION_STALE`                 | endpoint  | no           | error    | reject                               |
| `ENDPOINT_SANDBOX_NOT_READY`             | endpoint  | yes          | warning  | retry-with-backoff                   |
| `ENDPOINT_RESET_FAILED`                  | endpoint  | no           | critical | halt + alert                         |
| `ENDPOINT_RESET_VERIFICATION_DIVERGENCE` | endpoint  | no           | critical | halt + alert (substrate-lying class) |
| `ENDPOINT_INTEGRITY_MONITOR_TRIPPED`     | endpoint  | no           | critical | halt + alert                         |
| `SANDBOX_TOOL_ERROR`                     | sandbox   | n/a          | n/a      | tool error, expected outcome         |
| `SANDBOX_FRAME_TOO_LARGE`                | sandbox   | no           | error    | close vsock                          |
| `SANDBOX_FRAME_MALFORMED`                | sandbox   | no           | error    | close vsock                          |
| `SANDBOX_EVIDENCE_GAP`                   | sandbox   | no           | error    | command failed                       |
| `SANDBOX_EVIDENCE_DUPLICATE`             | sandbox   | no           | error    | command failed                       |
| `SANDBOX_EVIDENCE_OUT_OF_ORDER`          | sandbox   | no           | error    | command failed                       |
| `SYSTEM_INTERNAL_ERROR`                  | any       | no           | error    | escalate                             |

---

## 11. Connection Lifecycle

### Endpoint connection (persistent outbound, with session_id — F12 fix)

```
agent_start:
  load endpoint_id, private_key from disk
  load nonce_replay_store from disk (SQLite)
  connect_loop:
    open WSS to relay /v1/endpoint/connect
    send EndpointHello with connection_proof
    receive EndpointHelloAck { session_id }
    on_success:
      mark session_id in agent state
      enter dispatch_loop
      handle_envelopes_with_session_check (reject session-mismatched frames)
    on_failure:
      log error
      backoff (1s, 2s, 4s, 8s, 16s, 32s, 60s, max)
      retry
    on_drop:
      session_id invalidated
      reconnect → new session_id
```

### Relay-restart recovery (F12 fix)

When relay restarts:

- Active sessions are invalidated (relay forgets session_ids)
- Endpoints reconnect; relay assigns fresh session_ids
- In-flight commands at restart time:
  - If `expires_at > restart_time + 60s`: relay attempts resume by querying audit log, transitions stale states to `failed` with `RELAY_INTERNAL_ERROR` if no result has arrived
  - If `expires_at < restart_time + 60s`: relay marks them `timed_out` directly
- Endpoint-side: in-flight dispatches journaled; on reconnect with new session, endpoint replays journal with `resumed: true` flag (audit chain preserved)

### Reconnect / offline-queue (DEFERRED per D16)

Endpoint loses WS to relay → reconnect-loop. While disconnected, operator dispatches fail with `RELAY_ENDPOINT_UNREACHABLE`. No queue for MVP.

---

## 12. Security Considerations

### Threat model summary

(Full version in P3.0 doc, drafted separately.) Per plan v3.1 §5:

- Outsider with relay credentials: intended; signed and audited; ChangeSet preview limits.
- Outsider without credentials: can't reach endpoint (no listening ports).
- Compromised tool: runs in sandbox; should not escape, persist across reset, exfiltrate.
- Compromised image: out of MVP scope.
- Compromised host agent: out of MVP scope.
- **Substrate-lying attacker:** reconcile-state-drift pattern. Defense: 3-source cross-check on reset verification; `RESET_VERIFICATION_DIVERGENCE` halts agent.
- **Participant-orchestrator contamination:** integration-review round-1 pattern. Defense: AuditLogEntry wrapper structurally enforces channel_of_origin + immutability of operator-payload bytes (§8).
- **Cross-endpoint envelope replay** (F5 — introduced as new threat in v2, defended in v2): defended via signed `target_endpoint_id` in CommandEnvelope; endpoint rejects `WRONG_AUDIENCE`.
- **Cross-context signature replay** (F7 — addressed in v2): defended via SIGN_CONTEXT_PREFIX domain separation per signing context.

### Replay prevention

- `nonce` (32 bytes random per envelope) tracked in persistent SQLite store on endpoint (NOT in-memory only)
- `expires_at` issued_at + 5 min default for envelopes; deadline_ms for operator requests
- Endpoint rejects: duplicate nonce, expired envelope, future-dated envelope (>60s skew), full nonce cache (`NONCE_CACHE_FULL`)

### Identifier normalization (F20 fix)

All string identifiers (tool names, operator IDs, endpoint IDs, tenant IDs, etc.) MUST be NFC-normalized before:

- Signing (any context)
- Storing in audit log
- Comparison for routing or auth
- Display in operator UI

UTF-8 encoding of NFC form is the canonical bytes representation. RFC 8785 JCS does not handle Unicode normalization on its own; agents MUST do this step explicitly.

### Key rotation

Out of MVP scope. v1.0 work.

### Audit log integrity

Out of MVP scope (signed-evidence-bundles per backlog). MVP audit log = append-only SQLite; operator can request hash-chain verification post-MVP.

---

## 13. JSON Schema Definitions

All schemas are JSON Schema Draft 2020-12. **All object schemas use `additionalProperties: false`** (F15 fix). Lifecycle-dependent shape constraints expressed via `oneOf` (F11 fix).

### 13.1 DispatchRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DispatchRequest",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "type",
    "request_id",
    "tool",
    "params",
    "target_endpoint_id",
    "tenant_id",
    "correlation_id",
    "operator",
    "options"
  ],
  "properties": {
    "type": { "const": "DispatchRequest" },
    "request_id": { "type": "string", "format": "uuid" },
    "tool": { "type": "string", "minLength": 1, "maxLength": 256 },
    "params": { "type": "object" },
    "target_endpoint_id": { "type": "string", "format": "uuid" },
    "tenant_id": { "type": "string", "format": "uuid" },
    "correlation_id": { "type": "string", "minLength": 1, "maxLength": 256 },
    "operator": { "$ref": "#/$defs/Operator" },
    "options": {
      "type": "object",
      "additionalProperties": false,
      "required": ["auto_confirm", "stream_progress", "deadline_ms"],
      "properties": {
        "auto_confirm": { "type": "boolean" },
        "stream_progress": { "type": "boolean" },
        "deadline_ms": { "type": "integer", "minimum": 1000, "maximum": 600000 }
      }
    }
  },
  "$defs": {
    "Operator": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "id", "auth_proof"],
      "properties": {
        "kind": { "enum": ["human", "agent"] },
        "id": { "type": "string", "minLength": 1 },
        "auth_proof": { "$ref": "#/$defs/AuthProof" },
        "originating_human_id": { "type": "string", "minLength": 1 },
        "delegating_principal_id": { "type": "string" }
      },
      "allOf": [
        {
          "if": {
            "properties": { "kind": { "const": "agent" } },
            "required": ["kind"]
          },
          "then": { "required": ["originating_human_id"] }
        }
      ]
    },
    "AuthProof": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "signature"],
          "properties": {
            "kind": { "const": "hmac_signed_envelope" },
            "signature": { "type": "string", "minLength": 1 }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "token"],
          "properties": {
            "kind": { "const": "jwt" },
            "token": { "type": "string", "minLength": 1 }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "cert_fingerprint"],
          "properties": {
            "kind": { "const": "caf_mtls" },
            "cert_fingerprint": { "type": "string", "minLength": 1 }
          }
        }
      ]
    }
  }
}
```

### 13.2 CommandEnvelope

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CommandEnvelope",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "type",
    "command_id",
    "tenant_id",
    "target_endpoint_id",
    "correlation_id",
    "session_id",
    "tool",
    "params",
    "operator",
    "lifecycle_state",
    "issued_at",
    "expires_at",
    "nonce",
    "signing_key_id",
    "signature_algo",
    "signature"
  ],
  "properties": {
    "type": { "const": "CommandEnvelope" },
    "command_id": { "type": "string", "format": "uuid" },
    "tenant_id": { "type": "string", "format": "uuid" },
    "target_endpoint_id": { "type": "string", "format": "uuid" },
    "correlation_id": { "type": "string", "minLength": 1, "maxLength": 256 },
    "session_id": { "type": "string", "format": "uuid" },
    "tool": { "type": "string", "minLength": 1, "maxLength": 256 },
    "params": { "type": "object" },
    "operator": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "id"],
      "properties": {
        "kind": { "enum": ["human", "agent"] },
        "id": { "type": "string", "minLength": 1 },
        "originating_human_id": { "type": "string", "minLength": 1 },
        "delegating_principal_id": { "type": "string" }
      },
      "allOf": [
        {
          "if": {
            "properties": { "kind": { "const": "agent" } },
            "required": ["kind"]
          },
          "then": { "required": ["originating_human_id"] }
        }
      ]
    },
    "lifecycle_state": { "const": "dispatched" },
    "issued_at": { "type": "string", "format": "date-time" },
    "expires_at": { "type": "string", "format": "date-time" },
    "nonce": {
      "type": "string",
      "minLength": 43,
      "maxLength": 43,
      "pattern": "^[A-Za-z0-9_-]+$"
    },
    "signing_key_id": { "type": "string", "minLength": 1 },
    "signature_algo": { "const": "ed25519-jcs-sha256-v1" },
    "signature": { "type": "string", "minLength": 1 }
  }
}
```

### 13.3 CommandResult (with lifecycle-dependent oneOf)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CommandResult",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "type",
    "command_id",
    "endpoint_id",
    "session_id",
    "lifecycle_state",
    "evidence_hash",
    "ts"
  ],
  "properties": {
    "type": { "const": "CommandResult" },
    "command_id": { "type": "string", "format": "uuid" },
    "endpoint_id": { "type": "string", "format": "uuid" },
    "session_id": { "type": "string", "format": "uuid" },
    "lifecycle_state": { "enum": ["completed", "failed"] },
    "payload": { "type": ["object", "null"] },
    "error": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "properties": {
        "code": { "type": "string" },
        "message": { "type": "string" }
      },
      "required": ["code", "message"]
    },
    "evidence_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
    "sandbox_reset_state": { "$ref": "#/$defs/SandboxResetState" },
    "resumed": { "type": "boolean" },
    "ts": { "type": "string", "format": "date-time" }
  },
  "oneOf": [
    {
      "properties": {
        "lifecycle_state": { "const": "completed" },
        "payload": { "type": "object" },
        "error": { "type": "null" }
      },
      "required": ["payload", "sandbox_reset_state"]
    },
    {
      "properties": {
        "lifecycle_state": { "const": "failed" },
        "payload": { "type": "null" },
        "error": { "type": "object" }
      },
      "required": ["error"]
    }
  ],
  "$defs": {
    "SandboxResetState": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reset_at",
        "golden_hash",
        "verification_passed",
        "verification_details"
      ],
      "properties": {
        "reset_at": { "type": "string", "format": "date-time" },
        "golden_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
        "verification_passed": { "type": "boolean" },
        "verification_details": { "$ref": "#/$defs/VerificationDetails" }
      }
    },
    "VerificationDetails": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "fs_hash",
        "fs_hash_baseline",
        "fs_hash_match",
        "open_fd_count",
        "open_fd_count_baseline",
        "vmm_api_state",
        "expected_vmm_api_state",
        "divergence_action"
      ],
      "properties": {
        "fs_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
        "fs_hash_baseline": {
          "type": "string",
          "pattern": "^sha256:[a-f0-9]{64}$"
        },
        "fs_hash_match": { "type": "boolean" },
        "open_fd_count": { "type": "integer", "minimum": 0 },
        "open_fd_count_baseline": { "type": "integer", "minimum": 0 },
        "vmm_api_state": { "enum": ["running", "stopped", "paused", "error"] },
        "expected_vmm_api_state": {
          "enum": ["running", "stopped", "paused", "error"]
        },
        "divergence_action": { "enum": ["none", "halt"] }
      }
    }
  }
}
```

### 13.4 Remaining message schemas (NEW v2 — F1 indirectly, completeness)

Schemas drafted in compact form here; expanded in `schemas/` directory at freeze time.

**ChangeSetPreview, ConfirmRequest, ResultEvent, ProgressEvent (operator-side), ErrorEvent (relay→operator), OperatorHello, OperatorHelloAck:** all object schemas with `additionalProperties: false`, required fields per §4 prose, lifecycle_state enum-bounded where present.

**EndpointHello, EndpointHelloAck, ProgressEvent (endpoint-side), ErrorEvent (endpoint→relay), HealthPing, HealthPong:** object schemas with `additionalProperties: false`, including required `endpoint_id` and `session_id` on all endpoint-origin frames (F13 fix).

**CommandAck (NEW v3, normative schema per Codex V3-ACK-02 fix):**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CommandAck",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "type",
    "command_id",
    "endpoint_id",
    "session_id",
    "track",
    "will_emit_progress",
    "ts"
  ],
  "properties": {
    "type": { "const": "CommandAck" },
    "command_id": { "type": "string", "format": "uuid" },
    "endpoint_id": { "type": "string", "format": "uuid" },
    "session_id": { "type": "string", "format": "uuid" },
    "track": { "enum": ["data_provider", "mutator"] },
    "will_emit_progress": { "type": "boolean" },
    "estimated_duration_ms": {
      "type": ["integer", "null"],
      "minimum": 0,
      "maximum": 600000
    },
    "ts": { "type": "string", "format": "date-time" }
  }
}
```

**ToolDispatch, ToolResult, EvidenceChunk, GuestQuery (NEW v3), GuestResponse (NEW v3), ResetSignal, ResetAck:** object schemas with `additionalProperties: false`. EvidenceChunk includes `chunk_size` (uint32 max) and `is_terminal` boolean. GuestQuery uses `query_kind` enum: `OpenFdCount` | `MemUsage` | `ProcessList`. GuestResponse's `result` shape is per-kind union. ResetAck includes the typed VerificationDetails (per 13.3 above).

**AuditLogEntry:** object schema with `additionalProperties: false`, `channel_of_origin` enum, all fields per §8.

(Full canonical schemas extracted to `schemas/*.json` files at freeze; these inline forms are normative for the prose sections that reference them.)

---

## 14. Wire-Spec Mandates (formerly "Open Implementation Choices")

Per F19 + §14.1 critique: most items previously left to implementer choice were wire-affecting. Tightened in v2:

**Mandated (interop requirements):**

1. **Operator HMAC key derivation** — exact HKDF-SHA-256 formula in §3.2 (was implementer choice; now mandatory).
2. **JCS implementation behavior** — must conform to RFC 8785 strictly + NFC-normalize strings before serializing.
3. **vsock framing rules** — §2 max 16 MiB, 30s partial-frame timeout, length-prefix parser behavior.
4. **WebSocket frame opcode** — TEXT (0x1) for both operator↔relay AND relay↔endpoint. No binary frames.
5. **WebSocket Ping/Pong cadence** — 30s; 60s timeout for missing Pong → connection dead.

**Implementer-discretion (truly non-wire-affecting):**

1. **CLI prompt UX for ChangeSetPreview** — plain-text or rich; not on the wire.
2. **SDK async API shape** — channels, callbacks, async iterators; language-idiomatic.
3. **Endpoint key encryption-at-rest** — file with 0600, Keychain, etc. Operational choice.
4. **Tool params validation** — per-tool JSON Schema registered at image-build time; validation in sandbox not relay (relay treats `params` as opaque).

---

## 15. Status & Cross-Review Plan

- [x] v1 draft committed
- [x] v1 → v2 revision after Codex adversarial review (20 findings addressed)
- [x] crd4sdom cross-review (DONE 2026-04-26) — 7 findings: ACK message structural gap, NFC ordering, chunk_data hashing, length-prefix size, GuestQuery message type, vmm_api_state vocabulary, persistent-nonce-store estimate
- [x] v2 → v3 revision per crd4sdom findings (this version)
- [ ] **Re-Codex on v3** — per crd4sdom's "belt-and-suspenders" recommendation; ACK addition is structural enough to verify
- [ ] **0bz7aztr cross-review tomorrow morning UTC** — §3.3 + §5 + §6 scope (vmm-state/disk-image/CHV-API knowledge transfers); independent read on what crd4sdom missed
- [ ] dttytevx cross-review — relay-shape sanity check (still pending; sent 2026-04-26 22:48Z, awaiting reply)
- [ ] Mark FROZEN

When all checks complete, this document becomes the wire-protocol freeze.

---

## 16.5 v2 → v3 Fix Mapping (crd4sdom cross-review findings)

| Finding (crd4sdom)                                                      | v3 fix location                                                                                                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ------------------------- |
| Q1 — NFC ordering ambiguity (NFC-then-JCS vs JCS-then-NFC)              | §3.3 step 2 wording tightened: "NFC each string value during/before JCS serialization, never after"                                           |
| Q2 — chunk_data hash over base64 vs decoded bytes ambiguous             | §6.3 disambiguation: hash is computed over decoded chunk bytes, not base64 representation; `chunk_size_uint32_be` records decoded byte length |
| Q2 — vsock length-prefix size unspecified (uint32 vs uint64 vs varint)  | §2 vsock framing pinned to `uint32 big-endian`                                                                                                |
| Q3 — per-envelope verification estimate revised                         | Plan v3.2: P1.3 estimate 4-6d (from 3-5d); persistent nonce store with fail-closed semantics is the surprise                                  |
| Q4 — ACK message structural gap (joint MSP correlation position breaks) | §5.1.5 NEW CommandAck message; §7 explicit ACK→started transition; §13.4 schema                                                               |
| Q4 — `delegating_principal_id` chain semantics underspecified           | §3 prose expanded; §13.1/§13.2 schemas verified                                                                                               |
| TM-Touchpoint-1 — `expected_vmm_api_state` vocabulary uniformity        | §5.2 common vocabulary `running                                                                                                               | stopped | paused | error`; §13.3 schema enum |
| TM-Touchpoint-2 — host-queries-guest message type missing               | §6.3.5/§6.3.6 NEW GuestQuery / GuestResponse messages with `OpenFdCount` / `MemUsage` / `ProcessList` query kinds                             |

## 16. Codex Finding → v2 Fix Mapping

| Finding                                                 | Severity  | v2 fix location                                                                                              |
| ------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| F1 — channel_of_origin not in schemas                   | blocking  | §8 AuditLogEntry wrapper schema; §13.4 mention; structural enforcement at audit layer                        |
| F2 — correlation_id missing from required[]             | blocking  | §13.1 DispatchRequest required[]; §13.2 CommandEnvelope required[]                                           |
| F3 — endpoint→relay ErrorEvent missing; lifecycle stuck | blocking  | §5.5 ErrorEvent (endpoint→relay) NEW; §7 reject-before-start transitions                                     |
| F4 — reset verification untyped                         | blocking  | §6.5 typed verification_details; §13.3 SandboxResetState + VerificationDetails $defs; divergence_action enum |
| F5 — CommandEnvelope lacks target_endpoint_id           | blocking  | §5.1 target_endpoint_id mandatory + signed; §3.3 audience verification step; §13.2 required[]                |
| F6 — enrollment GET/POST mismatch + no re-enrollment    | blocking  | §3.1 POST /v1/endpoint/enroll; atomic token consumption; re-enrollment flow                                  |
| F7 — signing context confusion                          | important | §3.3 SIGN_CONTEXT_PREFIX domain separation; algo `ed25519-jcs-sha256-v1`                                     |
| F8 — nonce LRU under-specified                          | important | §3.3 persistent SQLite store; min 100k capacity; fail-closed `NONCE_CACHE_FULL`                              |
| F9 — vsock framing under-specified                      | important | §2 max 16 MiB; 30s partial-frame timeout; FRAME_TOO_LARGE / FRAME_MALFORMED codes                            |
| F10 — HealthPong missing                                | important | §5.4 HealthPong shape with agent_health + sandbox_state                                                      |
| F11 — CommandResult illegal state combos                | important | §13.3 lifecycle-dependent oneOf                                                                              |
| F12 — no session_id/epoch                               | important | §2 session_id model; §5.x all endpoint frames carry session_id; §11 relay-restart recovery                   |
| F13 — endpoint→relay frames lack endpoint_id            | important | §5.x all endpoint-origin frames include endpoint_id; relay validates against authenticated WS connection     |
| F14 — error code namespace inconsistencies              | important | §10 normalized format; recoverable + severity + action columns split                                         |
| F15 — schemas not closed                                | important | §13.\* `additionalProperties: false` everywhere                                                              |
| F16 — ConfirmRequest unbound from preview               | important | §4.2/§4.3 preview_hash; relay rejects PREVIEW_HASH_MISMATCH                                                  |
| F17 — EvidenceChunk hash-chain undefined                | important | §6.3 explicit chain formula; gap/duplicate/order rules                                                       |
| F18 — text vs binary frame inconsistency                | important | §2 TEXT only (opcode 0x1) for both WebSocket transports                                                      |
| F19 — JWT/CAF in schema, MVP rejects                    | important | §3.4 v1.0+ marked; relay returns AUTH_MODE_NOT_SUPPORTED for now                                             |
| F20 — Unicode normalization gap                         | nit       | §3.3 NFC-normalize before signing; §12 NFC mandate; §14 wire-spec mandate                                    |

---

## Appendix A: References

- RFC 8785 — JSON Canonicalization Scheme (JCS)
- RFC 6455 — WebSocket Protocol
- RFC 5869 — HKDF (used in §3.2 operator key derivation)
- Unicode Normalization Form C (NFC)
- D27 — auth_proof discriminated union (12xnwqbb)
- D28 — tenant_id + correlation_id mandatory (12xnwqbb)
- D29 — 7-state lifecycle vocab (12xnwqbb)
- D30 — anti-contamination protocol (12xnwqbb) — now structurally enforced via AuditLogEntry §8
- D11 — operator class envelope (12xnwqbb refinement)
- D32 — P3.1a sequencing gate (0bz7aztr) — CLEARED 2026-04-26T21:56:11Z
- R18 — substrate-lying attacker class (0bz7aztr reconcile-state-drift pattern)
- MSP correlation fix design (round-2 integration review work, 2026-04-23)
- Codex adversarial review v1 (2026-04-26, task-mogbp239-i56evy) — 20 findings; v2 fixes mapped in §16
