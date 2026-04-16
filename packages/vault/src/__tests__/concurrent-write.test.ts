import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import { mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { BrainstormVault } from "../vault.js";

const password = "vault-concurrent-pw";

function freshVault() {
  const dir = mkdtempSync(join(tmpdir(), "brainstorm-vault-cc-"));
  const vaultPath = join(dir, "vault.json");
  return { vault: new BrainstormVault(vaultPath, 30), vaultPath };
}

describe("vault atomic writes", () => {
  it("leaves no .tmp files behind after a burst of set() calls", async () => {
    const { vault, vaultPath } = freshVault();
    await vault.init(password);

    for (let i = 0; i < 5; i++) {
      vault.set(`KEY_${i}`, `value-${i}`);
    }

    const dir = dirname(vaultPath);
    const lingering = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(lingering).toEqual([]);

    expect(vault.get("KEY_0")).toBe("value-0");
    expect(vault.get("KEY_4")).toBe("value-4");
  });

  it("is not blocked by a stale tempfile left over from a crashed writer", async () => {
    const { vault, vaultPath } = freshVault();
    await vault.init(password);

    // Simulate a prior crashed writer that left the old shared .tmp path.
    // The pre-fix code would have reused this path and truncated it; the
    // fix uses pid+uuid suffixed temps, so this stale file is untouched.
    const stale = vaultPath + ".tmp";
    writeFileSync(stale, "stale contents from crashed writer");

    vault.set("FRESH", "after-crash");

    // New set() succeeded...
    expect(vault.get("FRESH")).toBe("after-crash");
    // ...and didn't clobber the stale legacy tempfile.
    expect(existsSync(stale)).toBe(true);
  });

  it("reopens cleanly after many writes (no partial/torn state)", async () => {
    const { vault, vaultPath } = freshVault();
    await vault.init(password);

    for (let i = 0; i < 20; i++) {
      vault.set(`K${i}`, `v${i}`);
    }
    vault.lock();

    const reopened = new BrainstormVault(vaultPath, 30);
    reopened.open(password);
    for (let i = 0; i < 20; i++) {
      expect(reopened.get(`K${i}`)).toBe(`v${i}`);
    }
  });
});
