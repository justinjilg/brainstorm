# Brainstorm Endpoint Agent — Threat Model & Integrity Monitor Design

**Status:** DRAFT v1.1 (post-0bz7aztr-review revision) — 2026-04-26
**Scope:** sandbox + agent + relay layers of the dispatch system
**Cross-review gate:** orchestrator draft → 0bz7aztr substantive review (DONE, Linux backend lens) → v1.1 revision → 0bz7aztr round 2 + crd4sdom Go-integration lens → finalize

**v1.1 changelog (key changes from v1):**

- §4.1: misattribution of brainstormVM CHV snapshot/restore as "well-tested in production" CORRECTED — production prior art is `vm.create/boot/delete + vm.info`, NOT snapshot/restore. Snapshot/restore characterization is NEW work in P3.1a.
- §3.1 A6: sub-classified into A6a (false-existence) + A6b (false-state); architectural caveat added (monitor at agent/VMM boundary, NOT CP/HAL).
- §5.1: settling-period rule (`T_settling = 5s`) added to handle source-readiness asymmetry post-reset.
- §5.2: heterogeneity claim tightened — "different application-layer surfaces, sharing kernel-layer trust" instead of "different attack surfaces."
- §5.5: explicit limitation added — monitor does NOT observe layers above agent/VMM boundary (CP/HAL out of scope).
- §4.4: split RESET_VERIFICATION_DIVERGENCE (immediate halt) vs RESET_VERIFICATION_TIMEOUT (one retry); explicit ErrorEvent to relay's monitoring channel for ops visibility.
- §7: T5 caveats added; new tests T5c (baseline tamper), T5d (false-existence), T13 (gRPC race), T14 (agent restart), T15 (disk collision) — all from 0bz7aztr's debugging this week.

---

## 1. Scope

This document is the threat model for the Brainstorm endpoint-agent dispatch MVP: the boundaries between operator, brainstorm-relay, brainstorm-agent (Linux + macOS endpoints), and the microVM sandbox (Cloud Hypervisor or Apple Virtualization.framework).

In scope:

- The endpoint host (the customer machine running brainstorm-agent)
- The microVM sandbox running on that host (Linux guest, executed via CHV or VF)
- The agent ↔ sandbox vsock interface
- Reset machinery and integrity monitor (the core defense against state leakage between dispatches)
- The signed envelope path from relay → agent → sandbox

Out of scope (referenced for completeness, not protected):

