/**
 * Structured Trajectory Recording — JSONL event log for every agent interaction.
 *
 * Records LLM calls, tool executions, routing decisions, compaction events,
 * and errors as structured events. Enables:
 *   - Post-hoc debugging
 *   - SWE-bench evaluation
 *   - BrainstormRouter intelligence feedback
 *   - Cost analysis per task type
 *
 * Writes to ~/.brainstorm/trajectories/<session-id>.jsonl
 *
 * Inspired by Trae Agent's trajectory recording system, enhanced with
 * BrainstormRouter routing metadata that no other tool captures.
 */

import { mkdirSync, appendFile, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type TrajectoryEventType =
  | "session-start"
  | "llm-call"
  | "tool-call"
  | "tool-result"
  | "routing-decision"
  | "turn-summary"
  | "compaction"
  | "trajectory-reduction"
  | "error"
  | "session-end";

export interface TrajectoryEvent {
  type: TrajectoryEventType;
  timestamp: string;
  sessionId: string;
  turn: number;
  data: Record<string, unknown>;
}

export interface LLMCallData {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cost: number;
  strategy: string;
}

export interface ToolCallData {
  name: string;
  input: Record<string, unknown>;
  durationMs: number;
}

export interface ToolResultData {
  name: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface RoutingDecisionData {
  candidates: Array<{ model: string; score: number }>;
  winner: string;
  strategy: string;
  reasoning: string;
  taskType: string;
  complexity: string;
}

/**
 * Records agent trajectory events to JSONL files.
 */
export class TrajectoryRecorder {
  private filePath: string;
  private sessionId: string;
  private turn = 0;
  private enabled: boolean;

  constructor(sessionId: string, enabled = true) {
    this.sessionId = sessionId;
    this.enabled = enabled;

    const dir = join(homedir(), ".brainstorm", "trajectories");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.filePath = join(dir, `${sessionId}.jsonl`);
  }

  /** Set the current turn number. */
  setTurn(turn: number): void {
    this.turn = turn;
  }

  /** Record a session start event. */
  recordSessionStart(metadata: Record<string, unknown>): void {
    this.record("session-start", metadata);
  }

  /** Record an LLM call. */
  recordLLMCall(data: LLMCallData): void {
    this.record("llm-call", data as unknown as Record<string, unknown>);
  }

  /** Record a tool call (before execution). */
  recordToolCall(data: ToolCallData): void {
    this.record("tool-call", data as unknown as Record<string, unknown>);
  }

  /** Record a tool result (after execution). */
  recordToolResult(data: ToolResultData): void {
    this.record("tool-result", data as unknown as Record<string, unknown>);
  }

  /** Record a routing decision. */
  recordRoutingDecision(data: RoutingDecisionData): void {
    this.record("routing-decision", data as unknown as Record<string, unknown>);
  }

  /** Record a turn summary (TurnContext snapshot). */
  recordTurnSummary(data: Record<string, unknown>): void {
    this.record("turn-summary", data);
  }

  /** Record a compaction event. */
  recordCompaction(data: {
    messagesBefore: number;
    messagesAfter: number;
    tokensSaved: number;
  }): void {
    this.record("compaction", data as unknown as Record<string, unknown>);
  }

  /** Record a trajectory reduction event. */
  recordReduction(data: {
    removedCount: number;
    tokensSaved: number;
    reasons: Record<string, number>;
  }): void {
    this.record(
      "trajectory-reduction",
      data as unknown as Record<string, unknown>,
    );
  }

  /** Record an error. */
  recordError(data: {
    message: string;
    recoveryAction?: string;
    model?: string;
  }): void {
    this.record("error", data as unknown as Record<string, unknown>);
  }

  /** Record session end. */
  recordSessionEnd(data: {
    totalCost: number;
    totalTurns: number;
    durationMs: number;
  }): void {
    this.record("session-end", data as unknown as Record<string, unknown>);
  }

  /** Get the trajectory file path. */
  getFilePath(): string {
    return this.filePath;
  }

  private record(
    type: TrajectoryEventType,
    data: Record<string, unknown>,
  ): void {
    if (!this.enabled) return;

    const event: TrajectoryEvent = {
      type,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      turn: this.turn,
      data,
    };

    // Async write — trajectory recording is best-effort, never blocks the agent loop
    appendFile(this.filePath, JSON.stringify(event) + "\n", () => {
      // Fire-and-forget — errors are silently ignored
    });
  }
}
