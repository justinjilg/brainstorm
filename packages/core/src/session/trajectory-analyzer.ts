/**
 * Trajectory Analyzer — the learning loop.
 *
 * Reads trajectory JSONL files from ~/.brainstorm/trajectories/,
 * extracts per-session signals (model performance, task type, cost,
 * Read:Edit ratio, tool success), and aggregates them into a
 * routing-intelligence.json file that the router uses as priors.
 *
 * This is the flywheel: every session makes routing smarter.
 *
 * Schema of routing-intelligence.json:
 * {
 *   updatedAt: ISO,
 *   sessionsAnalyzed: N,
 *   models: {
 *     "anthropic/claude-sonnet-4.6": {
 *       totalSessions: N,
 *       successCount: N,
 *       failureCount: N,
 *       avgCostPerSession: N,
 *       avgReadEditRatio: N,
 *       avgToolSuccessRate: N,
 *       byTaskType: {
 *         "code-generation": { successes: N, failures: N },
 *         "refactoring": { successes: N, failures: N }
 *       }
 *     }
 *   },
 *   taskTypes: {
 *     "code-generation": { bestModel: "...", worstModel: "..." }
 *   },
 *   projectPreferences: {
 *     "<project-hash>": { preferredModel: "...", successRate: N }
 *   }
 * }
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("trajectory-analyzer");

interface ModelStats {
  totalSessions: number;
  successCount: number;
  failureCount: number;
  totalCost: number;
  totalReads: number;
  totalWrites: number;
  totalToolCalls: number;
  totalToolSuccesses: number;
  byTaskType: Record<
    string,
    {
      successes: number;
      failures: number;
      avgCost: number;
    }
  >;
}

export interface RoutingIntelligence {
  updatedAt: string;
  sessionsAnalyzed: number;
  models: Record<
    string,
    {
      totalSessions: number;
      successCount: number;
      failureCount: number;
      successRate: number;
      avgCostPerSession: number;
      avgReadEditRatio: number;
      avgToolSuccessRate: number;
      byTaskType: Record<
        string,
        {
          successes: number;
          failures: number;
          avgCost: number;
        }
      >;
    }
  >;
  taskTypes: Record<
    string,
    {
      bestModel: string | null;
      bestModelSuccessRate: number;
      totalSamples: number;
    }
  >;
  projectPreferences: Record<
    string,
    {
      preferredModel: string | null;
      preferredModelSuccessRate: number;
      sessionsOnProject: number;
    }
  >;
}

const READ_TOOLS = new Set([
  "file_read",
  "glob",
  "grep",
  "list_dir",
  "git_status",
  "git_diff",
  "git_log",
  "memory",
]);

const WRITE_TOOLS = new Set([
  "file_write",
  "file_edit",
  "multi_edit",
  "batch_edit",
  "shell",
]);

interface SessionSummary {
  sessionId: string;
  projectPath: string;
  model: string;
  provider: string;
  taskType: string;
  complexity: string;
  totalCost: number;
  totalLLMCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolCalls: number;
  toolSuccesses: number;
  toolFailures: number;
  reads: number;
  writes: number;
  hadErrors: boolean;
  duration: number;
  success: boolean;
}

/**
 * Parse a single trajectory JSONL file and extract a session summary.
 */
