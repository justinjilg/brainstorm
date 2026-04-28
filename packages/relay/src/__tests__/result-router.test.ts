import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ResultRouter } from "../result-router.js";
import { AuditLog } from "../audit.js";
import { SessionStore, type TransportHandle } from "../session-store.js";
import { LifecycleManager } from "../lifecycle.js";
import type {
  CommandAck,
  CommandResult,
  ProgressEventEndpointSide,
  ErrorEventEndpointToRelay,
  CompletedCommandResult,
  FailedCommandResult,
} from "../types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs.length = 0;
});

function fakeTransport(): TransportHandle {
  let alive = true;
  return {
    async send() {},
    async close() {
      alive = false;
    },
    isAlive() {
      return alive;
    },
  };
}

function freshTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Fixture {
  router: ResultRouter;
  audit: AuditLog;
  sessions: SessionStore;
  lifecycle: LifecycleManager;
}

function setup(): Fixture {
  const dir = freshTempDir("result-router-test-");
  const audit = new AuditLog(join(dir, "audit.db"));
  const sessions = new SessionStore();
  const lifecycle = new LifecycleManager();
  const router = new ResultRouter({ audit, sessions, lifecycle });
  return { router, audit, sessions, lifecycle };
}

function registerEndpoint(
  sessions: SessionStore,
  opts: {
    session_id: string;
    endpoint_id: string;
  },
) {
  sessions.registerEndpoint({
    session_id: opts.session_id,
    endpoint_id: opts.endpoint_id,
    tenant_id: "tenant-1",
    opened_at: new Date().toISOString(),
    transport: fakeTransport(),
    inflight_command_ids: new Set(),
  });
}

function registerInflight(
  router: ResultRouter,
  command_id: string,
  opts?: {
    endpoint_session_id?: string;
  },
) {
  router.registerInflight({
    command_id,
    request_id: "req-1",
    operator_session_id: "op-1",
    endpoint_id: "ep-1",
    endpoint_session_id: opts?.endpoint_session_id ?? "s-1",
    dispatch_request: { tool: "echo" },
    correlation_id: "corr-1",
    started_at: "2026-04-27T12:00:00.000Z",
    payload_size_in: 17,
  });
}

describe("ResultRouter — registerInflight validation", () => {
  it("throws when BR outcome metadata is missing", () => {
    const f = setup();
    expect(() =>
      f.router.registerInflight({
        command_id: "cmd-1",
        request_id: "req-1",
        operator_session_id: "op-1",
        endpoint_id: "ep-1",
        endpoint_session_id: "s-1",
        dispatch_request: { tool: "echo" },
        correlation_id: "",
        started_at: "2026-04-27T12:00:00.000Z",
        payload_size_in: 1,
      }),
    ).toThrow(/valid correlation_id is required/);
  });
});

