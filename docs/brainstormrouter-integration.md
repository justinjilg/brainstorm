# BrainstormRouter Integration

[BrainstormRouter](https://brainstormrouter.com) is the intelligent AI gateway that powers Brainstorm's multi-model routing. It's an OpenAI-compatible API gateway with Thompson sampling across 357+ models from 7 providers.

## How It Works

```
Brainstorm CLI
  → BrainstormRouter API (api.brainstormrouter.com/v1)
    → Provider selection (Anthropic, OpenAI, Google, etc.)
      → LLM API
    ← Response with routing metadata headers
  ← Agent uses response + metadata for self-awareness
```

Every request to BrainstormRouter includes:
- **Agent identity** — Who's calling (agent name, session ID)
- **Task profile** — Classified task metadata (complexity, category)
- **Routing hints** — Strategy preference, budget constraints

Every response from BrainstormRouter includes custom headers:
- `x-br-model` — Actual model used
- `x-br-provider` — Provider that served the request
- `x-br-cost` — Cost of this request
- `x-br-latency` — End-to-end latency
- `x-br-session-cost` — Cumulative session cost
- `x-br-budget-remaining` — Budget remaining

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
Quick connectivity test — checks if BrainstormRouter is reachable and authenticated.

## API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/chat/completions` | POST | Main inference (OpenAI-compatible) |
| `/v1/models` | GET | List available models |
| `/v1/agent/status` | GET | Agent identity and budget |
| `/v1/agent/memory` | GET/POST | Persistent memory |
| `/v1/intelligence/leaderboard` | GET | Model rankings |
| `/v1/intelligence/insights` | GET | Optimization suggestions |
| `/v1/health` | GET | Health check |

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

BrainstormRouter also exposes 64 MCP tools via SSE transport. Brainstorm auto-connects to these on startup if configured:

```toml
[mcp.brainstormrouter]
transport = "sse"
url = "https://api.brainstormrouter.com/mcp/sse"
```

The native REST tools (8) are preferred over MCP tools for common operations due to lower latency.