function analyzeTrajectoryFile(filePath: string): SessionSummary | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;

    const summary: SessionSummary = {
      sessionId: "",
      projectPath: "",
      model: "",
      provider: "",
      taskType: "unknown",
      complexity: "unknown",
      totalCost: 0,
      totalLLMCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      toolCalls: 0,
      toolSuccesses: 0,
      toolFailures: 0,
      reads: 0,
      writes: 0,
      hadErrors: false,
      duration: 0,
      success: false,
    };

    let sessionStartTime = 0;
    let sessionEndTime = 0;

    for (const line of lines) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (!summary.sessionId && event.sessionId) {
        summary.sessionId = event.sessionId;
      }

      switch (event.type) {
        case "session-start":
          sessionStartTime = new Date(event.timestamp).getTime();
          summary.projectPath = event.data?.projectPath ?? "";
          break;

        case "session-end":
          sessionEndTime = new Date(event.timestamp).getTime();
          // Success means: no errors, at least one LLM call completed, and the
          // model produced output. Tool use is orthogonal — conversational
          // sessions (storm run without --tools) are valid successes when the
          // LLM actually answers the question. Previously this required
          // toolCalls > 0, which counted every non-tool session as a failure
          // and poisoned the Thompson sampling priors with false negatives.
          summary.success =
            !summary.hadErrors &&
            summary.totalLLMCalls > 0 &&
            summary.totalOutputTokens > 0;
          break;

        case "llm-call":
          summary.totalLLMCalls++;
          summary.totalCost += event.data?.cost ?? 0;
          summary.totalInputTokens += event.data?.inputTokens ?? 0;
          summary.totalOutputTokens += event.data?.outputTokens ?? 0;
          if (!summary.model && event.data?.model) {
            summary.model = event.data.model;
            summary.provider = event.data.provider ?? "";
          }
          break;

        case "routing-decision":
          if (event.data?.taskType) summary.taskType = event.data.taskType;
          if (event.data?.complexity)
            summary.complexity = event.data.complexity;
          break;

        case "tool-call":
          summary.toolCalls++;
          const toolName = event.data?.name;
          if (toolName) {
            if (READ_TOOLS.has(toolName)) summary.reads++;
            if (WRITE_TOOLS.has(toolName)) summary.writes++;
          }
          break;

        case "tool-result":
          if (event.data?.ok === true) summary.toolSuccesses++;
          else if (event.data?.ok === false) summary.toolFailures++;
          break;

        case "error":
          summary.hadErrors = true;
          break;
      }
    }

    summary.duration = sessionEndTime - sessionStartTime;
    return summary;
  } catch (e) {
    log.warn({ err: e, filePath }, "Failed to analyze trajectory file");
    return null;
  }
}

/**
 * Aggregate session summaries into routing intelligence.
 */
function aggregate(summaries: SessionSummary[]): RoutingIntelligence {
  const models: Record<string, ModelStats> = {};
  const projectStats: Record<
    string,
    Record<string, { successes: number; failures: number }>
  > = {};

  for (const s of summaries) {
    if (!s.model) continue;

    // Model stats
    if (!models[s.model]) {
      models[s.model] = {
        totalSessions: 0,
        successCount: 0,
        failureCount: 0,
        totalCost: 0,
        totalReads: 0,
        totalWrites: 0,
        totalToolCalls: 0,
        totalToolSuccesses: 0,
        byTaskType: {},
      };
    }
    const m = models[s.model];
    m.totalSessions++;
    if (s.success) m.successCount++;
    else m.failureCount++;
    m.totalCost += s.totalCost;
    m.totalReads += s.reads;
    m.totalWrites += s.writes;
    m.totalToolCalls += s.toolCalls;
    m.totalToolSuccesses += s.toolSuccesses;

    if (!m.byTaskType[s.taskType]) {
      m.byTaskType[s.taskType] = { successes: 0, failures: 0, avgCost: 0 };
    }
    const t = m.byTaskType[s.taskType];
    if (s.success) t.successes++;
    else t.failures++;
    t.avgCost =
      (t.avgCost * (t.successes + t.failures - 1) + s.totalCost) /
      (t.successes + t.failures);

    // Project stats
    if (s.projectPath) {
      if (!projectStats[s.projectPath]) projectStats[s.projectPath] = {};
      if (!projectStats[s.projectPath][s.model]) {
        projectStats[s.projectPath][s.model] = { successes: 0, failures: 0 };
      }
      if (s.success) projectStats[s.projectPath][s.model].successes++;
      else projectStats[s.projectPath][s.model].failures++;
    }
  }

  // Compute derived metrics and best models per task type
  const taskTypeBest: Record<
    string,
    {
      bestModel: string | null;
      bestModelSuccessRate: number;
      totalSamples: number;
    }
  > = {};

  const modelsOut: RoutingIntelligence["models"] = {};
  for (const [modelId, stats] of Object.entries(models)) {
    modelsOut[modelId] = {
      totalSessions: stats.totalSessions,
      successCount: stats.successCount,
      failureCount: stats.failureCount,
      successRate:
        stats.totalSessions > 0 ? stats.successCount / stats.totalSessions : 0,
      avgCostPerSession:
        stats.totalSessions > 0 ? stats.totalCost / stats.totalSessions : 0,
      avgReadEditRatio:
        stats.totalWrites > 0 ? stats.totalReads / stats.totalWrites : Infinity,
      avgToolSuccessRate:
        stats.totalToolCalls > 0
          ? stats.totalToolSuccesses / stats.totalToolCalls
          : 0,
      byTaskType: stats.byTaskType,
    };

    // Track best model per task type
    for (const [taskType, t] of Object.entries(stats.byTaskType)) {
      const total = t.successes + t.failures;
      if (total < 2) continue; // Need at least 2 samples
      const successRate = t.successes / total;
      if (
        !taskTypeBest[taskType] ||
        successRate > taskTypeBest[taskType].bestModelSuccessRate
      ) {
        taskTypeBest[taskType] = {
          bestModel: modelId,
          bestModelSuccessRate: successRate,
          totalSamples: total,
        };
      }
    }
  }

  // Project preferences — best model per project
  const projectPreferences: RoutingIntelligence["projectPreferences"] = {};
  for (const [projectPath, projectModels] of Object.entries(projectStats)) {
    let bestModel: string | null = null;
    let bestRate = 0;
    let totalSessions = 0;
    for (const [modelId, stats] of Object.entries(projectModels)) {
      const total = stats.successes + stats.failures;
      totalSessions += total;
      if (total < 2) continue;
      const rate = stats.successes / total;
      if (rate > bestRate) {
        bestModel = modelId;
        bestRate = rate;
      }
    }
    projectPreferences[projectPath] = {
      preferredModel: bestModel,
      preferredModelSuccessRate: bestRate,
      sessionsOnProject: totalSessions,
    };
  }

  return {
    updatedAt: new Date().toISOString(),
    sessionsAnalyzed: summaries.length,
    models: modelsOut,
    taskTypes: taskTypeBest,
    projectPreferences,
  };
}

