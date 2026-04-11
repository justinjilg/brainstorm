/**
 * Multi-Agent Planner — decomposes a high-level request into a persistent
 * task board for the worker pool to execute.
 *
 * Part of Transformation 2 from linked-crunching-hamming.md.
 *
 * Flow:
 *   1. Caller passes a request like "add tests to packages/db, packages/onboard, packages/server"
 *   2. Planner spawns a planning subagent with the existing DECOMPOSITION_PROMPT
 *   3. Subagent returns JSON: { summary, subtasks: [{ id, description, dependsOn, ... }] }
 *   4. Planner persists each subtask as an orchestration_tasks row with the
 *      decomposition's dependency edges, returning the run_id for the worker pool to consume.
 *
 * Why this lives in core/plan/ instead of orchestrator/:
 *   - The Planner needs spawnSubagent (core), DECOMPOSITION_PROMPT (agents),
 *     and OrchestrationTaskRepository (orchestrator).
 *   - core already depends on agents and (now) orchestrator.
 *   - orchestrator deliberately stays as the SQL/state layer with no LLM
 *     dependencies, so it can be tested in isolation.
 */

import { DECOMPOSITION_PROMPT } from "@brainst0rm/agents";
import {
  OrchestrationRunRepository,
  OrchestrationTaskRepository,
} from "@brainst0rm/orchestrator";
import { createLogger } from "@brainst0rm/shared";
import type Database from "better-sqlite3";
import { spawnSubagent, type SubagentOptions } from "../agent/subagent.js";

const log = createLogger("multi-agent-planner");

export interface PlannedSubtask {
  id: string;
  description: string;
  requiredCapabilities: string[];
  complexity: string;
  dependsOn: string[];
  estimatedTokens?: number;
}

export interface PlanResult {
  runId: string;
  summary: string;
  subtaskCount: number;
  totalDependencies: number;
  cost: number;
  modelUsed: string;
  rawDecomposition: { summary: string; subtasks: PlannedSubtask[] };
}

export interface PlanOptions {
  /** High-level request to decompose. */
  request: string;
  /** Project ID that owns the run (FK target for orchestration_runs). */
  projectId: string;
  /** Optional human-friendly run name. Defaults to first 60 chars of request. */
  runName?: string;
  /** Optional budget limit in dollars for the entire run (Planner + Workers + Judge). */
  budgetLimit?: number;
  /** Subagent options for spawning the planner LLM call. */
  subagentOptions: SubagentOptions;
  /** SQLite database handle (for the persistent task board). */
  db: Database.Database;
}

/**
 * Run the Planner: spawn a decomposition subagent, persist its output as a
 * new orchestration run with one task per subtask, return the new run id.
 *
 * The Planner does NOT execute tasks — that's the worker pool's job. It
 * only decomposes and persists. This separation is important: the Planner
 * can be re-run cheaply on plan failure, and worker spawning is decoupled
 * from the LLM-driven planning step.
 */
