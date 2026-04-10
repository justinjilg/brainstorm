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

  it("handles empty task list correctly", () => {
    const result = aggregateResults(STUB_RUN as any, [], PROJECT_NAMES);
    expect(result.projectCount).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);

    const formatted = formatAggregatedResults(result);
    expect(formatted).toContain("0/0 projects completed");
    expect(formatted).not.toContain("✓");
    expect(formatted).not.toContain("✗");
  });

  it("handles single project execution", () => {
    const singleTask = [STUB_TASKS[0]];
    const run = { ...STUB_RUN, totalCost: 0.1 };
    const result = aggregateResults(
      run as any,
      singleTask as any,
      PROJECT_NAMES,
    );
    expect(result.projectCount).toBe(1);
    expect(result.successCount).toBe(1);

    const formatted = formatAggregatedResults(result);
    expect(formatted).toContain("1/1 projects completed");
    expect(formatted).toContain("✓ brainstormmsp ($0.1000)");
  });

  it("handles various failure and status combinations", () => {
    const mixedTasks = [
      {
        projectId: "proj-aaa",
        status: "failed",
        resultSummary: "Error A",
        cost: 0.1,
      },
      {
        projectId: "proj-bbb",
        status: "skipped",
        resultSummary: "Not needed",
        cost: 0.0,
      },
      {
        projectId: "proj-ccc",
        status: "running",
        resultSummary: "In progress",
        cost: 0.05,
      },
      {
        projectId: "proj-ddd",
        status: "pending",
        resultSummary: "Waiting",
        cost: 0.0,
      },
    ];
    const result = aggregateResults(
      STUB_RUN as any,
      mixedTasks as any,
      new Map([
        ["proj-aaa", "projA"],
        ["proj-bbb", "projB"],
        ["proj-ccc", "projC"],
        ["proj-ddd", "projD"],
      ]),
    );

    expect(result.projectCount).toBe(4);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(1);

    const formatted = formatAggregatedResults(result);
    expect(formatted).toContain("0/4 projects completed");
    expect(formatted).toContain("✗ projA");
    expect(formatted).toContain("○ projB");
    expect(formatted).toContain("● projC");
    expect(formatted).toContain("● projD");
  });

  it("handles formatting with high costs (max budget scenario)", () => {
    const expensiveRun = { ...STUB_RUN, totalCost: 9999.9999 };
    const expensiveTask = [
      {
        projectId: "proj-aaa",
        status: "completed",
        resultSummary: "Done",
        cost: 9999.9999,
      },
    ];

    const result = aggregateResults(
      expensiveRun as any,
      expensiveTask as any,
      PROJECT_NAMES,
    );
    const formatted = formatAggregatedResults(result);
    expect(formatted).toContain("$9999.9999 total");
    expect(formatted).toContain("($9999.9999)");
  });

  it("truncates multi-line summaries to 3 lines maximum", () => {
    const taskWithLongSummary = [
      {
        projectId: "proj-aaa",
        status: "completed",
        resultSummary: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
        cost: 0.1,
      },
    ];
    const result = aggregateResults(
      STUB_RUN as any,
      taskWithLongSummary as any,
      PROJECT_NAMES,
    );

    const formatted = formatAggregatedResults(result);
    expect(formatted).toContain("Line 1");
    expect(formatted).toContain("Line 2");
    expect(formatted).toContain("Line 3");
    expect(formatted).not.toContain("Line 4");
    expect(formatted).not.toContain("Line 5");
  });

  it("truncates summary lines longer than 120 characters", () => {
    const longString = "A".repeat(150);
    const taskWithLongLine = [
      {
        projectId: "proj-aaa",
        status: "completed",
        resultSummary: longString,
        cost: 0.1,
      },
    ];
    const result = aggregateResults(
      STUB_RUN as any,
      taskWithLongLine as any,
      PROJECT_NAMES,
    );

    const formatted = formatAggregatedResults(result);
    const expectedTruncatedString = "A".repeat(120);
    expect(formatted).toContain(expectedTruncatedString);
    expect(formatted).not.toContain(longString);
  });
});
