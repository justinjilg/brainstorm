# Platform Contract v1 Gap Inventory — 2026-05-20

**Audit performed:** 2026-05-20 by `godmode-contract-verifier` (semantic) + Explore agent (static analysis)
**Scope:** All 5 Brainstorm products against the 5-endpoint contract in `docs/platform-contract-v1.md`
**Status:** PR 1 deliverable of the Business Harness Opus project (see `.claude/notes/business-harness-opus-plan-2026-05-20.md`)

## Summary

| Product | Compliance  | Has /health |      /god-mode/tools       |     /god-mode/execute      |         /api/v1/self         |     /api/v1/discovery     |
| ------- | ----------- | :---------: | :------------------------: | :------------------------: | :--------------------------: | :-----------------------: |
| **MSP** | 85%         |     ✅      |             ✅             |             ✅             |              ❌              |            ❌             |
| **BR**  | 50%         |     ✅      | ⚠️ via capability registry | ⚠️ via capability registry |              ❌              |            ❌             |
| **VM**  | 60% via MCP |     ✅      | ⚠️ MCP transport not REST  | ⚠️ MCP transport not REST  | ⚠️ MCP `initialize` not REST | ⚠️ MCP discovery not REST |
| **GTM** | 0%          |     ✅      |             ❌             |             ❌             |              ❌              |            ❌             |
| **Ops** | N/A         |   ✅ ALB    |   — IaC, not a service —   |                            |                              |                           |

## Detailed findings per product

### MSP (`~/Projects/brainstormmsp`) — 85% compliant

✅ **`GET /health`** — `app.py:1054`
Returns `{ status: "ok" | "degraded" | "down", checks: {...}, timestamp }`. Compliant.

✅ **`GET /api/v1/god-mode/tools`** — `app/api/god_mode.py:1741-1757`
Returns `{ product, version, tools[], count }`. Compliant.

✅ **`POST /api/v1/god-mode/execute`** — `app/api/god_mode.py:1760-2163`
Returns `{ success, tool, data, risk_level, trace_id, command_id }`. Schema differs from the contract spec but semantically compliant. **Gap:** mutating tools should return `{ kind: "changeset", changeset_id, simulate_url, blast_radius, approval_url }`; need to verify this for mutating tools in this codebase. Flag for `changeset-discipline-checker` follow-up.

❌ **`GET /api/v1/self`** — NOT FOUND
`app/api/platform_integration.py` exists but only has `/events` and `/tenants`. The contract endpoint `/api/v1/self` returning `{ product, version, capabilities, schema_version }` is not implemented.

❌ **`GET /api/v1/discovery`** — NOT FOUND
`app/api/discovery/discovery.py` exists but provides domain-specific routes (stats, assets), NOT the platform contract discovery endpoint that should return `{ tools_url, self_url, events_url?, openapi_url? }`.

### BR (`~/Projects/brainstormrouter`) — 50% compliant

✅ **`GET /health`** — `src/api/server.ts:710`
Hono route handler.

⚠️ **`GET /api/v1/god-mode/tools`** — `src/api/register-routes.ts:764`
Migrated to `defineCapability(system.godMode.*)` — implementation lives in BR's capability registry, not as a direct REST handler. Functionally exposes the contract data but through a different abstraction. **Gap:** brainstorm clients reading the contract endpoint expect a stable URL; the capability indirection may break consumers that don't go through BR's typed gateway client.

⚠️ **`POST /api/v1/god-mode/execute`** — capability-dispatched
Same pattern as above.

❌ **`GET /api/v1/self`** — Not found in TypeScript sources or test files.

❌ **`GET /api/v1/discovery`** — Not found.

### VM (`~/Projects/brainstormvm`) — 60% compliant _via MCP, not REST_

Significant finding: VM speaks **MCP JSON-RPC**, not HTTP REST. The contract specifies REST. This is a transport-protocol gap.

✅ **`GET /health`** — `cmd/brainstormvm-mcp/main.go:6`
Part of MCP contract; dynamically discovered from modules.

⚠️ **`GET /api/v1/god-mode/tools`** — semantically present
MCP-style tools list via `buildToolList()`. Equivalent data, different transport.

⚠️ **`POST /api/v1/god-mode/execute`** — semantically present
Tools execution via MCP `tools/call` handler.

⚠️ **`GET /api/v1/self`** — semantically present
MCP `initialize` RPC response contains `serverInfo` with version and modules. Equivalent data, different transport.

⚠️ **`GET /api/v1/discovery`** — semantically present
Module discovery via `registry.Discover()`. Equivalent data, different transport.

**Recommendation:** the contract should be amended to permit MCP JSON-RPC as an alternative transport, OR VM should add a REST proxy layer. Per the audit, the former is more elegant — VM is already an MCP-native product, and brainstorm already speaks MCP for tool dispatch.

### GTM (`~/Projects/brainstorm-gtm`) — 0% compliant

✅ **`GET /health`** — `intelligence/sentinels/page_health_sentinel.py`
Health probes are configured; FastAPI routes exist for operational concerns.

❌ **All god-mode endpoints** — NOT FOUND
GTM is structured as an async orchestrator (70 agents per memory `project_brainstorm-gtm`), not a tool-producing platform. There is no god-mode tools registry or execute handler.

