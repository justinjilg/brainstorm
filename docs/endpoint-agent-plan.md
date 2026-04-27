# Brainstorm Endpoint Agent — MVP Plan

**Status:** v3.2 (post-cross-review, estimate bumps + protocol v3 reflection) — 2026-04-26
**Inspired by:** Claude Desktop Dispatch architecture (Codex fresh-perspective session, 2026-04-25)
**Working mode:** plan-set; execution begins with P1.0 wire-protocol spec freeze

---

## 1. Mission & Scope

### Mission

Recreate the two foundational primitives of a Dispatch-pattern endpoint agent so Brainstorm can dispatch governed actions to customer endpoints with auditor-defensible isolation:

1. **Sandbox** — microVM execution isolation. Linux endpoints use Cloud Hypervisor; macOS endpoints use Apple Virtualization.framework. Both run the same Linux guest image behind a unified sandbox abstraction.
2. **Communication protocol** — cloud-relay-with-persistent-outbound-connections between operator and endpoint, supporting both human (CLI) and autonomous-agent (SDK) operators against the same dispatch primitive.

### What ships at MVP

A working dispatch loop with these properties demonstrable on **both Linux and macOS endpoints**:

- Operator (human via CLI, autonomous Claude via SDK) issues a dispatch
- Brainstorm-platform relay validates, signs, routes
- Endpoint (Linux or macOS, brainstorm-agent) executes inside a microVM (CHV or VF, respectively)
- microVM is reset between dispatches with hash-verified golden state
- Result streams back to operator over the same persistent channel
- Every step has a `command_id`-correlated audit trail
- ChangeSet preview shown to operator before any execution

### Hard scope locks

| Dimension                 | Lock                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Endpoint OS               | Linux + macOS                                                                                                         |
| Sandbox VMM               | CHV (Linux) + VF (macOS), unified Go abstraction                                                                      |
| Sandbox lifecycle         | Persistent VM, reset between dispatches                                                                               |
| Operator → Relay protocol | WebSocket-over-TLS                                                                                                    |
| Relay architecture        | NEW Brainstorm-platform service (NOT MSP extension)                                                                   |
| Customer-fleet state      | Greenfield                                                                                                            |
| macOS minimum version     | macOS 14 Sonoma+ for fast snapshot; macOS 11+ cold-boot fallback                                                      |
| macOS distribution        | Local dev signing only for MVP; notarization is v1.0 production work                                                  |
| Initial deployment        | Justin's laptop full-stack + AWS/VM testbed                                                                           |
| Codex involvement         | Per-peer trust model (see D8 — was wrong as project-wide in v3, corrected)                                            |
| **Staffing model**        | **Option Y selected: both backends, orchestrator primary on Linux + macOS sandbox tracks. Slower timeline accepted.** |
| **Realistic timeline**    | **10-13 weeks elapsed (vs original optimistic projection of 5-7 weeks). Single-orchestrator-primary is the cost.**    |

### Explicit non-goals

- Multi-product tool surface refactor (Codex Phase 2)
- Endpoint-side ChangeSet enforcement
- Multi-tenant refinement beyond one-agent-one-tenant
- Fleet management (discovery, dashboards, agent auto-update)
- Windows endpoint support (Wasm fallback v1.1+)
- Reconnect / offline-queue semantics
- Compliance certifications
- macOS notarization + Apple Developer Program
- Operator-side UX polish
- HA brainstorm-relay

---

## 2. Architecture

### Components

```
┌─────────────────────┐     ┌────────────────────────┐     ┌───────────────────────────────┐
│  Operator surface   │     │   brainstorm-relay     │     │      brainstorm-agent         │
│                     │     │   (NEW platform svc)   │     │   (Linux OR macOS endpoint)   │
│  ┌───────────────┐  │ WS  │                        │ WS  │                               │
│  │ Human (CLI)   │──┼─────┤  - WS server           ├─────┤  - Persistent outbound WS     │
│  └───────────────┘  │     │  - Operator auth       │     │  - No listening ports         │
│  ┌───────────────┐  │     │  - command_id mint     │     │  - Sandbox abstraction (Go)   │
│  │ Agent (SDK)   │──┼─────┤  - Per-envelope sign   │     │      ┌────────────────┐       │
│  └───────────────┘  │     │  - Result fanout       │     │      │ Sandbox iface  │       │
└─────────────────────┘     │  - Audit log           │     │      └─┬────────────┬─┘       │
                            │  - Anti-contamination  │     │        │            │         │
                            │    sidecar (v3.1)      │     │  ┌─────▼────┐  ┌────▼──────┐  │
                            └────────────────────────┘     │  │  CHV     │  │  Apple VF │  │
                                                           │  │ (Linux)  │  │ (macOS)   │  │
                                                           │  └─────┬────┘  └────┬──────┘  │
                                                           │        │            │         │
                                                           │   ┌────┴────────────┴────┐    │
                                                           │   │ Linux microVM       │    │
                                                           │   │ (shared guest image)│    │
                                                           │   │  vsock + virtio-fs  │    │
                                                           │   └─────────────────────┘    │
                                                           └───────────────────────────────┘
```

### Sandbox abstraction layer

