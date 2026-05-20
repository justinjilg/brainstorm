# BrainstormRouter Integration

[BrainstormRouter](https://brainstormrouter.com) is the intelligent AI gateway that powers Brainstorm's multi-model routing. It's an OpenAI-compatible API gateway with Thompson-sampling routing across a curated catalog of 31 models from 8 providers (Anthropic, OpenAI, Google, xAI, Groq, Perplexity, DeepSeek, Moonshot).

> Authoritative discovery surfaces (use these instead of hard-coding):
>
> - `https://api.brainstormrouter.com/openapi.json` — full endpoint contract
> - `https://api.brainstormrouter.com/v1/discovery` — live capabilities, MCP tool count, memory blocks, routing strategies
> - `https://brainstormrouter.com/llms.txt` — agent-ingestion summary
> - `https://api.brainstormrouter.com/attestation` — signed image + Rekor transparency

## How It Works

```
Brainstorm CLI
  → BrainstormRouter API (api.brainstormrouter.com/v1)
    → Provider selection (Anthropic, OpenAI, Google, etc.)
      → LLM API
    ← Response with routing metadata headers + signed trust envelope
  ← Agent uses response + metadata for self-awareness
```

Every request to BrainstormRouter includes:

- **Agent identity** — Who's calling (agent name, session ID)
- **Task profile** — Classified task metadata (complexity, category)
- **Routing hints** — Strategy preference, budget constraints

Every response from BrainstormRouter includes a rich `x-br-*` header envelope. The high-value fields (verified live 2026-05-15):

| Header                                                                        | Meaning                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `x-br-envelope`                                                               | Trust-envelope mode marker (`audit`, `enforce`, etc.)  |
| `x-br-audit-hash`                                                             | 64-hex audit-chain pointer for evidence ledger linking |
| `x-br-routed-model`                                                           | Actual model used (e.g. `deepseek/deepseek-chat`)      |
| `x-br-actual-cost`                                                            | Measured cost in USD for this request                  |
| `x-br-estimated-cost`                                                         | Pre-routing cost estimate                              |
| `x-br-routing-savings`                                                        | Savings vs. naive routing                              |
| `x-br-budget-remaining`                                                       | Budget remaining after this call                       |
| `x-br-total-latency-ms`                                                       | End-to-end latency                                     |
| `x-br-provider-latency-ms`                                                    | Provider-side latency only                             |
| `x-br-routing-overhead-ms`                                                    | Time spent in BR routing logic                         |
| `x-br-route-reason`                                                           | Why this model was picked (`explicit`, `auto`, etc.)   |
| `x-br-route-confidence`                                                       | Confidence score (0–1)                                 |
| `x-br-routing-reasoning`                                                      | Full reasoning JSON                                    |
| `x-br-quality-tier`                                                           | `heuristic` / `learned` / `verified`                   |
| `x-br-quality-score`                                                          | Quality score for the selected model                   |
| `x-br-selection-method`                                                       | Selection algorithm used                               |
| `x-br-selection-confidence`                                                   | Selection confidence (0–1)                             |
| `x-br-models-considered`                                                      | How many models BR evaluated                           |
| `x-br-reputation-tier`                                                        | Caller's reputation tier (`gold`, `silver`, etc.)      |
| `x-br-tier`                                                                   | Caller's subscription tier (`community`, etc.)         |
| `x-br-model-contract`                                                         | `strict` when model-contract enforcement is on         |
| `x-br-deprecation`                                                            | Sunset notice + migration target (when applicable)     |
| `x-br-guardian-status` / `x-br-guardian-overhead-ms`                          | Guardian safety layer                                  |
| `x-br-guardrail-status` / `x-br-guardrail-summary` / `x-br-guardrail-actions` | Response WAF state                                     |
| `x-request-id`                                                                | Request id (use for `/v1/usage/{id}/feedback`)         |

The trust envelope itself is a JWS/Ed25519-signed token minted server-side; see [Trust Envelope](https://docs.brainstormrouter.com/concepts/trust-envelope) for the payload schema (`br_principal`, `br_budget`, `br_scope`, `br_trust`, `br_observability`, `br_test`). The signature never leaves BR — clients consume the audit hash + envelope-mode header instead.

## Native Intelligence Tools

Brainstorm ships 8 tools that call BrainstormRouter's REST API directly (no MCP needed):

### `br_status`

Full system check — returns agent identity, budget status, system health, and optimization suggestions.

### `br_budget`

Current budget status: daily spend, remaining budget, spend rate, and forecast for remaining capacity.

### `br_leaderboard`

Real performance rankings based on production data: which models are fastest, cheapest, and highest quality for each task type.

### `br_insights`

Cost optimization recommendations: which models to prefer/avoid, estimated savings from switching strategies.

### `br_models`

Lists all available models with pricing, capabilities, and provider info. Filterable by provider or capability.

### `br_memory_search`

Search persistent memory across sessions. Memories stored via `br_memory_store` persist indefinitely.

### `br_memory_store`

Save facts, decisions, or context that should persist across sessions. The agent can retrieve these later via `br_memory_search`.

### `br_health`

Quick connectivity test — checks if BrainstormRouter is reachable via the unauthenticated `/health` probe.

## API Endpoints Used

| Endpoint                    | Method | Purpose                                     |
| --------------------------- | ------ | ------------------------------------------- |
| `/health`                   | GET    | Unauthenticated connectivity probe          |
| `/v1/chat/completions`      | POST   | Main inference (OpenAI-compatible)          |
| `/v1/self`                  | GET    | Agent identity, budget, health, suggestions |
| `/v1/budget/status`         | GET    | Current budget status                       |
| `/v1/budget/forecast`       | GET    | Spend forecast                              |
| `/v1/models`                | GET    | List available models                       |
| `/v1/memory/query`          | POST   | Persistent memory search                    |
| `/v1/memory/store`          | POST   | Persistent memory write                     |
| `/v1/intelligence/rankings` | GET    | Model rankings                              |
| `/v1/insights/optimize`     | GET    | Optimization suggestions                    |

## Authentication

BrainstormRouter uses API keys. Store yours in the vault:

```bash
storm vault add BRAINSTORM_API_KEY
```

A free community key is included for zero-setup onboarding (rate-limited, shared budget).

## Error Recovery

BrainstormRouter sends structured recovery hints in error responses:

```json
{
  "error": { "message": "Rate limit exceeded", "type": "rate_limit" },
  "recovery": {
    "action": "retry",
    "message": "Rate limited. Retry in 30 seconds.",
    "wait_ms": 30000,
    "endpoint": null,
    "docs_url": "https://docs.brainstormrouter.com/rate-limits"
  }
}
```

Brainstorm parses these hints automatically and shows actionable messages to the user.

## MCP Integration

BrainstormRouter exposes its tool catalog via MCP. The tool count is a live value (107 in `llms.txt` as of 2026-05-15, 111 reported by `/v1/discovery`) — always read it from `GET /v1/discovery` rather than hard-coding.

```toml
[mcp.brainstormrouter]
transport = "http"
url = "https://api.brainstormrouter.com/v1/mcp/connect"
```

The native REST tools (8 in `packages/tools/src/builtin/br-intelligence.ts`) are preferred over MCP tools for common operations due to lower latency.
