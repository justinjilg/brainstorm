import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createFleetSignalsMiddleware,
  getFleetDashboard,
  pruneFleetState,
} from "../middleware/builtin/fleet-signals";
import type { MiddlewareToolResult } from "../middleware/types";

describe("Fleet Signals Middleware", () => {
  beforeEach(() => {
    // Clear out the fleet state before each test.
    // The easiest way to force-clear the singleton map without changing code
    // is to mock Date.now to something very old, run pruneFleetState, then restore.
    const realDateNow = Date.now.bind(global.Date);
    global.Date.now = () => realDateNow() + 60 * 60 * 1000; // +1 hour into the future
    pruneFleetState();
    global.Date.now = realDateNow;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes a new session and increments active sessions", () => {
    const middleware = createFleetSignalsMiddleware("test-session-1");
    expect(middleware.name).toBe("fleet-signals");

    const dashboard = getFleetDashboard();
    expect(dashboard.activeSessions).toBe(1);
    expect(dashboard.avgReadEditRatio).toBe(Infinity);
    expect(dashboard.totalFailures).toBe(0);
  });

  it("tracks tool successes and failures", () => {
    const middleware = createFleetSignalsMiddleware("test-session-2");

    const successResult: MiddlewareToolResult = {
      toolCallId: "1",
      name: "unknown_tool",
      ok: true,
      output: "ok",
      durationMs: 10,
    };

    const failResult: MiddlewareToolResult = {
      toolCallId: "2",
      name: "unknown_tool",
      ok: false,
      output: "error",
      durationMs: 10,
    };

    middleware.afterToolResult?.(successResult);
    middleware.afterToolResult?.(failResult);
    middleware.afterToolResult?.(failResult);

    const dashboard = getFleetDashboard();
    expect(dashboard.totalFailures).toBe(2);
  });

  it("tracks read vs write tools and calculates ratio correctly", () => {
    const middleware = createFleetSignalsMiddleware("test-session-3");

    // 4 reads
    for (let i = 0; i < 4; i++) {
      middleware.afterToolResult?.({
        toolCallId: `r${i}`,
        name: "file_read",
        ok: true,
        output: "ok",
        durationMs: 10,
      });
    }

    // 2 writes
    for (let i = 0; i < 2; i++) {
      middleware.afterToolResult?.({
        toolCallId: `w${i}`,
        name: "file_write",
        ok: true,
        output: "ok",
        durationMs: 10,
      });
    }

    const dashboard = getFleetDashboard();
    expect(dashboard.avgReadEditRatio).toBe(2.0);
    // Writes < 3, so not considered degraded yet
    expect(dashboard.degradedSessions).not.toContain("test-session-3");
  });

  it("flags degraded sessions when writes >= 3 and ratio < 3.0", () => {
    const middleware = createFleetSignalsMiddleware("test-session-4");

    // 4 reads
    for (let i = 0; i < 4; i++) {
      middleware.afterToolResult?.({
        toolCallId: `r${i}`,
        name: "file_read",
        ok: true,
        output: "ok",
        durationMs: 10,
      });
    }

    // 3 writes -> ratio is 4/3 = 1.33 < 3.0
    for (let i = 0; i < 3; i++) {
      middleware.afterToolResult?.({
        toolCallId: `w${i}`,
        name: "file_write",
        ok: true,
        output: "ok",
        durationMs: 10,
      });
    }

    const dashboard = getFleetDashboard();
    expect(dashboard.degradedSessions).toContain("test-session-4");
  });

  it("prunes stale sessions correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000)); // Start at 1 second

    const middleware = createFleetSignalsMiddleware("test-session-stale");

    middleware.afterToolResult?.({
      toolCallId: "1",
      name: "file_read",
      ok: true,
      output: "ok",
      durationMs: 10,
    });

    // Verify it's active
    expect(getFleetDashboard().activeSessions).toBe(1);

    // Advance time by 35 minutes (over the 30 minute stale threshold)
    vi.advanceTimersByTime(35 * 60 * 1000);

    pruneFleetState();
    expect(getFleetDashboard().activeSessions).toBe(0);
  });
});
