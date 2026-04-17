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

    it("rejects quantified-group ReDoS patterns like (a+)+ and (.*|x)*", async () => {
      // Both of these catastrophic-backtrack shapes bypassed the original
      // "two adjacent quantifiers" heuristic because a `)` sits between
      // the inner and outer quantifier.
      for (const matcher of ["(a+)+", "(.*|x)*", "(.+)+", "(a|b+)*"]) {
        manager.register({
          event: "PreToolUse",
          type: "command",
          command: "echo bad",
          matcher,
        });
      }
      // None of these compiled, so nothing fires regardless of the input.
      const results = await manager.fire("PreToolUse", {
        toolName: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      expect(results).toHaveLength(0);
    });

    it("still accepts safe regex matchers", async () => {
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "echo ok",
        matcher: "^shell|^bash$",
      });
      const results = await manager.fire("PreToolUse", {
        toolName: "shell",
      });
      expect(results).toHaveLength(1);
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

    it("blocking PreToolUse failure short-circuits subsequent hooks", async () => {
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "false",
        blocking: true,
      });
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "echo should-not-run",
      });
      const results = await manager.fire("PreToolUse", {
        toolName: "shell",
      });
      // The blocking failure should break the loop — second hook never runs
      expect(results).toHaveLength(1);
      expect(results[0].blocked).toBe(true);
    });
  });

  describe("variable expansion", () => {
    it("expands $FILE and $TOOL in command with shell-escaped values", async () => {
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "echo tool=$TOOL file=$FILE",
      });
      const results = await manager.fire("PreToolUse", {
        toolName: "shell",
        filePath: "/tmp/safe.txt",
      });
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].output).toBe("tool=shell file=/tmp/safe.txt");
    });

    it("shell-escapes $FILE to prevent command injection", async () => {
      // A malicious file path attempting to inject a second command.
      // If escaping works, the whole string becomes a literal argument to echo
      // and no injected command runs.
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "echo $FILE",
      });
      const results = await manager.fire("PreToolUse", {
        toolName: "shell",
        filePath: "foo'; echo pwned; echo '",
      });
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      // The literal should be echoed verbatim; "pwned" must NOT appear on its own line
      expect(results[0].output).toContain("foo");
      expect(results[0].output).toContain("pwned");
      // Critical: the output must be a single echoed line containing the
      // full literal payload — not two separate echo invocations.
      const lines = (results[0].output ?? "").split("\n");
      expect(lines).toHaveLength(1);
    });
  });

  describe("permission decisions", () => {
    it("parses PERMISSION:deny from stdout and sets blocked=true on PreToolUse", async () => {
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "echo PERMISSION:deny",
      });
      manager.register({
        event: "PreToolUse",
        type: "command",
        command: "echo should-not-run",
      });
      const results = await manager.fire("PreToolUse", { toolName: "shell" });
      // Short-circuit: only the first hook runs
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].permissionDecision).toBe("deny");
      expect(results[0].blocked).toBe(true);
      expect(manager.isBlocked(results)).toBe(true);
    });

    it("getPermissionDecision prioritizes deny > ask > allow", () => {
      const results = [
        {
          hookId: "a",
          event: "PreToolUse" as const,
          success: true,
          durationMs: 0,
          permissionDecision: "allow" as const,
        },
        {
          hookId: "b",
          event: "PreToolUse" as const,
          success: true,
          durationMs: 0,
          permissionDecision: "ask" as const,
        },
        {
          hookId: "c",
          event: "PreToolUse" as const,
          success: true,
          durationMs: 0,
          permissionDecision: "deny" as const,
        },
      ];
      expect(manager.getPermissionDecision(results)).toBe("deny");

      // ask beats allow
      expect(manager.getPermissionDecision(results.slice(0, 2))).toBe("ask");

      // allow alone
      expect(manager.getPermissionDecision([results[0]])).toBe("allow");

      // no decisions -> undefined
      expect(
        manager.getPermissionDecision([
          {
            hookId: "x",
            event: "Stop",
            success: true,
            durationMs: 0,
          },
        ]),
      ).toBeUndefined();
    });
  });

  describe("subagent matcher", () => {
    it("matches against subagentType (not toolName) for SubagentStart events", async () => {
      manager.register({
        event: "SubagentStart",
        type: "command",
        command: "echo matched",
        matcher: "^explore$",
      });

      const matched = await manager.fire("SubagentStart", {
        subagentType: "explore",
      });
      expect(matched).toHaveLength(1);
      expect(matched[0].success).toBe(true);

      const unmatched = await manager.fire("SubagentStart", {
        subagentType: "plan",
      });
      expect(unmatched).toHaveLength(0);
    });
  });

  describe("prompt hook type", () => {
    it("returns a failed result without executing anything", async () => {
      manager.register({
        event: "SessionStart",
        type: "prompt",
        command: "Summarize the session.",
      });
      const results = await manager.fire("SessionStart");
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toMatch(/not yet implemented/i);
    });
  });
});
