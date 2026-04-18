import { describe, it, expect } from "vitest";
import { runProbe } from "../runner.js";
import type { Probe } from "../types.js";

const baseProbe: Probe = {
  id: "test-traversal",
  capability: "code-correctness",
  // Field was renamed from `input` to `prompt` during a refactor; this
  // test file was missed. Keep the body minimal — the runner never
  // reaches the LLM in the cases below because the sandbox path check
  // fires first.
  prompt: "ignored",
  workspace: "sandbox",
  // Empty verification block — the sandbox path check in the runner
  // fires before any scoring happens, so verify content doesn't
  // matter for these cases. Name was `expectations` in an earlier
  // Probe shape; now `verify`.
  verify: {},
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