describe("ResultRouter — CommandAck", () => {
  it("forwards ACK as ProgressEvent { lifecycle_state: 'started' }", () => {
    const f = setup();
    registerEndpoint(f.sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    f.lifecycle.reserve("cmd-1");
    f.lifecycle.transition("cmd-1", { kind: "dispatch_sent" });
    registerInflight(f.router, "cmd-1");

    const ack: CommandAck = {
      type: "CommandAck",
      command_id: "cmd-1",
      endpoint_id: "ep-1",
      session_id: "s-1",
      track: "data_provider",
      will_emit_progress: false,
      ts: new Date().toISOString(),
    };
    const r = f.router.handleCommandAck(ack);
    expect(r.kind).toBe("operator_event");
    if (r.kind === "operator_event") {
      expect(r.frame.type).toBe("ProgressEvent");
      expect(r.frame.lifecycle_state).toBe("started");
      expect(r.frame.request_id).toBe("req-1");
      expect(r.target_operator_session_id).toBe("op-1");
    }
    expect(f.lifecycle.getState("cmd-1")).toBe("started");
  });

  it("rejects ACK from stale session", () => {
    const f = setup();
    registerEndpoint(f.sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    f.lifecycle.reserve("cmd-1");
    f.lifecycle.transition("cmd-1", { kind: "dispatch_sent" });
    registerInflight(f.router, "cmd-1", { endpoint_session_id: "s-1" });

    // Replace session — s-1 is now stale
    registerEndpoint(f.sessions, { session_id: "s-2", endpoint_id: "ep-1" });

    const ack: CommandAck = {
      type: "CommandAck",
      command_id: "cmd-1",
      endpoint_id: "ep-1",
      session_id: "s-1", // stale
      track: "data_provider",
      will_emit_progress: false,
      ts: new Date().toISOString(),
    };
    const r = f.router.handleCommandAck(ack);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.error.code).toBe("ENDPOINT_SESSION_STALE");
    }
  });

  it("rejects ACK from wrong endpoint", () => {
    const f = setup();
    registerEndpoint(f.sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    registerEndpoint(f.sessions, { session_id: "s-2", endpoint_id: "ep-2" });
    f.lifecycle.reserve("cmd-1");
    f.lifecycle.transition("cmd-1", { kind: "dispatch_sent" });
    registerInflight(f.router, "cmd-1"); // inflight ep-1
    const ack: CommandAck = {
      type: "CommandAck",
      command_id: "cmd-1",
      endpoint_id: "ep-2", // mismatch
      session_id: "s-2",
      track: "data_provider",
      will_emit_progress: false,
      ts: new Date().toISOString(),
    };
    const r = f.router.handleCommandAck(ack);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.error.code).toBe("RELAY_ENDPOINT_MISMATCH");
    }
  });

  it("returns no_inflight for unknown command_id", () => {
    const f = setup();
    registerEndpoint(f.sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    const ack: CommandAck = {
      type: "CommandAck",
      command_id: "cmd-unknown",
      endpoint_id: "ep-1",
      session_id: "s-1",
      track: "data_provider",
      will_emit_progress: false,
      ts: new Date().toISOString(),
    };
    const r = f.router.handleCommandAck(ack);
    expect(r.kind).toBe("no_inflight");
  });
});

