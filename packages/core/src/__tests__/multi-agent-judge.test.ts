import { describe, it, expect } from "vitest";
import { detectConflicts } from "../plan/multi-agent-judge.js";
import type { OrchestrationTask } from "@brainst0rm/shared";

function makeTask(
  id: string,
  files: string[],
  status: OrchestrationTask["status"] = "completed",
): OrchestrationTask {
  return {
    id,
    runId: "test-run",
    projectId: "test-project",
    prompt: `task ${id}`,
    status,
    subagentType: "code",
    cost: 0,
    dependsOn: [],
    filesTouched: files,
  };
}

describe("detectConflicts", () => {
  it("returns empty matrix when no files overlap", () => {
    const tasks = [
      makeTask("a", ["packages/db/src/foo.ts"]),
      makeTask("b", ["packages/onboard/src/bar.ts"]),
      makeTask("c", ["packages/server/src/baz.ts"]),
    ];
    expect(detectConflicts(tasks)).toEqual({});
  });

  it("flags a single file touched by two tasks", () => {
    const tasks = [
      makeTask("a", ["src/shared.ts", "src/a.ts"]),
      makeTask("b", ["src/shared.ts", "src/b.ts"]),
    ];
    const conflicts = detectConflicts(tasks);
    expect(Object.keys(conflicts)).toEqual(["src/shared.ts"]);
    expect(conflicts["src/shared.ts"].sort()).toEqual(["a", "b"]);
  });

  it("flags multiple conflicts and lists every overlapping task", () => {
    const tasks = [
      makeTask("a", ["x.ts", "y.ts"]),
      makeTask("b", ["x.ts", "z.ts"]),
      makeTask("c", ["x.ts", "w.ts"]),
      makeTask("d", ["z.ts"]),
    ];
    const conflicts = detectConflicts(tasks);
    expect(Object.keys(conflicts).sort()).toEqual(["x.ts", "z.ts"]);
    expect(conflicts["x.ts"].sort()).toEqual(["a", "b", "c"]);
    expect(conflicts["z.ts"].sort()).toEqual(["b", "d"]);
  });

  it("ignores tasks that did not complete", () => {
    const tasks = [
      makeTask("a", ["shared.ts"]),
      makeTask("b", ["shared.ts"], "failed"),
      makeTask("c", ["shared.ts"], "pending"),
    ];
    const conflicts = detectConflicts(tasks);
    // Only `a` is completed → no other completed task touches shared.ts
    expect(conflicts).toEqual({});
  });

  it("ignores tasks with no filesTouched", () => {
    const tasks: OrchestrationTask[] = [
      makeTask("a", ["shared.ts"]),
      {
        id: "b",
        runId: "test-run",
        projectId: "test-project",
        prompt: "b",
        status: "completed",
        subagentType: "code",
        cost: 0,
        dependsOn: [],
        // filesTouched omitted
      },
    ];
    expect(detectConflicts(tasks)).toEqual({});
  });

  it("handles a single task with many files", () => {
    const tasks = [makeTask("solo", ["a.ts", "b.ts", "c.ts", "d.ts"])];
    expect(detectConflicts(tasks)).toEqual({});
  });
});
