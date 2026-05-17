/**
 * BrainstormRouter mesh-auth Phase 2 — the broker for A2A Protocol v0.1.
 *
 * Implements POST /v1/mesh/invoke/{target_did}:
 *   1. Parse + validate request body, headers (Authorization, traceparent,
 *      Idempotency-Key).
 *   2. Verify the per-agent JWT.
 *   3. Check the distributed replay store; reject duplicates with 409.
 *   4. Resolve the capability against the Agent Capability Registry; reject
 *      unknown/inactive with 404.
 *   5. Enforce tenant isolation (caller.tenant_id == target tenant).
 *   6. Dispatch to the target. The dispatcher contract is pluggable so the
 *      broker can route to brainstormVM CP, brainstormMSP cloud, or any
 *      future host without taking a dep on a specific HTTP client here.
 *
 * Synchronous targets return a sync result; long-running targets cause a
 * 202 Accepted with a status_url. The companion task store tracks async
 * state until completion or expiry.
 */

import { randomUUID } from "node:crypto";
import type {
  A2AErrorCode,
  A2AErrorEnvelope,
  A2AInvokeAsyncResponse,
  A2AInvokeRequest,
  A2AInvokeSyncResponse,
  AgentJWTClaims,
  TraceContext,
} from "./types.js";
import type { SeenStore } from "./replay-store.js";
import type { TaskStore } from "./task-store.js";
import { buildAcceptedRecord } from "./task-store.js";
import {
  formatTraceparent,
  nextSpan,
  parseTraceparent,
} from "./trace-context.js";

/** Outcome the dispatcher returns when it accepts and forwards a request. */
export type DispatchOutcome =
  | {
      kind: "sync";
      output: unknown;
      evidence_envelope_hash: string;
      completed_at: string;
    }
  | { kind: "async" }
  | { kind: "error"; status: number; envelope: A2AErrorEnvelope };

/**
 * Resolve a capability on a target. Returns null when the capability is
 * not registered (or removed); returns the active record otherwise.
 *
 * Implementations call the Agent Capability Registry — either via direct
 * package import (when the broker shares process with the registry) or via
 * HTTP (when the registry runs in a separate service).
 */
export interface CapabilityResolver {
  resolve(
    targetDID: string,
    capability: string,
  ): Promise<{
    status: "active" | "deprecated" | "removed";
    tenantId: string;
  } | null>;
}

/**
 * Dispatch the invocation to the target. The dispatcher is the only place
 * that knows how to actually reach a particular agent (HTTP push, queue
 * enqueue, WS frame, etc.).
 */
export interface Dispatcher {
  dispatch(input: {
    targetDID: string;
    capability: string;
    request: A2AInvokeRequest;
    callerDID: string;
    traceparent: string;
    tracestate?: string;
  }): Promise<DispatchOutcome>;
}

/**
 * Verify a per-agent JWT and return the claims. Implementations consult the
 * BR signing-key store (rotated independently of agent enrollment).
 */
export interface JWTVerifier {
  verify(token: string): Promise<AgentJWTClaims | null>;
}

/** Configuration carried by the broker. */
export interface MeshBrokerConfig {
  seenStore: SeenStore;
  taskStore: TaskStore;
  resolver: CapabilityResolver;
  dispatcher: Dispatcher;
  jwt: JWTVerifier;
  /** URL prefix the broker uses to construct status_url responses. */
  statusUrlPrefix: string;
}

/** Inputs to the broker — abstracted away from any specific HTTP framework. */
export interface MeshInvokeInput {
  targetDID: string;
  authorizationHeader: string | null;
  traceparentHeader: string | null;
  tracestateHeader: string | null;
  idempotencyKeyHeader: string | null;
  body: unknown;
}

/** Outcome the broker hands back to whatever HTTP layer is in front. */
export type MeshInvokeOutcome =
  | { status: 200; body: A2AInvokeSyncResponse }
  | { status: 202; body: A2AInvokeAsyncResponse }
  | { status: number; body: A2AErrorEnvelope };

/**
 * The broker. Stateless aside from injected stores; safe under concurrent
 * invocation from one process.
 */
export class MeshBroker {
  constructor(private readonly cfg: MeshBrokerConfig) {}