describe("ResultRouter — CommandResult terminal", () => {
  function buildCompleted(): CompletedCommandResult {
    return {
      type: "CommandResult",
      command_id: "cmd-1",
      endpoint_id: "ep-1",
      session_id: "s-1",
      lifecycle_state: "completed",
      payload: { stdout: "hello", stderr: "", exit_code: 0 },
      evidence_hash: "sha256:" + "a".repeat(64),
      sandbox_reset_state: {
        reset_at: new Date().toISOString(),
        golden_hash: "sha256:" + "b".repeat(64),
        verification_passed: true,
        verification_details: {
          fs_hash: "sha256:" + "c".repeat(64),
          fs_hash_baseline: "sha256:" + "c".repeat(64),
          fs_hash_match: true,
          open_fd_count: 3,
          open_fd_count_baseline: 3,
          vmm_api_state: "running",
          expected_vmm_api_state: "running",
          divergence_action: "none",
        },
      },
      ts: new Date().toISOString(),
    };
  }

  function buildFailed(): FailedCommandResult {
    return {
      type: "CommandResult",
      command_id: "cmd-1",
      endpoint_id: "ep-1",
      session_id: "s-1",
      lifecycle_state: "failed",
      error: { code: "SANDBOX_TOOL_ERROR", message: "tool exited 1" },
      evidence_hash: "sha256:" + "a".repeat(64),
      ts: new Date().toISOString(),
    };
  }

  it("forwards completed result as ResultEvent and removes from in-flight", () => {
    const f = setup();
    registerEndpoint(f.sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    f.lifecycle.reserve("cmd-1");
    f.lifecycle.transition("cmd-1", { kind: "dispatch_sent" });
    f.lifecycle.transition("cmd-1", { kind: "ack_received" });
    registerInflight(f.router, "cmd-1");

    expect(f.router.inflightCount()).toBe(1);
    const r = f.router.handleCommandResult(buildCompleted());
    expect(r.kind).toBe("operator_event");
    if (r.kind === "operator_event") {
      expect(r.frame.type).toBe("ResultEvent");
      expect(r.frame.lifecycle_state).toBe("completed");
      expect(r.frame.payload).toEqual({
        stdout: "hello",
        stderr: "",
        exit_code: 0,
      });
    }
    expect(f.router.inflightCount()).toBe(0);
    expect(f.lifecycle.isTerminal("cmd-1")).toBe(true);
  });

  it("forwards failed result with error", () => {
    const f = setup();
    registerEndpoint(f.sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    f.lifecycle.reserve("cmd-1");
    f.lifecycle.transition("cmd-1", { kind: "dispatch_sent" });
    f.lifecycle.transition("cmd-1", { kind: "ack_received" });
    registerInflight(f.router, "cmd-1");

    const r = f.router.handleCommandResult(buildFailed());
    expect(r.kind).toBe("operator_event");
    if (r.kind === "operator_event") {
      expect(r.frame.lifecycle_state).toBe("failed");
      expect(r.frame.error?.code).toBe("SANDBOX_TOOL_ERROR");
    }
  });

  it("late_arrival result after timed_out is ack_only and recorded as audit", () => {
    const f = setup();
    registerEndpoint(f.sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    f.lifecycle.reserve("cmd-1");
    f.lifecycle.transition("cmd-1", { kind: "dispatch_sent" });
    f.lifecycle.transition("cmd-1", { kind: "deadline_exceeded" });
    registerInflight(f.router, "cmd-1");
    expect(f.lifecycle.getState("cmd-1")).toBe("timed_out");
    const r = f.router.handleCommandResult(buildCompleted());
    expect(r.kind).toBe("ack_only");
    // audit log should have the late_arrival entry
    const entries = f.audit.getByCommandId("cmd-1");
    const late = entries.find(
      (e) =>
        e.message_type === "CommandResult" &&
        e.metadata_sidecar &&
        (e.metadata_sidecar as any).late_arrival === true,
    );
    expect(late).toBeDefined();
  });
});

describe("ResultRouter — ACK timeout", () => {
  it("emits ENDPOINT_NO_ACK error to operator", () => {
    const f = setup();
    registerEndpoint(f.sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    f.lifecycle.reserve("cmd-1");
    f.lifecycle.transition("cmd-1", { kind: "dispatch_sent" });
    registerInflight(f.router, "cmd-1");

    const r = f.router.handleAckTimeout("cmd-1");
    expect(r.kind).toBe("operator_event");
    if (r.kind === "operator_event") {
      expect(r.frame.code).toBe("ENDPOINT_NO_ACK");
    }
    expect(f.lifecycle.getState("cmd-1")).toBe("timed_out");
    expect(f.router.inflightCount()).toBe(0);
  });

  it("ack timeout for unknown command_id is no_inflight", () => {
    const f = setup();
    const r = f.router.handleAckTimeout("cmd-nonexistent");
    expect(r.kind).toBe("no_inflight");
  });
});

describe("ResultRouter — endpoint ErrorEvent", () => {
  it("forwards SIGNATURE_INVALID error and transitions to failed", () => {
    const f = setup();
    registerEndpoint(f.sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    f.lifecycle.reserve("cmd-1");
    f.lifecycle.transition("cmd-1", { kind: "dispatch_sent" });
    registerInflight(f.router, "cmd-1");

    const err: ErrorEventEndpointToRelay = {
      type: "ErrorEvent",
      command_id: "cmd-1",
      endpoint_id: "ep-1",
      session_id: "s-1",
      code: "ENDPOINT_SIGNATURE_INVALID",
      message: "envelope signature failed verification",
      ts: new Date().toISOString(),
    };
    const r = f.router.handleEndpointError(err);
    expect(r.kind).toBe("operator_event");
    if (r.kind === "operator_event") {
      expect(r.frame.code).toBe("ENDPOINT_SIGNATURE_INVALID");
    }
    expect(f.lifecycle.getState("cmd-1")).toBe("failed");
    expect(f.router.inflightCount()).toBe(0);
  });
});

describe("ResultRouter — ProgressEvent", () => {
  it("forwards progress event with started→progress lifecycle change on first fraction", () => {
    const f = setup();
    registerEndpoint(f.sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    f.lifecycle.reserve("cmd-1");
    f.lifecycle.transition("cmd-1", { kind: "dispatch_sent" });
    f.lifecycle.transition("cmd-1", { kind: "ack_received" });
    registerInflight(f.router, "cmd-1");

    const evt: ProgressEventEndpointSide = {
      type: "ProgressEvent",
      command_id: "cmd-1",
      endpoint_id: "ep-1",
      session_id: "s-1",
      lifecycle_state: "progress",
      seq: 1,
      progress: { fraction: 0.5, message: "half done" },
      ts: new Date().toISOString(),
    };
    const r = f.router.handleProgressEvent(evt);
    expect(r.kind).toBe("operator_event");
    if (r.kind === "operator_event") {
      expect(r.frame.progress?.fraction).toBe(0.5);
    }
    expect(f.lifecycle.getState("cmd-1")).toBe("progress");
  });
});
