# @brainstorm/gateway

Typed client for the BrainstormRouter SaaS API.

## Key Exports

- `GatewayClient` — Typed API client for all BrainstormRouter endpoints
- `parseGatewayHeaders()` — Extract routing metadata from response headers

## Headers Parsed

- `x-br-model` — Actual model used
- `x-br-provider` — Provider that served the request
- `x-br-cost` — Cost of this request
- `x-br-latency` — End-to-end latency
- `x-br-session-cost` — Cumulative session cost
- `x-br-budget-remaining` — Budget remaining
