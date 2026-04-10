import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AgentConnector,
  createAgentConnector,
} from "../../../connectors/agent/index.js";
import { AgentClient } from "../../../connectors/agent/client.js";

// Mock the global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("AgentConnector", () => {
  const config = {
    id: "test-agent",
    baseUrl: "https://api.test.com",
    apiKeyName: "TEST_API_KEY",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.TEST_API_KEY = "test-key-123";
  });

  it("should initialize with correct capabilities", () => {
    const connector = createAgentConnector(config);
    expect(connector.name).toBe("agent");
    expect(connector.displayName).toBe("BrainstormAgent");
    expect(connector.capabilities).toContain("endpoint-management");
  });

  it("should perform a health check", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ok" }),
    });

    const connector = new AgentConnector(config);
    const health = await connector.healthCheck();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.test.com/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key-123",
        }),
      }),
    );
    expect(health.ok).toBe(true);
  });

  it("should provide tools and execute one", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [{ id: "agent-123", status: "online" }] }),
    });

    const connector = createAgentConnector(config);
    const tools = connector.getTools();

    expect(tools.length).toBeGreaterThan(0);

    const listTool = tools.find((t) => t.name === "agent_list");
    expect(listTool).toBeDefined();

    if (listTool) {
      const result = await listTool.execute({ status: "online" }, {} as any);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.test.com/api/v1/edge/agents?status=online",
        expect.any(Object),
      );
      expect(result).toEqual({
        agents: [{ id: "agent-123", status: "online" }],
      });
    }
  });

  it("should generate a prompt", () => {
    const connector = createAgentConnector(config);
    const prompt = connector.getPrompt();
    expect(prompt).toContain("Edge Agent Intelligence");
  });
});
