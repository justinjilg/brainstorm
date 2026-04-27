# @brainst0rm/relay

Brainstorm-platform relay service: governed dispatch between operators (CLI/SDK) and endpoints (`brainstorm-agent`). Implements the wire protocol from `docs/endpoint-agent-protocol-v1.md`.

## Architecture

Three transports:

```
operator (CLI/SDK)  ←──WS──→  brainstorm-relay  ←──WS──→  brainstorm-agent (endpoint)
                                                            ↑
                                                            ↓ vsock
                                                          microVM (CHV/VF sandbox)
```

The relay is the platform-layer service per plan v3.2 D9: NEW service, NOT an extension of MSP's relay. MSP becomes a consumer of this relay alongside other future products.

## Run (laptop dev)

```bash
# Generate secrets (one-time per dev environment)
export BRAINSTORM_RELAY_ADMIN_TOKEN=$(openssl rand -hex 32)
export BRAINSTORM_RELAY_TENANT_KEY_HEX=$(openssl rand -hex 32)
export BRAINSTORM_RELAY_OPERATOR_HMAC_KEY_HEX=$(openssl rand -hex 32)

# Optional: set non-default ids/ports
export BRAINSTORM_RELAY_OPERATOR_ID="alice@example.com"
export BRAINSTORM_RELAY_TENANT_ID="tenant-local"
export BRAINSTORM_RELAY_PORT_WS=8443
export BRAINSTORM_RELAY_PORT_HTTP=8444

npm install
npm run build
npm start
```

Output:

```
[relay] WS listening on 127.0.0.1:8443 (paths /v1/operator, /v1/endpoint/connect)
[relay] HTTP enrollment listening on 127.0.0.1:8444
[relay] data dir: ~/.brainstorm/relay
[relay] tenant_id: tenant-local, operator_id: alice@example.com
```

## Modules

| Module             | Purpose                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `canonical.ts`     | RFC 8785 JCS + NFC normalization + 5 SIGN_CONTEXT prefixes; `__proto__` defense; key-collision detection                           |
| `signing.ts`       | Ed25519 sign/verify with `ed25519-jcs-sha256-v1` algorithm; safe HMAC wrapper; constant-time compare                               |
| `operator-key.ts`  | HKDF-SHA-256 mandatory operator-key derivation per spec §3.2                                                                       |
| `verification.ts`  | Operator HMAC verify + endpoint connection-proof Ed25519 verify with clock-skew bounds                                             |
| `audit.ts`         | SQLite audit log with channel-of-origin discipline; verbatim operator-bytes; hash verification                                     |
| `nonce-store.ts`   | Persistent nonce-replay store; min 100k capacity; fail-closed `NONCE_CACHE_FULL` semantics                                         |
| `session-store.ts` | Operator + endpoint session registry; reconnect-replaces-prior; stale-session detection                                            |
| `lifecycle.ts`     | 7-state machine (`pending\|dispatched\|started\|progress\|completed\|failed\|timed_out`); pure `nextState`; late-arrival semantics |
| `dispatch.ts`      | `DispatchOrchestrator` — operator request → ChangeSetPreview → signed CommandEnvelope                                              |
| `result-router.ts` | Endpoint frame → operator frame fanout; stale-session + endpoint-identity binding                                                  |
| `ack-timeout.ts`   | 5s ACK-timeout timer with injectable clock; relay-observable per V3-ACK-01                                                         |
| `relay-server.ts`  | Glue: handshake + frame dispatch + fanout                                                                                          |
| `ws-binding.ts`    | Actual `ws` library wrapper; binds operator + endpoint paths                                                                       |
| `enrollment.ts`    | HTTP endpoints for endpoint registration (admin issues token, agent enrolls public key)                                            |
| `bin.ts`           | Entry point — wires all modules from env config                                                                                    |
| `types.ts`         | Wire types from spec §13 schemas                                                                                                   |

## Cryptographic invariants

The foundation crypto is the most-reviewed surface. Key invariants enforced:

1. **NFC-then-JCS, never JCS-then-NFC** — applying NFC to JCS output bytes would mutate already-canonical bytes and break verification (`canonical.ts` step 2).

2. **Domain separation via SIGN_CONTEXT prefix** — every signing context (CommandEnvelope, ConnectionProof, BootstrapToken, OperatorHmac, EvidenceChunk) prepends a unique byte string before SHA-256 + Ed25519. Cross-context replay (using a CommandEnvelope sig as a connection proof) fails because the prefix differs.

3. **`__proto__` own-key preservation** — `nfcNormalize` uses `Object.create(null) + Object.defineProperty` to prevent the legacy `__proto__` setter from silently dropping a wire field from the canonical form (Codex blocking finding).

4. **NFC key-collision rejection** — if two distinct wire keys (e.g. `"café"` NFD + `"café"` NFC) normalize to the same form, `nfcNormalize` throws `NfcKeyCollisionError`. Last-write-wins canonical bytes would violate signing injectivity.

5. **Signed `target_endpoint_id`** — every CommandEnvelope is bound to its target endpoint. Cross-endpoint replay within the same tenant fails with `WRONG_AUDIENCE`.

6. **Persistent nonce store, fail-closed** — nonces survive endpoint restart (SQLite); under capacity pressure, relay rejects new envelopes with `NONCE_CACHE_FULL` rather than evicting unexpired entries.

7. **Channel-of-origin via AuditLogEntry wrapper** — anti-contamination is structural at the audit layer, not a wire-layer convention. Operator-payload bytes are preserved verbatim; relay-internal annotations live in `metadata_sidecar`.

## Test coverage

Vitest. Run with `npm test`.

```
canonical.test.ts        — NFC + JCS + domain separation + __proto__ regression + collision rejection
signing.test.ts          — Ed25519 sign/verify + cross-context rejection + tamper detection + HMAC
operator-key.test.ts     — HKDF deterministic + sensitivity to ikm/info
audit.test.ts            — channel-of-origin + verbatim operator-bytes + hash verification
nonce-store.test.ts      — fresh accept + replay reject + eviction window + restart durability
session-store.test.ts    — operator/endpoint registry + reconnect + stale-session detection
lifecycle.test.ts        — happy path + late_arrival + invalid_transition + ACK timeout
verification.test.ts     — operator HMAC + connection-proof Ed25519 + clock-skew bounds
result-router.test.ts    — ACK→started + stale-session reject + cross-endpoint reject + late-arrival audit
ack-timeout.test.ts      — fake-clock-based timer correctness
dispatch.test.ts         — orchestrator happy path + tenant-mismatch + preview-hash mismatch
enrollment.test.ts       — token issue + atomic consume + revoke + re-enrollment
integration.test.ts      — end-to-end dispatch happy path + rejection paths
```

## Status

MVP foundation complete. Ready for:

- Brainstorm CLI dispatch subcommand (P1.2) to consume operator-side WS path
- brainstorm-agent extension (P1.3, owned by `crd4sdom`) to consume endpoint-side WS path
- Stage 1.0 loopback validation (P1.4)

Post-MVP backlog:

- TLS termination directly in the relay (currently relies on reverse proxy)
- Operator identity registry (multi-operator support; MVP is single operator)
- Multi-tenant signing keys
- Reconnect with offline command queue (D16)
- Production deployment target finalization (D17)
- HA relay (D8: single-instance MVP)