Inside `brainstorm-agent` (Go), single Sandbox interface with two implementations:

```go
type Sandbox interface {
    Boot(imagePath string) error
    Dispatch(ctx context.Context, cmd CommandEnvelope) (CommandResult, error)
    Reset() error
    VerifyResetIntegrity() (GoldenHash, error)
    Shutdown() error
}

type CloudHypervisorSandbox struct { /* Linux/KVM */ }
type VirtualizationFrameworkSandbox struct { /* macOS/VF */ }
```

Backend selected at agent startup via `runtime.GOOS`. Same Linux microVM image runs under both.

### Anti-contamination protocol (v3.1, contributed by 12xnwqbb)

Direct lift of integration-review v1.2 lessons applied to the relay:

- **Operator-payload bytes kept verbatim.** Relay never inline-annotates operator-content.
- **Sidecar metadata channel.** Relay-emitted metadata (command_id, timestamps, audit fields) goes to a separate channel never confused with operator content.
- **Lifecycle events** use the pre-registered 7-state vocabulary federated with MSP correlation work + BR routing-stream:
  ```
  pending | dispatched | started | progress | completed | failed | timed_out
  ```
- **Audit log** records the channel-of-origin for every entry (operator vs relay-internal vs endpoint vs sandbox).

### Wire flow (happy path)

1. Operator constructs `DispatchRequest{ tool, params, target_endpoint_id, operator, tenant_id, correlation_id?, auth_proof }`
2. Operator opens WebSocket to relay, sends request
3. Relay validates `auth_proof`, looks up `target_endpoint_id` → routing destination
4. Relay generates `command_id` (UUID), pre-inserts to audit log with channel-of-origin = `operator`
5. Relay emits `ChangeSetPreview{ command_id, operator_visible_summary }` over the same WS — sidecar metadata, not inline-annotated
6. Operator confirms (CLI: tty prompt; SDK: callback or auto-confirm flag)
7. Relay signs `CommandEnvelope{ command_id, tool, params, operator, tenant_id, correlation_id?, deadline, lifecycle_state: "dispatched", signature }` per-envelope (Ed25519, tenant key)
8. Relay pushes envelope to endpoint
9. brainstorm-agent verifies signature, dispatches to its `Sandbox` interface (CHV or VF) via vsock
10. Sandbox executes tool, emits result + evidence over vsock
11. Agent emits `CommandResult{ command_id, lifecycle_state: "completed"|"failed"|"timed_out", payload?, error?, evidence_hash, sandbox_reset_state }`
12. Sandbox reset triggered (snapshot revert + integrity verify) before next dispatch admitted
13. Relay receives result, persists with channel-of-origin = `endpoint`, streams to operator
14. Operator (CLI) renders; (SDK) returns to caller

### Component-level interfaces

**Operator → Relay** (WebSocket, JSON):

```
DispatchRequest:    operator-initiated
ConfirmRequest:     operator-confirms-changeset
StreamSubscribe:    operator-tails-result
ResultEvent:        relay → operator
ProgressEvent:      relay → operator (lifecycle state transitions)
ErrorEvent:         relay → operator
```

**Relay → Endpoint** (WebSocket binary, signed envelope):

```
CommandEnvelope:    relay → endpoint, signed
CommandResult:      endpoint → relay (echoed command_id, lifecycle state)
ProgressEvent:      endpoint → relay (lifecycle state transitions)
HealthPing:         bidirectional keepalive
```

**Endpoint → Sandbox** (vsock, framed binary; identical interface across backends):

```
ToolDispatch:       agent → sandbox
ToolResult:         sandbox → agent
EvidenceChunk:      sandbox → agent
ResetSignal:        agent → sandbox
ResetAck:           sandbox → agent (reset complete + golden hash)
```

### Identity & auth (v3.1 — refined per 12xnwqbb feedback)

**Endpoints**:

- Per-endpoint UUID, generated at install
- Per-tenant Ed25519 keypair; bootstrap-token enrollment with 24h TTL
- All Relay → Endpoint envelopes signed by tenant key

**Operator class envelope shape (v3.1):**

```typescript
operator: {
  kind: "human" | "agent";
  id: string;                          // human_id or agent_soul_id
  auth_proof: AuthProof;               // discriminated union, see below
  originating_human_id?: string;       // ROOT human in dispatch chain (renamed from parent_human_id)
  delegating_principal_id?: string;    // immediate parent in chain (for chain-depth >2)
}

type AuthProof =
  | { kind: "hmac_signed_envelope"; signature: string }   // default for MVP
  | { kind: "jwt"; token: string }                        // alternative mode
  | { kind: "caf_mtls"; cert_fingerprint: string }        // CAF-enrolled operators (v1.0)
```

`originating_human_id` always points to the root human in the dispatch chain (audit traceability across agent→agent delegations). `delegating_principal_id` records the immediate parent in chain-depth >2 cases (rare in MVP, designed for).

**Required envelope fields (mandatory from MVP):**

- `tenant_id` — federation across BR/MSP/relay (no scoping problem pushed to call sites)
- `correlation_id` — cross-product join (endpoint LLM-calls back through BR threadable)

