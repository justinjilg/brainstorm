import { describe, it, expect } from "vitest";
import { runProbe } from "../runner.js";
import type { Probe } from "../types.js";

const baseProbe: Probe = {
  id: "test-traversal",
  capability: "code-correctness",
  input: "ignored",
  // Signal: force the runner to the sandbox-setup branch before any agent
  // work happens — the path assertion is the first thing to run.
  workspace: "sandbox",
  // Intentionally empty expectations so scorer doesn't matter for this test.
  expectations: {} as any,
};

describe("runProbe — probe.setup.files path validation", () => {
  it("surfaces an error when setup path tries to escape the sandbox", async () => {
    const malicious: Probe = {
      ...baseProbe,
      setup: {
        files: {
          "../../../evil.txt": "pwned",
        },
      },
    };

    const result = await runProbe(malicious);
    expect(result.error).toMatch(/escapes sandbox/i);
  });

  // path.join() neutralizes absolute-path second args (treats them as relative
  // to the first arg), so "/tmp/x" in setup.files lands under sandboxDir
  // safely and doesn't need a separate guard.
});
