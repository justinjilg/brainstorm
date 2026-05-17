/**
 * Async task state machine for A2A invocations that don't complete
 * synchronously.
 *
 * When a target accepts an invocation but doesn't have an answer within
 * ~30s, the broker returns 202 Accepted with a status_url. This module
 * tracks the task's lifecycle so GET /v1/mesh/task/{task_id} can answer.
 *
 * In-memory implementation only for v0.1. Multi-instance production will
 * need a Redis-backed implementation; the interface is shaped to make
 * substitution easy.
 */

import type {
  A2AErrorEnvelope,
  A2AInvokeSyncResponse,
  TaskRecord,
  TaskState,
} from "./types.js";

export interface TaskStore {
  /** Record a freshly-accepted task. */
  accept(record: TaskRecord): Promise<void>;

  /** Read the current state of a task. Returns null if unknown. */
  get(taskId: string): Promise<TaskRecord | null>;

  /** Transition state. completedAt is set when state is terminal. */
  transition(
    taskId: string,
    state: TaskState,
    opts?: {
      result?: A2AInvokeSyncResponse;
      failure?: A2AErrorEnvelope;
      completedAt?: string;
    },
  ): Promise<TaskRecord | null>;

  /** Expire any tasks whose expires_at < now. Returns the count. */
  sweepExpired(now: Date): Promise<number>;
}

const DEFAULT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes per spec

/**
 * In-memory implementation. Safe under concurrent access from one process;
 * production multi-instance deployment needs Redis or similar.
 */
export class InMemoryTaskStore implements TaskStore {
  private readonly records = new Map<string, TaskRecord>();

  async accept(record: TaskRecord): Promise<void> {
    this.records.set(record.task_id, record);
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    const r = this.records.get(taskId);
    if (!r) return null;
    // Lazy expiry: if past expires_at and still non-terminal, mark expired.
    if (new Date(r.expires_at).getTime() < Date.now()) {
      if (
        r.state !== "completed" &&
        r.state !== "failed" &&
        r.state !== "expired"
      ) {
        const expired: TaskRecord = {
          ...r,
          state: "expired",
          completed_at: new Date().toISOString(),
        };
        this.records.set(taskId, expired);
        return expired;
      }
    }
    return r;
  }

  async transition(
    taskId: string,
    state: TaskState,
    opts?: {
      result?: A2AInvokeSyncResponse;
      failure?: A2AErrorEnvelope;
      completedAt?: string;
    },
  ): Promise<TaskRecord | null> {
    const r = this.records.get(taskId);
    if (!r) return null;
    if (isTerminal(r.state)) {
      // Don't overwrite a terminal state — caller racing.
      return r;
    }
    const updated: TaskRecord = {
      ...r,
      state,
      result: opts?.result ?? r.result,
      failure: opts?.failure ?? r.failure,
      completed_at:
        opts?.completedAt ??
        (isTerminal(state) ? new Date().toISOString() : r.completed_at),
    };
    this.records.set(taskId, updated);
    return updated;
  }

  async sweepExpired(now: Date): Promise<number> {
    let count = 0;
    for (const [k, r] of this.records) {
      if (
        !isTerminal(r.state) &&
        new Date(r.expires_at).getTime() < now.getTime()
      ) {
        this.records.set(k, {
          ...r,
          state: "expired",
          completed_at: now.toISOString(),
        });
        count++;
      }
    }
    return count;
  }

  /** Test helper. */
  _clear(): void {
    this.records.clear();
  }
}

function isTerminal(s: TaskState): boolean {
  return s === "completed" || s === "failed" || s === "expired";
}

/** Build an accepted TaskRecord with sensible defaults. */
export function buildAcceptedRecord(opts: {
  taskId: string;
  callerDID: string;
  targetDID: string;
  capability: string;
  traceparent: string;
  tracestate?: string;
  ttlMs?: number;
}): TaskRecord {
  const now = new Date();
  const ttl = opts.ttlMs ?? DEFAULT_EXPIRY_MS;
  return {
    task_id: opts.taskId,
    state: "accepted",
    caller_did: opts.callerDID,
    target_did: opts.targetDID,
    capability: opts.capability,
    traceparent: opts.traceparent,
    tracestate: opts.tracestate,
    accepted_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
  };
}
