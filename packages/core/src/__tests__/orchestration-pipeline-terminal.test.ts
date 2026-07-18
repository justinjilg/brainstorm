import { describe, it, expect } from "vitest";
import { runOrchestrationPipeline } from "../plan/orchestration-pipeline.js";
import type {
  PhaseDispatcher,
  PipelineEvent,
} from "../plan/orchestration-pipeline.js";

/** Dispatcher whose phase text + cost are configurable. */
function dispatcher(opts: {
  text?: (phase: string) => string;
  cost?: number;
}): PhaseDispatcher {
  return {
    runPhase: async (_agentId, _type, prompt) => ({
      text: opts.text ? opts.text(prompt) : "some output",
      cost: opts.cost ?? 0,
      toolCalls: [],
    }),
    runParallel: async () => [],
    runCommand: async () => ({ passed: true, output: "" }),
  };
}

async function collect(gen: AsyncGenerator<PipelineEvent>) {
  const events: PipelineEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const TERMINALS = new Set([
  "pipeline-completed",
  "pipeline-failed",
  "pipeline-paused",
]);

describe("runOrchestrationPipeline — exactly one terminal event", () => {
  it("emits pipeline-completed when every phase produces output", async () => {
    const events = await collect(
      runOrchestrationPipeline("build", dispatcher({}), {
        projectPath: "/tmp",
        phases: ["spec", "architecture"],
      }),
    );
    const terminals = events.filter((e) => TERMINALS.has(e.type));
    expect(terminals).toHaveLength(1);
    expect(terminals[0].type).toBe("pipeline-completed");
  });

  it("emits pipeline-failed (not completed) when a phase output is empty", async () => {
    // Second phase (architecture) produces empty output → that phase fails.
    let call = 0;
    const emptySecond: PhaseDispatcher = {
      runPhase: async () => {
        call++;
        return { text: call >= 2 ? "" : "output", cost: 0, toolCalls: [] };
      },
      runParallel: async () => [],
      runCommand: async () => ({ passed: true, output: "" }),
    };
    const events = await collect(
      runOrchestrationPipeline("build", emptySecond, {
        projectPath: "/tmp",
        phases: ["spec", "architecture"],
      }),
    );
    const terminals = events.filter((e) => TERMINALS.has(e.type));
    expect(terminals).toHaveLength(1);
    expect(terminals[0].type).toBe("pipeline-failed");
    expect(
      events.some((e) => e.type === "pipeline-completed"),
    ).toBe(false);
  });

  it("emits ONLY pipeline-paused on budget exhaustion — no trailing completed", async () => {
    // Each phase costs 10; budget 5 → the guard trips before the first phase.
    const events = await collect(
      runOrchestrationPipeline("build", dispatcher({ cost: 10 }), {
        projectPath: "/tmp",
        phases: ["spec", "architecture", "implementation"],
        budget: 5,
      }),
    );
    const terminals = events.filter((e) => TERMINALS.has(e.type));
    // The double-finalize bug emitted pipeline-paused AND pipeline-completed.
    expect(terminals).toHaveLength(1);
    expect(terminals[0].type).toBe("pipeline-paused");
  });
});
