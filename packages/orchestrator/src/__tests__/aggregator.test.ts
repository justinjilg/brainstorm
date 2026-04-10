/**
 * Orchestrator aggregator tests.
 */

import { describe, it, expect } from "vitest";
import { aggregateResults, formatAggregatedResults } from "../aggregator.js";

const STUB_RUN = {
  id: "run-1",
  description: "Deploy security patches across all projects",
  totalCost: 0.25,
  status: "completed",
};

const STUB_TASKS = [
  {
    projectId: "proj-aaa",
    status: "completed",
    resultSummary: "Fixed 3 CVEs",
    cost: 0.1,
  },
  {
    projectId: "proj-bbb",
    status: "completed",
    resultSummary: "Updated deps",
    cost: 0.08,
  },
  {
    projectId: "proj-ccc",
    status: "failed",
    resultSummary: "Build failed",
    cost: 0.07,
  },
];

const PROJECT_NAMES = new Map([
  ["proj-aaa", "brainstormmsp"],
  ["proj-bbb", "peer10"],
  ["proj-ccc", "eventflow"],
]);

describe("Orchestrator Aggregator", () => {
  it("aggregates results with correct counts", () => {
    const result = aggregateResults(
      STUB_RUN as any,
      STUB_TASKS as any,
      PROJECT_NAMES,
    );
    expect(result.projectCount).toBe(3);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    expect(result.totalCost).toBe(0.25);
  });

  it("maps project IDs to names", () => {
    const result = aggregateResults(
      STUB_RUN as any,
      STUB_TASKS as any,
      PROJECT_NAMES,
    );
    expect(result.perProject[0].name).toBe("brainstormmsp");
    expect(result.perProject[2].name).toBe("eventflow");
  });

  it("falls back to truncated ID for unknown projects", () => {
    const emptyNames = new Map<string, string>();
    const result = aggregateResults(
      STUB_RUN as any,
      STUB_TASKS as any,
      emptyNames,
    );
    expect(result.perProject[0].name).toBe("proj-aaa");
  });

  it("formats results as readable markdown", () => {
    const result = aggregateResults(
      STUB_RUN as any,
      STUB_TASKS as any,
      PROJECT_NAMES,
    );
    const formatted = formatAggregatedResults(result);
    expect(formatted).toContain("2/3 projects completed");
    expect(formatted).toContain("✓ brainstormmsp");
    expect(formatted).toContain("✗ eventflow");
    expect(formatted).toContain("Fixed 3 CVEs");
  });
});
