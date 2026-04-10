import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MCPClientManager, type MCPServerConfig } from "../client.js";

// Shared mock state so vi.mock() factory and tests can coordinate
const mockState: {
  tools: Record<string, any> | null;
  lastTransport: any;
  closeFn: ReturnType<typeof vi.fn>;
  throwOnCreate: Error | null;
} = {
  tools: null,
  lastTransport: null,
  closeFn: vi.fn(),
  throwOnCreate: null,
};

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async ({ transport }: { transport: any }) => {
    mockState.lastTransport = transport;
    if (mockState.throwOnCreate) throw mockState.throwOnCreate;
    return {
      tools: async () => mockState.tools,
      close: mockState.closeFn,
    };
  }),
}));

vi.mock("@ai-sdk/mcp/mcp-stdio", () => ({
  Experimental_StdioMCPTransport: class {
    kind = "stdio";
    opts: any;
    constructor(opts: any) {
      this.opts = opts;
    }
  },
}));

function makeRegistry() {
  // MCPClientManager writes via (registry as any).tools.set(...)
  return { tools: new Map<string, any>() } as any;
}

describe("MCPClientManager", () => {
  beforeEach(() => {
    mockState.tools = null;
    mockState.lastTransport = null;
    mockState.closeFn = vi.fn();
    mockState.throwOnCreate = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("addServers skips disabled entries", async () => {
    const mgr = new MCPClientManager();
    mgr.addServers([
      { name: "a", transport: "http", url: "http://x", enabled: false },
      { name: "b", transport: "http", url: "http://y", enabled: true },
      { name: "c", transport: "http", url: "http://z" }, // undefined = enabled
    ]);
    mockState.tools = {};
    const registry = makeRegistry();
    const result = await mgr.connectAll(registry);
    expect(result.connected).toEqual(["b", "c"]);
    expect(result.connected).not.toContain("a");
  });

  it("normalizes MCP tool schema — injects type:'object' and properties", async () => {
    mockState.tools = {
      search: {
        description: "search stuff",
        parameters: { required: ["q"] }, // missing type + properties
      },
    };
    const mgr = new MCPClientManager();
    mgr.addServers([{ name: "srv", transport: "http", url: "http://x" }]);
    const registry = makeRegistry();

    await mgr.connectAll(registry);

    const entry = registry.tools.get("mcp_srv_search");
    expect(entry).toBeDefined();
    expect(entry.deferred).toBe(true);
    expect(entry.description).toBe("search stuff");
    const aiSdkTool = entry.toAISDKTool();
    expect(aiSdkTool.parameters.type).toBe("object");
    expect(aiSdkTool.parameters.properties).toEqual({});
    expect(aiSdkTool.parameters.required).toEqual(["q"]);
  });

  it("registers tools under mcp_<server>_<tool> naming and honors toolFilter", async () => {
    mockState.tools = {
      keep: { description: "k" },
      drop: { description: "d" },
    };
    const mgr = new MCPClientManager();
    mgr.addServers([
      {
        name: "srv",
        transport: "http",
        url: "http://x",
        toolFilter: ["keep"],
      },
    ]);
    const registry = makeRegistry();
    await mgr.connectAll(registry);

    expect(registry.tools.has("mcp_srv_keep")).toBe(true);
    expect(registry.tools.has("mcp_srv_drop")).toBe(false);
  });

  it("rejects malformed tool defs via validateMCPTool and reports errors", async () => {
    mockState.tools = {
      good: { description: "ok" },
      bad_desc: { description: 123 }, // non-string description
      bad_schema: { description: "x", parameters: "not-an-object" },
      nullish: null,
    };
    const mgr = new MCPClientManager();
    mgr.addServers([{ name: "srv", transport: "http", url: "http://x" }]);
    const registry = makeRegistry();
    const result = await mgr.connectAll(registry);

    expect(registry.tools.has("mcp_srv_good")).toBe(true);
    expect(registry.tools.has("mcp_srv_bad_desc")).toBe(false);
    expect(registry.tools.has("mcp_srv_bad_schema")).toBe(false);
    expect(registry.tools.has("mcp_srv_nullish")).toBe(false);
    expect(result.connected).toContain("srv");
    // Three malformed tools should surface as three errors on the same server
    const srvErrors = result.errors.filter((e) => e.name === "srv");
    expect(srvErrors.length).toBe(3);
    for (const err of srvErrors) {
      expect(err.error).toMatch(/Malformed tool/);
    }
  });

  it("passes BRAINSTORM_API_KEY env as Bearer header on http/sse transport", async () => {
    mockState.tools = {};
    const mgr = new MCPClientManager();
    const cfg: MCPServerConfig = {
      name: "srv",
      transport: "sse",
      url: "http://x",
      env: { BRAINSTORM_API_KEY: "secret-token" },
    };
    mgr.addServers([cfg]);
    await mgr.connectAll(makeRegistry());

    expect(mockState.lastTransport.type).toBe("sse");
    expect(mockState.lastTransport.url).toBe("http://x");
    expect(mockState.lastTransport.headers).toEqual({
      Authorization: "Bearer secret-token",
    });
  });

  it("omits headers when no auth is configured", async () => {
    mockState.tools = {};
    const mgr = new MCPClientManager();
    mgr.addServers([{ name: "srv", transport: "http", url: "http://x" }]);
    await mgr.connectAll(makeRegistry());

    expect(mockState.lastTransport.type).toBe("http");
    expect(mockState.lastTransport.headers).toBeUndefined();
  });

  it("builds stdio transport via Experimental_StdioMCPTransport", async () => {
    mockState.tools = {};
    const mgr = new MCPClientManager();
    mgr.addServers([
      {
        name: "srv",
        transport: "stdio",
        command: "my-mcp",
        args: ["--flag"],
        env: { FOO: "bar" },
      },
    ]);
    await mgr.connectAll(makeRegistry());

    // Custom class from the mock — has .kind and .opts
    expect(mockState.lastTransport.kind).toBe("stdio");
    expect(mockState.lastTransport.opts.command).toBe("my-mcp");
    expect(mockState.lastTransport.opts.args).toEqual(["--flag"]);
    expect(mockState.lastTransport.opts.env.FOO).toBe("bar");
  });

  it("captures connection errors without throwing, then disconnectAll cleans up", async () => {
    mockState.throwOnCreate = new Error("boom");
    const mgr = new MCPClientManager();
    mgr.addServers([{ name: "broken", transport: "http", url: "http://x" }]);

    const result = await mgr.connectAll(makeRegistry());
    expect(result.connected).toEqual([]);
    expect(result.errors).toEqual([{ name: "broken", error: "boom" }]);
    expect(mgr.listConnected()).toEqual([]);

    // Now a successful server, then disconnectAll
    mockState.throwOnCreate = null;
    mockState.tools = {};
    mgr.addServers([{ name: "ok", transport: "http", url: "http://x" }]);
    await mgr.connectAll(makeRegistry());
    expect(mgr.listConnected()).toContain("ok");

    await mgr.disconnectAll();
    expect(mockState.closeFn).toHaveBeenCalled();
    expect(mgr.listConnected()).toEqual([]);
  });
});
