# Brainstorm Platform Contract Specification v1

## Purpose

This is the canonical specification for how every system in the Brainstorm ecosystem communicates. Any system implementing this contract is automatically discoverable and operable from the Brainstorm CLI, dashboard, and API.

**Audience**: Any engineer implementing God Mode endpoints on a new or existing system.  
**Languages**: The contract is HTTP + JSON for most products. **MCP JSON-RPC over stdio is an accepted equivalent transport** for products that natively speak MCP (e.g. BrainstormVM) — see §9. Implementations exist in TypeScript (BR, CLI), Python (MSP, GTM), and Go (VM-via-MCP).  
**Validator**: `brainstorm platform verify <url>` tests compliance for HTTP products. `brainstorm platform verify <mcp-endpoint> --transport=mcp` tests compliance for MCP products.

---

## 1. Authentication

### 1.1 Token Format

All authenticated requests use Bearer tokens in the Authorization header:

```
Authorization: Bearer <token>
```

Three token types are accepted:

| Type           | Format                       | Issuer           | Use                              |
| -------------- | ---------------------------- | ---------------- | -------------------------------- |
| Supabase JWT   | `eyJ...` (base64url)         | Supabase Auth    | Human users (browser, CLI)       |
| Service key    | `bst_svc_<48 hex chars>`     | Product server   | Automation, CI/CD, cross-product |
| Platform token | JWT with `platform_*` claims | BrainstormRouter | Cross-product delegation         |

### 1.2 Required JWT Claims

```json
{
  "sub": "user-uuid",
  "platform_tenant_id": "tenant-uuid",
  "exp": 1712345678
}
```

### 1.3 Tenant Scoping

**Every query MUST be scoped to `platform_tenant_id`.** No exceptions. The tenant ID comes from the JWT claim, never from user input.

---

## 2. Health Endpoint

```
GET /health
→ 200
{
  "status": "healthy" | "degraded" | "unhealthy",
  "version": "2.1.0",
  "product": "msp",
  "uptime_seconds": 86400,
  "checks": { "database": "ok", "cache": "ok" }
}
```

| Field          | Type                                     | Required |
| -------------- | ---------------------------------------- | -------- |
| status         | `"healthy" \| "degraded" \| "unhealthy"` | Yes      |
| version        | string (semver)                          | Yes      |
| product        | string (lowercase slug)                  | Yes      |
| uptime_seconds | number                                   | No       |
| checks         | Record<string, string>                   | No       |

No auth required. Returns 200 (healthy/degraded) or 503 (unhealthy).

---

## 3. Tool Discovery

```
GET /api/v1/god-mode/tools
Authorization: Bearer <token>
→ 200
{
  "product": "msp",
  "version": "2.1.0",
  "tool_count": 12,
  "tools": [ <ToolDefinition>, ... ]
}
```

### Tool Definition

```json
{
  "name": "msp.list_devices",
  "domain": "endpoint-management",
  "product": "msp",
  "description": "Search for devices by owner, hostname, or keyword.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search term" }
    },
    "required": ["query"]
  },
  "risk_level": "read_only",
  "requires_changeset": false,
  "evidence_type": "observation"
}
```

| Field              | Type       | Required | Description                                      |
| ------------------ | ---------- | -------- | ------------------------------------------------ |
| name               | string     | Yes      | `{product}.{verb}_{noun}` — globally unique      |
| domain             | string     | Yes      | Capability domain (dashboard grouping)           |
| product            | string     | Yes      | Must match response `product` field              |
| description        | string     | Yes      | Human-readable, injected into LLM prompt         |
| parameters         | JSONSchema | Yes      | Input validation schema                          |
| risk_level         | enum       | Yes      | `read_only \| low \| medium \| high \| critical` |
| requires_changeset | boolean    | Yes      | If true → simulation + approval flow             |
| evidence_type      | enum       | No       | `observation \| execution \| decision`           |

### Naming Convention

```
{product}.{verb}_{noun}

Products: msp, br, gtm, vm, shield, hive, ops, openclaw
Verbs:    list, get, create, update, delete, set, run, scan, check, migrate, deploy
```

### Domain Registry

| Domain              | Products      |
| ------------------- | ------------- |
| endpoint-management | MSP           |
| endpoint-security   | MSP, Shield   |
| backup              | MSP           |
| service-discovery   | MSP           |
| user-management     | MSP           |
| model-routing       | BR            |
| billing             | BR            |
| api-keys            | BR            |
| observability       | BR, MSP       |
| agent-management    | GTM, OpenClaw |
| campaigns           | GTM           |
| lead-management     | GTM           |
| analytics           | GTM, Hive     |
| compute             | VM            |
| storage             | VM            |
| network             | VM            |
| migration           | VM            |
| email-security      | Shield        |
| quarantine          | Shield        |
| trust-analysis      | Shield        |
| threat-intel        | Shield        |
| domain-management   | Hive          |
| infrastructure      | Ops           |