/**
 * Read all trajectory files in ~/.brainstorm/trajectories/ and write
 * ~/.brainstorm/routing-intelligence.json with aggregated stats.
 */
export function analyzeTrajectories(opts?: {
  trajectoriesDir?: string;
  outputPath?: string;
  maxAgeDays?: number;
}): RoutingIntelligence {
  const trajectoriesDir =
    opts?.trajectoriesDir ?? join(homedir(), ".brainstorm", "trajectories");
  const outputPath =
    opts?.outputPath ??
    join(homedir(), ".brainstorm", "routing-intelligence.json");
  const maxAgeDays = opts?.maxAgeDays ?? 30;

  if (!existsSync(trajectoriesDir)) {
    log.info(
      { trajectoriesDir },
      "No trajectories directory — nothing to analyze",
    );
    const empty: RoutingIntelligence = {
      updatedAt: new Date().toISOString(),
      sessionsAnalyzed: 0,
      models: {},
      taskTypes: {},
      projectPreferences: {},
    };
    return empty;
  }

  const files = readdirSync(trajectoriesDir).filter((f) =>
    f.endsWith(".jsonl"),
  );
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const summaries: SessionSummary[] = [];
  for (const file of files) {
    const filePath = join(trajectoriesDir, file);
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < cutoffMs) continue; // Skip old files
    } catch {
      continue;
    }
    const summary = analyzeTrajectoryFile(filePath);
    if (summary) summaries.push(summary);
  }

  log.info(
    { sessionCount: summaries.length, filesScanned: files.length },
    "Analyzed trajectories",
  );

  const intelligence = aggregate(summaries);

  // Ensure output directory exists
  const outputDir = join(homedir(), ".brainstorm");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  writeFileSync(outputPath, JSON.stringify(intelligence, null, 2), "utf-8");
  log.info({ outputPath }, "Routing intelligence updated");

  return intelligence;
}

/**
 * Load routing intelligence from disk. Returns empty state if not found.
 */
export function loadRoutingIntelligence(): RoutingIntelligence | null {
  const path = join(homedir(), ".brainstorm", "routing-intelligence.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RoutingIntelligence;
  } catch (e) {
    log.warn({ err: e }, "Failed to load routing intelligence");
    return null;
  }
}

/**
 * Convert RoutingIntelligence to the format BrainstormRouter.loadStats() expects.
 * This is the bridge that closes the learning loop: trajectories → analyzer →
 * intelligence → router priors → next session's decisions.
 */
export function toHistoricalStats(intelligence: RoutingIntelligence): Array<{
  taskType: string;
  modelId: string;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  avgCost: number;
  samples: number;
}> {
  const stats: Array<{
    taskType: string;
    modelId: string;
    successes: number;
    failures: number;
    avgLatencyMs: number;
    avgCost: number;
    samples: number;
  }> = [];

  for (const [modelId, model] of Object.entries(intelligence.models)) {
    for (const [taskType, t] of Object.entries(model.byTaskType)) {
      const samples = t.successes + t.failures;
      if (samples === 0) continue;
      stats.push({
        taskType,
        modelId,
        successes: t.successes,
        failures: t.failures,
        avgLatencyMs: 0, // Not yet tracked per task-type
        avgCost: t.avgCost,
        samples,
      });
    }
  }

  return stats;
}
