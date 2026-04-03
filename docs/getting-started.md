# Getting Started with Brainstorm

Brainstorm is a governed control plane for AI-managed infrastructure. It connects AI operators (Claude Code, Claude Desktop, or any MCP-compatible agent) to your entire product ecosystem through a standardized protocol.

## Quick Start (2 minutes)

### 1. Install

```bash
npm install -g @brainst0rm/cli
```

### 2. Set your API key

```bash
export BRAINSTORM_API_KEY=br_live_xxx
```

Get a key at [brainstormrouter.com/dashboard](https://brainstormrouter.com/dashboard). This single key authenticates you across the entire ecosystem.

### 3. Run setup

```bash
brainstorm setup
```

This will:

- Verify your API key
- Test connectivity to all products (MSP, BR, GTM, VM, Shield)
- Configure Claude Code's MCP settings (`~/.claude/mcp.json`)
- Report what's connected and how many tools are available

### 4. Restart Claude Code

Claude Code will discover Brainstorm's MCP server and gain access to all God Mode tools across every connected product.

### 5. Verify

```bash
brainstorm status
```

```
Brainstorm Ecosystem Status
───────────────────────────

Auth:     ✓ BR key set
Vault:    ✓ 1Password connected

Products:
  ● BrainstormMSP        12 tools  brainstormmsp.ai        78ms  healthy
  ● BrainstormRouter      10 tools  api.brainstormrouter.com 12ms  healthy
  ○ BrainstormGTM          9 tools  catsfeet.com             —    offline
  ○ BrainstormVM           9 tools  vm.brainstorm.co         —    offline
  ○ BrainstormShield      10 tools  shield.brainstorm.co     —    offline

MCP:      ✓ brainstorm MCP server configured

12 tools available across ecosystem.
```

---

## How It Works

### Architecture

```
You (human intent)
  → Claude Code (AI operator — reads, writes, reasons, decides)
    → Brainstorm MCP Server (tool discovery + routing)
      → BrainstormRouter (model selection, cost tracking, memory)
        → Products (MSP, VM, Shield, GTM, Ops)
          → Edge agents, databases, infrastructure
```

### The Platform Contract

Every product in the ecosystem implements the same 5 endpoints:

| Endpoint                        | Purpose              |
| ------------------------------- | -------------------- |
| `GET /health`                   | Is the system alive? |
| `GET /api/v1/god-mode/tools`    | What can it do?      |
| `POST /api/v1/god-mode/execute` | Do it.               |
| `POST /api/v1/platform/events`  | Something happened.  |
| `POST /api/v1/platform/tenants` | Add/remove a tenant. |

The CLI discovers products at runtime. Adding a new product to the ecosystem requires zero code changes — just a config entry.

### Tools

When Claude Code connects via MCP, it gets access to all discovered tools:

| Tool                     | Product | What it does                         |
| ------------------------ | ------- | ------------------------------------ |
| `msp_list_devices`       | MSP     | Search managed devices               |
| `msp_backup_coverage`    | MSP     | Check backup status                  |
| `msp_isolate_device`     | MSP     | Network-isolate a compromised device |
| `br_list_models`         | BR      | List available LLM models            |
| `br_budget_status`       | BR      | Check spend vs budget                |
| `gtm_list_campaigns`     | GTM     | Show active marketing campaigns      |
| `vm_list_instances`      | VM      | List virtual machines                |
| `shield_list_quarantine` | Shield  | Show quarantined emails              |

Tools with `requires_changeset: true` go through a safety flow: **simulation → approval → execution**. The AI cannot destroy a VM or isolate a device without showing you what will happen first.

### Safety

- **ChangeSets** — every destructive action is simulated before execution. Risk scored 0-100. Cascading effects shown. User approves or rejects.
- **Audit trail** — every tool call is logged with HMAC-signed evidence. Tamper-evident. 7-year retention.
- **Tenant isolation** — every query scoped to `platform_tenant_id`. 56 tests verify no cross-tenant leakage.
- **Rate limiting** — 60 req/min per tenant per product. Prevents runaway automation.
- **PQC signing** — evidence chains signed with hybrid Ed25519 + ML-DSA-65 (post-quantum ready).

---

## Commands

### `brainstorm setup`

One-command bootstrap. Run on any new machine.

```bash
brainstorm setup
```

### `brainstorm status`

Full ecosystem diagnostic.

```bash
brainstorm status
```

### `brainstorm mcp`

MCP server (stdio). Claude Code spawns this automatically via `~/.claude/mcp.json`.

### `brainstorm serve`

HTTP API server for dashboards and direct API access.

```bash
brainstorm serve --port 8000 --cors
```

### `brainstorm run`

Single-shot prompt with tool access.

```bash
brainstorm run --tools --max-steps 5 --lfg "list all managed devices"
```

### `brainstorm platform verify <url>`

Test if a product implements the platform contract.

```bash
brainstorm platform verify https://brainstormmsp.ai
```

### `brainstorm platform init`

Generate a `product-manifest.yaml` template for a new product.

---

## Authentication

### API Keys

| Key                         | Purpose                     |
| --------------------------- | --------------------------- |
| `BRAINSTORM_API_KEY`        | BrainstormRouter (required) |
| `BRAINSTORM_MSP_API_KEY`    | MSP God Mode tools          |
| `BRAINSTORM_GTM_API_KEY`    | GTM agent management        |
| `BRAINSTORM_VM_API_KEY`     | VM operations               |
| `BRAINSTORM_SHIELD_API_KEY` | Email security tools        |

### 1Password

If `OP_SERVICE_ACCOUNT_TOKEN` is set, all keys resolve from 1Password automatically.

```bash
export OP_SERVICE_ACCOUNT_TOKEN=ops_xxx
brainstorm setup  # keys resolve automatically
```

### Multi-Tenant

Every API call is scoped to `platform_tenant_id` from the JWT. Teams get their own tenant. Data is isolated at the database level with RLS policies.

---

## Adding a New Product

### 1. Implement 3 endpoints

```
GET  /health → { status: "healthy", version: "1.0.0", product: "myproduct" }
GET  /api/v1/god-mode/tools → { product: "myproduct", tools: [...] }
POST /api/v1/god-mode/execute → { tool: "myproduct.do_thing", params: {...} }
```

### 2. Add to config

```toml
[godmode.connectors.myproduct]
enabled = true
displayName = "My Product"
baseUrl = "https://myproduct.example.com"
apiKeyName = "MYPRODUCT_API_KEY"
```

### 3. Verify

```bash
brainstorm platform verify https://myproduct.example.com
```

### 4. Restart Claude Code

The new product's tools appear automatically. No code changes in Brainstorm.

---

## Specification

Full platform contract: [docs/platform-contract-v1.md](platform-contract-v1.md)

Covers: authentication, tool discovery, tool execution, event signing, tenant lifecycle, product manifests, error codes, rate limiting, naming conventions.

---

## For AI Operators

When operating through Brainstorm:

- **Call tools, don't guess.** Every product's capabilities are discoverable via God Mode.
- **Destructive actions produce ChangeSets.** Show the simulation. Wait for approval.
- **Everything is audited.** HMAC-signed, tenant-scoped, tamper-evident.
- **Route LLM calls through BrainstormRouter.** It tracks cost and picks the best model.
- **Discover at runtime.** `GET /api/v1/god-mode/tools` tells you what any system can do.
