---
name: godmode-operations
description: Operate brainstorm's God Mode infrastructure control plane. Use when managing endpoints, agents, email security, VMs, or any connected product.
---

# God Mode Operations

God Mode connects brainstorm to external infrastructure through the platform contract. Every product that implements `GET /health`, `GET /api/v1/god-mode/tools`, and `POST /api/v1/god-mode/execute` becomes controllable.

## ChangeSet Protocol

Every destructive action returns a **ChangeSet** — a simulation of what will happen:

```
1. Call a mutating God Mode tool (e.g., msp_isolate_device)
2. Tool returns a ChangeSet with:
   - changeset_id
   - simulation (statePreview, cascades, constraints)
   - risk score (0-100)
   - risk factors
3. Present the ChangeSet to the user
4. User approves → call gm_changeset_approve with the ID
5. User rejects → call gm_changeset_reject with the ID
```

**Rules:**

- NEVER auto-approve a ChangeSet — always present and wait
- If risk score > 50, explicitly warn about each risk factor
- If cascading effects include data loss or service interruption, highlight them
- One approval gates the entire operation

## Entity Resolution

Users refer to things by name, not by system ID:

- "John's computer" → search devices by owner name → resolve to device ID
- "the QA server" → search by hostname pattern → confirm with user if multiple matches

## Cross-System Actions

When a request involves multiple products:

1. Identify all systems that need to act
2. Call each system's tools in sequence
3. Present a unified summary of ALL changesets
4. One approval gates everything

## Connected Products

| Product          | What it manages                  | Example tools                                |
| ---------------- | -------------------------------- | -------------------------------------------- |
| BrainstormMSP    | Endpoints, users, backup, agents | msp_list_devices, agent_list, agent_run_tool |
| BrainstormRouter | AI routing, cost tracking        | br_status, br_budget, br_models              |
| BrainstormGTM    | Marketing, campaigns             | gtm_campaigns, gtm_leads                     |
| BrainstormVM     | Virtual machines                 | vm_create, vm_migrate                        |
| BrainstormShield | Email security                   | shield_scan, shield_quarantine               |

## Edge Agent Operations

The agent connector provides direct control over edge agents:

- `agent_list` — fleet overview
- `agent_status` — detail + trust score
- `agent_ooda_events` — autonomous reasoning trail
- `agent_workflow_approve` — approve/reject OODA decisions
- `agent_run_tool` — dispatch any of 73 tools to remote endpoint
- `agent_kill_switch` — emergency stop (ChangeSet-gated)
