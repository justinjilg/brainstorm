import { describe, it, expect } from "vitest";
import type { AgentEvent, ToolPermission } from "@brainst0rm/shared";
import { buildAuthorityCheck, BlockedCallCollector } from "../authority.js";
import type { ChannelAuthority } from "../types.js";

describe("buildAuthorityCheck", () => {
  const perms: ToolPermission[] = ["auto", "confirm", "deny"];

  // [authority, permission] -> expected decision
  const table: Array<[ChannelAuthority, ToolPermission, string]> = [
    ["read-only", "auto", "allow"],
    ["read-only", "confirm", "deny"],
    ["read-only", "deny", "deny"],
    ["approvals", "auto", "allow"],
    ["approvals", "confirm", "deny"],
    ["approvals", "deny", "deny"],
    ["full", "auto", "allow"],
    ["full", "confirm", "allow"],
    ["full", "deny", "deny"],
  ];

  for (const [authority, permission, expected] of table) {
    it(`${authority} + ${permission} => ${expected}`, () => {
      const check = buildAuthorityCheck(authority);
      expect(check("some_tool", permission)).toBe(expected);
    });
  }

  it("read-only/approvals never return 'confirm' (no sync approval UI)", () => {
    for (const authority of ["read-only", "approvals"] as ChannelAuthority[]) {
      const check = buildAuthorityCheck(authority);
      for (const p of perms) {
        expect(check("t", p)).not.toBe("confirm");
      }
    }
  });
});

describe("BlockedCallCollector", () => {
  const start = (toolName: string, args: unknown): AgentEvent => ({
    type: "tool-call-start",
    toolName,
    args,
  });
  const blockedResult = (toolName: string): AgentEvent => ({
    type: "tool-call-result",
    toolName,
    result: {
      ok: false,
      blocked: true,
      needsConfirmation: false,
      permissionDecision: "deny",
      tool: toolName,
    },
  });
  const okResult = (toolName: string): AgentEvent => ({
    type: "tool-call-result",
    toolName,
    result: { ok: true },
  });

  it("captures a call whose result is permission-blocked", () => {
    const c = new BlockedCallCollector();
    c.consume(start("file_write", { path: "a.txt", content: "x" }));
    c.consume(blockedResult("file_write"));
    expect(c.blocked()).toEqual([
      { tool: "file_write", input: { path: "a.txt", content: "x" } },
    ]);
  });

  it("does not capture a call that succeeded", () => {
    const c = new BlockedCallCollector();
    c.consume(start("file_read", { path: "a.txt" }));
    c.consume(okResult("file_read"));
    expect(c.blocked()).toEqual([]);
  });

  it("matches start/result by tool name in FIFO order", () => {
    const c = new BlockedCallCollector();
    c.consume(start("shell", { cmd: "rm -rf /" }));
    c.consume(start("shell", { cmd: "touch b" }));
    c.consume(blockedResult("shell")); // resolves the first shell call
    expect(c.blocked()).toEqual([
      { tool: "shell", input: { cmd: "rm -rf /" } },
    ]);
  });

  it("ignores a blocked result with no matching pending start", () => {
    const c = new BlockedCallCollector();
    c.consume(blockedResult("git_commit"));
    expect(c.blocked()).toEqual([]);
  });

  it("blocked() returns a copy, not the internal array", () => {
    const c = new BlockedCallCollector();
    c.consume(start("shell", { cmd: "x" }));
    c.consume(blockedResult("shell"));
    const first = c.blocked();
    first.push({ tool: "injected", input: null });
    expect(c.blocked()).toHaveLength(1);
  });
});
