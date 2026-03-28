/**
 * Trajectory Capture — records orchestration pipeline executions as training data.
 *
 * Every pipeline run produces a structured trajectory that captures:
 * - The user's request
 * - Each phase's agent, model, tools, cost, duration, and output quality
 * - The pipeline outcome (build pass, test pass, review findings)
 * - Feedback loops (review → re-implementation cycles)
 *
 * Trajectories are emitted as JSONL for:
 * 1. Local storage (~/.brainstorm/trajectories/orchestration/)
 * 2. BrainstormRouter Intelligence API (POST /v1/agent/trajectory)
 * 3. HuggingFace dataset push (justinjilg/brainstorm-orchestration-trajectories)
 *
 * This data trains BrainstormLLM v2 — the orchestration model.
 */

import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  PipelineEvent,
  PipelinePhase,
  PhaseResult,
} from "./orchestration-pipeline.js";

// ── Types ──────────────────────────────────────────────────────────

export interface OrchestrationTrajectory {
  id: string;
  timestamp: string;
  request: string;
  projectPath: string;
  projectType?: string;
  phases: PhaseTrajectory[];
  outcome: PipelineOutcome;
  totalCost: number;
  totalDuration: number;
  feedbackLoops: FeedbackLoop[];
}

export interface PhaseTrajectory {
  phase: PipelinePhase;
  agentId: string;
  modelUsed?: string;
  subagentType: string;
  toolCalls: string[];
  inputTokens?: number;
  outputTokens?: number;
  cost: number;
  duration: number;
  success: boolean;
  skipped: boolean;
  error?: string;
  outputLength: number;
}

export interface PipelineOutcome {
  success: boolean;
  phasesCompleted: number;
  phasesTotal: number;
  buildPassed?: boolean;
  testsPassed?: boolean;
  reviewFindings: number;
  criticalFindings: number;
  filesChanged?: number;
}

export interface FeedbackLoop {
  from: PipelinePhase;
  to: PipelinePhase;
  reason: string;
  timestamp: number;
}

// ── Trajectory Recorder ────────────────────────────────────────────

const TRAJECTORY_DIR = join(
  homedir(),
  ".brainstorm",
  "trajectories",
  "orchestration",
);

export class TrajectoryRecorder {
  private id: string;
  private request: string;
  private projectPath: string;
  private startTime: number;
  private phases: PhaseTrajectory[] = [];
  private feedbackLoops: FeedbackLoop[] = [];
  private currentPhase: Partial<PhaseTrajectory> | null = null;
  private outcome: PipelineOutcome = {
    success: false,
    phasesCompleted: 0,
    phasesTotal: 0,
    reviewFindings: 0,
    criticalFindings: 0,
  };

  constructor(request: string, projectPath: string) {
    this.id = randomUUID();
    this.request = request;
    this.projectPath = projectPath;
    this.startTime = Date.now();

    if (!existsSync(TRAJECTORY_DIR)) {
      mkdirSync(TRAJECTORY_DIR, { recursive: true });
    }
  }

  /** Process a pipeline event and record relevant data. */
  recordEvent(event: PipelineEvent): void {
    switch (event.type) {
      case "pipeline-started":
        this.outcome.phasesTotal = event.phases.length;
        break;

      case "phase-started":
        this.currentPhase = {
          phase: event.phase,
          agentId: event.agentId,
          cost: 0,
          duration: 0,
          success: false,
          skipped: false,
          toolCalls: [],
          outputLength: 0,
        };
        break;

      case "phase-completed":
        if (this.currentPhase) {
          this.phases.push({
            phase: event.result.phase,
            agentId: event.result.agentId,
            subagentType: "auto", // BR picks the model
            toolCalls: event.result.toolCalls,
            cost: event.result.cost,
            duration: event.result.duration,
            success: event.result.success,
            skipped: false,
            error: event.result.error,
            outputLength: event.result.output.length,
          });
          if (event.result.success) this.outcome.phasesCompleted++;
          this.currentPhase = null;
        }
        break;

      case "phase-failed":
        if (this.currentPhase) {
          this.phases.push({
            phase: event.phase,
            agentId: this.currentPhase.agentId ?? "unknown",
            subagentType: "auto",
            toolCalls: [],
            cost: 0,
            duration: 0,
            success: false,
            skipped: false,
            error: event.error,
            outputLength: 0,
          });
          this.currentPhase = null;
        }
        break;

      case "review-findings":
        this.outcome.reviewFindings = event.findings.length;
        this.outcome.criticalFindings = event.findings.filter(
          (f) => f.severity === "critical",
        ).length;
        break;

      case "feedback-loop":
        this.feedbackLoops.push({
          from: event.from,
          to: event.to,
          reason: event.reason,
          timestamp: Date.now(),
        });
        break;

      case "pipeline-completed":
        this.outcome.success =
          event.results.every((r) => r.success) && event.totalCost >= 0;
        this.outcome.phasesCompleted = event.results.filter(
          (r) => r.success,
        ).length;

        // Check verify phase for build/test results
        const verifyResult = event.results.find((r) => r.phase === "verify");
        if (verifyResult) {
          this.outcome.buildPassed =
            verifyResult.output.includes("Build: PASS");
          this.outcome.testsPassed =
            verifyResult.output.includes("Tests: PASS");
        }
        break;
    }
  }

