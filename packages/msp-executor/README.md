# @brainst0rm/msp-executor

`ToolExecutor` implementation for [`@brainst0rm/endpoint-stub`](../endpoint-stub)
that bridges relay-side dispatch into BrainstormMSP's god-mode REST API.

When the Brainstorm relay routes a `CommandEnvelope` to the MSP-facing
endpoint-stub, this executor translates the call into a single
`POST /api/v1/god-mode/execute` against MSP, preserving the relay's
`command_id` end-to-end.

## What this is for

A single correlation token (`command_id`) dominates the chain
end-to-end:

```
operator → relay → endpoint-stub → MspExecutor → MSP god-mode → MSP edge agent → result
   ^                                                  ^
   |                                                  |
   +------------ same command_id throughout ----------+
```

`MspExecutor` puts that token on the wire as both
`X-Brainstorm-Command-Id` (the MSP-side correlation header introduced
in `brainstormmsp` commit `4d4b7813`) and `Idempotency-Key` (the
existing replay header). MSP enforces that they are equal — see commit
`4d582709`, which rejects mismatches with `400
IDEMPOTENCY_CORRELATION_MISMATCH`. Setting both from the same source
ensures we never trip the check from this side.

## What this is NOT

- **Not a general-purpose HTTP client.** It speaks one endpoint
  (`POST /api/v1/god-mode/execute`) and one auth contract
  (`Authorization: Bearer …`).
- **Not ChangeSet-aware.** v1 sends `simulate: false` outright;
  destructive tools are gated upstream (operator confirms before the
  envelope ever crosses the relay).
- **Not real-MSP tested yet.** All tests inject `fetch`. First real-MSP
  smoke happens when the deploy is authorised + the MSP-side branch
  PR lands.

## Wire shape

Verbatim, so `dttytevx` can pin against it:

```
POST {baseUrl}/api/v1/god-mode/execute
X-Brainstorm-Command-Id: {command_id}     ← injected correlation token
Idempotency-Key:        {command_id}      ← MUST equal X-Brainstorm-Command-Id
Authorization:          Bearer {apiKey}    ← service_key OR jwt; same on the wire
Content-Type:           application/json

{ "tool": "...", "params": { ... }, "simulate": false }
```

## Programmatic usage

```typescript
import { EndpointStub } from "@brainst0rm/endpoint-stub";
import { MspExecutor } from "@brainst0rm/msp-executor";

const executor = new MspExecutor({
  baseUrl: "https://brainstormmsp.ai",
  apiKey: process.env.BSM_MSP_API_KEY!,
  authMode: "service_key",
  tenantId: "tenant-prod-7",
});

const stub = new EndpointStub({
  relayUrl: "wss://relay.brainstorm.co",
  tenantId: "tenant-prod-7",
  identityPath: "/var/lib/brainstorm/endpoint-stub/identity.json",
  endpointId: "uuid-...",
  tenantPublicKey: pubkeyBytes,
  executor: executor.execute,
});

await stub.run();
```

## Environment variables

The executor itself doesn't read env. It expects to be wired up by
`endpoint-stub`'s `bin.ts` via the analogous `BSM_USE_MSP_EXECUTOR=1`
escape hatch (mirrors `BSM_USE_CHV_EXECUTOR=1`):

| Variable               | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `BSM_USE_MSP_EXECUTOR` | `1` to wire `MspExecutor` instead of the default stub. |
| `BSM_MSP_BASE_URL`     | MSP base URL, e.g. `https://brainstormmsp.ai`.         |
| `BSM_MSP_API_KEY`      | Bearer credential — service key OR jwt.                |
| `BSM_MSP_AUTH_MODE`    | `service_key` (default) or `jwt`.                      |
| `BSM_MSP_TENANT_ID`    | `msp_tenant_id` for telemetry/logging.                 |

The endpoint-stub side wiring is intentionally not in this PR — it
lives in `packages/endpoint-stub/src/bin.ts` and will be added in the
follow-up PR that authorises the deploy. Sketch of what that looks
like:

```typescript
// packages/endpoint-stub/src/bin.ts (illustrative — NOT yet wired)
function loadMspExecutorIfRequested(): ToolExecutor | undefined {
  const env = process.env;
  if (env.BSM_USE_MSP_EXECUTOR !== "1") return undefined;

  const baseUrl = env.BSM_MSP_BASE_URL;
  const apiKey = env.BSM_MSP_API_KEY;
  const tenantId = env.BSM_MSP_TENANT_ID;
  if (!baseUrl)
    throw new Error("BSM_USE_MSP_EXECUTOR=1 but BSM_MSP_BASE_URL unset");
  if (!apiKey)
    throw new Error("BSM_USE_MSP_EXECUTOR=1 but BSM_MSP_API_KEY unset");
  if (!tenantId)
    throw new Error("BSM_USE_MSP_EXECUTOR=1 but BSM_MSP_TENANT_ID unset");

  const authMode = (env.BSM_MSP_AUTH_MODE ?? "service_key") as
    | "service_key"
    | "jwt";
  const executor = new MspExecutor({ baseUrl, apiKey, authMode, tenantId });
  return executor.execute;
}
```

## Exit code mapping

Mirrors the POSIX/run-parts conventions used in `chv-executor.ts` so
the operator's mental model is identical across executors:

| Exit | Cause                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Tool succeeded.                                                                                                                                                                                         |
| 1    | Unclassified 4xx that's not idempotency/auth/404 (e.g. `400 CHANGESET_REQUIRED`, `400 VALIDATION`, `413`, `429`). Tool-rejection, not server failure.                                                   |
| 1+   | Tool ran and reported a non-zero exit (preserved verbatim from a 200 `{exit_code,...}` response).                                                                                                       |
| 124  | Transport, timeout, expired deadline, executor-bug failures, or malformed 200 body. No coherent MSP response. Includes `IDEMPOTENCY_CORRELATION_MISMATCH` (which should be unreachable from this code). |
| 125  | MSP server error (5xx). Body forwarded in stderr.                                                                                                                                                       |
| 126  | Auth failure (`401 UNAUTHORIZED` / `403 FORBIDDEN` incl `TENANT_MISMATCH`).                                                                                                                             |
| 127  | Tool not found (`404 NOT_FOUND`).                                                                                                                                                                       |

The endpoint-stub turns any non-zero exit into a `failed` `CommandResult`
with `error.code = SANDBOX_TOOL_ERROR`.

## Testing

```bash
cd packages/msp-executor
npx vitest run
```

20 tests cover happy path, header propagation (command_id,
Idempotency-Key parity, X-Correlation-Id forwarding, auth modes),
error mapping (1 / 124 / 125 / 126 / 127), transport failures (abort,
network), and Codex-review hardening (deadline-fail-fast,
non-positive `defaultTimeoutMs` rejection, non-JSON 200, malformed
`exit_code`).

All tests are mock-only against an injected `fetch`. Real-MSP smoke
testing waits on:

1. Justin authorising a deploy of the `feat/god-mode-injected-command-id`
   branch on the MSP side.
2. `dttytevx` opening the matching PR.
3. End-to-end relay → endpoint-stub → MspExecutor → MSP smoke (the
   v1 three-tool dispatch proof: `msp.list_devices` +
   `msp.agent_health` + `msp.process_kill`).
