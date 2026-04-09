import { describe, it, expect, beforeEach } from "vitest";
import { HookManager } from "../manager.js";
import type { HookDefinition } from "../types.js";

describe("HookManager", () => {
  let manager: HookManager;

  beforeEach(() => {
    manager = new HookManager();
  });

  describe("register/remove", () => {
    it("registers a hook and returns an ID", () => {
      const id = manager.register({
        event: "SessionStart",
        type: "command",
        command: "echo hello",
      });
      expect(id).toMatch(/^hook-\d+$/);
      expect(manager.list()).toHaveLength(1);
    });

    it("registers multiple hooks", () => {
      manager.register({
        event: "SessionStart",
        type: "command",
        command: "echo 1",
      });
      manager.register({
        event: "Stop",
        type: "command",
        command: "echo 2",
      });
      expect(manager.list()).toHaveLength(2);
    });

    it("removes a hook by ID", () => {
      const id = manager.register({
        event: "SessionStart",
        type: "command",
        command: "echo hello",
      });
      expect(manager.remove(id)).toBe(true);
      expect(manager.list()).toHaveLength(0);
    });

    it("returns false for unknown hook ID", () => {
      expect(manager.remove("hook-999")).toBe(false);
    });

    it("registerAll adds multiple hooks at once", () => {
      const hooks: HookDefinition[] = [
        { event: "SessionStart", type: "command", command: "echo 1" },
        { event: "Stop", type: "command", command: "echo 2" },
        { event: "PreCompact", type: "command", command: "echo 3" },
      ];
      manager.registerAll(hooks);
      expect(manager.list()).toHaveLength(3);
    });
  });

  describe("fire", () => {
    it("fires hooks matching an event", async () => {
      manager.register({
        event: "SessionStart",
        type: "command",
        command: "echo fired",
      });
      const results = await manager.fire("SessionStart");
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].output?.trim()).toBe("fired");
    });

    it("does not fire hooks for non-matching events", async () => {
      manager.register({
        event: "SessionStart",
        type: "command",
        command: "echo fired",
      });
      const results = await manager.fire("Stop");
      expect(results).toHaveLength(0);
    });

    it("fires multiple hooks for same event", async () => {
      manager.register({
        event: "SessionStart",
        type: "command",
        command: "echo first",
      });
      manager.register({
        event: "SessionStart",
        type: "command",
        command: "echo second",
      });
      const results = await manager.fire("SessionStart");
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it("captures failed command output", async () => {
      manager.register({
        event: "SessionStart",
        type: "command",
        command: "false", // exits with code 1
      });
      const results = await manager.fire("SessionStart");
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
    });

    it("records duration", async () => {
      manager.register({
        event: "SessionStart",
        type: "command",
        command: "echo fast",
      });
      const results = await manager.fire("SessionStart");
      expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(results[0].durationMs).toBeLessThan(5000);
    });
  });

  describe("matcher", () => {
    it("fires only when matcher matches tool name", async () => {
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "echo matched",
        matcher: "^file_write$",
      });
      const matchResults = await manager.fire("PreToolUse", {
        toolName: "file_write",
      });
      expect(matchResults).toHaveLength(1);

      const noMatchResults = await manager.fire("PreToolUse", {
        toolName: "shell",
      });
      expect(noMatchResults).toHaveLength(0);
    });

    it("rejects ReDoS patterns with literal nested quantifiers", async () => {
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "echo bad",
        matcher: "a{1}{2}", // literal nested quantifiers — rejected
      });
      // Should not match (regex rejected by ReDoS heuristic)
      const results = await manager.fire("PreToolUse", {
        toolName: "a",
      });
      expect(results).toHaveLength(0);
    });
  });

  describe("blocking hooks", () => {
    it("blocking PreToolUse failure sets blocked=true", async () => {
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "false", // exits with code 1
        blocking: true,
      });
      const results = await manager.fire("PreToolUse", {
        toolName: "shell",
      });
      expect(results).toHaveLength(1);
      expect(results[0].blocked).toBe(true);
    });

    it("non-blocking hook failure does not set blocked", async () => {
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "false",
        blocking: false,
      });
      const results = await manager.fire("PreToolUse", {
        toolName: "shell",
      });
      expect(results).toHaveLength(1);
      expect(results[0].blocked).toBeFalsy();
    });
  });
});
