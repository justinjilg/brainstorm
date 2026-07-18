import { describe, it, expect } from "vitest";
import {
  shellTool,
  setBackgroundEventHandler,
} from "../builtin/shell.js";
import { withSession } from "../session-context.js";

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
