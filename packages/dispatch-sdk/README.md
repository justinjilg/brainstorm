# @brainst0rm/dispatch-sdk

Programmatic Brainstorm dispatch primitive for autonomous-agent operators (P1.7 milestone).

Wraps the operator-side WebSocket flow with a typed `dispatch()` function and an async-iterator API for streaming progress events.

## When to use this vs. the CLI

- **CLI (`brainstorm dispatch`)** — humans, one-off invocations, terminal output.
- **SDK (`@brainst0rm/dispatch-sdk`)** — autonomous Claude agents, long-running sessions, programmatic consumption of progress and results.

Both speak the same wire protocol; the relay treats them identically per `operator.kind` (`"human"` vs `"agent"`).

## Usage

```typescript
import { Dispatcher } from "@brainst0rm/dispatch-sdk";

const dispatcher = new Dispatcher({
  relayUrl: "wss://relay.example.com",
  apiKey: process.env.BRAINSTORM_AGENT_API_KEY!,
  agentId: "agent-soul-abc-123",
  parentHumanId: "alice@example.com", // who launched this agent
  tenantId: "tenant-1",
});

await dispatcher.connect();

// Simple: await terminal result
const result = await dispatcher.dispatch({
  tool: "echo",
  params: { message: "hello from agent" },
  targetEndpointId: "ep-uuid-here",
  autoConfirm: true,
});

if (result.status === "completed") {
  console.log(result.payload?.stdout);
}

// Streaming: iterate progress events
const stream = dispatcher.dispatchStreaming({
  tool: "long-running-task",
  params: { foo: "bar" },
  targetEndpointId: "ep-uuid-here",
  autoConfirm: true,
});
for await (const event of stream) {
  if (event.kind === "preview") {
    console.log("preview:", event.preview_summary);
  } else if (event.kind === "progress") {
    console.log(`[${event.fraction ?? "--"}] ${event.message ?? ""}`);
  } else if (event.kind === "result") {
    console.log("done:", event.result.status);
  }
}

await dispatcher.close();
```

## Identity

The SDK is for agent-class operators. Every dispatch carries:

- `operator.kind = "agent"`
- `operator.id = agentId` (the agent's SOUL)
- `operator.originating_human_id = parentHumanId` (mandatory for agent class — preserves the audit chain back to the root human who launched the agent)
- `operator.delegating_principal_id` (optional; used when chain depth > 2)

The relay's audit log records both `originating_human_id` and `id`, so dispatch decisions made by autonomous agents are always traceable to the human who launched the agent.

## Auth

Same HKDF-SHA-256 key derivation as the CLI, scoped to the agent's identity. The relay derives the same HMAC key independently and verifies signatures via `operatorHmac` in constant time.

The `apiKey` is issued by the relay during agent provisioning (`POST /v1/admin/agent/provision` — to be defined in a future iteration; for MVP, an admin static key works). NEVER hardcode in source; load from env or a secrets vault.

## Status

P1.7 milestone delivered. Builds against `@brainst0rm/relay` v0.1.0. Compatible with the wire protocol v3 in `docs/endpoint-agent-protocol-v1.md`.