**MVP auth default:** HMAC-signed envelope with vault-resolved key for humans, relay-issued key for agents. JWT and CAF mTLS are alternative modes the relay accepts but doesn't require for MVP.

### Audit

End-to-end `command_id` correlation: operator-initiated → relay-minted → endpoint-echoed → sandbox-evidence-tagged → relay-persisted → operator-shown. Inherits typed-reservation pattern from MSP correlation work (round-2 design).

Audit log = SQLite at `~/.brainstorm/relay/audit.db`. Channel-of-origin recorded per entry (operator | relay-internal | endpoint | sandbox).

---

## 3. Phase 1 — Prove the Dispatch Loop

**Goal:** validate the comms protocol end-to-end with NO sandbox. Tools execute on the endpoint host directly for Phase 1; sandbox layer comes in Phase 3.

### Deploy topology

| Stage                           | Operator host | Relay host     | Endpoint host                  | Sandbox? |
| ------------------------------- | ------------- | -------------- | ------------------------------ | -------- |
| **Stage 1.0** (laptop loopback) | Laptop        | Laptop         | Laptop                         | NO       |
| **Stage 1.1** (distributed)     | Laptop        | Linux VM       | Linux VM + Laptop (macOS)      | NO       |
| **Stage 1.2** (cloud relay)     | Laptop        | AWS / Linux VM | Linux VM + Laptop (macOS)      | NO       |
| **Stage 3.x** (sandbox enabled) | Laptop        | (any)          | Linux VM (CHV) AND Laptop (VF) | YES      |

### Milestones (owners locked post-engagement)

| ID       | Description                                                                                                                                                                                                                                                                  | Owner                                                                          | Estimate                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **P1.0** | Wire protocol spec freeze; envelope schemas as JSON Schema; identity/auth flows                                                                                                                                                                                              | Orchestrator (drafts), dttytevx (cross-review), crd4sdom (consume-side review) | 3-5d                                                                                                                                |
| **P1.1** | brainstorm-relay v0 — TypeScript/Bun WS server, auth, signing, audit, anti-contamination sidecar                                                                                                                                                                             | Orchestrator                                                                   | 1w                                                                                                                                  |
| **P1.2** | brainstorm CLI dispatch subcommand                                                                                                                                                                                                                                           | Orchestrator                                                                   | 3-5d                                                                                                                                |
| **P1.3** | brainstorm-agent extension for operator-origin commands; per-envelope Ed25519 verification; persistent nonce store (SQLite, fail-closed under capacity pressure); adopt-fresh interfaces from Move-1 (typed-reservation Protocol, Mutator/DataProvider, ACK/PROGRESS/RESULT) | crd4sdom                                                                       | **4-6d** (revised v3.2 per crd4sdom Q3; persistent nonce store with NONCE_CACHE_FULL fail-closed semantics is more complex than 1d) |
| **P1.4** | Stage 1.0 loopback validation                                                                                                                                                                                                                                                | Orchestrator                                                                   | 1-2d                                                                                                                                |
| **P1.5** | Persistence layer (SQLite audit log, endpoint registry, command_id history)                                                                                                                                                                                                  | Orchestrator                                                                   | 3-5d                                                                                                                                |
| **P1.6** | Stage 1.1 distributed (relay on Linux VM, endpoint on Linux VM + laptop macOS)                                                                                                                                                                                               | Orchestrator                                                                   | 3-5d                                                                                                                                |
| **P1.7** | Agent-operator path (SDK dispatch primitive, agent-instance API key provisioning)                                                                                                                                                                                            | Orchestrator                                                                   | 3-5d                                                                                                                                |

### Phase 1 success gates

| Gate                            | Threshold                                                        |
| ------------------------------- | ---------------------------------------------------------------- |
| Loopback dispatch round-trip    | < 500ms p50, < 1s p99                                            |
| Distributed dispatch round-trip | < 1s p50 LAN, < 5s p99 cross-region                              |
| Concurrent dispatches           | 10 in-flight without state corruption                            |
| Auth                            | Both human + agent operator paths working                        |
| Audit                           | command_id traceable end-to-end with channel-of-origin           |
| ChangeSet preview               | Sidecar-channel delivery, not inline; operator can decline       |
| Failure handling                | Tool errors don't crash agent; network drops detected within 30s |
| Signing                         | Tampered envelopes rejected (red-team)                           |
| Cross-OS connectivity           | Both Linux and macOS endpoints connect to relay                  |

### Phase 1 cost

**Realistic:** 3-4 weeks elapsed. Bottleneck: P1.0 spec freeze (orchestrator + cross-review) + P1.7 agent-operator path.

---

## 4. Phase 2 — DEFERRED

Codex-recommended general runtime refactor. Out of MVP. Reactivation trigger: if Phase 1 surfaces tool-surface insufficiency, Phase 2 unblocks.

---

## 5. Phase 3 — Sandbox (Parallel Tracks)

**Goal:** add unified sandbox abstraction + two backends (Linux/CHV, macOS/VF) + reset machinery to brainstorm-agent.

### Threat model (P3.0 — must be drafted before any backend implementation)

**Defenders' guarantees (both backends):**

