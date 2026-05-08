# Desktop Surface Status (2026-05-08)

Honest catalog of every Desktop workspace × verb cell — what is implemented vs scaffolded vs explicit Phase-2 placeholder. Source of truth for downstream agents that need to know "is X already done, or am I building it?"

This is a snapshot. When a surface lands or moves status, update the row + commit alongside the implementation PR.

## Status legend

- **Live** — Surface renders real data and supports its primary action.
- **Partial** — Surface exists with a subset of the intended capability (one of N actions, read-only when mutation was intended, etc.).
- **Stub** — Surface renders a `<Placeholder>` card with explicit "Coming in Phase 2" copy. Not a bug.
- **Missing** — Cell is referenced in the entity/verb model but has no implementation.

## Business workspace

| Verb      | Status  | What it does today                                                                                                                                                                                                                                                                               | Reference                                                         |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Plan      | Live    | `BusinessPlanBody` — identity header, seven-folder nav grid, federation pointers (products / runtimes / external systems / access policy / AI-loop budget)                                                                                                                                       | `apps/desktop/src/components/business/BusinessPlanBody.tsx`       |
| Inspect   | Live    | `BusinessInspectBody` — cold-open verify pills, loop-event log (now durably persisted per PR #293), customer drift panel                                                                                                                                                                         | `apps/desktop/src/components/business/BusinessInspectBody.tsx`    |
| Operate   | Partial | `BusinessOperateBody` — `Run indexer loop now` button, `Run drift detector now` button, drift apply/revert per-row. **Missing:** God Mode tool console, ChangeSet center, Client 360, incident room, backup remediation, patch workflow, SLA workflow, QBR generation (per PRD Phase 1-2)        | `apps/desktop/src/components/business/BusinessOperateBody.tsx`    |
| Configure | Stub    | `BusinessWorkspace.tsx:78` — placeholder telling the operator to edit `business.toml` directly. **Missing:** `business.toml` editor, access-tiers editor, AI-loop budget editor, connector credentials, tenant/client scoping, approval delegation policy, retention policy (per PRD §Surface 4) | `apps/desktop/src/components/workspaces/BusinessWorkspace.tsx:78` |

## Platform workspace

| Verb      | Status  | What it does today                                                                                                                                                                                                                              | Reference                                                              |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Plan      | Live    | KAIROS health, connected products, register/un-register flow                                                                                                                                                                                    | `apps/desktop/src/components/workspaces/PlatformWorkspace.tsx`         |
| Inspect   | Partial | Product manifest viewer; product event stream                                                                                                                                                                                                   | `apps/desktop/src/components/workspaces/PlatformWorkspace.tsx`         |
| Operate   | Stub    | KAIROS start/stop only. **Missing:** connector invocation, scheduler queue, model/router control, cost-quota controls, workflow run history, trace/evidence search (per PRD §Surface 5). Explicit Phase-2 marker at `PlatformWorkspace.tsx:247` | `apps/desktop/src/components/workspaces/PlatformWorkspace.tsx:245-247` |
| Configure | Stub    | Placeholder. **Missing:** connector credentials, model/router defaults, cost quota policy                                                                                                                                                       | `apps/desktop/src/components/workspaces/PlatformWorkspace.tsx`         |

## Project workspace

| Verb      | Status  | Notes                                                                                                                    |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Plan      | Live    | Project metadata + repo overview                                                                                         |
| Inspect   | Partial | Per-project event surface                                                                                                |
| Operate   | Stub    | `ProjectWorkspace.tsx:6-7` documents this is reserved for buried capabilities (eval runner, scheduler) coming in Phase 2 |
| Configure | Stub    | Same as above — per-project settings are Phase 2                                                                         |

## Self workspace

| Verb      | Status | Notes                                              |
| --------- | ------ | -------------------------------------------------- |
| Plan      | Live   | User profile + active context                      |
| Inspect   | Live   | Session history, recent conversations              |
| Operate   | Live   | `SkillsView` — list and toggle skills. Real data.  |
| Configure | Stub   | `SelfWorkspace.tsx:60` — palette config is Phase 2 |

## Conversation workspace

| Verb                                 | Status | Notes                                                                                                                               |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Plan / Inspect / Operate / Configure | Stub   | `ConversationWorkspace.tsx:6` — verbs are placeholders pending thread metadata, fork, replay, per-conversation overrides in Phase 2 |

## Cross-cutting Desktop surfaces (workspace-independent)

- **NewHarnessWizard** — Live. Used from first-run + "create harness" actions.
- **Active harness session indicator** — Live. Top of every Business workspace.
- **Loop-event live stream** — Live. Persisted to `loop_events` SQLite table since PR #293; survives restart.
- **Permission prompts (chat tool gate)** — Partial. `packages/server/src/server.ts:491,556` runs chat with `permissionCheck: () => "allow"`. Production hardening per PRD §P1-7.

## Counts at a glance

- **Live:** 9 cells
- **Partial:** 5 cells
- **Stub (explicit Phase-2 placeholder):** 8 cells
- **Missing (cell exists in nav but no implementation):** 0

## Where this doc fits

Companion to:

- `docs/business-harness-prd-claude-code-2026-05-08.md` — what should exist (vision)
- `docs/business-harness-research-log-2026-05-08.md` — calibrated scoring

This doc is the **delta** — what currently is. Update it when surfaces move status.
