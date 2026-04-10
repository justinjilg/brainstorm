import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KeyResolver } from "../resolver.js";
import { BrainstormVault } from "../vault.js";

// Mock the backend modules
vi.mock("../backends/op-cli.js", () => ({
  isOpAvailable: vi.fn(),
  opRead: vi.fn(),
}));

vi.mock("../backends/env.js", () => ({
  envRead: vi.fn(),
}));

import * as opCli from "../backends/op-cli.js";
import * as env from "../backends/env.js";

describe("KeyResolver", () => {
  let vault: BrainstormVault;
  const testPassword = "test-vault-password";
  const mockVaultPath = "/tmp/test-vault.json";

  beforeEach(() => {
    vi.resetAllMocks();
    // Create a mock vault - we need to mock the file system operations
    vault = new BrainstormVault(mockVaultPath, 30);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolver chain priority: vault → 1Password → env", () => {
    it("returns value from vault when vault exists and is unlocked", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(true);
      vi.spyOn(vault, "get").mockReturnValue("vault-secret");
      vi.mocked(opCli.isOpAvailable).mockReturnValue(false);

      const resolver = new KeyResolver(vault);
      const result = await resolver.get("API_KEY");

      expect(result).toBe("vault-secret");
      expect(vault.get).toHaveBeenCalledWith("API_KEY");
      expect(opCli.isOpAvailable).not.toHaveBeenCalled();
    });

    it("falls back to 1Password when vault exists but key not found", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(true);
      vi.spyOn(vault, "get").mockReturnValue(null);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(true);
      vi.mocked(opCli.opRead).mockReturnValue("op-secret");

      const resolver = new KeyResolver(vault);
      const result = await resolver.get("API_KEY");

      expect(result).toBe("op-secret");
      expect(vault.get).toHaveBeenCalledWith("API_KEY");
      expect(opCli.opRead).toHaveBeenCalledWith("API_KEY");
    });

    it("falls back to env when vault and 1Password both miss", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(true);
      vi.spyOn(vault, "get").mockReturnValue(null);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(true);
      vi.mocked(opCli.opRead).mockReturnValue(null);
      vi.mocked(env.envRead).mockReturnValue("env-secret");

      const resolver = new KeyResolver(vault);
      const result = await resolver.get("API_KEY");

      expect(result).toBe("env-secret");
      expect(env.envRead).toHaveBeenCalledWith("API_KEY");
    });

    it("returns null when all backends miss", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(true);
      vi.spyOn(vault, "get").mockReturnValue(null);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(true);
      vi.mocked(opCli.opRead).mockReturnValue(null);
      vi.mocked(env.envRead).mockReturnValue(null);

      const resolver = new KeyResolver(vault);
      const result = await resolver.get("API_KEY");

      expect(result).toBeNull();
    });

    it("skips vault and goes directly to 1Password when vault does not exist", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(false);
      const isOpenSpy = vi.spyOn(vault, "isOpen").mockReturnValue(false);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(true);
      vi.mocked(opCli.opRead).mockReturnValue("op-secret");

      const resolver = new KeyResolver(vault);
      const result = await resolver.get("API_KEY");

      expect(result).toBe("op-secret");
      expect(isOpenSpy).not.toHaveBeenCalled();
      expect(opCli.opRead).toHaveBeenCalledWith("API_KEY");
    });

    it("skips 1Password when op CLI is not available", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(true);
      vi.spyOn(vault, "get").mockReturnValue(null);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(false);
      vi.mocked(env.envRead).mockReturnValue("env-secret");

      const resolver = new KeyResolver(vault);
      const result = await resolver.get("API_KEY");

      expect(result).toBe("env-secret");
      expect(opCli.opRead).not.toHaveBeenCalled();
    });
  });

  describe("lazy vault unlock", () => {
    it("prompts for password when vault exists but is locked", async () => {
      // Track if vault is open
      let isOpen = false;

      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockImplementation(() => isOpen);
      vi.spyOn(vault, "get").mockImplementation(() => {
        // Only return value if vault is open
        return isOpen ? "vault-secret" : null;
      });
      const openSpy = vi.spyOn(vault, "open").mockImplementation(() => {
        isOpen = true;
      });

      const mockPrompt = vi.fn().mockResolvedValue(testPassword);
      const resolver = new KeyResolver(vault, mockPrompt);
      const result = await resolver.get("API_KEY");

      expect(mockPrompt).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith(testPassword);
      expect(result).toBe("vault-secret");
    });

    it("falls back to other backends when password prompt fails", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(false);
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      const mockPrompt = vi.fn().mockRejectedValue(new Error("User cancelled"));
      vi.mocked(opCli.isOpAvailable).mockReturnValue(true);
      vi.mocked(opCli.opRead).mockReturnValue("op-secret");

      const resolver = new KeyResolver(vault, mockPrompt);
      const result = await resolver.get("API_KEY");

      expect(result).toBe("op-secret");
      expect(stderrSpy).toHaveBeenCalledWith(
        "[vault] Unlock failed — falling back to 1Password/env for this key only\n",
      );
      stderrSpy.mockRestore();
    });

    it("does not prompt when no password prompt is provided", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(false);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(true);
      vi.mocked(opCli.opRead).mockReturnValue("op-secret");

      const resolver = new KeyResolver(vault); // No prompt provided
      const result = await resolver.get("API_KEY");

      expect(result).toBe("op-secret");
    });
  });

  describe("getRequired", () => {
    it("returns value when found in any backend", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(true);
      vi.spyOn(vault, "get").mockReturnValue("vault-secret");
      vi.mocked(opCli.isOpAvailable).mockReturnValue(false);

      const resolver = new KeyResolver(vault);
      const result = await resolver.getRequired("API_KEY");

      expect(result).toBe("vault-secret");
    });

    it("throws when key not found in any backend", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(true);
      vi.spyOn(vault, "get").mockReturnValue(null);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(true);
      vi.mocked(opCli.opRead).mockReturnValue(null);
      vi.mocked(env.envRead).mockReturnValue(null);

      const resolver = new KeyResolver(vault);
      await expect(resolver.getRequired("MISSING_KEY")).rejects.toThrow(
        'Key "MISSING_KEY" not found in vault, 1Password, environment',
      );
    });

    it("error message excludes vault when vault does not exist", async () => {
      vi.spyOn(vault, "exists").mockReturnValue(false);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(false);
      vi.mocked(env.envRead).mockReturnValue(null);

      const resolver = new KeyResolver(vault);
      await expect(resolver.getRequired("MISSING_KEY")).rejects.toThrow(
        'Key "MISSING_KEY" not found in environment',
      );
    });
  });

  describe("status", () => {
    it("reports vault as not initialized when vault does not exist", () => {
      vi.spyOn(vault, "exists").mockReturnValue(false);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(false);

      const resolver = new KeyResolver(vault);
      const status = resolver.status();

      expect(status.vault).toBe("not initialized");
      expect(status.op).toBe("not available");
      expect(status.env).toBe("always available");
    });

    it("reports vault as locked when vault exists but is not open", () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(false);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(true);

      const resolver = new KeyResolver(vault);
      const status = resolver.status();

      expect(status.vault).toBe("locked");
      expect(status.op).toBe("available");
    });

    it("reports vault as unlocked with key count when open", () => {
      vi.spyOn(vault, "exists").mockReturnValue(true);
      vi.spyOn(vault, "isOpen").mockReturnValue(true);
      vi.spyOn(vault, "list").mockReturnValue(["KEY1", "KEY2", "KEY3"]);
      vi.mocked(opCli.isOpAvailable).mockReturnValue(true);

      const resolver = new KeyResolver(vault);
      const status = resolver.status();

      expect(status.vault).toBe("unlocked (3 keys)");
    });
  });
});