1. No state leakage between dispatches (verified by reset machinery)
2. No host filesystem access from sandbox (FS isolation)
3. No direct internet egress from sandbox (agent-mediated proxy, audited)
4. No sandbox escape to host (CHV/VF + minimal kernel + seccomp inside guest)
5. Reset is verifiable (golden-image hash compare + integrity monitor)

**Attacker model classes (v3.1 — expanded per 0bz7aztr's reconcile-state-drift finding + 12xnwqbb's anti-contamination concern):**

- **Outsider with relay credentials:** can dispatch arbitrary commands (intended; signed + audited + ChangeSet preview limits)
- **Outsider without credentials:** can't reach endpoint (no listening ports)
- **Compromised tool:** runs in sandbox; should not escape, persist across reset, or exfiltrate
- **Compromised image:** out of scope MVP
- **Compromised host agent:** out of scope MVP
- **NEW: Substrate-lying attacker.** Pattern from 0bz7aztr's brainstormVM reconcile-state-drift finding: the layer below the integrity monitor lies about its state ("HAL says running, CH says Created, 82 phantom records"). Defense: independent observability of substrate truth, not just self-reported state. Integrity monitor verifies via two paths (filesystem hash AND open-fd count AND VMM API state) and alerts on cross-source divergence.
- **NEW: Participant-orchestrator contamination.** Pattern from integration-review round 1: a layer that's both participant and adjudicator can inject directives into evidence streams. Defense: relay-side anti-contamination protocol (sidecar metadata channel; operator-payload bytes kept verbatim; channel-of-origin recorded per audit entry). Endpoint-side analog: agent doesn't inline-annotate sandbox-emitted evidence.

### Track structure (parallel after P3.0)

```
                    P3.0 (shared, threat model)
                    ─────────────────────────────
                                │
                ┌───────────────┴────────────────┐
                ▼                                ▼
        Track A: Linux                   Track B: macOS
        ─────────────                    ─────────────
        P3.1a CHV bringup                P3.1b VF bringup
        P3.2a CHV reset                  P3.2b VF reset
                │                                │
                └───────────────┬────────────────┘
                                ▼
                    P3.3 (crd4sdom — abstraction + integration)
                    P3.4 (orchestrator + crd4sdom — image build)
                                │
                ┌───────────────┴────────────────┐
                ▼                                ▼
        P3.5a Linux validation           P3.5b macOS validation
```

### Sequencing constraint (HARD)

