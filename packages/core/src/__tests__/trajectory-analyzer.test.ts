import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  analyzeTrajectories,
  loadRoutingIntelligence,
  toHistoricalStats,
  type RoutingIntelligence,
} from "../session/trajectory-analyzer.js";

const tempDirs: string[] = [];
const routingFilePath = join(
  homedir(),
  ".brainstorm",
  "routing-intelligence.json",
);

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJsonlSession(
  dir: string,
  fileName: string,
  events: Array<Record<string, unknown> | string>,
): string {
  const filePath = join(dir, fileName);
  const content = events
    .map((event) => (typeof event === "string" ? event : JSON.stringify(event)))
    .join("\n");
  writeFileSync(filePath, `${content}\n`, "utf-8");
  return filePath;
}

function createSessionEvents(opts: {
  sessionId: string;
  projectPath: string;
  model: string;
  provider?: string;
  taskType?: string;
  llmCost?: number;
  readTools?: string[];
  writeTools?: string[];
  toolFailures?: number;
  includeError?: boolean;
}): Array<Record<string, unknown>> {
  const provider = opts.provider ?? "anthropic";
  const taskType = opts.taskType ?? "unknown";
  const llmCost = opts.llmCost ?? 0;
  const readTools = opts.readTools ?? [];
  const writeTools = opts.writeTools ?? [];
  const toolFailures = opts.toolFailures ?? 0;

  const events: Array<Record<string, unknown>> = [
    {
      sessionId: opts.sessionId,
      type: "session-start",
      timestamp: "2026-04-10T10:00:00.000Z",
      data: {
        projectPath: opts.projectPath,
      },
    },
    {
      sessionId: opts.sessionId,
      type: "routing-decision",
      timestamp: "2026-04-10T10:00:01.000Z",
      data: {
        taskType,
        complexity: "medium",
      },
    },
    {
      sessionId: opts.sessionId,
      type: "llm-call",
      timestamp: "2026-04-10T10:00:02.000Z",
      data: {
        model: opts.model,
        provider,
        cost: llmCost,
        inputTokens: 100,
        outputTokens: 40,
      },
    },
  ];

  let toolIndex = 0;
  for (const toolName of [...readTools, ...writeTools]) {
    events.push({
      sessionId: opts.sessionId,
      type: "tool-call",
      timestamp: `2026-04-10T10:00:${String(3 + toolIndex).padStart(2, "0")}.000Z`,
      data: {
        name: toolName,
      },
    });
    events.push({
      sessionId: opts.sessionId,
      type: "tool-result",
      timestamp: `2026-04-10T10:00:${String(3 + toolIndex).padStart(2, "0")}.500Z`,
      data: {
        ok: true,
      },
    });
    toolIndex++;
  }

  for (let i = 0; i < toolFailures; i++) {
    events.push({
      sessionId: opts.sessionId,
      type: "tool-call",
      timestamp: `2026-04-10T10:01:${String(i).padStart(2, "0")}.000Z`,
      data: {
        name: "shell",
      },
    });
    events.push({
      sessionId: opts.sessionId,
      type: "tool-result",
      timestamp: `2026-04-10T10:01:${String(i).padStart(2, "0")}.500Z`,
      data: {
        ok: false,
      },
    });
  }

  if (opts.includeError) {
    events.push({
      sessionId: opts.sessionId,
      type: "error",
      timestamp: "2026-04-10T10:02:00.000Z",
      data: {
        message: "simulated failure",
      },
    });
  }

  events.push({
    sessionId: opts.sessionId,
    type: "session-end",
    timestamp: "2026-04-10T10:03:00.000Z",
    data: {},
  });

  return events;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(routingFilePath, { force: true });
});

