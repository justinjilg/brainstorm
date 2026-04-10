import { describe, it, expect } from "vitest";
import {
  filterToolsForSchedule,
  getScheduleToolList,
  validateTaskSafety,
} from "../safety.js";

describe("safety logic", () => {
  describe("filterToolsForSchedule", () => {
    it("should allow safe read-only tools when mutations are disabled", () => {
      const allowed = filterToolsForSchedule(
        ["file_read", "glob", "shell"],
        false,
      );
      expect(allowed).toEqual(["file_read", "glob"]);
    });

    it("should deny user interactive tools even when mutations are allowed", () => {
      const allowed = filterToolsForSchedule(
        ["ask_user", "file_write", "prompt_user"],
        true,
      );
      expect(allowed).toEqual(["file_write"]);
    });

    it("should allow everything except denied tools when mutations are allowed", () => {
      const allowed = filterToolsForSchedule(
        ["file_write", "shell", "git_commit"],
        true,
      );
      expect(allowed).toEqual(["file_write", "shell", "git_commit"]);
    });
  });

  describe("getScheduleToolList", () => {
    it("should return ['*'] if mutations are allowed", () => {
      const tools = getScheduleToolList(true);
      expect(tools).toEqual(["*"]);
    });

    it("should return specific read-only tools if mutations are not allowed", () => {
      const tools = getScheduleToolList(false);
      expect(tools).toContain("file_read");
      expect(tools).not.toContain("file_write");
      expect(tools).not.toContain("*");
    });
  });

  describe("validateTaskSafety", () => {
    it("should return empty array for safe configurations", () => {
      const warnings = validateTaskSafety({
        prompt: "Check system health",
        allowMutations: false,
        budgetLimit: 5,
        maxTurns: 20,
        timeoutMs: 60000,
      });
      expect(warnings).toEqual([]);
    });

    it("should generate warnings for missing budget limits", () => {
      const warnings = validateTaskSafety({
        prompt: "Do a thing",
        allowMutations: false,
        budgetLimit: 0,
        maxTurns: 20,
        timeoutMs: 60000,
      });
      expect(warnings).toContain(
        "No budget limit set. Task could run up unlimited costs.",
      );
    });

    it("should warn if mutations are enabled", () => {
      const warnings = validateTaskSafety({
        prompt: "Do a thing",
        allowMutations: true,
        budgetLimit: 5,
        maxTurns: 20,
        timeoutMs: 60000,
      });
      expect(warnings).toContain(
        "Mutations enabled. Task can write files, run shell commands, and make git commits.",
      );
    });

    it("should detect dangerous patterns in prompts when mutations are enabled", () => {
      const warnings = validateTaskSafety({
        prompt: "Run rm -rf /",
        allowMutations: true,
        budgetLimit: 5,
        maxTurns: 20,
        timeoutMs: 60000,
      });
      expect(
        warnings.some((w) =>
          w.includes("potentially dangerous pattern: rm\\s+-rf"),
        ),
      ).toBe(true);
    });

    it("should warn on high limits", () => {
      const warnings = validateTaskSafety({
        prompt: "Analyze",
        allowMutations: false,
        budgetLimit: 20, // > 10
        maxTurns: 100, // > 50
        timeoutMs: 2000000, // > 1800000
      });
      expect(warnings.some((w) => w.includes("High budget limit"))).toBe(true);
      expect(warnings.some((w) => w.includes("High turn limit"))).toBe(true);
      expect(warnings.some((w) => w.includes("Long timeout"))).toBe(true);
    });
  });
});