**P3.1a does NOT start until brainstormVM vm.boot is proven E2E on bare metal.** 0bz7aztr's tonight's deploy (PR #274 + path-correction PR) is the gate. Building endpoint agent on a CHV foundation that itself isn't verified is bad engineering.

### Milestones (owners locked post-engagement)

| ID        | Description                                                                                                                                                                                                          | Owner                                                 | Advisor                                                                                         | Estimate                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **P3.0**  | Threat model + design doc; attacker classes including substrate-lying + participant-orchestrator-contamination; integrity monitor architecture                                                                       | Orchestrator (drafts)                                 | 0bz7aztr (substantive review, ~3-5d), crd4sdom (Go integration lens, light)                     | 5-7d total                                                                                                         |
| **P3.1a** | Cloud Hypervisor bringup on Linux VM; vsock + virtio-fs; manual snapshot create/revert                                                                                                                               | Orchestrator                                          | 0bz7aztr (handoff `local_executor.go` patterns + CHV API questions + 24h PR review)             | 1.5w                                                                                                               |
| **P3.2a** | Linux reset machinery; reset trigger after every dispatch + on suspicion; verification = filesystem hash compare + open-fd check + VMM API state cross-check; integrity monitor host-side                            | Orchestrator                                          | 0bz7aztr (PR review)                                                                            | 2.5w                                                                                                               |
| **P3.1b** | Apple Virtualization.framework bringup on macOS; `Code-Hex/vz` maturity check; same Linux microVM image; `VZSavedStateURL` save/restore on Sonoma+                                                                   | Orchestrator                                          | crd4sdom (Go integration support per `Sandbox` interface conformance)                           | 1.5w                                                                                                               |
| **P3.2b** | macOS reset machinery; cold-boot fallback for macOS <14; reset verification                                                                                                                                          | Orchestrator                                          | crd4sdom (PR review)                                                                            | 1.5w                                                                                                               |
| **P3.3**  | Sandbox abstraction interface (Go); integration of CHV + VF impls; stub replacement; tool registration; vsock evidence path; egress proxy (DNS/conntrack/TLS handling); GuestQuery/GuestResponse handler integration | crd4sdom                                              | Orchestrator (provides backend impls), 0bz7aztr (light advisor)                                 | **2-2.5w** (revised v3.2 per crd4sdom; egress proxy DNS/conntrack/TLS-MITM-or-not decision tree grows during impl) |
| **P3.4**  | Image build pipeline; reproducible Linux microVM; MVP tool set baked in (echo, whoami, uname, cat-file + 2-3 MSP-relevant); image hash baseline                                                                      | Orchestrator + crd4sdom (split CI/Linux package work) | 0bz7aztr (light advisor on microVM image-construction patterns from Hetzner if schedule allows) | 3-5d                                                                                                               |
| **P3.5a** | Linux validation; 1000 dispatches red-team; sandbox escape; network egress audit; reset verification injection                                                                                                       | Orchestrator                                          | 0bz7aztr (1d VF-failure-class mapping review)                                                   | 3-5d                                                                                                               |
| **P3.5b** | macOS validation; same red-team battery on VF backend; cold-boot fallback correctness                                                                                                                                | Orchestrator                                          | crd4sdom (PR review)                                                                            | 3-5d                                                                                                               |

### Phase 3 success gates (apply to both backends)

| Gate                                | Linux threshold                                                                        | macOS threshold                               |
| ----------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------- |
| Sandbox cold-boot                   | < 2s                                                                                   | < 3s                                          |
| Reset latency                       | < 500ms p50                                                                            | < 1s p50 (Sonoma+); < 5s (cold-boot fallback) |
| Dispatch latency w/ sandbox         | < 1.5s overhead vs Phase 1                                                             | < 2s overhead                                 |
| State leak (1000 dispatch red-team) | 0                                                                                      | 0                                             |
| Sandbox escape                      | None                                                                                   | None                                          |
| Network egress                      | 100% routed through agent proxy, audited                                               | Same                                          |
| Reset verification                  | Catches all injected state changes; 3-source cross-check (FS hash + open-fd + VMM API) | Same                                          |

### Phase 3 cost

**Realistic:** 7-8 weeks elapsed for the orchestrator-primary track; crd4sdom's P3.3 + P3.4 contributions run parallel.

---

## 6. Cross-Cutting Concerns

### Identity / auth (locked per §2)

- **Endpoint enrollment:** install-time bootstrap token, 24h TTL
- **Operator key issuance:** human → vault-resolved; agent → relay-issued, scoped to originating_human_id
- **Per-envelope signing:** mandatory, Ed25519, tenant key
- **Auth proof discriminated union:** HMAC default for MVP; JWT + CAF mTLS as alternative modes

### Audit

- `command_id` end-to-end correlation
- Channel-of-origin per audit entry (anti-contamination requirement)
- `evidence_hash` from sandbox hash-chains execution evidence
- Reset state hash recorded post-reset
- Integrity monitor logs all 3-source cross-checks

### Streaming

WebSocket on operator↔relay supports streaming. ProgressEvent frames as endpoint emits lifecycle state transitions.

### ChangeSet preview

For MVP: generic preview ("about to run `<tool>` with params `<json>` on endpoint `<id>` as operator `<class>:<id>`"). Sidecar-channel delivery (not inline-annotated). Tool-specific previews v1.1.

### Reconnect / offline-queue (DEFERRED)

Endpoint loses WS to relay → reconnect-loop with exponential backoff. While disconnected, operator dispatches fail with `ENDPOINT_UNREACHABLE`. No queue for MVP.

### macOS-specific concerns

- Local ad-hoc signing for MVP; notarization is v1.0 production work
- VF entitlement `com.apple.security.virtualization` required at build time
- Agent detects host version at startup, picks fast-snapshot vs cold-boot fallback

---

## 7. Risk Register

| ID            | Risk                                                                                                                        | Severity | Mitigation                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0 (NEW)**  | **Orchestrator as single-point-of-failure (Option Y consequence). If orchestrator pulled to other work, MVP slips.**        | High     | Documented; Option Y was deliberate trade-off; mitigation = explicit weekly progress markers + early-warning if pulled                                                                        |
| R1            | Reset verification turns into research project                                                                              | High     | Time-box per-track verification at 1.5w; if blowing past, drop integrity monitor (keep hash compare only) and revisit post-MVP                                                                |
| R2            | Operator-side WS connection latency under load                                                                              | Medium   | Connection pooling at relay; benchmark in P1.4                                                                                                                                                |
| R3            | CHV / VF CVE / sandbox escape                                                                                               | High     | Minimal kernel; auto-update for image only; track CVE feeds for both VMMs                                                                                                                     |
| R4            | Image distribution > 100MB                                                                                                  | Medium   | Ship-at-install assumed; switch to download-on-first-dispatch if crosses threshold                                                                                                            |
| R5            | Identity/auth design takes longer than estimated                                                                            | Medium   | P1.0 spec freeze is the bottleneck                                                                                                                                                            |
| R6            | Agent-operator audit chain incoherent (originating_human_id missing)                                                        | High     | `originating_human_id` is mandatory field; relay rejects agent dispatches without it                                                                                                          |
| R7            | Tool execution inside sandbox lacks expected runtime                                                                        | Medium   | MVP tool set intentionally minimal; image runtime versioned                                                                                                                                   |
| R8            | brainstorm-relay single point of failure                                                                                    | Medium   | Out of MVP; v1.1 work for HA                                                                                                                                                                  |
| R9            | crd4sdom's Move-1 Dual-Track-Tools work conflicts with Phase 1                                                              | Medium   | Adopt-fresh: Move-1 stabilizes this week (crd4sdom commitment); P1.3 adopts typed-reservation Protocol fresh                                                                                  |
| R10           | MSP correlation fix not landed before MVP starts                                                                            | Medium   | brainstorm-relay implements typed-reservation pattern fresh; doesn't strictly inherit MSP code                                                                                                |
| R11           | Production relay deployment target undecided                                                                                | Low      | Out of MVP scope                                                                                                                                                                              |
| R12           | macOS Sonoma not available on dev/customer Mac                                                                              | Medium   | Cold-boot fallback works on macOS 11+; documented as degraded mode                                                                                                                            |
| **R13**       | **`Code-Hex/vz` Go bindings insufficient for production**                                                                   | Medium   | P3.1b begins with maturity check; if insufficient, write thin CGo bridge directly to VF (~3-5d delta)                                                                                         |
| R14           | Apple VF entitlement signing breaks during local dev                                                                        | Low      | Local ad-hoc signing covers Justin's laptop                                                                                                                                                   |
| R15           | Two sandbox backends double maintenance/CVE surface                                                                         | Medium   | Accept; both backends use minimal Linux microVM guest, so most CVE work is shared on guest side                                                                                               |
| R16           | macOS reset latency much higher than Linux on cold-boot fallback                                                            | Medium   | Documented; macOS 14+ recommended                                                                                                                                                             |
| **R17 (NEW)** | **P3.1a gated on brainstormVM vm.boot E2E proof; if Gate 3 slips, P3.1a slips**                                             | Medium   | Sequencing constraint accepted; orchestrator can advance Track B (macOS VF) ahead of Track A while waiting                                                                                    |
| **R18 (NEW)** | **Substrate-lying attacker class (reconcile-state-drift pattern from 0bz7aztr) requires 3-source cross-check**              | High     | Integrity monitor verifies via FS hash + open-fd count + VMM API state; cross-source divergence triggers alert                                                                                |
| **R19 (NEW)** | **dttytevx's claim "Justin rescinded Codex for MSP" remains [relayed] from orchestrator session; not first-hand confirmed** | Low      | Per-peer trust model holds (D8 corrected); orchestrator durable Codex rule applies to own code; crd4sdom durable rule applies to brainstorm-agent code; not propagated as universal precedent |

---

## 8. Sequencing

```
WEEK 0   ┌─ P1.0 spec freeze (orch + dttytevx + crd4sdom review)
         └─ Move-1 stabilization (crd4sdom, parallel)
                          │
WEEK 1-2 ▼
         ┌─ P1.1 relay (orch) ────────────┐
         ├─ P1.2 CLI (orch) ──────────────┤
         └─ P1.3 agent ext (crd4sdom) ────┤
                                          │
WEEK 3   ▼                                ▼
         P1.4 loopback ─► P1.5 persist ─► P1.6 distributed ─►
                                                          │
WEEK 4   ▼                                                ▼
         P1.7 agent path

                          [brainstormVM vm.boot E2E gate]

WEEK 5   ┌─ P3.0 threat model (orch draft, 0bz advise) ───┐
                                                          │
WEEK 6-9 ▼                                                ▼
         ┌── Track B macOS ──┐    ┌── Track A Linux ──┐
         │  P3.1b VF bringup │    │  P3.1a CHV bringup│
         │  P3.2b VF reset   │    │  P3.2a Linux reset│
         └─────────┬─────────┘    └─────────┬─────────┘
                   │                        │
WEEK 10  ▼─────────┴──────┬─────────────────┘
         P3.3 abstraction (crd4sdom) + P3.4 image (orch+crd4sdom)
                                          │
WEEK 11  ▼
         P3.5a Linux + P3.5b macOS validation ─► MVP demonstrable
```

**Realistic ETA: 10-13 weeks elapsed** from kick to MVP-demonstrable.

Optimistic 9 weeks if P3.0 threat model + P3.1b VF bringup go faster than estimated. Pessimistic 16 weeks if reset verification or Code-Hex/vz maturity issues blow past time-boxes.

---

## 9. Decisions Locked

| #                      | Decision                                                                                            | Value                                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1                     | Endpoint OS                                                                                         | Linux + macOS                                                                                                                                                                                                                                     |
| D2                     | Phase 1 commitment                                                                                  | Full implementation                                                                                                                                                                                                                               |
| D3                     | Sandbox VMM                                                                                         | CHV (Linux) + VF (macOS), unified Go abstraction                                                                                                                                                                                                  |
| D4                     | Sandbox lifecycle                                                                                   | Persistent VM with reset                                                                                                                                                                                                                          |
| D5                     | Operator → Relay protocol                                                                           | WebSocket-over-TLS                                                                                                                                                                                                                                |
| D6                     | Initial deployment                                                                                  | Justin's laptop full-stack + AWS/VM testbed                                                                                                                                                                                                       |
| D7                     | Customer endpoint state                                                                             | Greenfield                                                                                                                                                                                                                                        |
| **D8**                 | **Codex involvement (CORRECTED in v3.1 from "opportunistic project-wide" to per-peer pluralistic)** | **Per-peer trust model: dttytevx MSP-rescinded (relayed claim); orchestrator durable rule for own code; crd4sdom durable rule for agent code; 12xnwqbb direct-only; 0bz7aztr relay-trust-with-provenance**                                        |
| D9                     | Relay architecture                                                                                  | NEW Brainstorm-platform service                                                                                                                                                                                                                   |
| D10                    | Endpoint identity                                                                                   | Per-endpoint UUID + per-tenant Ed25519 keypair                                                                                                                                                                                                    |
| **D11**                | **Operator class envelope (REFINED v3.1)**                                                          | **`{ kind, id, auth_proof, originating_human_id?, delegating_principal_id? }` — `parent_human_id` renamed to `originating_human_id` (root); `delegating_principal_id` for chain-depth >2**                                                        |
| D12                    | Per-envelope signing                                                                                | Mandatory, Ed25519, tenant key                                                                                                                                                                                                                    |
| D13                    | Reset frequency                                                                                     | Every dispatch + on suspicion                                                                                                                                                                                                                     |
| D14                    | Sandbox image distribution                                                                          | Ship at install                                                                                                                                                                                                                                   |
| D15                    | Verification approach                                                                               | Hash compare AND integrity monitor (both, 3-source cross-check)                                                                                                                                                                                   |
| D16                    | Reconnect / offline queue                                                                           | Deferred to v1.1                                                                                                                                                                                                                                  |
| D17                    | Production relay deploy target                                                                      | Open; not blocking MVP                                                                                                                                                                                                                            |
| D18                    | Endpoint enrollment                                                                                 | Install-time bootstrap token, 24h TTL                                                                                                                                                                                                             |
| D19                    | Audit log storage                                                                                   | SQLite at relay, channel-of-origin per entry                                                                                                                                                                                                      |
| D20                    | ChangeSet preview                                                                                   | Generic preview MVP, sidecar-channel; tool-specific v1.1                                                                                                                                                                                          |
| D21                    | Network egress from sandbox                                                                         | Agent-proxied, audited                                                                                                                                                                                                                            |
| D22                    | MVP tool set                                                                                        | echo, whoami, uname, cat-file + 2-3 MSP-relevant                                                                                                                                                                                                  |
| D23                    | macOS minimum version                                                                               | macOS 14 Sonoma+ for fast snapshot; macOS 11+ cold-boot fallback                                                                                                                                                                                  |
| D24                    | macOS notarization                                                                                  | Deferred to v1.0 production work                                                                                                                                                                                                                  |
| D25                    | VF Go bindings                                                                                      | `Code-Hex/vz` candidate; maturity-check at P3.1b start                                                                                                                                                                                            |
| D26                    | Sandbox abstraction interface                                                                       | Go interface; backend selected via `runtime.GOOS`                                                                                                                                                                                                 |
| **D27 (NEW)**          | **Auth proof discriminated union**                                                                  | **HMAC-signed-envelope (default MVP), JWT (alternative), CAF mTLS (CAF-enrolled operators, v1.0)**                                                                                                                                                |
| **D28 (NEW)**          | **Mandatory envelope fields**                                                                       | **`tenant_id` and `correlation_id` mandatory from MVP (federation + cross-product join)**                                                                                                                                                         |
| **D29 (NEW)**          | **Lifecycle state vocabulary**                                                                      | **7-state: `pending\|dispatched\|started\|progress\|completed\|failed\|timed_out` (federated with MSP correlation work + BR routing-stream)**                                                                                                     |
| **D30 (NEW)**          | **Anti-contamination protocol**                                                                     | **Relay keeps operator-payload bytes verbatim; sidecar metadata channel never confused with operator content; channel-of-origin per audit entry**                                                                                                 |
| **D31 (REVISED v3.2)** | **P3.3 estimate**                                                                                   | **2-2.5 weeks (revised from 1.5-2w per crd4sdom's full-spec read; egress proxy decision tree complexity)**                                                                                                                                        |
| **D34 (NEW v3.2)**     | **P1.3 estimate**                                                                                   | **4-6 days (revised from 3-5d per crd4sdom Q3; persistent nonce store with fail-closed semantics)**                                                                                                                                               |
| **D35 (NEW v3.2)**     | **§4.1 threat model — CHV snapshot/restore characterization is NEW work, not pre-existing**         | **Per 0bz7aztr correction: brainstormVM verified prior art covers vm.create/boot/delete + vm.info + per-VM disk; snapshot/restore is P3.1a deliverable. 1000-iteration latency distribution + failure mode catalog with 0bz7aztr advisor input.** |
| **D36 (NEW v3.2)**     | **CommandAck mandatory message**                                                                    | **Endpoint emits ACK after envelope verification, before sandbox dispatch; carries `track`, `will_emit_progress`, `estimated_duration_ms`. Lifecycle `dispatched → started` is explicit on ACK. Joint MSP correlation position alignment.**       |
| **D32 (NEW)**          | **P3.1a sequencing gate**                                                                           | **Does NOT start until brainstormVM vm.boot proven E2E on bare metal (per 0bz7aztr's sequencing constraint)**                                                                                                                                     |
| **D33 (NEW)**          | **Staffing model**                                                                                  | **Option Y selected: both backends, orchestrator primary on Linux + macOS sandbox tracks; ~10-13 weeks realistic; single-orchestrator-primary as accepted cost**                                                                                  |

---

## 10. Post-MVP Backlog

- Multi-product tool surface (Codex Phase 2)
- Endpoint-side ChangeSet enforcement
- Windows endpoint support via Wasm runtime
- Reconnect / offline command queue
- Fleet management (discovery, dashboards, agent auto-update)
- Per-tool ChangeSet preview functions
- Compliance certification work
- HA brainstorm-relay
- Production relay deployment target finalization
- Tool packaging dynamic injection (vs. baked into image)
- Reproducible image builds with signature verification
- Hardware-rooted attestation
- Multi-tenant refinement
- Operator UX polish
- Customer audit log export (signed-evidence bundles)
- macOS distribution: code-signing + notarization (Apple Developer Program enrollment)
- MSP migration to consume brainstorm-platform relay (eliminates dual-signature-path cost)

---

## 11. Peer Dependencies (LOCKED post-engagement)

| Peer                         | Locked commitment                                                                                                                                                                                                                                                                                                                                                                                               | Total time                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **orchestrator** (this peer) | P1.0 spec freeze; P1.1 relay; P1.2 CLI; P1.4-P1.7; P3.0 draft; P3.1a + P3.2a Linux track primary; P3.1b + P3.2b macOS track primary; P3.3 backend impls (crd4sdom integrates); P3.4 share with crd4sdom; P3.5a + P3.5b validation                                                                                                                                                                               | ~10-13 weeks (Option Y consequence)      |
| **crd4sdom**                 | P1.3 agent operator-origin extension (4-6d, v3.2 revised); P3.0 review (Go integration lens, DONE 2026-04-26); P3.3 sandbox abstraction primary (Reading A, 2-2.5w v3.2 revised); P3.4 share with orchestrator; Move-1 stabilizing this week to anchor adopt-fresh interfaces; durable Codex rule applies to all agent-side contributions; protocol spec v2 cross-review DONE (7 findings, all addressed in v3) | ~4-5.5 weeks focused work (v3.2 revised) |
| **0bz7aztr**                 | P3.0 threat model substantive review (3-5d); P3.1a CHV technical advisor (handoff `local_executor.go` + 24h PR review); 1d VF-failure-class mapping; P3.4 light advisor on microVM image patterns if schedule allows; P3.1a sequencing gate = brainstormVM vm.boot E2E proof                                                                                                                                    | ~6-8d over MVP window                    |
| **dttytevx**                 | P1.0 wire-protocol cross-review; audit-chain cross-review for relay platform-vs-MSP-extension framing                                                                                                                                                                                                                                                                                                           | Light, awaiting reply                    |
| **12xnwqbb**                 | Out of MVP critical path; substantive design feedback adopted into v3.1 (D27 D28 D29 D30; auth_proof discriminated union; originating_human_id rename; tenant_id + correlation_id mandatory; 7-state vocab; anti-contamination protocol)                                                                                                                                                                        | Done unless re-engaged                   |

---

## 12. Status

**Plan-set. Phase 1 P1.0 spec freeze begins on Justin's go-ahead.**

Move-1 stabilization (crd4sdom) runs in parallel through end of week 0 to anchor adopt-fresh interfaces by P1.3 kick.

P3.1a sequencing gate watching for brainstormVM vm.boot E2E proof on bare metal (0bz7aztr's tonight's deploy + Gate 3).

---

## Appendix A: Glossary

- **Dispatch** — operator-initiated request to execute a tool on a specific endpoint
- **Endpoint** — a customer-owned Linux or macOS machine running brainstorm-agent
- **Operator** — entity issuing dispatches; either human (CLI) or autonomous Claude agent (SDK)
- **Relay** — Brainstorm-platform service that mediates between operators and endpoints
- **Sandbox** — microVM running on the endpoint, executes tools in isolation
- **CHV** — Cloud Hypervisor (Linux backend)
- **VF** — Apple Virtualization.framework (macOS backend)
- **Reset** — sandbox state-clear cycle: snapshot revert + verification, between dispatches
- **command_id** — UUID assigned by relay at dispatch time, threaded through entire chain
- **CommandEnvelope** — signed dispatch payload from relay → endpoint
- **CommandResult** — endpoint → relay payload with execution outcome
- **ChangeSet preview** — operator-visible summary of what's about to happen
- **SOUL** — agent identity primitive (per `project_br_agent_identity.md`)
- **originating_human_id** — root human in dispatch chain
- **delegating_principal_id** — immediate parent in chain depth >2
- **Anti-contamination protocol** — relay-side discipline keeping operator-payload bytes verbatim; integration-review v1.2 lessons applied
- **Substrate-lying attacker** — pattern from reconcile-state-drift; layer below integrity monitor lies about its state

## Appendix B: Reference Materials

- `docs/platform-contract-v1.md`
- `~/Projects/brainstormmsp/app/api/edge/websocket.py` — MSP relay reference
- `~/Projects/brainstorm-agent/` — existing brainstorm-agent codebase
- Codex fresh-perspective transcript (2026-04-25)
- MSP correlation fix design (round-2 integration review work, 2026-04-23)
- `~/.brainstorm/integration-reviews/runs/2026-04-23T12-43-22Z-dttytevx-c93bb/`
- 0bz7aztr's `project_reconcile_state_drift.md` (referenced for substrate-lying attacker class)
- Anthropic Dispatch documentation
- Apple Virtualization.framework documentation
- Cloud Hypervisor
- `Code-Hex/vz` (Go bindings for VF)
