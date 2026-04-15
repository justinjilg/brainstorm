import { afterEach, describe, expect, it, vi } from "vitest";

// Vault operations use Argon2id which is intentionally slow (~2s per call).
vi.setConfig({ testTimeout: 15_000 });
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrainstormVault } from "../vault.js";

const testPassword = "vault-test-password";

function createVault(autoLockMinutes = 30) {
  const tempDir = mkdtempSync(join(tmpdir(), "brainstorm-vault-"));
  const vaultPath = join(tempDir, "vault.json");
  const vault = new BrainstormVault(vaultPath, autoLockMinutes);

  return { vault, vaultPath };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BrainstormVault state management", () => {
  it("creates an empty vault, locks it, and unlocks it with the password", async () => {
    const { vault } = createVault();

    await vault.init(testPassword);

    expect(vault.exists()).toBe(true);
    expect(vault.isOpen()).toBe(true);
    expect(vault.getInfo().keyCount).toBe(0);

    vault.lock();

    expect(vault.isOpen()).toBe(false);
    expect(vault.isLocked()).toBe(true);
    expect(vault.get("missing")).toBeNull();

    vault.open(testPassword);

    expect(vault.isOpen()).toBe(true);
    expect(vault.isLocked()).toBe(false);
    expect(vault.getInfo().keyCount).toBe(0);
  });

  it("saves and retrieves a key across lock and unlock", async () => {
    const { vault } = createVault();

    await vault.init(testPassword);
    vault.set("OPENAI_API_KEY", "secret-value");

    expect(vault.get("OPENAI_API_KEY")).toBe("secret-value");

    vault.lock();
    vault.open(testPassword);

    expect(vault.get("OPENAI_API_KEY")).toBe("secret-value");
  });

  it("fails to unlock with the wrong password", async () => {
    const { vault } = createVault();

    await vault.init(testPassword);
    vault.lock();

    expect(() => vault.open("wrong-password")).toThrow();
    expect(vault.isOpen()).toBe(false);
    expect(vault.isLocked()).toBe(true);
  });

  it("lists stored keys without exposing values", async () => {
    const { vault } = createVault();

    await vault.init(testPassword);
    vault.set("OPENAI_API_KEY", "secret-1");
    vault.set("ANTHROPIC_API_KEY", "secret-2");

    expect(vault.list().sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]);
    expect(vault.getInfo().keys.sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]);
  });

  it("deletes a key and reports whether it existed", async () => {
    const { vault } = createVault();

    await vault.init(testPassword);
    vault.set("OPENAI_API_KEY", "secret-value");

    expect(vault.delete("OPENAI_API_KEY")).toBe(true);
    expect(vault.get("OPENAI_API_KEY")).toBeNull();
    expect(vault.delete("OPENAI_API_KEY")).toBe(false);
    expect(vault.list()).toEqual([]);
  });

  it("auto-locks after the configured timeout when accessed again", async () => {
    vi.useFakeTimers();
    const { vault } = createVault(0.001);

    await vault.init(testPassword);
    expect(vault.isOpen()).toBe(true);

    vi.advanceTimersByTime(61);

    expect(vault.isOpen()).toBe(false);
    expect(vault.isLocked()).toBe(true);
    expect(vault.get("anything")).toBeNull();

    vault.open(testPassword);
    expect(vault.isOpen()).toBe(true);
  });
});
