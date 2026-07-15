import { describe, it, expect } from "vitest";
import {
  resolveToolScope,
  applyReadOnlyDowngrade,
  composeSystemPrompt,
} from "../agent/subagent";

// Mirrors READ_ONLY_TOOLS in spawnSubagent — the downgrade target for
// mutating subagent types spawned without a permissionCheck.
const READ_ONLY_TOOLS = [
  "file_read",
  "glob",
  "grep",
  "list_dir",
  "git_status",
  "git_diff",
  "git_log",
];

// These tests exercise the security-critical narrowing semantics of subagent
// tool scoping and system-prompt composition as pure functions — no models,
// routers, or providers are spawned.

describe("resolveToolScope — narrowing intersection chain", () => {
  it("returns the type's list unchanged when no allowlist or parent is given", () => {
    expect(resolveToolScope(["file_read", "grep"])).toEqual([
      "file_read",
      "grep",
    ]);
  });

  it("returns undefined ('all') when the type grants all and nothing narrows it", () => {
    expect(resolveToolScope("all")).toBeUndefined();
  });

  it("honors an allowlist that is a subset of the type ceiling", () => {
    expect(
      resolveToolScope(["file_read", "grep", "glob"], ["grep", "glob"]),
    ).toEqual(["grep", "glob"]);
  });

  it("clips allowlist names that are outside the type ceiling (never widens)", () => {
    // shell is NOT in the type's list, so it must be dropped.
    expect(resolveToolScope(["file_read", "grep"], ["grep", "shell"])).toEqual([
      "grep",
    ]);
  });

  it("an allowlist can never grant a tool the type does not permit", () => {
    expect(resolveToolScope(["file_read"], ["shell", "git_commit"])).toEqual(
      [],
    );
  });

  it("'all' type + allowlist yields exactly the allowlist", () => {
    expect(resolveToolScope("all", ["file_write", "shell"])).toEqual([
      "file_write",
      "shell",
    ]);
  });

  it("composes allowlist with the parent ceiling", () => {
    // Type permits a,b,c,d; allowlist narrows to a,b,c; parent only has a,c.
    expect(
      resolveToolScope(["a", "b", "c", "d"], ["a", "b", "c"], ["a", "c"]),
    ).toEqual(["a", "c"]);
  });

  it("'all' type + allowlist + parent intersects both ceilings", () => {
    expect(resolveToolScope("all", ["a", "b", "c"], ["b", "c", "z"])).toEqual([
      "b",
      "c",
    ]);
  });

  it("intersects with the parent ceiling when no allowlist is present", () => {
    expect(
      resolveToolScope(["file_read", "grep", "shell"], undefined, [
        "file_read",
        "grep",
      ]),
    ).toEqual(["file_read", "grep"]);
  });

  it("'all' type restricted purely by the parent ceiling", () => {
    expect(resolveToolScope("all", undefined, ["file_read"])).toEqual([
      "file_read",
    ]);
  });

  it("treats an empty allowlist as absent (unchanged behavior)", () => {
    expect(resolveToolScope(["file_read", "grep"], [])).toEqual([
      "file_read",
      "grep",
    ]);
    expect(resolveToolScope("all", [])).toBeUndefined();
  });

  it("treats an empty parent list as absent (unchanged behavior)", () => {
    expect(resolveToolScope(["file_read", "grep"], undefined, [])).toEqual([
      "file_read",
      "grep",
    ]);
  });

  it("does not mutate the input type array", () => {
    const typeList = ["file_read", "grep"];
    resolveToolScope(typeList, ["grep"]);
    expect(typeList).toEqual(["file_read", "grep"]);
  });
});

describe("applyReadOnlyDowngrade — mutating-type downgrade never widens", () => {
  it("returns all read-only tools when the incoming scope is 'all' (undefined)", () => {
    expect(applyReadOnlyDowngrade(undefined, READ_ONLY_TOOLS)).toEqual(
      READ_ONLY_TOOLS,
    );
  });

  it("intersects the read-only set with an existing scope (does not replace it)", () => {
    // A 'code' type resolves to "all"; a per-spawn allowlist narrows it to
    // just ["grep"]. The read-only downgrade must NOT re-grant file_read etc.
    const resolved = resolveToolScope("all", ["grep"]);
    expect(applyReadOnlyDowngrade(resolved, READ_ONLY_TOOLS)).toEqual(["grep"]);
  });

  it("never re-grants a tool the allowlist deliberately excluded", () => {
    // Caller excludes file_read to keep the subagent away from sensitive
    // files. Downgrade must respect that exclusion.
    const resolved = resolveToolScope("all", ["grep", "glob"]);
    const downgraded = applyReadOnlyDowngrade(resolved, READ_ONLY_TOOLS);
    expect(downgraded).not.toContain("file_read");
    expect(downgraded).toEqual(["grep", "glob"]);
  });

  it("drops allowlist tools that are not read-only", () => {
    // shell survives resolveToolScope ('all' + allowlist) but must be
    // stripped by the read-only downgrade.
    const resolved = resolveToolScope("all", ["grep", "shell"]);
    expect(applyReadOnlyDowngrade(resolved, READ_ONLY_TOOLS)).toEqual(["grep"]);
  });

  it("composes with the parent ceiling too", () => {
    const resolved = resolveToolScope(
      "all",
      ["file_read", "grep", "shell"],
      ["grep", "shell"],
    );
    // allowlist ∩ parent = [grep, shell]; read-only downgrade drops shell.
    expect(applyReadOnlyDowngrade(resolved, READ_ONLY_TOOLS)).toEqual(["grep"]);
  });

  it("does not mutate the incoming scope array", () => {
    const resolved = ["grep", "shell"];
    applyReadOnlyDowngrade(resolved, READ_ONLY_TOOLS);
    expect(resolved).toEqual(["grep", "shell"]);
  });
});

describe("composeSystemPrompt — append never replaces", () => {
  it("returns the base unchanged when promptAppend is absent", () => {
    expect(composeSystemPrompt("base")).toBe("base");
    expect(composeSystemPrompt("base", undefined)).toBe("base");
  });

  it("appends with a blank-line separator, preserving the base", () => {
    expect(composeSystemPrompt("base", "extra")).toBe("base\n\nextra");
  });

  it("preserves the base prompt in full (does not overwrite it)", () => {
    const base = "You are an exploration subagent. Read-only tools only.";
    const result = composeSystemPrompt(base, "Focus on packages/core.");
    expect(result.startsWith(base)).toBe(true);
    expect(result).toContain("Focus on packages/core.");
  });
});
