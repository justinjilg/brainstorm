import { describe, it, expect } from "vitest";
import {
  getToolsForTier,
  getTierForComplexity,
  getTierForTool,
  escalateTier,
  isToolInTier,
} from "../progressive";

describe("Progressive Tool Loading", () => {
  it("returns minimal tools for trivial/simple tasks", () => {
    expect(getTierForComplexity("trivial")).toBe("minimal");
    expect(getTierForComplexity("simple")).toBe("minimal");
    const tools = getToolsForTier("minimal");
    expect(tools).toContain("file_read");
    expect(tools).toContain("shell");
    expect(tools).not.toContain("git_commit");
  });

  it("returns full tools for complex/expert tasks", () => {
    expect(getTierForComplexity("complex")).toBe("full");
    expect(getTierForComplexity("expert")).toBe("full");
    const tools = getToolsForTier("full");
    expect(tools).toContain("br_status");
    expect(tools).toContain("file_read");
  });

  it("includes dynamic tools in all tiers when allRegisteredTools provided", () => {
    const allTools = [
      "file_read",
      "shell",
      "glob",
      "file_write",
      "file_edit",
      "msp_list_devices",
      "msp_device_status",
      "gm_changeset_list",
    ];

    const minimal = getToolsForTier("minimal", allTools);
    // Should include the 5 minimal tools PLUS the 3 dynamic tools
    expect(minimal).toContain("file_read");
    expect(minimal).toContain("msp_list_devices");
    expect(minimal).toContain("msp_device_status");
    expect(minimal).toContain("gm_changeset_list");
  });

  it("does not duplicate built-in tools when passed as allRegisteredTools", () => {
    const allTools = ["file_read", "shell", "glob", "file_write", "file_edit"];
    const minimal = getToolsForTier("minimal", allTools);
    // Should be exactly the minimal set, no duplicates
    const uniqueTools = [...new Set(minimal)];
    expect(minimal.length).toBe(uniqueTools.length);
  });

  it("escalates tiers correctly", () => {
    expect(escalateTier("minimal")).toBe("standard");
    expect(escalateTier("standard")).toBe("full");
    expect(escalateTier("full")).toBeNull();
  });

  it("finds correct tier for known tools", () => {
    expect(getTierForTool("file_read")).toBe("minimal");
    expect(getTierForTool("git_commit")).toBe("standard");
    expect(getTierForTool("br_status")).toBe("full");
    expect(getTierForTool("msp_list_devices")).toBeNull(); // dynamic
  });

  it("checks tool membership correctly", () => {
    expect(isToolInTier("file_read", "minimal")).toBe(true);
    expect(isToolInTier("git_commit", "minimal")).toBe(false);
    expect(isToolInTier("git_commit", "standard")).toBe(true);
  });
});
