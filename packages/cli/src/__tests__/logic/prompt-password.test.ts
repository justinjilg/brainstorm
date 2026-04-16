import { describe, it, expect, afterEach } from "vitest";
import { promptPassword } from "../../util/prompt-password.js";

describe("promptPassword", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns the env-var value without prompting when the env var is set", async () => {
    process.env.BRAINSTORM_VAULT_PASSWORD = "env-bypass-password";
    const result = await promptPassword("ignored prompt");
    expect(result).toBe("env-bypass-password");
  });

  it("accepts a custom env var name so different callers can bypass independently", async () => {
    process.env.GITHUB_TOKEN = "gh_ghghghghghgh";
    const result = await promptPassword("PAT:", "GITHUB_TOKEN");
    expect(result).toBe("gh_ghghghghghgh");
  });

  it("does not read any env var when envVar is null", async () => {
    // If promptPassword tried to read an env var, it wouldn't block — but the
    // test would fail below when stdin isn't a TTY. What we assert here is
    // that explicitly passing null disables the bypass entirely: the call
    // proceeds to the prompt phase and hangs waiting for stdin, which we
    // race against a short timeout.
    process.env.BRAINSTORM_VAULT_PASSWORD = "should-be-ignored";
    const prompted = promptPassword("Pw:", null);
    const raced = await Promise.race([
      prompted.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("timed-out"), 100)),
    ]);
    expect(raced).toBe("timed-out");
    // Nothing to clean up — the promise stays pending but tests exit.
  });
});
