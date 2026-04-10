// @ts-nocheck — autonomously generated, type fixtures simplified
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MCPClientManager, type MCPServerConfig } from "../client.js";

// Mock state for transport testing
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

// Mock @ai-sdk/mcp for HTTP/SSE transports
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

// Mock @ai-sdk/mcp/mcp-stdio for stdio transport
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
  return { tools: new Map<string, any>() } as any;
}

describe("Transport Layer", () => {
  beforeEach(() => {
    mockState.tools = {};
    mockState.lastTransport = null;
    mockState.closeFn = vi.fn();
    mockState.throwOnCreate = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("HTTP Transport", () => {
    it("creates HTTP transport with correct type and URL", async () => {
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "http-server",
        transport: "http",
        url: "https://api.example.com/mcp",
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.type).toBe("http");
      expect(mockState.lastTransport.url).toBe("https://api.example.com/mcp");
    });

    it("includes custom headers in HTTP transport when provided via env", async () => {
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "http-auth-server",
        transport: "http",
        url: "http://localhost:3000/mcp",
        env: { BRAINSTORM_API_KEY: "test-api-key-123" },
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.type).toBe("http");
      expect(mockState.lastTransport.headers).toEqual({
        Authorization: "Bearer test-api-key-123",
      });
    });

    it("omits headers when BRAINSTORM_API_KEY is not set", async () => {
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "http-public-server",
        transport: "http",
        url: "http://localhost:3000/mcp",
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.type).toBe("http");
      expect(mockState.lastTransport.headers).toBeUndefined();
    });
  });

  describe("SSE Transport", () => {
    it("creates SSE transport with correct type and URL", async () => {
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "sse-server",
        transport: "sse",
        url: "https://events.example.com/sse",
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.type).toBe("sse");
      expect(mockState.lastTransport.url).toBe(
        "https://events.example.com/sse",
      );
    });

    it("includes Bearer token in SSE transport headers", async () => {
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "sse-auth-server",
        transport: "sse",
        url: "http://localhost:8080/sse",
        env: { BRAINSTORM_API_KEY: "sse-secret-token" },
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.type).toBe("sse");
      expect(mockState.lastTransport.headers).toEqual({
        Authorization: "Bearer sse-secret-token",
      });
    });

    it("handles SSE transport without authentication", async () => {
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "sse-public-server",
        transport: "sse",
        url: "http://localhost:8080/events",
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.type).toBe("sse");
      expect(mockState.lastTransport.url).toBe("http://localhost:8080/events");
      expect(mockState.lastTransport.headers).toBeUndefined();
    });
  });

  describe("Stdio Transport", () => {
    it("creates stdio transport with command and args", async () => {
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "stdio-server",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.kind).toBe("stdio");
      expect(mockState.lastTransport.opts.command).toBe("npx");
      expect(mockState.lastTransport.opts.args).toEqual([
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/tmp",
      ]);
    });

    it("passes environment variables to stdio transport", async () => {
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "stdio-env-server",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: {
          NODE_ENV: "production",
          API_KEY: "secret123",
          DEBUG: "true",
        },
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.kind).toBe("stdio");
      expect(mockState.lastTransport.opts.env.NODE_ENV).toBe("production");
      expect(mockState.lastTransport.opts.env.API_KEY).toBe("secret123");
      expect(mockState.lastTransport.opts.env.DEBUG).toBe("true");
    });

    it("merges process.env with custom env for stdio transport", async () => {
      const originalEnv = process.env;
      process.env = { ...originalEnv, PATH: "/usr/bin", HOME: "/home/test" };

      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "stdio-merge-env",
        transport: "stdio",
        command: "python",
        args: ["mcp_server.py"],
        env: { CUSTOM_VAR: "custom_value" },
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.kind).toBe("stdio");
      // Should have both process.env and custom env
      expect(mockState.lastTransport.opts.env.PATH).toBe("/usr/bin");
      expect(mockState.lastTransport.opts.env.HOME).toBe("/home/test");
      expect(mockState.lastTransport.opts.env.CUSTOM_VAR).toBe("custom_value");

      process.env = originalEnv;
    });

    it("uses default npx command when command is not specified", async () => {
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "stdio-default-cmd",
        transport: "stdio",
        url: "@modelcontextprotocol/server-sqlite",
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.kind).toBe("stdio");
      expect(mockState.lastTransport.opts.command).toBe("npx");
      expect(mockState.lastTransport.opts.args).toEqual([
        "@modelcontextprotocol/server-sqlite",
      ]);
    });

    it("handles empty args array for stdio transport", async () => {
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "stdio-no-args",
        transport: "stdio",
        command: "my-mcp-server",
        args: [],
      };
      mgr.addServers([config]);
      await mgr.connectAll(makeRegistry());

      expect(mockState.lastTransport.kind).toBe("stdio");
      expect(mockState.lastTransport.opts.command).toBe("my-mcp-server");
      expect(mockState.lastTransport.opts.args).toEqual([]);
    });
  });

  describe("Transport Error Handling", () => {
    it("captures HTTP transport connection errors", async () => {
      mockState.throwOnCreate = new Error("Connection refused");
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "failing-http",
        transport: "http",
        url: "http://localhost:9999",
      };
      mgr.addServers([config]);
      const result = await mgr.connectAll(makeRegistry());

      expect(result.connected).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].name).toBe("failing-http");
      expect(result.errors[0].error).toBe("Connection refused");
    });

    it("captures SSE transport connection errors", async () => {
      mockState.throwOnCreate = new Error("SSE stream closed unexpectedly");
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "failing-sse",
        transport: "sse",
        url: "http://localhost:9998/events",
      };
      mgr.addServers([config]);
      const result = await mgr.connectAll(makeRegistry());

      expect(result.connected).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].name).toBe("failing-sse");
      expect(result.errors[0].error).toBe("SSE stream closed unexpectedly");
    });

    it("captures stdio transport spawn errors", async () => {
      mockState.throwOnCreate = new Error("spawn ENOENT");
      const mgr = new MCPClientManager();
      const config: MCPServerConfig = {
        name: "failing-stdio",
        transport: "stdio",
        command: "nonexistent-command",
        args: ["--flag"],
      };
      mgr.addServers([config]);
      const result = await mgr.connectAll(makeRegistry());

      expect(result.connected).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].name).toBe("failing-stdio");
      expect(result.errors[0].error).toBe("spawn ENOENT");
    });
  });

  describe("Multiple Transports", () => {
    it("handles mixed transport types in single manager", async () => {
      const mgr = new MCPClientManager();

      // First connect HTTP
      mockState.tools = {};
      mgr.addServers([
        { name: "http-srv", transport: "http", url: "http://localhost:3001" },
      ]);
      await mgr.connectAll(makeRegistry());
      expect(mockState.lastTransport.type).toBe("http");

      // Clear and add SSE
      mgr.listConnected().forEach((name: string) => {
        mgr["connections"].delete(name);
      });

      // Reset and add stdio
      mockState.lastTransport = null;
      mgr.addServers([
        {
          name: "stdio-srv",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
        },
      ]);
      await mgr.connectAll(makeRegistry());
      expect(mockState.lastTransport.kind).toBe("stdio");
    });
  });
});
