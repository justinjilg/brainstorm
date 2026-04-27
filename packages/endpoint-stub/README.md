# @brainst0rm/endpoint-stub

Reference implementation of the **endpoint** side of the Brainstorm dispatch
protocol. Connects to a relay over WebSocket, receives `CommandEnvelope`
frames, executes tools via a pluggable executor, and emits `CommandAck` /
`ProgressEvent` / `CommandResult` back to the relay.

## What this is for

1. **Test fixture** for distributed dispatch flows (Stage 1.1+ in
   `docs/endpoint-agent-plan.md`). Stand it up alongside `@brainst0rm/relay`
   to exercise the full operator → relay → endpoint loop without needing
   a real sandboxed agent.
2. **Reference** for `crd4sdom`'s production `brainstorm-agent` (Go).
   The TypeScript here pins the protocol semantics — `CommandAck` timing,
   signature verification order, lifecycle transitions — that the Go
   implementation must also satisfy.
3. **Self-contained dev endpoint** for local `brainstorm dispatch` smoke
   tests on a developer laptop.

## What this is NOT

The stub is honest about being a stub:

- No microVM sandbox isolation (P3 work in the production agent)
- No real evidence-chain hashing of execution
- No reset machinery between commands
- No `GuestQuery` / `GuestResponse` integrity-monitor handling

Every result the stub produces includes `{ stub: true }` in its stdout JSON
so consumers can immediately see they're not running against a real
isolated endpoint.

## Quick start

```bash
# 1. Start a relay (separate terminal)
brainstorm-relay

# 2. Have an admin issue a bootstrap token via the relay's HTTP API
curl -X POST http://127.0.0.1:8444/v1/admin/endpoint/enroll \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"tenant-dev"}'
# → { "bootstrap_token": "...", "endpoint_id": "uuid-..." }

# 3. Run the stub
export BRAINSTORM_RELAY_URL_WS=ws://127.0.0.1:8443
export BRAINSTORM_RELAY_URL_HTTP=http://127.0.0.1:8444
export BRAINSTORM_ENDPOINT_BOOTSTRAP=...        # from step 2
export BRAINSTORM_ENDPOINT_TENANT_ID=tenant-dev
export BRAINSTORM_ENDPOINT_ID=...               # from step 2
export BRAINSTORM_ENDPOINT_TENANT_PUBKEY_HEX=... # tenant's signing pubkey
brainstorm-endpoint-stub
```

The stub generates an Ed25519 keypair on first run and persists it to
`~/.brainstorm/endpoint-stub/identity.json` (mode 0600). Subsequent runs
reuse the keypair, so the relay continues to recognize it.

## Programmatic usage

```typescript
import { EndpointStub, type ToolExecutor } from "@brainst0rm/endpoint-stub";

const myExecutor: ToolExecutor = async (ctx) => {
  return { exit_code: 0, stdout: `ran ${ctx.tool}`, stderr: "" };
};

const stub = new EndpointStub({
  relayUrl: "ws://127.0.0.1:8443",
  tenantId: "tenant-dev",
  identityPath: "/tmp/my-endpoint.json",
  endpointId: "uuid-...",
  tenantPublicKey: tenantPubKeyBytes,
  executor: myExecutor,
});

await stub.connect(); // EndpointHello + await EndpointHelloAck
await stub.run(); // Loop until close
```

`connect()` resolves once the session is established, so it's safe for an
operator to immediately dispatch. `run()` resolves when the connection
closes.

## Pluggable executor

The default `stubExecutor` echoes each command's params back as JSON. To
exercise more interesting code paths, supply your own:

```typescript
const echoExecutor: ToolExecutor = async (ctx) => {
  // ctx: { command_id, tool, params, deadline_ms }
  return { exit_code, stdout, stderr };
};
```

Returning `exit_code !== 0` produces a `failed` `CommandResult` with code
`SANDBOX_TOOL_ERROR`. Throwing an exception does the same with the error
message in `error.message`.

## Protocol contract enforced

The stub verifies, in order, before executing any tool:

1. **Ed25519 signature** on the `CommandEnvelope` against the configured
   `tenantPublicKey` (per `ed25519-jcs-sha256-v1`).
2. **Audience — endpoint**: `target_endpoint_id` must equal this stub's
   `endpoint_id` (F5: cross-endpoint envelope replay defense).
3. **Audience — tenant**: `tenant_id` must match the stub's tenant.
4. **Session epoch**: `session_id` must match the current connection's
   session (F12: relay-restart stale-session defense).
5. **Time skew**: `issued_at` must be within ±60 s of the endpoint's
   wall clock.
6. **Expiry**: `expires_at` must be in the future.
7. **Lifetime cap**: `expires_at − issued_at` must not exceed 5 min.
8. **Nonce uniqueness** (in-memory only — see "out of scope" below):
   the same nonce cannot be replayed within a single stub process.

A failure emits an `ErrorEvent` with one of:
`ENDPOINT_SIGNATURE_INVALID`, `ENDPOINT_WRONG_AUDIENCE`,
`ENDPOINT_SESSION_STALE`, `ENDPOINT_ENVELOPE_EXPIRED`,
`ENDPOINT_NONCE_REPLAY`.

After verification the stub sends `CommandAck` _before_ invoking the
executor, matching the protocol's `dispatched → started` transition
contract.

### Explicit out-of-scope (production agent's job)

- **Persistent nonce store** that survives restart. The stub uses an
  in-memory `Set<string>`; a process restart resets it. The production
  agent must use a SQLite-backed nonce store with a `NONCE_CACHE_FULL`
  fail-closed policy.
- **`signing_key_id` lookup / revocation**. The stub trusts the single
  `tenantPublicKey` passed in. Production must look up the key by
  `signing_key_id` and check a revocation list.
- **Atomic identity-file writes**. `loadOrCreateIdentity` uses
  `writeFileSync(..., { mode: 0o600 })` — there is no temp-file +
  rename. A crash between `writeFileSync` start and OS sync could
  leave a partial JSON file. The threat model accepts this for the
  laptop-loopback host.

## Tests

```bash
npm test --workspace=@brainst0rm/endpoint-stub
```

Tests stand up a real relay (WebSocket + enrollment HTTP) on loopback,
point a real `EndpointStub` at it, drive a dispatch from a fake operator,
and verify all 7 protocol-correctness invariants end-to-end.
