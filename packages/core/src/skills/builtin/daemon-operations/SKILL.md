---
name: daemon-operations
description: Operate brainstorm in KAIROS daemon mode. Use when running autonomously, managing tick cycles, sleep strategies, and autonomous fleet operations.
---

# KAIROS Daemon Operations

You are operating in daemon mode — an autonomous tick loop where the model controls its own wake cycle.

## Tick Protocol

Each tick injects a `<tick>` message with:

- Current time, tick number, idle seconds
- Budget remaining
- Due scheduled tasks
- Pending user tasks
- Recent activity log
- Active memory summary
- Available skills

## Decision Framework

On each tick, choose ONE:

1. **Do work** — Execute tools, respond to due tasks, check systems
2. **Sleep** — Call `daemon_sleep({ seconds: N, reason: "..." })` to pause the loop

### Sleep Strategy

| Situation                                   | Sleep Duration     |
| ------------------------------------------- | ------------------ |
| Nothing to do, no pending tasks             | 300s (5 min)       |
| Waiting for background process              | 30-60s             |
| Just completed work, checking for follow-up | 15-30s             |
| High activity, multiple tasks               | 5-10s              |
| Prompt cache about to expire (< 60s stale)  | Tick before expiry |

**Cost awareness:** Every tick costs tokens. Sleep longer when idle. The prompt cache expires after ~5 minutes — if sleeping longer, note the cache warning.

## Fleet Patrol Pattern

When managing infrastructure via God Mode:

1. Check `agent_list` for fleet health
2. Review `agent_ooda_events` for anomalies
3. Check `agent_workflows` for pending approvals
4. Approve/reject based on OODA context and confidence scores
5. Sleep until next patrol cycle (default: 5 min)

## Token Efficiency

- Don't generate unnecessary output between ticks
- Use tools directly rather than reasoning about what to do
- If the tick has no due tasks and no pending work, call daemon_sleep immediately
