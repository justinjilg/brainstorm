import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process BEFORE importing the module under test
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";

// We need to re-import the module fresh for each test to clear the internal cache.
// We'll dynamically import it in beforeEach.
describe("1Password CLI backend", () => {
  let opModule: typeof import("../backends/op-cli.js");
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetAllMocks();
    // Clear module cache and re-import to reset the internal opAvailableCache
    vi.resetModules();

    // Reset environment
    process.env = { ...originalEnv };
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    delete process.env.BRAINSTORM_OP_VAULT;

    // Re-import the module to get fresh state
    opModule = await import("../backends/op-cli.js");
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("isOpAvailable", () => {
    it("returns false when OP_SERVICE_ACCOUNT_TOKEN is not set", async () => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = "";
      const result = opModule.isOpAvailable();
      expect(result).toBe(false);
    });

    it("returns false when op CLI is not installed", async () => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = "test-token";
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("Command not found");
      });

      const result = opModule.isOpAvailable();
      expect(result).toBe(false);
      expect(execFileSync).toHaveBeenCalledWith("op", ["--version"], {
        timeout: 3000,
        stdio: "pipe",
      });
    });

    it("returns true when op CLI is available and token is set", async () => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = "test-token";
      vi.mocked(execFileSync).mockReturnValue(Buffer.from("2.18.0"));

      const result = opModule.isOpAvailable();
      expect(result).toBe(true);
    });

    it("caches availability result for subsequent calls", async () => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = "test-token";
      vi.mocked(execFileSync).mockReturnValue(Buffer.from("2.18.0"));

      // First call
      opModule.isOpAvailable();
      // Second call should use cached value
      opModule.isOpAvailable();
      opModule.isOpAvailable();

      expect(execFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("opRead", () => {
    beforeEach(async () => {
      // Setup successful availability check
      process.env.OP_SERVICE_ACCOUNT_TOKEN = "test-token";
      vi.mocked(execFileSync).mockReturnValue(Buffer.from("2.18.0"));
    });

    it("returns null when op is not available", async () => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = "";
      const result = opModule.opRead("API_KEY");
      expect(result).toBeNull();
    });

    it("reads key from default vault", async () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("2.18.0")) // for isOpAvailable
        .mockReturnValueOnce(Buffer.from("secret-value")); // for opRead

      const result = opModule.opRead("BRAINSTORM_API_KEY");

      expect(result).toBe("secret-value");
      expect(execFileSync).toHaveBeenLastCalledWith(
        "op",
        ["read", "op://Dev Keys/BrainstormRouter API Key/credential"],
        { timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
      );
    });

    it("reads key from custom vault via env var", async () => {
      process.env.BRAINSTORM_OP_VAULT = "Custom Vault";
      vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("2.18.0"))
        .mockReturnValueOnce(Buffer.from("custom-secret"));

      const result = opModule.opRead("BRAINSTORM_API_KEY");

      expect(result).toBe("custom-secret");
      expect(execFileSync).toHaveBeenLastCalledWith(
        "op",
        ["read", "op://Custom Vault/BrainstormRouter API Key/credential"],
        { timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
      );
    });

    it("reads key from explicitly provided vault", async () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("2.18.0"))
        .mockReturnValueOnce(Buffer.from("explicit-secret"));

      const result = opModule.opRead("BRAINSTORM_API_KEY", "Explicit Vault");

      expect(result).toBe("explicit-secret");
      expect(execFileSync).toHaveBeenLastCalledWith(
        "op",
        ["read", "op://Explicit Vault/BrainstormRouter API Key/credential"],
        { timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
      );
    });

    it("maps known environment variable names to 1Password item names", async () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("2.18.0"))
        .mockReturnValueOnce(Buffer.from("anthropic-key"));

      opModule.opRead("ANTHROPIC_API_KEY");

      expect(execFileSync).toHaveBeenLastCalledWith(
        "op",
        ["read", "op://Dev Keys/Anthropic API Key/credential"],
        { timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
      );
    });

    it("uses key name directly for unknown keys", async () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("2.18.0"))
        .mockReturnValueOnce(Buffer.from("unknown-key"));

      opModule.opRead("UNKNOWN_CUSTOM_KEY");

      expect(execFileSync).toHaveBeenLastCalledWith(
        "op",
        ["read", "op://Dev Keys/UNKNOWN_CUSTOM_KEY/credential"],
        { timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
      );
    });

    it("trims whitespace from returned value", async () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("2.18.0"))
        .mockReturnValueOnce(Buffer.from("  secret-with-spaces  \n"));

      const result = opModule.opRead("API_KEY");

      expect(result).toBe("secret-with-spaces");
    });

    it("returns null for empty values", async () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("2.18.0"))
        .mockReturnValueOnce(Buffer.from("   "));

      const result = opModule.opRead("API_KEY");

      expect(result).toBeNull();
    });

    it("returns null when op read fails", async () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("2.18.0"))
        .mockImplementationOnce(() => {
          throw new Error("Item not found");
        });

      const result = opModule.opRead("MISSING_KEY");

      expect(result).toBeNull();
    });

    it("caches successful reads", async () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("2.18.0"))
        .mockReturnValue(Buffer.from("cached-secret"));

      // First read
      opModule.opRead("API_KEY");
      // Second read should use cache
      opModule.opRead("API_KEY");

      // Should only call execFileSync for availability + first read
      expect(execFileSync).toHaveBeenCalledTimes(2);
    });

    it("caches failed reads with shorter TTL", async () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("2.18.0"))
        .mockImplementationOnce(() => {
          throw new Error("Item not found");
        });

      // First read - fails
      opModule.opRead("MISSING_KEY");
      // Second read - should use cached failure
      opModule.opRead("MISSING_KEY");

      // Should only call execFileSync for availability + first read
      expect(execFileSync).toHaveBeenCalledTimes(2);
    });

    it("handles all mapped key types", async () => {
      const testCases = [
        { key: "BRAINSTORM_API_KEY", expectedItem: "BrainstormRouter API Key" },
        { key: "ANTHROPIC_API_KEY", expectedItem: "Anthropic API Key" },
        { key: "OPENAI_API_KEY", expectedItem: "OpenAI API Key" },
        {
          key: "GOOGLE_GENERATIVE_AI_API_KEY",
          expectedItem: "Google AI API Key (server)",
        },
        { key: "DEEPSEEK_API_KEY", expectedItem: "DeepSeek API Key" },
        { key: "MOONSHOT_API_KEY", expectedItem: "Moonshot API Key" },
        {
          key: "BRAINSTORM_ADMIN_KEY",
          expectedItem: "BrainstormRouter Admin Key",
        },
        {
          key: "BRAINSTORM_MSP_API_KEY",
          expectedItem: "BrainstormMSP God Mode Service Key",
        },
      ];

      for (const { key, expectedItem } of testCases) {
        // Re-import to clear the cache for each key test
        vi.resetModules();
        opModule = await import("../backends/op-cli.js");
        process.env.OP_SERVICE_ACCOUNT_TOKEN = "test-token";

        vi.mocked(execFileSync)
          .mockReturnValueOnce(Buffer.from("2.18.0"))
          .mockReturnValueOnce(Buffer.from("secret"));

        opModule.opRead(key);
        expect(execFileSync).toHaveBeenLastCalledWith(
          "op",
          ["read", `op://Dev Keys/${expectedItem}/credential`],
          expect.any(Object),
        );
      }
    });
  });
});