describe("trajectory-analyzer", () => {
  it("returns empty routing intelligence for an empty trajectories directory", () => {
    const trajectoriesDir = createTempDir("trajectory-empty-");
    const outputDir = createTempDir("trajectory-output-");
    const outputPath = join(outputDir, "routing-intelligence.json");

    const intelligence = analyzeTrajectories({
      trajectoriesDir,
      outputPath,
    });

    expect(intelligence.sessionsAnalyzed).toBe(0);
    expect(intelligence.models).toEqual({});
    expect(intelligence.taskTypes).toEqual({});
    expect(intelligence.projectPreferences).toEqual({});
  });

  it("extracts model, task type, and tool counts from a single valid session", () => {
    const trajectoriesDir = createTempDir("trajectory-single-");
    const outputDir = createTempDir("trajectory-output-");
    const outputPath = join(outputDir, "routing-intelligence.json");

    writeJsonlSession(
      trajectoriesDir,
      "session-1.jsonl",
      createSessionEvents({
        sessionId: "session-1",
        projectPath: "/repo/project-a",
        model: "anthropic/claude-sonnet-4.6",
        taskType: "refactoring",
        llmCost: 1.25,
        readTools: ["file_read", "grep"],
        writeTools: ["file_edit"],
      }),
    );

    const intelligence = analyzeTrajectories({
      trajectoriesDir,
      outputPath,
    });

    const modelStats = intelligence.models["anthropic/claude-sonnet-4.6"];
    expect(intelligence.sessionsAnalyzed).toBe(1);
    expect(modelStats).toMatchObject({
      totalSessions: 1,
      successCount: 1,
      failureCount: 0,
      successRate: 1,
      avgCostPerSession: 1.25,
      avgReadEditRatio: 2,
      avgToolSuccessRate: 1,
    });
    expect(modelStats.byTaskType.refactoring).toEqual({
      successes: 1,
      failures: 0,
      avgCost: 1.25,
    });
    expect(intelligence.taskTypes).toEqual({});
    expect(intelligence.projectPreferences["/repo/project-a"]).toEqual({
      preferredModel: null,
      preferredModelSuccessRate: 0,
      sessionsOnProject: 1,
    });
  });

  it("aggregates multiple sessions into model and task type summaries", () => {
    const trajectoriesDir = createTempDir("trajectory-multi-");
    const outputDir = createTempDir("trajectory-output-");
    const outputPath = join(outputDir, "routing-intelligence.json");

    writeJsonlSession(
      trajectoriesDir,
      "session-a1.jsonl",
      createSessionEvents({
        sessionId: "session-a1",
        projectPath: "/repo/project-a",
        model: "anthropic/claude-sonnet-4.6",
        taskType: "code-generation",
        llmCost: 1,
        readTools: ["file_read"],
        writeTools: ["file_edit"],
      }),
    );
    writeJsonlSession(
      trajectoriesDir,
      "session-a2.jsonl",
      createSessionEvents({
        sessionId: "session-a2",
        projectPath: "/repo/project-a",
        model: "anthropic/claude-sonnet-4.6",
        taskType: "code-generation",
        llmCost: 2,
        readTools: ["glob", "grep"],
        writeTools: ["file_write"],
      }),
    );
    writeJsonlSession(
      trajectoriesDir,
      "session-b1.jsonl",
      createSessionEvents({
        sessionId: "session-b1",
        projectPath: "/repo/project-a",
        model: "openai/gpt-4.1",
        provider: "openai",
        taskType: "code-generation",
        llmCost: 3,
        readTools: ["file_read"],
        writeTools: ["shell"],
        includeError: true,
      }),
    );
    writeJsonlSession(
      trajectoriesDir,
      "session-b2.jsonl",
      createSessionEvents({
        sessionId: "session-b2",
        projectPath: "/repo/project-b",
        model: "openai/gpt-4.1",
        provider: "openai",
        taskType: "bug-fix",
        llmCost: 4,
        readTools: ["file_read"],
        writeTools: ["file_edit"],
      }),
    );

    const intelligence = analyzeTrajectories({
      trajectoriesDir,
      outputPath,
    });

    expect(intelligence.sessionsAnalyzed).toBe(4);
    expect(intelligence.models["anthropic/claude-sonnet-4.6"]).toMatchObject({
      totalSessions: 2,
      successCount: 2,
      failureCount: 0,
      successRate: 1,
      avgCostPerSession: 1.5,
      avgReadEditRatio: 1.5,
      avgToolSuccessRate: 1,
    });
    expect(intelligence.models["openai/gpt-4.1"]).toMatchObject({
      totalSessions: 2,
      successCount: 1,
      failureCount: 1,
      successRate: 0.5,
      avgCostPerSession: 3.5,
      avgReadEditRatio: 1,
      avgToolSuccessRate: 1,
    });
    expect(
      intelligence.models["anthropic/claude-sonnet-4.6"].byTaskType[
        "code-generation"
      ],
    ).toEqual({
      successes: 2,
      failures: 0,
      avgCost: 1.5,
    });
    expect(
      intelligence.models["openai/gpt-4.1"].byTaskType["code-generation"],
    ).toEqual({
      successes: 0,
      failures: 1,
      avgCost: 3,
    });
    expect(intelligence.taskTypes["code-generation"]).toEqual({
      bestModel: "anthropic/claude-sonnet-4.6",
      bestModelSuccessRate: 1,
      totalSamples: 2,
    });
    expect(intelligence.projectPreferences["/repo/project-a"]).toEqual({
      preferredModel: "anthropic/claude-sonnet-4.6",
      preferredModelSuccessRate: 1,
      sessionsOnProject: 3,
    });
    expect(intelligence.projectPreferences["/repo/project-b"]).toEqual({
      preferredModel: null,
      preferredModelSuccessRate: 0,
      sessionsOnProject: 1,
    });
  });

  it("skips malformed JSONL lines without crashing", () => {
    const trajectoriesDir = createTempDir("trajectory-malformed-");
    const outputDir = createTempDir("trajectory-output-");
    const outputPath = join(outputDir, "routing-intelligence.json");

    writeJsonlSession(trajectoriesDir, "session-malformed.jsonl", [
      ...createSessionEvents({
        sessionId: "session-malformed",
        projectPath: "/repo/project-c",
        model: "anthropic/claude-sonnet-4.6",
        taskType: "code-generation",
        llmCost: 2.5,
        readTools: ["file_read"],
        writeTools: ["file_edit"],
      }).slice(0, 3),
      "{this is not valid json",
      ...createSessionEvents({
        sessionId: "session-malformed",
        projectPath: "/repo/project-c",
        model: "anthropic/claude-sonnet-4.6",
        taskType: "code-generation",
        llmCost: 2.5,
        readTools: ["file_read"],
        writeTools: ["file_edit"],
      }).slice(3),
    ]);

    const intelligence = analyzeTrajectories({
      trajectoriesDir,
      outputPath,
    });

    expect(intelligence.sessionsAnalyzed).toBe(1);
    expect(intelligence.models["anthropic/claude-sonnet-4.6"]).toMatchObject({
      totalSessions: 1,
      successCount: 1,
      failureCount: 0,
    });
  });

  it("returns null when loading routing intelligence with no file", () => {
    const loaded = loadRoutingIntelligence();

    expect(loaded).toBeNull();
  });

  it("loads routing intelligence from a valid file", () => {
    mkdirSync(join(homedir(), ".brainstorm"), { recursive: true });
    const intelligence: RoutingIntelligence = {
      updatedAt: "2026-04-10T10:00:00.000Z",
      sessionsAnalyzed: 3,
      models: {
        "anthropic/claude-sonnet-4.6": {
          totalSessions: 3,
          successCount: 2,
          failureCount: 1,
          successRate: 2 / 3,
          avgCostPerSession: 1.75,
          avgReadEditRatio: 2,
          avgToolSuccessRate: 0.8,
          byTaskType: {
            refactoring: {
              successes: 2,
              failures: 1,
              avgCost: 1.75,
            },
          },
        },
      },
      taskTypes: {
        refactoring: {
          bestModel: "anthropic/claude-sonnet-4.6",
          bestModelSuccessRate: 2 / 3,
          totalSamples: 3,
        },
      },
      projectPreferences: {
        "/repo/project-a": {
          preferredModel: "anthropic/claude-sonnet-4.6",
          preferredModelSuccessRate: 2 / 3,
          sessionsOnProject: 3,
        },
      },
    };

    writeFileSync(
      routingFilePath,
      JSON.stringify(intelligence, null, 2),
      "utf-8",
    );

    const loaded = loadRoutingIntelligence();

    expect(loaded).toEqual(intelligence);
  });

  it("converts routing intelligence to router historical stats format", () => {
    const intelligence: RoutingIntelligence = {
      updatedAt: "2026-04-10T10:00:00.000Z",
      sessionsAnalyzed: 4,
      models: {
        "anthropic/claude-sonnet-4.6": {
          totalSessions: 3,
          successCount: 2,
          failureCount: 1,
          successRate: 2 / 3,
          avgCostPerSession: 1.4,
          avgReadEditRatio: 2,
          avgToolSuccessRate: 0.9,
          byTaskType: {
            "code-generation": {
              successes: 2,
              failures: 1,
              avgCost: 1.5,
            },
            refactoring: {
              successes: 0,
              failures: 0,
              avgCost: 999,
            },
          },
        },
        "openai/gpt-4.1": {
          totalSessions: 1,
          successCount: 1,
          failureCount: 0,
          successRate: 1,
          avgCostPerSession: 3,
          avgReadEditRatio: 1,
          avgToolSuccessRate: 1,
          byTaskType: {
            "bug-fix": {
              successes: 1,
              failures: 0,
              avgCost: 3,
            },
          },
        },
      },
      taskTypes: {},
      projectPreferences: {},
    };

    const stats = toHistoricalStats(intelligence);

    expect(stats).toEqual([
      {
        taskType: "code-generation",
        modelId: "anthropic/claude-sonnet-4.6",
        successes: 2,
        failures: 1,
        avgLatencyMs: 0,
        avgCost: 1.5,
        samples: 3,
      },
      {
        taskType: "bug-fix",
        modelId: "openai/gpt-4.1",
        successes: 1,
        failures: 0,
        avgLatencyMs: 0,
        avgCost: 3,
        samples: 1,
      },
    ]);
  });
});
