import { describe, it, expect } from "vitest";
import { formatTurnContext, type TurnContext } from "../types.js";

describe("formatTurnContext", () => {
  const baseContext: TurnContext = {
    turn: 1,
    model: "gpt-4",
    strategy: "cost-first",
    toolCalls: [],
    turnCost: 0.005,
    budgetRemaining: 0.995,
    budgetPercent: 5,
    filesRead: [],
    filesWritten: [],
    sessionMinutes: 0,
    unhealthyTools: [],
    buildStatus: "unknown",
    buildWarning: "",
    costPerHour: 0,
  };

  it("formats basic context with minimal fields", () => {
    const result = formatTurnContext(baseContext);
    expect(result).toContain("Turn 1");
    expect(result).toContain("gpt-4");
    expect(result).toContain("tools: none");
    expect(result).toContain("$0.005");
    expect(result).toContain("budget 5%");
  });

  it("includes tool calls in output", () => {
    const ctx: TurnContext = {
      ...baseContext,
      toolCalls: [
        { name: "file_read", ok: true },
        { name: "shell", ok: false },
      ],
    };
    const result = formatTurnContext(ctx);
    expect(result).toContain("tools: file_read shell✗");
  });

  it("formats file operations with arrows", () => {
    const ctx: TurnContext = {
      ...baseContext,
      filesRead: ["/path/to/file1.ts"],
      filesWritten: ["/path/to/file2.ts"],
    };
    const result = formatTurnContext(ctx);
    expect(result).toContain("files: file1.ts↓ file2.ts↑");
  });

  it("limits file list to 6 entries", () => {
    const ctx: TurnContext = {
      ...baseContext,
      filesRead: ["/a/1.ts", "/b/2.ts", "/c/3.ts", "/d/4.ts"],
      filesWritten: ["/e/5.ts", "/f/6.ts", "/g/7.ts"],
    };
    const result = formatTurnContext(ctx);
    // Extract the files section between "files: " and the next " |" or "]"
    const fileMatch = result.match(/files: ([^\]|]+)/);
    expect(fileMatch).toBeTruthy();
    const fileCount = fileMatch![1].trim().split(" ").length;
    expect(fileCount).toBe(6);
  });

  it("includes unhealthy tools when present", () => {
    const ctx: TurnContext = {
      ...baseContext,
      unhealthyTools: [
        { name: "shell", error: "timeout" },
        { name: "fetch", error: "network" },
      ],
    };
    const result = formatTurnContext(ctx);
    expect(result).toContain("unhealthy: shell,fetch");
  });

  it("includes build status when not unknown", () => {
    const ctx: TurnContext = {
      ...baseContext,
      buildStatus: "failing",
    };
    const result = formatTurnContext(ctx);
    expect(result).toContain("build: failing");
  });

  it("omits build status when unknown", () => {
    const result = formatTurnContext(baseContext);
    expect(result).not.toContain("build:");
  });

  it("includes cost per hour when positive", () => {
    const ctx: TurnContext = {
      ...baseContext,
      costPerHour: 12.5,
    };
    const result = formatTurnContext(ctx);
    expect(result).toContain("$12.50/hr");
  });

  it("omits cost per hour when zero", () => {
    const result = formatTurnContext(baseContext);
    expect(result).not.toContain("/hr");
  });

  it("appends build warning on new line when present", () => {
    const ctx: TurnContext = {
      ...baseContext,
      buildWarning: "Type error in utils.ts",
    };
    const result = formatTurnContext(ctx);
    expect(result).toContain("\nType error in utils.ts");
  });

  it("includes session minutes in output", () => {
    const ctx: TurnContext = {
      ...baseContext,
      sessionMinutes: 42,
    };
    const result = formatTurnContext(ctx);
    expect(result).toContain("42min");
  });
});