### Risk Level Semantics

| Level     | CLI Behavior                              |
| --------- | ----------------------------------------- |
| read_only | Auto-approve, readonly=true               |
| low       | Auto-approve                              |
| medium    | ChangeSet if requires_changeset=true      |
| high      | Always ChangeSet + user approval          |
| critical  | ChangeSet + explicit confirmation + audit |

---

## 4. Tool Execution

```
POST /api/v1/god-mode/execute
Authorization: Bearer <token>
Content-Type: application/json

{
  "tool": "msp.list_devices",
  "params": { "query": "macbook" },
  "simulate": false,
  "correlation_id": "uuid",
  "idempotency_key": "uuid"
}
```

### Success Response

```json
{
  "success": true,
  "tool": "msp.list_devices",
  "data": { "devices": [...], "count": 1 },
  "risk_level": "read_only",
  "trace_id": "srv-123",
  "evidence_id": "ev-456"
}
```

### Simulation Response (simulate=true, requires_changeset=true)

```json
{
  "success": true,
  "tool": "msp.isolate_device",
  "simulation": {
    "success": true,
    "statePreview": { "device": "isolated" },
    "cascades": ["VPN disconnected"],
    "constraints": [],
    "estimatedDuration": "< 30 seconds"
  },
  "changes": [
    {
      "system": "msp",
      "entity": "device:abc",
      "operation": "execute",
      "before": { "network": "connected" },
      "after": { "network": "isolated" }
    }
  ],
  "description": "Isolate device from network",
  "risk_level": "high",
  "trace_id": "srv-124"
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION",
    "message": "Missing required parameter: device_id"
  },
  "tool": "msp.isolate_device",
  "trace_id": "srv-125"
}
```

### Error Codes

| Code         | HTTP | Meaning                           |
| ------------ | ---- | --------------------------------- |
| VALIDATION   | 400  | Invalid params                    |
| UNAUTHORIZED | 401  | Bad/missing token                 |
| FORBIDDEN    | 403  | Insufficient permissions          |
| NOT_FOUND    | 404  | Unknown tool                      |
| RATE_LIMITED | 429  | Per-tenant limit (60/min default) |
| CONFLICT     | 409  | Idempotency collision             |
| INTERNAL     | 500  | Server error                      |
| UNAVAILABLE  | 503  | System degraded                   |

Rate limit response MUST include `Retry-After` header.

---

## 5. Platform Events

```
POST /api/v1/platform/events
{
  "id": "uuid-v7",
  "type": "msp.alert.created",
  "tenant_id": "uuid",
  "product": "msp",
  "timestamp": "2026-04-03T12:00:00Z",
  "data": { ... },
  "schema_version": 1,
  "correlation_id": "uuid",
  "signature": "hmac-sha256-hex"
}
→ { "accepted": true, "handled": true }
```

### Signature Computation

```
tenant_key = HMAC-SHA256(master_secret, tenant_id)
payload = canonical_json(event excluding "signature")
signature = HMAC-SHA256(tenant_key, payload)
```

Canonical JSON: keys sorted recursively, no whitespace, UTF-8.

### Event Naming

```
{product}.{noun}.{past_tense_verb}
  msp.alert.created       br.model.degraded
  gtm.campaign.completed  shield.threat.detected
  vm.instance.migrated    ops.deploy.completed
```

---

## 6. Tenant Lifecycle

```
POST /api/v1/platform/tenants
{ "tenant_id": "uuid", "action": "provision" | "deprovision",
  "product_config": { "name": "Acme Corp" }, "idempotency_key": "uuid" }
→ { "success": true, "tenant_id": "uuid", "state": "provisioned" }
```

Deprovision = soft-delete, 30-day retention.

---

## 7. Product Manifest

Every repo root: `product-manifest.yaml`

```yaml
product:
  id: "msp"
  name: "BrainstormMSP"
  version: "2.1.0"
security:
  api_base: "https://brainstormmsp.ai"
  health: "/health"
  auth:
    human: "keycloak-oidc"
    machine: "api-key"
    tenant_claim: "platform_tenant_id"
capabilities:
  - domain: "endpoint-management"
events:
  publishes:
    - type: "msp.alert.created"
      schema_version: 1
  subscribes:
    - "platform.tenant.created"
```

---

## 8. Implementation Checklist

