# @brainstorm/mcp

MCP (Model Context Protocol) client for external tool integration.

## Key Exports

- `MCPClient` — Connect to MCP servers via SSE or HTTP transport
- Auto-connects to BrainstormRouter's 64 MCP tools on startup (if configured)

## Configuration

```toml
[mcp.brainstormrouter]
transport = "sse"
url = "https://api.brainstormrouter.com/mcp/sse"

[mcp.custom]
transport = "http"
url = "http://localhost:3001/mcp"
```
