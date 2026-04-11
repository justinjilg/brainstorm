import { describe, it, expect, vi, beforeEach } from "vitest";
import { runOnboardPipeline } from "../pipeline.js";
import type {
  OnboardEvent,
  OnboardOptions,
  OnboardDispatcher,
} from "../types.js";

// Mock the individual phases
vi.mock("../phases/static-analysis.js", () => ({
  runStaticAnalysis: vi.fn(() => ({
    analysis: {
      summary: {
        totalFiles: 10,
        totalLines: 100,
        moduleCount: 1,
        primaryLanguage: "TypeScript",
        frameworkList: [],
      },
    },
    gitSummary: "git log",
  })),
}));

vi.mock("../phases/verification.js", () => ({
  runVerification: vi.fn(() => ({
    agentsValid: true,
    agentErrors: [],
    routingValid: true,
    routingErrors: [],
    recipesValid: true,
    recipeErrors: [],
    brainstormMdValid: true,
    brainstormMdErrors: [],
  })),
}));

vi.mock("../phases/deep-exploration.js", () => ({
  runDeepExploration: vi.fn(async () => ({
    contextPatch: { exploration: {} },
    cost: 0.1,
    summary: "Explored",
    filesWritten: [],
  })),
}));

vi.mock("../phases/team-assembly.js", () => ({
  runTeamAssembly: vi.fn(async () => ({
    contextPatch: { agents: [] },
    cost: 0.2,
    summary: "Assembled",
    filesWritten: [],
  })),
}));

vi.mock("../phases/routing-rules.js", () => ({
  runRoutingRules: vi.fn(async () => ({
    contextPatch: { routingRules: [] },
    cost: 0.1,
    summary: "Routed",
    filesWritten: [],
  })),
}));

vi.mock("../phases/workflow-gen.js", () => ({
  runWorkflowGen: vi.fn(async () => ({
    contextPatch: { recipes: [] },
    cost: 0.1,
    summary: "Workflows",
    filesWritten: [],
  })),
}));

vi.mock("../phases/brainstorm-md.js", () => ({
  runBrainstormMd: vi.fn(async () => ({
    contextPatch: { brainstormMd: "" },
    cost: 0.1,
    summary: "Brainstorm",
    filesWritten: [],
  })),
}));

describe("Pipeline Dispatcher", () => {
  const dummyDispatcher: OnboardDispatcher = {
    explore: vi.fn().mockResolvedValue({ text: "", cost: 0 }),
    generate: vi.fn().mockResolvedValue({ text: "", cost: 0 }),
  };

  const dummyOptions: OnboardOptions = {
    projectPath: "/fake/path",
    budget: 10.0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function collectEvents(
    generator: AsyncGenerator<OnboardEvent>,
  ): Promise<OnboardEvent[]> {
    const events: OnboardEvent[] = [];
    for await (const event of generator) {
      events.push(event);
    }
    return events;
  }

  it("runs static-only mode correctly", async () => {
    const options: OnboardOptions = { ...dummyOptions, staticOnly: true };
    const generator = runOnboardPipeline(options, dummyDispatcher);
    const events = await collectEvents(generator);

    // Should skip all LLM phases
    const skippedPhases = events.filter((e) => e.type === "phase-skipped");
    expect(skippedPhases.length).toBe(5); // 5 LLM phases
    expect(
      skippedPhases.every((e: any) => e.reason === "Static-only mode"),
    ).toBe(true);

    const completed = events.find((e) => e.type === "onboard-completed") as any;
    expect(completed).toBeDefined();
    expect(completed.result.phasesRun).toContain("static-analysis");
    expect(completed.result.phasesRun).toContain("verification");
    expect(completed.result.phasesRun).not.toContain("deep-exploration");
  });

  it("skips LLM phases if dryRun is true", async () => {
    const options: OnboardOptions = { ...dummyOptions, dryRun: true };
    const generator = runOnboardPipeline(options, dummyDispatcher);
    const events = await collectEvents(generator);

    const skippedPhases = events.filter((e) => e.type === "phase-skipped");
    expect(skippedPhases.length).toBe(5);
    expect(skippedPhases[0]!.reason).toMatch(/Dry run/);

    const completed = events.find((e) => e.type === "onboard-completed") as any;
    expect(completed.result.phasesSkipped).toContain("deep-exploration");
  });

  it("fails early if static-analysis fails", async () => {
    const { runStaticAnalysis } = await import("../phases/static-analysis.js");
    vi.mocked(runStaticAnalysis).mockImplementationOnce(() => {
      throw new Error("Static analysis exploded");
    });

    const generator = runOnboardPipeline(dummyOptions, dummyDispatcher);
    const events = await collectEvents(generator);

    const failed = events.find((e) => e.type === "phase-failed");
    expect(failed).toBeDefined();
    expect((failed as any).error).toBe("Static analysis exploded");

    const completed = events.find((e) => e.type === "onboard-completed");
    expect(completed).toBeUndefined(); // Pipeline aborts
  });

  it("skips LLM phases due to budget constraints", async () => {
    // Only 0.01 budget, which is lower than any phase cost estimate
    const options: OnboardOptions = { ...dummyOptions, budget: 0.01 };
    const generator = runOnboardPipeline(options, dummyDispatcher);
    const events = await collectEvents(generator);

    const budgetWarnings = events.filter((e) => e.type === "budget-warning");
    expect(budgetWarnings.length).toBeGreaterThan(0);

    const skipped = events.filter((e) => e.type === "phase-skipped");
    expect(skipped.length).toBe(5); // all 5 skipped
    expect(skipped[0]!.reason).toMatch(/Budget insufficient/);
  });

  it("runs full pipeline successfully when budget allows", async () => {
    const generator = runOnboardPipeline(dummyOptions, dummyDispatcher);
    const events = await collectEvents(generator);

    const completedEvents = events.filter((e) => e.type === "phase-completed");
    // static, code-graph-build, 5 LLM phases, verification = 8 total
    expect(completedEvents.length).toBe(8);

    const finalEvent = events.find(
      (e) => e.type === "onboard-completed",
    ) as any;
    expect(finalEvent).toBeDefined();
    expect(finalEvent.result.phasesRun.length).toBe(8);
  });

  it("skips LLM phases if no dispatcher is provided", async () => {
    const generator = runOnboardPipeline(dummyOptions); // no dispatcher
    const events = await collectEvents(generator);

    const skipped = events.filter((e) => e.type === "phase-skipped");
    expect(skipped.length).toBe(5);
    expect(
      skipped.every((e: any) => e.reason === "No LLM dispatcher provided"),
    ).toBe(true);
  });
});
