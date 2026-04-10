import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  EmailConnector,
  createEmailConnector,
} from "../../../connectors/email/index.js";
import { EmailClient } from "../../../connectors/email/client.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("EmailConnector", () => {
  const config = {
    id: "test-email",
    baseUrl: "https://api.email.test.com",
    apiKeyName: "TEST_EMAIL_KEY",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.TEST_EMAIL_KEY = "email-key-456";
    // Ensure _GM_EMAIL_KEY doesn't interfere
    delete process.env._GM_EMAIL_KEY;
  });

  it("should initialize with correct capabilities", () => {
    const connector = createEmailConnector(config);
    expect(connector.name).toBe("email");
    expect(connector.displayName).toBe("BrainstormEmailSecurity");
    expect(connector.capabilities).toContain("email-security");
    expect(connector.capabilities).toContain("trust-graph");
  });

  it("should perform a health check", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ok" }),
    });

    const connector = new EmailConnector(config);
    const health = await connector.healthCheck();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.email.test.com/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer email-key-456",
        }),
      }),
    );
    expect(health.ok).toBe(true);
  });

  it("should provide tools and execute one", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: "msg-123", subject: "Test" }] }),
    });

    const connector = createEmailConnector(config);
    const tools = connector.getTools();

    expect(tools.length).toBeGreaterThan(0);

    const listTool = tools.find((t) => t.name === "email_list_messages");
    expect(listTool).toBeDefined();

    if (listTool) {
      const result = await listTool.execute(
        { recipient: "test@example.com" },
        {} as any,
      );
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.email.test.com/api/v1/email-security/messages?recipient=test%40example.com",
        expect.any(Object),
      );
      expect(result).toEqual({
        messages: [{ id: "msg-123", subject: "Test" }],
      });
    }
  });

  it("should use _GM_EMAIL_KEY over configured key if available", async () => {
    process.env._GM_EMAIL_KEY = "global-email-key";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ok" }),
    });

    const connector = new EmailConnector(config);
    await connector.healthCheck();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.email.test.com/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer global-email-key",
        }),
      }),
    );
  });
});
