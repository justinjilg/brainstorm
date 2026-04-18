import { describe, it, expect } from "vitest";
import { runOrchestrationPipeline } from "../plan/orchestration-pipeline.js";
import type { PhaseDispatcher } from "../plan/orchestration-pipeline.js";

function noopDispatcher(): PhaseDispatcher {
  return {
    runPhase: async () => ({ text: "", cost: 0, toolCalls: [] }),
    runParallel: async () => [],
    runCommand: async () => ({ passed: true, output: "" }),
  };
}

describe("runOrchestrationPipeline — resumeFrom validation", () => {
  it("throws when resumeFrom targets a phase that is not in the selected list", async () => {
    const gen = runOrchestrationPipeline("do thing", noopDispatcher(), {
      projectPath: "/tmp",
      phases: ["spec", "architecture"],
      resumeFrom: "refactor",
    });

    // The generator runs the validation at the top — the first .next() call
    // should surface the error rather than silently yield pipeline-completed
    // with no work done.
    await expect(gen.next()).rejects.toThrow(
      /resumeFrom="refactor".*not in the selected phases/,
    );
  });

  it("does not throw when resumeFrom matches a selected phase", async () => {
    const gen = runOrchestrationPipeline("do thing", noopDispatcher(), {
      projectPath: "/tmp",
      phases: ["spec", "architecture"],
      resumeFrom: "architecture",
    });
    // Just consume the first event — should be pipeline-started, not an error.
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect((first.value as { type: string }).type).toBe("pipeline-started");
  });

  it("does not throw when resumeFrom is omitted", async () => {
    const gen = runOrchestrationPipeline("do thing", noopDispatcher(), {
      projectPath: "/tmp",
      phases: ["spec"],
    });
    const first = await gen.next();
    expect(first.done).toBe(false);
  });
});