```
□ god_mode.{ts|py|go} with TOOLS list and EXECUTORS map
□ Routes: GET /api/v1/god-mode/tools, POST /api/v1/god-mode/execute
□ GET /health returns { status, version, product }
□ Rate limiting: 60 req/min per tenant
□ Param validation before execution
□ All queries scoped to platform_tenant_id
□ Query timeouts: 10s read, 30s write
□ Standard error format: { success: false, error: { code, message } }
□ product-manifest.yaml at repo root
□ Verify: brainstorm platform verify <url>
```

300-500 lines per system. 1-2 hours.

---

## 9. Alternative Transports

The platform contract is HTTP + JSON by default. Some products in the ecosystem natively speak Model Context Protocol (MCP) JSON-RPC over stdio — most notably BrainstormVM, which exposes its capabilities through an MCP server rather than a REST API. To keep the contract honest about transport diversity (and to avoid forcing those products to bolt on a REST proxy purely for contract compliance), **MCP JSON-RPC is an accepted equivalent transport** for §2 (Health), §3 (Tool Discovery), §4 (Tool Execution), §5.5 (Self), and §5.6 (Discovery).

The §5 platform events endpoint and §6 tenant lifecycle endpoint remain **HTTP-only** — those are server-to-server flows where MCP's stdio transport doesn't fit.

### 9.1 Equivalence map (HTTP REST ↔ MCP JSON-RPC)

| Contract endpoint               | MCP method                                           | Notes                                                                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                   | `health/check` OR derived from `initialize` response | Implementations may publish a `health/check` RPC, or return a `status` field on the `initialize` response's `serverInfo`. Either is compliant.                                                                                                      |
| `GET /api/v1/god-mode/tools`    | `tools/list`                                         | Return shape is MCP's `Tool[]`; the contract's `risk_level` + `requires_changeset` + `evidence_type` fields go into the MCP tool's `annotations` field (MCP SDK ≥ v0.7).                                                                            |
| `POST /api/v1/god-mode/execute` | `tools/call`                                         | Request `params.arguments` carries the contract's `params`. Response `content` arrays must conform to the success / simulation / error shapes in §4. ChangeSet `simulate=true` semantics are signaled by an `extra.simulate=true` flag on the call. |
| `GET /api/v1/self`              | `initialize` response                                | The MCP `initialize` RPC's response includes `serverInfo { name, version }` and `capabilities` — sufficient to populate the contract's `{ product, version, capabilities, schema_version }`.                                                        |
| `GET /api/v1/discovery`         | `initialize` response + `resources/list`             | The capabilities object lists supported resource types, equivalent to the contract's `{ tools_url, self_url, events_url?, openapi_url? }` (MCP variant publishes resource URIs instead of REST URLs).                                               |

### 9.2 Auth over MCP

MCP servers accept auth via environment variables on the stdio transport (e.g. `MCP_API_TOKEN`) OR via the first `initialize` message's `clientInfo.auth` field (MCP SDK ≥ v0.7). The token format and required JWT claims from §1 are unchanged — only the transport differs.

The `platform_tenant_id` claim still applies. MCP servers must enforce tenant scoping inside `tools/call` handlers identically to HTTP product handlers.

### 9.3 Events over MCP — explicit gap

MCP products that produce events MUST publish to the `brainstorm.events` EventBridge bus directly via the AWS SDK (or via a small HTTP-based proxy if the runtime can't reach AWS). MCP's `notifications/*` channel is NOT a substitute for federation events — the bus is the system of record for cross-product observability.

### 9.4 Implementation checklist for MCP products

In addition to the contract's normal §8 checklist:

```
□ MCP server registered with the brainstorm CLI's MCP client manager
□ initialize response includes serverInfo.name = "<product>" and version semver
□ initialize response capabilities object includes "tools" and "health"
□ tools/list returns Tool[] with annotations carrying risk_level + requires_changeset
□ tools/call respects simulate=true via extra.simulate flag
□ Auth enforced via MCP_API_TOKEN env or initialize.clientInfo.auth
□ Tenant scoping enforced in every handler
□ EventBridge publisher wired for state-change events (NOT MCP notifications)
□ Verify: brainstorm platform verify <stdio-endpoint> --transport=mcp
```

### 9.5 Why this amendment exists

The original contract assumed HTTP universally, which forced VM into an awkward position: it's an MCP-native product whose Go implementation would have needed a REST proxy layer purely to claim contract compliance. The audit at `docs/business-harness/contract-gap-inventory-2026-05.md` surfaced this as a "spec gap, not a code gap." Permitting MCP recognizes that:

1. brainstorm-the-hub already speaks MCP for tool dispatch (via the MCP client in `packages/mcp`)
2. The information conveyed is identical; only the wire shape differs
3. Forcing REST adds a translation layer that does nothing for the operator UX

Future transports (gRPC, OpenAPI-on-Hono, etc.) can be added here when justified — but should be additive, never replacing HTTP or MCP for products that already use them.