- Operator endpoint security (the operator's machine running brainstorm CLI / SDK)
- Relay infrastructure security beyond the relay-issued signing keys
- Compromised operator credentials (relay-side concern; treated as authenticated even when malicious)
- Hardware-rooted attestation of the host agent (post-MVP)
- Reproducible image build pipeline trust (post-MVP; image is treated as trusted at MVP boundary)

This document is the **defender's** view. It states what we promise, what we explicitly do not promise, what attackers can do, and what the integrity monitor must observe.

---

## 2. Defender's Guarantees (MVP)

What an auditor or compliance reviewer can rely on, with hash-verifiable evidence:

**G1 — No state leakage between dispatches.** Tool execution in dispatch N cannot read state created by dispatch N-1, after a successful reset. Verified by the 3-source reset-verification mechanism (§5.1).

**G2 — No host filesystem access from sandbox.** The sandbox FS is a copy-on-write microVM image; the host FS is reachable only via agent-mediated virtio-fs paths the agent explicitly chooses to expose. The default exposure is a single shared-fs mount (read-only inputs, write-once outputs).

**G3 — No direct internet egress from sandbox.** All network traffic from inside the sandbox is routed through a host-side agent proxy. The agent decides what egresses; every egress is audited.

**G4 — No sandbox escape to host.** The microVM (CHV or VF) runs with minimal kernel + seccomp inside the guest; default-deny network namespaces; no shared memory beyond the explicitly-mediated virtio devices.

**G5 — Reset is verifiable.** After every dispatch, before the next dispatch is admitted, the agent's integrity monitor performs 3-source cross-check (filesystem hash, open-fd count, VMM API state). Any divergence triggers `RESET_VERIFICATION_DIVERGENCE` and the agent enters degraded mode.

**G6 — Audit chain integrity.** Every dispatch produces an end-to-end command_id-correlated audit trail with channel-of-origin discipline (verbatim operator bytes; relay-stamped metadata; endpoint-stamped result; sandbox-stamped evidence). Auditor can replay and verify hashes.

**G7 — Cross-endpoint envelope replay defense.** Per protocol §3.3, signed envelopes carry `target_endpoint_id`. An envelope intended for endpoint A cannot be replayed against endpoint B even within the same tenant, even within the `expires_at` window.

**G8 — Cross-context signature replay defense.** Per protocol §3.3, signing context prefix domain-separates CommandEnvelope, ConnectionProof, BootstrapToken, and OperatorHmac. A signature from one context cannot be reused in another.

**Explicitly NOT promised at MVP:**

- Defense against compromised host agent (the agent is in the trust base)
- Defense against compromised image (the image is in the trust base; reproducible-build trust is post-MVP)
- Defense against side-channel attacks (Spectre/Meltdown class) inside the microVM
- Defense against physical access to the customer endpoint
- Defense against a compromised relay's signing keys (relay key compromise = full mesh compromise; key rotation is post-MVP)

---

## 3. Attacker Model

### 3.1 Attacker classes (formal enumeration)

**A1 — Outsider with relay credentials.** Holds valid operator API key (human or agent class). Can issue arbitrary `DispatchRequest` to any endpoint they have authorization for.

- _Capabilities granted:_ dispatch tools, observe results, see audit log entries scoped to their tenant.
- _Capabilities denied:_ impersonate other operators (different HMAC key), forge envelopes (don't have tenant signing key), bypass ChangeSet preview, bypass rate limits.
- _Threat severity:_ low — this is the intended access path; ChangeSet preview + audit are the controls.

**A2 — Outsider without credentials.** Network attacker; possibly on the path between operator/endpoint and relay.

- _Capabilities granted:_ observe TLS-encrypted traffic (limited; metadata only), attempt connections to relay/endpoint endpoints.
- _Capabilities denied:_ originate dispatches (no auth proof), connect to endpoint directly (no listening ports), forge envelopes (no signing key), MITM signed envelopes (TLS + per-envelope signing).
- _Threat severity:_ low — TLS + signing + no-listening-ports closes most paths.

**A3 — Compromised tool inside the sandbox.** A tool with code-execution that an attacker has corrupted (e.g., compromised dependency in the image, or a tool that takes attacker-controlled params).

- _Capabilities granted:_ arbitrary code execution inside the sandbox; read sandbox FS; attempt sandbox escape; attempt network egress; produce arbitrary EvidenceChunks.
- _Capabilities denied:_ persist across reset (G1/G5 defense), access host FS (G2), egress directly (G3), escape to host (G4 — depends on VMM hardness).
- _Threat severity:_ medium — this is the primary attacker class the sandbox isolates.

**A4 — Compromised image (BUILD-TIME).** An attacker with write access to the image build pipeline ships malicious binaries inside the microVM image.

- _Capabilities granted:_ arbitrary code execution inside the sandbox at startup; modify reset-verification output to falsely report `verification_passed: true`; corrupt the integrity monitor's golden hash baseline.
- _Capabilities denied:_ nothing inside the sandbox.
- _Threat severity:_ HIGH but EXPLICITLY OUT OF MVP SCOPE. Defended post-MVP via reproducible builds + signature verification on image.

**A5 — Compromised host agent.** An attacker who has gained code execution inside the brainstorm-agent process on the host.

- _Capabilities granted:_ forge endpoint→relay frames (using agent's keypair), bypass integrity monitor (the monitor IS the agent), accept arbitrary CommandEnvelopes the relay didn't sign (skip signature verification), inject false ResetAcks.
- _Capabilities denied:_ forge relay's tenant-signing key signatures (agent doesn't have it).
- _Threat severity:_ HIGH but EXPLICITLY OUT OF MVP SCOPE. Defended post-MVP via hardware-rooted attestation and minimal-trust agent supervisor pattern.

**A6 — Substrate-lying attacker (NEW v3.1 attacker class, sub-classified v1.1 per 0bz7aztr).** The layer beneath the integrity monitor lies about its state. Sub-classified into two patterns:

- **A6a — False-existence:** lifecycle truthfulness compromised. Pattern from 0bz7aztr's brainstormVM finding: 82 phantom HAL records with no corresponding CHV VM. CP/HAL claimed "exists" when nothing existed.
- **A6b — False-state:** freshness/cache-staleness compromised. Pattern from same finding: HAL reports `state: running` while CHV reports `state: Created`. Both records exist; one is stale.

**Architectural caveat (NEW v1.1):** the integrity monitor sits at the **agent/VMM boundary**, NOT the CP/HAL boundary. The 82-phantom case originally surfaced at CP/HAL would NOT have been caught by the integrity monitor as designed — phantoms are at a layer the monitor doesn't observe. The 3-source design catches CHV-layer lies; CP-layer lies are a separate problem (out of MVP scope).

- _Capabilities granted:_ depends on which substrate is lying. A6a (false-existence): could grant attacker the ability to claim a VM exists/is-fresh when it doesn't, slipping a stale rootfs into the next dispatch. A6b (false-state): could grant the ability to skip reset verification by reporting "Running" while VM is halted.
- _Capabilities denied:_ lying coherently across all three sources at the agent/VMM boundary is significantly harder than lying on one. **Heterogeneity caveat (NEW v1.1):** the three sources are different application-layer surfaces (storage, kernel introspection, VMM control-plane) sharing kernel-layer trust. Kernel-level host compromise lies through all three simultaneously; this is accepted via the kernel-as-trust-anchor in §3.2.
- _Threat severity:_ medium-to-high. 3-source cross-check (§5.1) is the primary defense at agent/VMM boundary; one source disagreeing → halt.

**A7 — Participant-orchestrator contamination (NEW v3.1 attacker class).** A layer that is structurally both a participant (originating its own data) and an orchestrator (collecting/forwarding others' data) injects its own framings into the stream of others' data. Pattern from integration-review round-1 audit failure: the round orchestrator (dttytevx) appended `[AUDITOR/ASSESSOR NOTE]` annotations into peer evidence files between Phase 1 collection and Phase 3 dispatch, contaminating 7 of 10 assessor outputs.

- _Capabilities granted:_ depends on which participant-orchestrator. The relay is structurally a participant-orchestrator for every dispatch (mints command_id, forwards operator content, collects endpoint results). A compromised or buggy relay could inject metadata into operator-content streams or rewrite endpoint results before audit.
- _Capabilities denied:_ the AuditLogEntry wrapper schema (protocol §8) structurally enforces channel_of_origin discipline; the operator-content payload_canonical_hash mismatches if relay has mutated bytes.
- _Threat severity:_ medium. Defended structurally in v2 protocol via AuditLogEntry §8 — operator-bytes are hashed verbatim; relay metadata is in sidecar fields, never inline.

**A8 — Cross-endpoint replay attacker.** Has captured a valid signed CommandEnvelope intended for endpoint A; attempts to replay it against endpoint B in the same tenant within the `expires_at` window.

- _Capabilities granted:_ attempted replay only.
- _Capabilities denied:_ envelope is signed with `target_endpoint_id` = A; endpoint B verifies and rejects with `WRONG_AUDIENCE`.
- _Threat severity:_ low at MVP — defended in protocol v2.

**A9 — Cross-context replay attacker.** Has captured a valid Ed25519 signature from one context (e.g., a CommandEnvelope signature) and attempts to use it as a different context (e.g., a connection proof).

- _Capabilities granted:_ attempted replay only.
- _Capabilities denied:_ signing context prefix (`brainstorm-cmd-envelope-v1\x00` vs `brainstorm-conn-proof-v1\x00`) ensures the signed bytes differ across contexts even if the underlying object is identical.
- _Threat severity:_ low — defended in protocol v2.

**A10 — Replay after agent restart.** An attacker who captured a signed envelope before agent restart; replays after the in-memory nonce-LRU is empty.

- _Capabilities granted:_ attempted replay only.
- _Capabilities denied:_ protocol §3.3 mandates persistent (SQLite or equivalent) nonce store, NOT in-memory only.
- _Threat severity:_ low — defended in protocol v2.

### 3.2 Trust anchors (what we trust unconditionally at MVP)

- The host operating system (Linux kernel for endpoint Linux; macOS Darwin kernel for endpoint macOS)
- The VMM binary (Cloud Hypervisor or Apple Virtualization.framework)
- The microVM image at install time (until reproducible-builds trust ships post-MVP)
- The brainstorm-agent binary on the host (until hardware-rooted attestation ships post-MVP)
- The relay's tenant signing keys (until key-rotation ships post-MVP)
- The endpoint's locally-stored Ed25519 private key (file with 0600 permissions; Keychain/macOS-specific later)
- The integrity monitor process (which is part of the agent; same trust)

A vulnerability in any trust anchor is a complete compromise. The MVP design accepts these as trust anchors without mitigation; post-MVP work hardens each.

---

## 4. Reset Granularity per Backend

The two backends differ in their snapshot/restore APIs and operational characteristics. This section makes the reset choice explicit per backend.

### 4.1 Linux / Cloud Hypervisor

**Reset method:** VM stop + restore from snapshot + restart.

**Snapshot baseline:** post-boot, post-tool-init, pre-first-dispatch state. Captured once at agent install + image-version-bump time.

**Snapshot mechanism:** Cloud Hypervisor's `snapshot` API:

- `POST /api/v1/vm.snapshot` with `destination_url: "file:///path/to/snapshot"` after baseline boot
- `POST /api/v1/vm.restore` with the snapshot path before next dispatch
- Both APIs documented and stable in CHV ≥ 0.30

**Reset latency target:** < 500ms p50.

**Why VM stop + restore vs in-place revert:**

- CHV's snapshot/restore APIs are documented in CHV ≥ 0.30 release notes. **Characterizing latency, reliability, and integrity at scale is a P3.1a deliverable, not a pre-existing assumption.** brainstormVM's verified prior art covers `vm.create` / `vm.boot` / `vm.delete` + `vm.info` state queries + per-VM disk lifecycle (verified 2026-04-26T21:56:11Z). Snapshot/restore characterization is NEW work.
- In-place revert (rolling back filesystem cow-snapshot without VM stop) is faster but less defensible — kernel state, page cache, hot CPU caches all persist, and we'd need to argue these don't carry exploitable state
- For MVP we accept the latency cost in exchange for "fresh boot from golden state" auditor-defensibility

**P3.1a deliverable (NEW v1.1, contributed by 0bz7aztr correction):** snapshot/restore characterization on Hetzner with 1000-iteration latency distribution + failure mode catalog. Required before P3.2a Linux reset machinery can claim defensible reset semantics.

**Substrate-lying defense (A6) for CHV path:**

- Source 1: filesystem hash (read FS image bytes from the snapshot file, hash)
- Source 2: open-fd count (queried via CHV's `vm.info` API)
- Source 3: VMM API state (CHV's `vm.info` returns `state: Running` post-restore)
- Cross-check: all three must report consistent post-reset state. Any divergence → `RESET_VERIFICATION_DIVERGENCE`.

### 4.2 macOS / Apple Virtualization.framework

**Reset method:** VM stop + restore from saved-state file + restart.

**Snapshot baseline:** same shape as Linux (post-boot, post-tool-init, pre-first-dispatch).

**Snapshot mechanism:**

- macOS 14 Sonoma+: `VZVirtualMachine.saveMachineState(to:)` and `VZVirtualMachine.restoreMachineState(from:)` provide native fast snapshot/restore
- macOS 11-13: no native snapshot API — fall back to **cold-boot reset** (VM stop, fresh boot from disk image). Slower (~2-5s) but functionally equivalent guarantee.
- Agent detects host macOS version at startup; logs `sandbox_mode: fast_snapshot` or `sandbox_mode: cold_boot_fallback`.

**Reset latency target:** < 1s p50 on Sonoma+; < 5s on cold-boot fallback.

**Why VM stop + restore for macOS too:**

- Same reasoning as Linux: fresh boot from golden state is more defensible than in-place revert
- VF's saved-state APIs are stable on macOS 14+; cold-boot fallback is also well-defined

**Substrate-lying defense (A6) for VF path:**

- Source 1: filesystem hash (read disk image bytes from saved-state file or fresh disk image)
- Source 2: open-fd count (queried via VF's `state` property + per-process introspection)
- Source 3: VMM API state (VF's `state` enum: `.stopped`, `.running`, `.paused`, `.error`)
- Cross-check: all three must report consistent post-reset state.

**Cold-boot fallback specifics:** since there's no saved state to compare against, "filesystem hash" baseline = the original disk image hash on disk. Reset is "shutdown VM, hash current disk image, compare to baseline, boot fresh." Slightly different code path; same guarantee.

### 4.3 Reset trigger policy (uniform across backends)

**Trigger: after every successful dispatch.** This is the default; per protocol §3.3 D13.

**Additional triggers:**

- On suspicion: integrity monitor flags an anomaly (e.g., open-fd count grew during dispatch beyond expected) → reset before next dispatch admitted
- On idle (post-MVP): if no dispatch has occurred for N minutes, reset to baseline as health check
- On error: any tool-side error or CommandResult `failed` triggers reset (even though state may have been corrupted, we don't trust it)

**Trigger NOT used:** background reset on a timer. The reset is dispatch-bounded; idle-reset is post-MVP.

### 4.4 Reset failure handling

Reset failures fall into two distinct classes (NEW v1.1, contributed by 0bz7aztr — the v1 absolute "no auto-recovery" missed a real distinction):

**Class 1 — RESET_VERIFICATION_DIVERGENCE.** A single source disagrees with expected. **Halt immediately, no retry.** Active claim of state implies attack or substantive bug; retrying would mask the lie. Examples: filesystem hash mismatch with non-zero diff; open-fd count > baseline; VMM API returns unexpected state.

**Class 2 — RESET_VERIFICATION_TIMEOUT.** All 3 sources are silent past `T_settling` (no responses received). **One retry with `T_settling` backoff, then halt if still silent.** Distinguishes "transient infrastructure issue" (guest agent not yet up, VMM still in transition, snapshot file write not synced) from "real attack." Real-world pattern from 0bz7aztr: 50% of brainstormVM "manual interventions" were functionally a `systemctl restart` — i.e., a retry that hadn't been wired in. Auto-retry-once-then-degraded is honest about that.

**Defense-in-depth caveat:** retry on a security gate creates attack surface. Defended via: only retry when ALL sources silent (no divergence to mask). Single-source divergence implies an active lie; no retry possible — halt.

**Common path on either class:**

- Agent enters **degraded mode** post-halt: refuses next dispatch
- Agent emits `ErrorEvent { code: "RESET_VERIFICATION_DIVERGENCE" | "RESET_VERIFICATION_TIMEOUT" | "RESET_FAILED" | "INTEGRITY_MONITOR_TRIPPED" }` to relay
- **Relay's monitoring channel** (NEW v1.1, ops-visibility): the same ErrorEvent is also forwarded to the relay's monitoring/alerting subscribers (per protocol §8 audit channel) so operators are notified explicitly — degraded mode shouldn't be inferred from "endpoint suddenly unreachable."
- Relay marks endpoint as `unreachable`; future dispatches fail with `RELAY_ENDPOINT_UNREACHABLE`
- Operator/admin must manually intervene: inspect agent logs, identify cause, re-enroll endpoint or restart agent
- Audit entry recorded at `channel_of_origin = "endpoint"` with full verification_details

The agent does NOT auto-recover from divergence (active lie). Auto-recovery on a divergence boundary is exactly the wrong design; one-retry on universal-silence is the only auto-recovery permitted, and only because no divergence has occurred yet to mask.

---

## 5. Integrity Monitor Architecture

### 5.1 3-source verification (the core mechanism)

The integrity monitor is a host-side observer (part of the brainstorm-agent process) that performs 3-source cross-check after every reset.

**Settling-period rule (NEW v1.1, contributed by 0bz7aztr):** sources have different "ready" times post-reset. Source 1 (FS hash) is ready immediately after restore writes; Source 2 (guest open-fd) requires guest agent up — typically seconds; Source 3 (VMM API state) requires VMM transition complete. Querying before all three are ready produces false-positive divergence from settling-period transients, not real attacks.

**Rule:** wait for all 3 sources to be queryable, OR `T_settling = 5s` elapsed since reset complete (whichever first), before evaluating unanimity. If `T_settling` expires with any source still silent → `RESET_VERIFICATION_TIMEOUT` (NOT `RESET_VERIFICATION_DIVERGENCE`; see §4.4).

**Source 1 — Filesystem hash:**

- Compute SHA-256 of the post-reset disk image bytes
- Compare against `golden_hash_baseline` recorded at install time
- Divergence: hash mismatch indicates filesystem state survived reset (possible tool persistence, possible compromised reset machinery)

**Source 2 — Open-fd count (on the guest, queried via VMM):**

- Count open file descriptors inside the guest at reset complete
- Compare against `open_fd_count_baseline` recorded at install time (typically 3-5 for the minimal Linux microVM: stdin/stdout/stderr + a couple of agent-init fds)
- Divergence: extra open fds indicate processes survived reset (possible tool background process, possible compromised guest agent)

**Source 3 — VMM API state:**

- Query VMM for VM state: `Running` post-restore, with no pending events
- For CHV: `GET /api/v1/vm.info` returns state enum
- For VF: `state` property returns enum
- Divergence: VM state inconsistent with "fresh post-restore" indicates VMM lying (substrate-lying attacker A6) or VMM bug

**Cross-check rule:** all three sources must agree on "fresh post-reset state." Any one source disagreeing → `verification_passed = false`, `divergence_action = "halt"`, agent enters degraded mode.

### 5.2 Substrate-lying defense (A6)

The 3-source design is the primary defense against A6. Lying coherently across all three is significantly harder than lying on one because:

- The three sources have **different application-layer surfaces** (NEW v1.1 clarification per 0bz7aztr): filesystem (storage layer abstraction), open-fd (kernel introspection abstraction), VMM API (control-plane abstraction).
- An attacker compromising the filesystem-hash function alone would be caught by VMM API state and open-fd cross-check.
- An attacker compromising the VMM API alone would be caught by filesystem hash.
- An attacker compromising the guest agent (open-fd source) alone would be caught by FS hash and VMM API.
- An attacker compromising all three simultaneously requires coordinating the lie across multiple application surfaces.

**Heterogeneity caveat (NEW v1.1):** the three sources are different at the **application layer** but ultimately observed via syscalls into the **same host kernel**. Kernel-level host compromise can lie through all three simultaneously. §3.2 lists the kernel as a trust anchor explicitly — this is correct, and the heterogeneity claim above is "different application-layer surfaces, sharing kernel-layer trust." Defense-in-depth via heterogeneous application surfaces is meaningful but bounded by the kernel trust anchor.

**Worked examples (NEW v1.1, from 0bz7aztr's prior art):**

- **82-phantom case (A6a false-existence at CP/HAL boundary):** all 3 sources at agent/VMM boundary correctly fail (silence — no disk, no guest, no socket). Unanimity holds; if this pattern manifested at agent/VMM boundary, it would be caught. NOTE the architectural caveat: phantoms originally surfaced at CP/HAL boundary, which is OUT of monitor scope (§5.5).
- **548-zombie case (A6b false-state at agent/VMM boundary):** Source 1 succeeds (disk exists), Source 2 fails (no guest agent up), Source 3 returns "Created" not "Running." 2 of 3 disagree. Caught by strict unanimity rule.

### 5.3 Cross-backend uniform interface

The integrity monitor is one piece of code (Go, in brainstorm-agent) that talks to two backends through the `Sandbox` interface:

```go
type Sandbox interface {
    // ... (Boot, Dispatch, Shutdown per protocol)
    Reset() error
    VerifyResetIntegrity() (VerificationDetails, error)
}
```

`VerifyResetIntegrity` is implemented per backend:

- `CloudHypervisorSandbox`: queries CHV API for VM state + reads snapshot disk image for FS hash + queries open-fd via guest agent
- `VirtualizationFrameworkSandbox`: queries VF state property + reads saved-state file for FS hash + queries open-fd via guest agent

The `VerificationDetails` struct returned (per protocol §13.3 schema) is identical shape across backends. The integrity monitor's decision logic (`verification_passed`, `divergence_action`) is uniform.

### 5.4 Persistent baseline storage

The `golden_hash_baseline` and `open_fd_count_baseline` are recorded:

- At endpoint install time, after first successful boot to ready state
- Stored in agent's SQLite at `~/.brainstorm/agent/baselines.db`
- Refreshed on agent upgrade (image-version-bump triggers re-capture)
- Encrypted at rest with the same key material as the endpoint's Ed25519 private key (file with 0600)

Tampering with the baseline file would defeat the verification. Defense post-MVP: hardware-rooted attestation of baseline integrity. MVP accepts this as a known trust anchor.

### 5.5 What the integrity monitor does NOT do at MVP

- **Does not catch sandbox escape in real-time.** The monitor runs at reset boundaries, not continuously. A compromised tool that escapes the sandbox during execution is not caught until the next reset (or never, if the escape disables the monitor itself).
- **Does not detect compromised image at build time** (A4). The baseline is captured from the as-shipped image; if the image was already compromised at build, baseline is compromised.
- **Does not detect compromised agent process** (A5). The monitor IS the agent.
- **Does not observe layers above the agent/VMM boundary (NEW v1.1, contributed by 0bz7aztr).** Specifically: CP/HAL-layer state-drift (e.g., relay-side or control-plane registry inconsistencies, like the 82-phantom records pattern at brainstormVM CP/HAL) is OUT of integrity monitor scope. The monitor catches lies between agent and VMM/sandbox; it does not catch lies between relay and agent (relay → audit log integrity is separate, see §8 of protocol spec) or between CP and agent.

These are post-MVP work items, called out explicitly in §2 "explicitly NOT promised."

---

## 6. Failure Modes + Mitigations

| ID   | Failure Mode                          | Triggering Class                           | Mitigation                                                                 | Residual Risk                                                                          |
| ---- | ------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| FM1  | State leakage between dispatches      | A3 (compromised tool)                      | G1/G5 reset + 3-source verification                                        | Sandbox escape during execution (residual; out-of-MVP)                                 |
| FM2  | Cross-endpoint replay                 | A8                                         | G7 signed `target_endpoint_id`; `WRONG_AUDIENCE` reject                    | None at MVP                                                                            |
| FM3  | Cross-context replay                  | A9                                         | G8 SIGN_CONTEXT_PREFIX; algo `ed25519-jcs-sha256-v1`                       | None at MVP                                                                            |
| FM4  | Replay after agent restart            | A10                                        | Persistent nonce store (SQLite); min 100k capacity                         | Burst-induced cache eviction handled by `NONCE_CACHE_FULL` fail-closed                 |
| FM5  | Substrate lies about reset            | A6                                         | 3-source cross-check; halt on divergence                                   | Coordinated multi-source lie (difficult but possible at kernel level)                  |
| FM6  | Relay contamination of operator bytes | A7                                         | AuditLogEntry wrapper §8; verbatim payload_bytes; payload_canonical_hash   | Compromised relay can still mint malicious envelopes (relay key in trust base)         |
| FM7  | Sandbox escape                        | A3 → A5                                    | CHV/VF + minimal kernel + seccomp; integrity monitor catches at next reset | Real-time escape during execution undetected until reset                               |
| FM8  | Tool persistence across reset         | A3                                         | G1; reset eliminates state                                                 | Defeated by FM5 if substrate lies                                                      |
| FM9  | Direct internet egress from sandbox   | A3                                         | G3; agent-mediated proxy; audited                                          | Bug in proxy could leak (mitigation: deny-by-default; whitelist explicit destinations) |
| FM10 | Forged CommandEnvelope from outsider  | A2                                         | Per-envelope Ed25519 signature; relay key in trust base                    | None at MVP (key compromise = full compromise)                                         |
| FM11 | Stale-session result injection        | A1 (compromised operator) or A5            | session_id binding (protocol §11)                                          | Compromised endpoint can still emit results for its own active session                 |
| FM12 | Compromised agent forges results      | A5                                         | EXPLICITLY OUT OF MVP SCOPE                                                | Hardware attestation post-MVP                                                          |
| FM13 | Compromised image                     | A4                                         | EXPLICITLY OUT OF MVP SCOPE                                                | Reproducible builds + image signing post-MVP                                           |
| FM14 | Operator-side preview/dispatch race   | A1 (or buggy relay)                        | preview_hash binding ChangeSetPreview ↔ ConfirmRequest (protocol §4.2-4.3) | None at MVP                                                                            |
| FM15 | NONCE_CACHE_FULL DoS                  | A1 (rate-limit-evading malicious operator) | Relay-side rate limit on signed dispatches per endpoint per minute         | Persistent attacker can degrade endpoint availability (acceptable; no command lost)    |

---

## 7. Red-Team Test Battery (P3.5a + P3.5b validation)

The success gates in plan v3.1 §5 reference "1000 dispatch red-team" tests. Concretizing:

**T1 — State persistence test (1000 dispatches):**

- Tool A in dispatch N writes a known marker (file at `/tmp/marker-N`, env var, etc.) inside the sandbox
- Tool B in dispatch N+1 reads from those locations
- Pass: dispatch N+1 reads zero markers from N (state was reset between)
- Run with N varying from 1 to 1000

**T2 — Sandbox escape attempt:**

- Tool that attempts (via known CHV/VF CVE simulation, ptrace games, /dev/mem access, etc.) to escape sandbox
- Pass: agent's integrity monitor detects, halts, audit records the attempt

**T3 — Network egress audit:**

- Tool that attempts direct internet egress (raw socket, DNS, HTTP)
- Pass: agent proxy rejects; audit records every attempt with destination

**T4 — Filesystem boundary:**

- Tool that attempts to read / write beyond the shared-fs mount
- Pass: VMM denies; audit records; tool exit code is non-zero (not "succeeded but read nothing")

**T5 — Reset verification injection (substrate-lying simulation):**

- Pause VM mid-dispatch; modify FS at host level; resume; trigger reset
- Pass: integrity monitor's filesystem hash check catches the modification, divergence_action = halt
- **Caveats (NEW v1.1, contributed by 0bz7aztr):**
  - VM dirty pages must be flushed before host-level write (otherwise modification is lost on resume)
  - Modification must preserve file size (otherwise hash trivially diverges before reset, defeating test purpose)
- Variant T5a: also modify open-fd count
- Variant T5b: also lie about VMM API state (requires VMM-level instrumentation)
- **Variant T5c (NEW v1.1):** attacker modifies FS at host level AND modifies the baseline DB to match. Tests whether baseline storage trust anchor (§5.4) is sufficient defense, OR whether we need additional baseline integrity (signing). Expected outcome: T5c PASS = baseline integrity trust anchor is sufficient (acceptable for MVP); T5c FAIL = need to ship baseline-signing in MVP.
- **Variant T5d (NEW v1.1, false-existence A6a):** attacker creates a "phantom" sandbox record (claim VM exists in registry) that doesn't correspond to a running VMM instance. Tests whether the integrity monitor catches false-existence at agent/VMM boundary. (Note: A6a originally surfaced at CP/HAL boundary, which is OUT of integrity monitor scope per §5.5; this test verifies the equivalent attempt at the in-scope boundary.)

**T13 — gRPC stream race during dispatch (NEW v1.1, contributed by 0bz7aztr):**

- Reference: 0bz7aztr's `project_grpc_stream_race.md` finding (SetStream/ClearStream race at brainstormVM)
- Endpoint: relay reconnects to agent during in-flight dispatch
- Pass: integrity monitor's state machine survives the reconnect; does NOT admit a new dispatch over an unverified VM

**T14 — Agent restart during dispatch (NEW v1.1, contributed by 0bz7aztr):**

- Endpoint: agent or CP restart while a dispatch is mid-flight
- Pass: post-restart, agent re-enters post-reset verification correctly; does NOT admit fresh dispatch over uncleared VM

**T15 — Per-VM disk file collision (NEW v1.1, contributed by 0bz7aztr):**

- Two endpoints with same VM name OR two dispatches racing on same disk path
- Pass: integrity monitor catches the case where a stale rootfs from prior dispatch is reused (file existence + content mismatch with expected golden state)

**T6 — Cross-endpoint replay:**

- Capture valid CommandEnvelope from session intended for endpoint A
- Replay against endpoint B in same tenant within expires_at window
- Pass: endpoint B rejects with `WRONG_AUDIENCE`

**T7 — Cross-context replay:**

- Take a valid CommandEnvelope signature
- Attempt to use it as a connection proof
- Pass: signing context prefix mismatch causes signature verification to fail

**T8 — Replay after restart:**

- Capture valid envelope; restart agent; replay before `expires_at`
- Pass: persistent nonce store rejects as duplicate

**T9 — NONCE_CACHE_FULL fail-closed:**

- Burst-flood with valid signed envelopes (via compromised operator) until nonce cache full
- Pass: subsequent envelopes rejected with `NONCE_CACHE_FULL`, not silently evicted
- Note: this also confirms graceful degradation rather than crash

**T10 — preview_hash mismatch defense:**

- Send DispatchRequest with one params set
- Receive ChangeSetPreview with `preview_hash`
- Send ConfirmRequest, but relay (simulated as buggy) tries to dispatch with different params
- Pass: `PREVIEW_HASH_MISMATCH` rejection

**T11 — Stale-session rejection:**

- Endpoint reconnects (new session_id)
- Endpoint emits a CommandResult with old session_id
- Pass: relay rejects with `SESSION_STALE`

**T12 — AuditLogEntry channel-of-origin immutability:**

- Operator submits DispatchRequest with `params: { harmful: true }`
- Relay records audit entry with `channel_of_origin: operator`, `payload_bytes` verbatim
- Verifier reads audit log; recomputes `payload_canonical_hash` from `payload_bytes`; compares to recorded hash
- Pass: hashes match, payload bytes match operator's original submission verbatim

---

## 8. Open Questions

1. **Filesystem-hash performance.** Hashing a multi-GB disk image after every reset is expensive. Mitigation candidates: (a) hash only the writable cow-overlay, not the full base image; (b) use Merkle tree to incrementally hash; (c) use VMM-provided integrity attestation if available. Decision deferred to P3.2a/P3.2b implementation.

2. **macOS open-fd count cross-check.** Querying open-fd inside the guest from the host requires a guest-side agent helper. Both backends use the same Linux microVM image, so the helper is shared. Implementation choice: helper as a separate binary inside image, or built into the Linux init.

3. **Idle-reset policy.** Plan v3.1 D13 says "every dispatch + on suspicion." Idle-reset (timer-based) is post-MVP. Should it also be added as a defense-in-depth? Decision: keep as post-MVP; not adding without operational data.

4. **Reset granularity for cold-boot fallback (macOS <14).** Cold boot is slower; do we want a per-endpoint policy that prefers in-place revert if the host is on cold-boot fallback? Decision: no — defensibility cost is not worth latency win at MVP.

5. **Integrity monitor as a separate process from agent.** Pro: minimizes blast radius if agent is compromised. Con: more moving parts. Decision: monitor IS the agent at MVP; separate-process design is post-MVP work.

6. **Hash function choice.** SHA-256 throughout. Alternative: BLAKE2b (faster). Decision: SHA-256 for compatibility with audit-log canonicalization (RFC 8785 doesn't mandate but pairs naturally); BLAKE2b deferred.

7. **Compromised-image attack class A4.** What's the minimum acceptable defense before we can claim image-level integrity? Reproducible-builds + signed images is the goal; until then, A4 is explicitly out of scope. Worth surfacing to compliance reviewers explicitly.

---

## 9. Cross-Review Plan

- [x] Draft committed (P3.0 in progress)
- [ ] **0bz7aztr substantive review** — Linux backend (CHV) lens; verify §4.1 reset granularity matches their Hetzner production patterns; verify §5.1 3-source verification against the reconcile-state-drift attacker class they originally surfaced (A6); challenge any defender's-guarantee claim that's overstated for the CHV path; ~3-5d
- [ ] **crd4sdom Go-integration review** — light load; verify §5.3 Sandbox interface design matches what they're planning for P3.3; flag any Go-side concerns about cross-backend uniformity
- [ ] **Codex adversarial review on threat model** — optional; security-critical document, worth one pass; defer if peer reviews already substantive
- [ ] Mark FROZEN; cross-link from `endpoint-agent-protocol-v1.md` §12 + `endpoint-agent-plan.md` §5

---

## Appendix A: References

- `endpoint-agent-protocol-v1.md` — wire protocol; §12 Security Considerations summary cross-references this doc
- `endpoint-agent-plan.md` v3.1 — §5 Phase 3 sandbox track structure; R18 substrate-lying attacker class
- 0bz7aztr's `project_reconcile_state_drift.md` — original substrate-lying finding from brainstormVM (548 zombies pattern)
- Integration-review round-1 audit (2026-04-23) — original participant-orchestrator-contamination finding (dttytevx orchestrator-side audit injection)
- Cloud Hypervisor `vm.snapshot` / `vm.restore` API documentation
- Apple Virtualization.framework `VZVirtualMachine.saveMachineState` / `restoreMachineState`
- RFC 8785 — JSON Canonicalization Scheme (used in audit-chain hash)
- D15 — Verification approach: hash compare AND integrity monitor (both, 3-source cross-check)
- D32 — P3.1a sequencing gate (cleared 2026-04-26T21:56:11Z)
- R18 — Substrate-lying attacker class
- FM5 above is the formalization of R18 in this document