  async invoke(input: MeshInvokeInput): Promise<MeshInvokeOutcome> {
    // --- Step 1: parse + structural validation ---
    const trace = parseTraceparent(input.traceparentHeader);
    if (!trace) {
      return err(400, "VALIDATION", "missing or malformed traceparent");
    }
    if (!input.idempotencyKeyHeader) {
      return err(400, "VALIDATION", "Idempotency-Key header is required");
    }
    if (
      !input.authorizationHeader ||
      !input.authorizationHeader.startsWith("Bearer ")
    ) {
      return err(
        401,
        "UNAUTHORIZED",
        "missing or malformed Authorization header",
      );
    }
    const token = input.authorizationHeader.slice("Bearer ".length).trim();

    const reqBody = input.body as A2AInvokeRequest | null;
    const bodyErr = validateBody(reqBody);
    if (bodyErr) {
      return err(400, "VALIDATION", bodyErr);
    }

    // --- Step 2: verify the JWT ---
    const claims = await this.cfg.jwt.verify(token);
    if (!claims) {
      return err(401, "UNAUTHORIZED", "JWT verification failed");
    }
    const callerDID = claims.sub;
    if (!callerDID) {
      return err(401, "UNAUTHORIZED", "JWT missing sub (caller DID)");
    }

    // The caller's JWT capabilities[] is the list of capabilities the agent
    // is AUTHORIZED to invoke on peers. Reject early if the requested
    // capability isn't in that list.
    if (!claims.capabilities.includes(reqBody!.capability)) {
      return err(
        403,
        "FORBIDDEN",
        `caller JWT does not include capability ${reqBody!.capability}`,
      );
    }

    // --- Step 3: distributed replay protection ---
    const seen = await this.cfg.seenStore.seeOrFetch(
      input.idempotencyKeyHeader,
      reqBody!.task_id,
    );
    if (!seen.firstTime) {
      return {
        status: 409,
        body: {
          success: false,
          error: {
            code: "CONFLICT",
            message: "duplicate Idempotency-Key",
          },
          task_id: seen.existingTaskId,
        },
      };
    }

    // --- Step 4: resolve capability on target ---
    const cap = await this.cfg.resolver.resolve(
      input.targetDID,
      reqBody!.capability,
    );
    if (!cap) {
      return err(
        404,
        "NOT_FOUND",
        `capability ${reqBody!.capability} not registered for ${input.targetDID}`,
      );
    }
    if (cap.status !== "active") {
      return err(
        404,
        "NOT_FOUND",
        `capability ${reqBody!.capability} is ${cap.status} on ${input.targetDID}`,
      );
    }

    // --- Step 5: tenant isolation ---
    if (claims.tenant_id !== cap.tenantId) {
      return err(
        403,
        "FORBIDDEN",
        `caller tenant ${claims.tenant_id} != target tenant ${cap.tenantId}`,
      );
    }

    // --- Step 6: dispatch ---
    // Build the downstream traceparent: same trace_id, fresh span_id.
    const downstreamTrace: TraceContext = nextSpan(trace);
    const downstreamTraceparent = formatTraceparent(downstreamTrace);

    const outcome = await this.cfg.dispatcher.dispatch({
      targetDID: input.targetDID,
      capability: reqBody!.capability,
      request: reqBody!,
      callerDID,
      traceparent: downstreamTraceparent,
      tracestate: input.tracestateHeader ?? undefined,
    });

    if (outcome.kind === "error") {
      return { status: outcome.status, body: outcome.envelope };
    }

    if (outcome.kind === "sync") {
      const response: A2AInvokeSyncResponse = {
        task_id: reqBody!.task_id,
        output: outcome.output,
        evidence_envelope_hash: outcome.evidence_envelope_hash,
        completed_at: outcome.completed_at,
        traceparent: downstreamTraceparent,
      };
      return { status: 200, body: response };
    }

    // Async path: record task in store and return 202 + status_url.
    const record = buildAcceptedRecord({
      taskId: reqBody!.task_id,
      callerDID,
      targetDID: input.targetDID,
      capability: reqBody!.capability,
      traceparent: downstreamTraceparent,
      tracestate: input.tracestateHeader ?? undefined,
    });
    await this.cfg.taskStore.accept(record);

    const response: A2AInvokeAsyncResponse = {
      task_id: reqBody!.task_id,
      status_url: `${this.cfg.statusUrlPrefix.replace(/\/$/, "")}/${encodeURIComponent(
        reqBody!.task_id,
      )}`,
      traceparent: downstreamTraceparent,
    };
    return { status: 202, body: response };
  }

  /** GET /v1/mesh/task/{task_id} — read current state of an async task. */
  async getTask(taskId: string): Promise<MeshInvokeOutcome> {
    const r = await this.cfg.taskStore.get(taskId);
    if (!r) {
      return err(404, "NOT_FOUND", `unknown task_id ${taskId}`);
    }
    if (r.state === "expired") {
      return err(410, "GONE", `task ${taskId} expired without completion`);
    }
    if (r.state === "completed" && r.result) {
      return { status: 200, body: r.result };
    }
    if (r.state === "failed" && r.failure) {
      return { status: 500, body: r.failure };
    }
    // Still accepted/running — return 202 with the same status_url shape
    // so pollers see a consistent payload.
    return {
      status: 202,
      body: {
        task_id: r.task_id,
        status_url: `/v1/mesh/task/${encodeURIComponent(r.task_id)}`,
        traceparent: r.traceparent,
      },
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function err(
  status: number,
  code: A2AErrorCode,
  message: string,
  _detail?: string,
): MeshInvokeOutcome {
  return {
    status,
    body: {
      success: false,
      error: { code, message },
    },
  };
}

function validateBody(body: A2AInvokeRequest | null): string | null {
  if (!body || typeof body !== "object") return "request body is required";
  if (typeof body.task_id !== "string" || body.task_id.length === 0) {
    return "task_id is required";
  }
  if (typeof body.capability !== "string" || body.capability.length === 0) {
    return "capability is required";
  }
  if (!body.capability.startsWith("agent.")) {
    return `capability must be in the agent.* namespace (got ${body.capability})`;
  }
  if (body.input === undefined) {
    return "input is required (use {} for no-arg capabilities)";
  }
  return null;
}

/** Convenience helper to record a sync completion against the task store —
 *  the dispatcher calls this when its async path resolves. */
export async function completeTask(
  store: TaskStore,
  taskId: string,
  result: A2AInvokeSyncResponse,
): Promise<void> {
  await store.transition(taskId, "completed", {
    result,
    completedAt: new Date().toISOString(),
  });
}

/** Record a failure against the task store. */
export async function failTask(
  store: TaskStore,
  taskId: string,
  failure: A2AErrorEnvelope,
): Promise<void> {
  await store.transition(taskId, "failed", {
    failure,
    completedAt: new Date().toISOString(),
  });
}
