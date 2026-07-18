import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Probe } from "../types.js";

// Capture the options runProbe passes into the agent loop so we can assert
// on tool scoping without touching a real model, db, or provider.
const loopOptions: any[] = [];

vi.mock("@brainst0rm/core", () => ({
  // eslint-disable-next-line require-yield
  runAgentLoop: vi.fn(async function* (_history: any, options: any) {
    loopOptions.push(options);
    yield { type: "done", totalCost: 0 };
  }),
  buildSystemPrompt: () => ({ prompt: "system" }),
  SessionManager: class {
    start() {
      return { id: "session-1" };
    }
    addUserMessage() {}
    getHistory() {
      return [];
    }
  },
}));
vi.mock("@brainst0rm/config", () => ({ loadConfig: () => ({ budget: {} }) }));
vi.mock("@brainst0rm/db", () => ({ getDb: () => ({}) }));
vi.mock("@brainst0rm/providers", () => ({
  createProviderRegistry: async () => ({}),
}));
vi.mock("@brainst0rm/router", () => ({
  BrainstormRouter: class {},
  CostTracker: class {
    getSessionCost() {
      return 0;
    }
  },
}));

import { runProbe } from "../runner.js";

const probe = (overrides: Partial<Probe>): Probe =>
  ({
    id: "scope-test",
    capability: "tool-selection",
    prompt: "ignored",
    verify: {},
    ...overrides,
  }) as Probe;

describe("runProbe — tool scoping by workspace", () => {
  beforeEach(() => {
    loopOptions.length = 0;
  });

  it("restricts project-workspace probes to read-only tools", async () => {
    const result = await runProbe(probe({ capability: "tool-selection" }));

    expect(result.error).toBeUndefined();
    expect(loopOptions).toHaveLength(1);
    expect(loopOptions[0].roleToolFilter).toEqual({
      allowedTools: ["file_read", "list_dir", "glob", "grep"],
    });
  });

  it("leaves sandboxed code-correctness probes unrestricted", async () => {
    const result = await runProbe(
      probe({ id: "scope-sandbox", capability: "code-correctness" }),
    );

    expect(result.error).toBeUndefined();
    expect(loopOptions).toHaveLength(1);
    expect(loopOptions[0].roleToolFilter).toBeUndefined();
  });

  it("respects an explicit workspace: sandbox override", async () => {
    const result = await runProbe(
      probe({
        id: "scope-explicit",
        capability: "multi-step",
        workspace: "sandbox",
      }),
    );

    expect(result.error).toBeUndefined();
    expect(loopOptions[0].roleToolFilter).toBeUndefined();
  });
});