  /** Finalize and persist the trajectory. Returns the trajectory object. */
  finalize(): OrchestrationTrajectory {
    const trajectory: OrchestrationTrajectory = {
      id: this.id,
      timestamp: new Date().toISOString(),
      request: this.request,
      projectPath: this.projectPath,
      phases: this.phases,
      outcome: this.outcome,
      totalCost: this.phases.reduce((sum, p) => sum + p.cost, 0),
      totalDuration: Date.now() - this.startTime,
      feedbackLoops: this.feedbackLoops,
    };

    // Write to local JSONL (source of truth)
    const filename = `${new Date().toISOString().slice(0, 10)}.jsonl`;
    const filepath = join(TRAJECTORY_DIR, filename);
    appendFileSync(filepath, JSON.stringify(trajectory) + "\n", "utf-8");

    // Push to BrainstormRouter (fire-and-forget, local is source of truth)
    this.pushToBR(trajectory).catch(() => {
      // Silent failure — local JSONL is the primary store
    });

    return trajectory;
  }

  /** Push trajectory to BrainstormRouter's trajectory endpoint. */
  private async pushToBR(trajectory: OrchestrationTrajectory): Promise<void> {
    const apiKey =
      process.env.BRAINSTORM_API_KEY ?? process.env.BRAINSTORM_ADMIN_KEY;
    if (!apiKey) return; // No key = skip push silently

    const res = await fetch(
      "https://api.brainstormrouter.com/v1/agent/trajectories",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(trajectory),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      // Log but don't throw — local JSONL is the real store
      const body = await res.text().catch(() => "");
      console.error(
        `[trajectory] BR push failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
  }

  /** Get the trajectory ID (for linking to BR API). */
  getId(): string {
    return this.id;
  }
}

// ── SFT Training Data Converter ────────────────────────────────────

/**
 * Convert a trajectory into SFT training examples for BrainstormLLM v2.
 *
 * Each phase in the trajectory becomes one training example:
 * - Input: request + phase + project context
 * - Label: what worked (agent, tools, cost, duration)
 * - Weight: pipeline outcome quality (success = 1.0, partial = 0.5, fail = 0.1)
 */
export function trajectoryToSFTExamples(
  trajectory: OrchestrationTrajectory,
): Array<{ input: string; label: string; weight: number }> {
  const examples: Array<{ input: string; label: string; weight: number }> = [];

  // Outcome weight: successful pipelines are worth more as training data
  const outcomeWeight = trajectory.outcome.success
    ? 1.0
    : trajectory.outcome.phasesCompleted /
          Math.max(trajectory.outcome.phasesTotal, 1) >
        0.5
      ? 0.5
      : 0.1;

  for (const phase of trajectory.phases) {
    if (phase.skipped) continue;

    const input = [
      `request: ${trajectory.request}`,
      `phase: ${phase.phase}`,
      `project_path: ${trajectory.projectPath}`,
      `budget_remaining: $${(trajectory.totalCost > 0 ? trajectory.totalCost : 1.0).toFixed(2)}`,
      `phases_completed: ${trajectory.phases.indexOf(phase)}`,
      `feedback_loops: ${trajectory.feedbackLoops.length}`,
    ].join("\n");

    const label = [
      `agent: ${phase.agentId}`,
      `tools: ${phase.toolCalls.join(",") || "none"}`,
      `estimated_cost: $${phase.cost.toFixed(4)}`,
      `max_steps: ${Math.ceil(phase.duration / 5000) || 5}`,
      `skip: ${phase.skipped}`,
      `success: ${phase.success}`,
    ].join("\n");

    examples.push({ input, label, weight: outcomeWeight });
  }

  return examples;
}

/**
 * Format SFT examples as JSONL for training.
 */
export function sftExamplesToJSONL(
  examples: Array<{ input: string; label: string; weight: number }>,
): string {
  return examples
    .map((ex) =>
      JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "You are BrainstormLLM, an orchestration model that predicts how to structure software development pipelines. Given a request and context, predict which agent, tools, and resource allocation to use for the current phase.",
          },
          { role: "user", content: ex.input },
          { role: "assistant", content: ex.label },
        ],
        weight: ex.weight,
      }),
    )
    .join("\n");
}
