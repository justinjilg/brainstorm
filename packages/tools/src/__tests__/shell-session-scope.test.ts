import { describe, it, expect } from "vitest";
import {
  shellTool,
  setBackgroundEventHandler,
  requeueBackgroundEvents,
  type BackgroundEvent,
} from "../builtin/shell.js";
import { withSession } from "../session-context.js";

const bgEvent = (over: Partial<BackgroundEvent> = {}): BackgroundEvent => ({
  taskId: "t1",
  command: "echo hi",
  exitCode: 0,
  stdout: "hi\n",
  stderr: "",
  ...over,
});

/**
 * Background completion events must route to the SESSION that spawned the job —
 * not "whatever handler is current" — because a background job outlives its
 * turn and another session may be active when it finishes.
 */
describe("shell background events — concurrent session isolation", () => {
  it("routes a job's completion only to its originating session's handler", async () => {
    const aEvents: string[] = [];
    const bEvents: string[] = [];
    setBackgroundEventHandler((e) => aEvents.push(e.command), "sh-A");
    setBackgroundEventHandler((e) => bEvents.push(e.command), "sh-B");

    // Session A spawns a quick background job.
    await withSession("sh-A", () =>
      shellTool.execute({
        command: "echo hello-A",
        background: true,
      } as any),
    );

    // Wait for the background 'close' to fire and route the event.
    await new Promise((r) => setTimeout(r, 400));

    // A's handler saw its job; B's did NOT (no cross-wiring).
    expect(aEvents).toContain("echo hello-A");
    expect(bEvents).toHaveLength(0);

    setBackgroundEventHandler(null, "sh-A");
    setBackgroundEventHandler(null, "sh-B");
  });

  it("queues a job's event for its session when no handler is registered yet", async () => {
    // No handler for sh-C at spawn time → event queues for sh-C.
    await withSession("sh-C", () =>
      shellTool.execute({
        command: "echo hello-C",
        background: true,
      } as any),
    );
    await new Promise((r) => setTimeout(r, 400));

    // Registering sh-C's handler now replays its queued event; sh-D sees nothing.
    const cEvents: string[] = [];
    const dEvents: string[] = [];
    setBackgroundEventHandler((e) => dEvents.push(e.command), "sh-D");
    setBackgroundEventHandler((e) => cEvents.push(e.command), "sh-C");

    expect(cEvents).toContain("echo hello-C");
    expect(dEvents).toHaveLength(0);

    setBackgroundEventHandler(null, "sh-C");
    setBackgroundEventHandler(null, "sh-D");
  });
});

/**
 * The turn-tail delivery gap (iter-009 / backlog 005.6 #5): a background job
 * that completes AFTER the loop's last queue drain but BEFORE its `finally`
 * nulls the handler is delivered to the still-registered handler and lands in
 * the loop's per-turn buffer, which dies with the generator — lost (not shown
 * this turn, not replayed next turn, because emitCompletion never routed it to
 * the pending queue). The loop now hands those leftovers to
 * requeueBackgroundEvents at teardown so the next turn replays them. These
 * tests exercise that mechanism deterministically.
 */
describe("shell background events — turn-tail requeue (mailbox)", () => {
  it("requeued events replay to the NEXT handler registered for the session", () => {
    // Simulates the loop teardown order exactly: null the handler (which clears
    // the session's pending queue), THEN requeue the leftovers.
    setBackgroundEventHandler(null, "mb-A"); // turn 1 finally
    requeueBackgroundEvents(
      [bgEvent({ command: "job-A", taskId: "a1" })],
      "mb-A",
    );

    // Turn 2 registers a handler → the requeued event replays.
    const replayed: string[] = [];
    setBackgroundEventHandler((e) => replayed.push(e.command), "mb-A");
    expect(replayed).toEqual(["job-A"]);

    setBackgroundEventHandler(null, "mb-A");
  });

  it("does NOT lose a completion delivered in the turn tail (full loss→fix sequence)", () => {
    // Turn 1: handler registered; a completion is delivered to it in the tail
    // (the handler pushes into the loop's per-turn buffer `q`, NOT the pending
    // queue — mirroring emitCompletion's handler-present path).
    const q: BackgroundEvent[] = [];
    setBackgroundEventHandler((e) => q.push(e), "mb-B");
    const tailEvent = bgEvent({ command: "tail-job", taskId: "b1" });
    // (loop's background handler receiving a late completion:)
    q.push(tailEvent);

    // Turn 1 finally: null handler, then hand the undrained buffer off.
    setBackgroundEventHandler(null, "mb-B");
    requeueBackgroundEvents(q, "mb-B");

    // Turn 2: the tail completion is NOT lost — it replays.
    const seen: string[] = [];
    setBackgroundEventHandler((e) => seen.push(e.command), "mb-B");
    expect(seen).toEqual(["tail-job"]);

    setBackgroundEventHandler(null, "mb-B");
  });

  it("keeps requeued events isolated per session", () => {
    setBackgroundEventHandler(null, "mb-C");
    setBackgroundEventHandler(null, "mb-D");
    requeueBackgroundEvents([bgEvent({ command: "for-C" })], "mb-C");

    const cSeen: string[] = [];
    const dSeen: string[] = [];
    setBackgroundEventHandler((e) => dSeen.push(e.command), "mb-D");
    setBackgroundEventHandler((e) => cSeen.push(e.command), "mb-C");

    expect(cSeen).toEqual(["for-C"]);
    expect(dSeen).toEqual([]); // D's queue untouched by C's requeue

    setBackgroundEventHandler(null, "mb-C");
    setBackgroundEventHandler(null, "mb-D");
  });

  it("is bounded — a flood of requeued events cannot grow unbounded", () => {
    setBackgroundEventHandler(null, "mb-E");
    // Far more than MAX_PENDING_EVENTS (100).
    const flood = Array.from({ length: 500 }, (_, i) =>
      bgEvent({ command: `job-${i}`, taskId: `e${i}` }),
    );
    requeueBackgroundEvents(flood, "mb-E");

    const seen: string[] = [];
    setBackgroundEventHandler((e) => seen.push(e.command), "mb-E");
    expect(seen.length).toBeLessThanOrEqual(100);
    expect(seen.length).toBeGreaterThan(0);

    setBackgroundEventHandler(null, "mb-E");
  });

  it("no-ops on an empty leftover set", () => {
    setBackgroundEventHandler(null, "mb-F");
    requeueBackgroundEvents([], "mb-F"); // must not create a stray queue
    const seen: string[] = [];
    setBackgroundEventHandler((e) => seen.push(e.command), "mb-F");
    expect(seen).toEqual([]);
    setBackgroundEventHandler(null, "mb-F");
  });
});
