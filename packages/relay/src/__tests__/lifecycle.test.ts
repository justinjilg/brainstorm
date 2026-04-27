import { describe, it, expect } from "vitest";
import { LifecycleManager, nextState } from "../lifecycle.js";

describe("nextState (pure transitions)", () => {
  it("pending → dispatched on dispatch_sent", () => {
    expect(nextState("pending", { kind: "dispatch_sent" })).toBe("dispatched");
  });

  it("pending only accepts dispatch_sent", () => {
    expect(nextState("pending", { kind: "ack_received" })).toBeNull();
    expect(nextState("pending", { kind: "result_completed" })).toBeNull();
  });

  it("dispatched → started on ack_received (v3 explicit ACK)", () => {
    expect(nextState("dispatched", { kind: "ack_received" })).toBe("started");
  });

  it("dispatched → failed on endpoint_error (reject-before-start, v2 F3 fix)", () => {
    expect(nextState("dispatched", { kind: "endpoint_error" })).toBe("failed");
  });

  it("dispatched → failed on endpoint_disconnected_before_ack (V3-ACK-01 fix)", () => {
    expect(
      nextState("dispatched", { kind: "endpoint_disconnected_before_ack" }),
    ).toBe("failed");
  });

  it("dispatched → timed_out on ack_timeout", () => {
    expect(nextState("dispatched", { kind: "ack_timeout" })).toBe("timed_out");
  });

  it("dispatched → timed_out on deadline_exceeded", () => {
    expect(nextState("dispatched", { kind: "deadline_exceeded" })).toBe(
      "timed_out",
    );
  });

  it("started → progress only when ProgressEvent has fraction", () => {
    expect(
      nextState("started", { kind: "progress_received", has_fraction: true }),
    ).toBe("progress");
    expect(
      nextState("started", { kind: "progress_received", has_fraction: false }),
    ).toBeNull();
  });

  it("started → completed on result_completed", () => {
    expect(nextState("started", { kind: "result_completed" })).toBe(
      "completed",
    );
  });

  it("started → failed on result_failed", () => {
    expect(nextState("started", { kind: "result_failed" })).toBe("failed");
  });

  it("progress → completed/failed/timed_out are valid", () => {
    expect(nextState("progress", { kind: "result_completed" })).toBe(
      "completed",
    );
    expect(nextState("progress", { kind: "result_failed" })).toBe("failed");
    expect(nextState("progress", { kind: "deadline_exceeded" })).toBe(
      "timed_out",
    );
  });

  it("terminal states reject all inputs (caller treats as late_arrival)", () => {
    for (const term of ["completed", "failed", "timed_out"] as const) {
      expect(nextState(term, { kind: "result_completed" })).toBeNull();
      expect(nextState(term, { kind: "ack_received" })).toBeNull();
      expect(nextState(term, { kind: "deadline_exceeded" })).toBeNull();
    }
  });
});

describe("LifecycleManager", () => {
  it("reserve creates pending state", () => {
    const m = new LifecycleManager();
    const r = m.reserve("cmd-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.to).toBe("pending");
    expect(m.getState("cmd-1")).toBe("pending");
    expect(m.count()).toBe(1);
  });

  it("reserve fails for duplicate command_id", () => {
    const m = new LifecycleManager();
    m.reserve("cmd-1");
    const r = m.reserve("cmd-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_transition");
  });

  it("transition for unknown command_id is unknown_command", () => {
    const m = new LifecycleManager();
    const r = m.transition("cmd-unknown", { kind: "ack_received" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown_command");
  });

  it("happy path: pending → dispatched → started → progress → completed", () => {
    const m = new LifecycleManager();
    m.reserve("cmd-1");
    expect(m.transition("cmd-1", { kind: "dispatch_sent" }).ok).toBe(true);
    expect(m.transition("cmd-1", { kind: "ack_received" }).ok).toBe(true);
    expect(
      m.transition("cmd-1", { kind: "progress_received", has_fraction: true })
        .ok,
    ).toBe(true);
    expect(m.transition("cmd-1", { kind: "result_completed" }).ok).toBe(true);
    expect(m.getState("cmd-1")).toBe("completed");
    expect(m.isTerminal("cmd-1")).toBe(true);
  });

  it("late arrival: input after terminal state recorded as late_arrival", () => {
    const m = new LifecycleManager();
    m.reserve("cmd-1");
    m.transition("cmd-1", { kind: "dispatch_sent" });
    m.transition("cmd-1", { kind: "deadline_exceeded" });
    expect(m.getState("cmd-1")).toBe("timed_out");
    // Late ACK arrives after timeout
    const r = m.transition("cmd-1", { kind: "ack_received" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("late_arrival");
    // State did NOT change
    expect(m.getState("cmd-1")).toBe("timed_out");
  });

  it("invalid transition (skipping ACK) is invalid_transition", () => {
    const m = new LifecycleManager();
    m.reserve("cmd-1");
    m.transition("cmd-1", { kind: "dispatch_sent" });
    // Skip ACK, try to go straight to result
    const r = m.transition("cmd-1", { kind: "result_completed" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_transition");
  });

  it("history records each transition", () => {
    const m = new LifecycleManager();
    m.reserve("cmd-1");
    m.transition("cmd-1", { kind: "dispatch_sent" });
    m.transition("cmd-1", { kind: "ack_received" });
    const h = m.getHistory("cmd-1")!;
    expect(h.length).toBe(3);
    expect(h.map((e) => e.to)).toEqual(["pending", "dispatched", "started"]);
  });

  it("forget removes the in-memory record", () => {
    const m = new LifecycleManager();
    m.reserve("cmd-1");
    m.forget("cmd-1");
    expect(m.getState("cmd-1")).toBeUndefined();
    // Subsequent transition is unknown_command
    const r = m.transition("cmd-1", { kind: "dispatch_sent" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown_command");
  });

  it("v3 ACK timeout from dispatched produces ENDPOINT_NO_ACK timed_out terminal", () => {
    const m = new LifecycleManager();
    m.reserve("cmd-1");
    m.transition("cmd-1", { kind: "dispatch_sent" });
    expect(m.transition("cmd-1", { kind: "ack_timeout" }).ok).toBe(true);
    expect(m.getState("cmd-1")).toBe("timed_out");
  });
});