**Strategic question:** Should GTM implement the full contract or be reclassified as a special case?

- **Option A — Implement:** Add minimal tool surface (e.g., `gtm.campaign.launch`, `gtm.contact.create`) plus `/self` and `/discovery`. GTM becomes operable from brainstorm. Pros: uniform; brainstorm UI is consistent. Cons: forces "tool" framing on what's really a workflow engine.
- **Option B — Reclassify:** Add a sibling contract for "orchestrator" products that exposes workflows (`GET /api/v1/workflows`, `POST /api/v1/workflows/{id}/start`) instead of tools. Brainstorm desktop has a separate "Workflows" surface alongside "Tools." Pros: honors the architectural distinction; cleaner.
- **Recommendation:** Option B. Author a `platform-contract-v1-orchestrator.md` sibling spec, and add the workflows endpoints in a follow-up PR.

### Ops (`~/Projects/BrainstormOps`) — N/A

Ops is Terraform IaC, not a runtime service. The contract doesn't apply directly.

**Strategic question:** Does the harness need a "terraform-operator" service that _fronts_ Ops actions (plan, apply, drift-check) as god-mode tools?

- **Option A — Service wrapper:** Author a small ECS service (or Lambda) that exposes `terraform.plan`, `terraform.apply` (ChangeSet-gated), `terraform.drift-check` as god-mode tools. Brainstorm operates Ops through this service.
- **Option B — CLI-only:** Operator uses `terraform` from the brainstorm Desktop code workspace directly. No god-mode wrapper.
- **Recommendation:** Option A — the value of brainstorm-as-hub is consistent UX. Make every product feel the same. PR 12 (Ops workspace) is where this lives; the operator-role for Ops gets pointed at the wrapper service, not the raw Terraform state.

## Cross-cutting findings

1. **`/api/v1/self` and `/api/v1/discovery` are missing universally.** This suggests they're "newer" contract endpoints that haven't been backfilled across products. They're trivial to add (small JSON returns) and could ship as a single multi-repo PR. Action: insert a new PR (call it 1.5) that adds /self + /discovery to MSP, BR, GTM in one coordinated landing.

2. **ChangeSet discipline is unverified.** This audit only checked endpoint _existence_. PR 1.5 (or PR 5 prep) should run `changeset-discipline-checker` against MSP's mutating tools to verify they return ChangeSet shapes, not immediate-execute responses.

3. **Transport heterogeneity is real.** MSP/BR/GTM are REST. VM is MCP. Ops is N/A. The contract should explicitly enumerate accepted transports (REST + MCP) and define equivalence rules. Action: amend `docs/platform-contract-v1.md` in a small PR.

4. **The "5 endpoints" frame might be too narrow.** Three classes of product seem to be emerging:
   - **Tool products** (MSP, BR, VM-eventually): expose tools + execute
   - **Orchestrator products** (GTM): expose workflows + step transitions
   - **Infra products** (Ops): exposed via a sibling service wrapper

   The contract should formalize this taxonomy in `platform-contract-v1.5.md` or successor.

## Action items derived from this audit

| ID   | Action                                                              | Target PR                                | Blocker for                                   |
| ---- | ------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| AI-1 | Add `/api/v1/self` + `/api/v1/discovery` to MSP, BR, GTM            | new PR 1.5                               | brainstorm consuming `/self` and `/discovery` |
| AI-2 | Verify MSP mutating tools return ChangeSet shape                    | folded into PR 5 (ChangeSet contract v2) | PR 5 ChangeSet promotion                      |
| AI-3 | Amend platform-contract-v1.md to permit MCP transport               | new PR (1.6)                             | VM compliance recognition                     |
| AI-4 | Design `platform-contract-v1-orchestrator.md` for GTM               | new PR (1.7, can be deferred)            | GTM workspace (PR 11)                         |
| AI-5 | Decide: Ops service-wrapper or CLI-only                             | strategic decision needed from Justin    | PR 12 Ops workspace                           |
| AI-6 | Audit BR's capability-routed god-mode for parity with REST contract | folded into PR 9 (BR workspace polish)   | BR contract acknowledgment                    |

## What the audit did NOT cover

- ChangeSet _discipline_ — only endpoint _existence_. Mutating tools may or may not gate via ChangeSets; that's `changeset-discipline-checker`'s job in a follow-up PR.
- Tenant scoping — `tenant-isolation-auditor`'s job in a follow-up PR.
- Authn/authz on each endpoint — assumed to be Bearer token per contract; not verified live.
- Live HTTP probing — this was static analysis only. Recommended next: `brainstorm platform verify <prod-url>` against each deployed product to confirm the static reading matches runtime behavior.

## Next steps (per the opus plan)

The plan's PR 2 (IAM operator roles + Keycloak OIDC) is now in flight in branch `feat/operator-roles-keycloak-oidc` on BrainstormOps. The audit findings don't block PR 2 — operator roles are about _access to resources_, not the application-level contract compliance.

After PR 2, the natural follow-up is **new PR 1.5** (add /self + /discovery across MSP, BR, GTM) which is small and unblocks brainstorm's harness-aware UI. The original PR 1.5 (BR cutover documentation) becomes PR 1.6.
