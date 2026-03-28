/**
 * ToolCallDisplay component tests — running/completed tool visualization.
 */

import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import {
  ToolCallDisplay,
  ToolCallList,
  type ToolCallState,
} from "../../components/ToolCallDisplay.js";
import { plain, containsText, hasColor } from "../helpers/ansi.js";

function makeTool(overrides?: Partial<ToolCallState>): ToolCallState {
  return {
    id: "tool-1",
    toolName: "file_read",
    args: { file_path: "/src/index.ts" },
    status: "done",
    startTime: Date.now() - 1000,
    duration: 500,
    ok: true,
    ...overrides,
  };
}

describe("ToolCallDisplay", () => {
  it("shows tool name", () => {
    const { lastFrame } = render(<ToolCallDisplay tool={makeTool()} />);
    expect(containsText(lastFrame(), "file_read")).toBe(true);
  });

  it("shows ✓ for successful completion", () => {
    const { lastFrame } = render(
      <ToolCallDisplay tool={makeTool({ status: "done", ok: true })} />,
    );
    expect(lastFrame()).toContain("✓");
    expect(hasColor(lastFrame(), "✓", "green")).toBe(true);
  });

  it("shows ✗ for failed completion", () => {
    const { lastFrame } = render(
      <ToolCallDisplay tool={makeTool({ status: "error", ok: false })} />,
    );
    expect(lastFrame()).toContain("✗");
    expect(hasColor(lastFrame(), "✗", "red")).toBe(true);
  });

  it("shows spinner for running tools", () => {
    const { lastFrame } = render(
      <ToolCallDisplay tool={makeTool({ status: "running" })} />,
    );
    // Running tools show the tool name in yellow
    expect(hasColor(lastFrame(), "file_read", "yellow")).toBe(true);
  });

  it("shows duration for completed tools", () => {
    const { lastFrame } = render(
      <ToolCallDisplay tool={makeTool({ duration: 1500 })} />,
    );
    expect(containsText(lastFrame(), "1.5s")).toBe(true);
  });

  it("shows duration in ms for fast tools", () => {
    const { lastFrame } = render(
      <ToolCallDisplay tool={makeTool({ duration: 42 })} />,
    );
    expect(containsText(lastFrame(), "42ms")).toBe(true);
  });

  // ── Arg summaries ──────────────────────────────────────────────────

  it("summarizes file_read path", () => {
    const { lastFrame } = render(
      <ToolCallDisplay
        tool={makeTool({
          toolName: "file_read",
          args: { file_path: "/Users/j/Projects/brainstorm/src/index.ts" },
        })}
      />,
    );
    expect(containsText(lastFrame(), "src/index.ts")).toBe(true);
  });

  it("summarizes shell command", () => {
    const { lastFrame } = render(
      <ToolCallDisplay
        tool={makeTool({
          toolName: "shell",
          args: { command: "npm run build" },
        })}
      />,
    );
    expect(containsText(lastFrame(), "npm run build")).toBe(true);
  });

  it("summarizes grep pattern", () => {
    const { lastFrame } = render(
      <ToolCallDisplay
        tool={makeTool({
          toolName: "grep",
          args: { pattern: "TODO", path: "src/" },
        })}
      />,
    );
    expect(containsText(lastFrame(), "/TODO/")).toBe(true);
  });

  it("summarizes subagent type and task", () => {
    const { lastFrame } = render(
      <ToolCallDisplay
        tool={makeTool({
          toolName: "subagent",
          args: { type: "explore", task: "Find auth middleware" },
        })}
      />,
    );
    expect(containsText(lastFrame(), "[explore]")).toBe(true);
    expect(containsText(lastFrame(), "Find auth middleware")).toBe(true);
  });
});

describe("ToolCallList", () => {
  it("returns null for empty list", () => {
    const { lastFrame } = render(<ToolCallList tools={[]} />);
    expect(lastFrame()).toBe("");
  });

  it("shows all tools when few", () => {
    const tools = [
      makeTool({ id: "1", toolName: "file_read" }),
      makeTool({ id: "2", toolName: "shell" }),
    ];
    const { lastFrame } = render(<ToolCallList tools={tools} />);
    expect(containsText(lastFrame(), "file_read")).toBe(true);
    expect(containsText(lastFrame(), "shell")).toBe(true);
  });

  it("shows hidden count for many completed tools", () => {
    const tools = Array.from({ length: 5 }, (_, i) =>
      makeTool({ id: String(i), toolName: `tool_${i}` }),
    );
    const { lastFrame } = render(<ToolCallList tools={tools} />);
    expect(containsText(lastFrame(), "3 earlier tool calls")).toBe(true);
  });

  it("always shows running tools", () => {
    const tools = [
      makeTool({ id: "1", toolName: "done1" }),
      makeTool({ id: "2", toolName: "done2" }),
      makeTool({ id: "3", toolName: "done3" }),
      makeTool({
        id: "4",
        toolName: "running1",
        status: "running",
      }),
    ];
    const { lastFrame } = render(<ToolCallList tools={tools} />);
    expect(containsText(lastFrame(), "running1")).toBe(true);
  });
});
