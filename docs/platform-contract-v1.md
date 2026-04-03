# Brainstorm Platform Contract Specification v1

## Purpose

This is the canonical specification for how every system in the Brainstorm ecosystem communicates. Any system implementing this contract is automatically discoverable and operable from the Brainstorm CLI, dashboard, and API.

**Audience**: Any engineer implementing God Mode endpoints on a new or existing system.  
**Languages**: The contract is HTTP + JSON. Implementations exist in TypeScript (BR, CLI), Python (MSP, GTM), and Go (VM).  
**Validator**: `brainstorm platform verify <url>` tests compliance.

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
    human: "supabase-jwt"
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