export async function planMultiAgentRun(
  options: PlanOptions,
): Promise<PlanResult> {
  const { request, projectId, runName, budgetLimit, subagentOptions, db } =
    options;

  log.info({ request: request.slice(0, 120) }, "Starting plan decomposition");

  // Spawn the planning subagent. The system prompt is the existing
  // DECOMPOSITION_PROMPT which is already tuned for JSON output.
  // We use type=plan if available, otherwise fall back to general.
  const result = await spawnSubagent(request, {
    ...subagentOptions,
    type: "plan",
    systemPrompt: DECOMPOSITION_PROMPT,
    // Decomposition is short — bound it tightly to keep cost predictable.
    maxSteps: 5,
  });

  if (result.budgetExceeded) {
    throw new Error(
      `Planner could not run: budget exceeded before decomposition started`,
    );
  }

  // Parse the JSON response. The decomposition prompt asks for strict JSON
  // but models often wrap it in markdown fences or add prose. Be tolerant.
  const decomposition = parseDecomposition(result.text);
  if (!decomposition) {
    throw new Error(
      `Planner returned unparseable response. First 500 chars: ${result.text.slice(0, 500)}`,
    );
  }

  if (decomposition.subtasks.length === 0) {
    throw new Error(
      `Planner returned an empty subtasks array. Refusing to create empty run.`,
    );
  }

  // Persist the run + tasks. The Planner's subtask IDs are model-generated
  // strings (e.g., "search-codebase"); we need to map them to the SQLite
  // UUIDs our depends_on column expects. Build that map as we insert.
  const runRepo = new OrchestrationRunRepository(db);
  const taskRepo = new OrchestrationTaskRepository(db);

  const run = runRepo.create({
    name: runName ?? request.slice(0, 60),
    description: decomposition.summary,
    projectIds: [projectId],
    budgetLimit,
  });

  // Map planner-id → SQLite UUID
  const idMap = new Map<string, string>();

  // First pass: insert tasks WITHOUT dependencies. We need every task to
  // have a UUID before we can resolve cross-references.
  for (const sub of decomposition.subtasks) {
    const persisted = taskRepo.create({
      runId: run.id,
      projectId,
      prompt: sub.description,
      subagentType: pickSubagentType(sub),
    });
    idMap.set(sub.id, persisted.id);
  }

  // Second pass: update each task's depends_on with resolved UUIDs.
  // Skip dependencies that point to unknown plan IDs (the model
  // hallucinated a reference) — log and continue rather than crash.
  let totalDeps = 0;
  for (const sub of decomposition.subtasks) {
    if (sub.dependsOn.length === 0) continue;
    const resolvedDeps: string[] = [];
    for (const planId of sub.dependsOn) {
      const uuid = idMap.get(planId);
      if (uuid) {
        resolvedDeps.push(uuid);
        totalDeps++;
      } else {
        log.warn(
          { from: sub.id, to: planId },
          "Decomposition referenced an unknown subtask id — dropping edge",
        );
      }
    }
    if (resolvedDeps.length > 0) {
      // Direct UPDATE — repository doesn't expose a setDeps method yet.
      db.prepare(
        `UPDATE orchestration_tasks SET depends_on = ? WHERE id = ?`,
      ).run(JSON.stringify(resolvedDeps), idMap.get(sub.id));
    }
  }

  log.info(
    {
      runId: run.id,
      subtasks: decomposition.subtasks.length,
      totalDeps,
      cost: result.cost,
    },
    "Plan persisted",
  );

  return {
    runId: run.id,
    summary: decomposition.summary,
    subtaskCount: decomposition.subtasks.length,
    totalDependencies: totalDeps,
    cost: result.cost,
    modelUsed: result.modelUsed,
    rawDecomposition: decomposition,
  };
}

/**
 * Map a subtask's required capabilities to a subagent type. Used so the
 * worker pool knows whether to spawn a "code", "review", or "general"
 * subagent for each task.
 */
function pickSubagentType(sub: PlannedSubtask): string {
  const caps = new Set(sub.requiredCapabilities);
  if (caps.has("code-generation")) return "code";
  if (sub.description.toLowerCase().includes("review")) return "review";
  if (caps.has("large-context")) return "explore";
  return "general";
}

/**
 * Parse the decomposition response. Tolerates:
 *   - Plain JSON
 *   - JSON wrapped in ```json ... ``` fences
 *   - JSON with leading/trailing prose
 *
 * Returns null if no parseable JSON object is found.
 */
export function parseDecomposition(
  text: string,
): { summary: string; subtasks: PlannedSubtask[] } | null {
  // Try plain JSON first.
  const direct = tryParse(text.trim());
  if (direct) return direct;

  // Try fenced code blocks.
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    const fenced = tryParse(fenceMatch[1].trim());
    if (fenced) return fenced;
  }

  // Try to find a top-level JSON object by brace matching.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    const sliced = tryParse(slice);
    if (sliced) return sliced;
  }

  return null;
}

function tryParse(
  candidate: string,
): { summary: string; subtasks: PlannedSubtask[] } | null {
  try {
    const parsed = JSON.parse(candidate);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.subtasks)
    ) {
      // Normalize each subtask — fill in missing fields with sensible defaults.
      const subtasks: PlannedSubtask[] = parsed.subtasks
        .filter(
          (s: any) =>
            typeof s?.id === "string" && typeof s?.description === "string",
        )
        .map((s: any) => ({
          id: s.id,
          description: s.description,
          requiredCapabilities: Array.isArray(s.requiredCapabilities)
            ? s.requiredCapabilities
            : [],
          complexity:
            typeof s.complexity === "string" ? s.complexity : "moderate",
          dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
          estimatedTokens:
            typeof s.estimatedTokens === "number"
              ? s.estimatedTokens
              : undefined,
        }));
      return { summary: parsed.summary, subtasks };
    }
  } catch {
    return null;
  }
  return null;
}
