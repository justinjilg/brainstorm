import { describe, it, expect } from "vitest";
import {
  withSession,
  enterSession,
  getSessionId,
} from "../session-context.js";
import {
  taskCreateTool,
  taskListTool,
  clearTasks,
} from "../builtin/task-manage.js";

/**
 * The load-bearing proof for relaxing the channel coordinator's global
 * serialization (bench/iterations/006/concurrency-isolation-audit.md,
 * prerequisite 2): the real agent loop selects its session with
 * `enterSession(sessionId)` (= AsyncLocalStorage.enterWith) at loop.ts, and
 * callers that can run concurrently now DRIVE that loop inside
 * `withSession(sessionId, …)`. This file proves that combination — a bare
 * enterWith nested inside a withSession run() scope — stays correct when two
 * sessions interleave, i.e. the loop's internal enterSession is
 * "redundant-but-harmless" under concurrency (it sets the same id the wrapper
 * already established, and cannot leak into a concurrent sibling).
 *
 * The coordinator-level test uses a FAKE loop with no enterSession; this closes
 * the gap by reproducing exactly what the real loop does to the ambient store.
 */
describe("session selection: enterSession nested in withSession under concurrency", () => {
  it("keeps getSessionId() correct across interleaved awaits when each run also calls enterSession", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));

    // Mirror the real loop: the caller establishes withSession(id); the loop
    // body then calls enterSession(id) (same id) and does async tool work.
    const run = (id: string, descs: string[]) =>
      withSession(id, async () => {
        enterSession(id); // what runAgentLoop does internally (loop.ts)
        const seen: string[] = [];
        for (const d of descs) {
          await tick(); // yield — the sibling session runs here
          seen.push(getSessionId());
          await taskCreateTool.execute({ description: d });
          await tick();
          seen.push(getSessionId());
        }
        const list = await taskListTool.execute({});
        return { seen, tasks: list.tasks.map((t) => t.description) };
      });

    const [a, b] = await Promise.all([
      run("sel-A", ["A1", "A2", "A3"]),
      run("sel-B", ["B1", "B2"]),
    ]);

    // Every observation — before AND after each interleaving await — saw the
    // run's OWN session id. The sibling's enterSession never bled across.
    expect(new Set(a.seen)).toEqual(new Set(["sel-A"]));
    expect(new Set(b.seen)).toEqual(new Set(["sel-B"]));
    // ...and the session-scoped task store isolated each run's writes.
    expect(a.tasks).toEqual(["A1", "A2", "A3"]);
    expect(b.tasks).toEqual(["B1", "B2"]);

    clearTasks("sel-A");
    clearTasks("sel-B");
  });

  it("a run's enterSession does not corrupt the caller's ambient scope after it returns", async () => {
    // withSession saves/restores, so even though the inner enterSession mutates
    // the ambient store, the outer scope is intact once the run resolves — the
    // property that makes it safe to drive many loops from one dispatcher.
    const outer = await withSession("outer", async () => {
      // A nested run (like a subagent) uses withSession + enterSession with a
      // DIFFERENT id...
      await withSession("inner", async () => {
        enterSession("inner");
        await new Promise((r) => setTimeout(r, 0));
      });
      // ...and the outer scope is restored to "outer", not left as "inner".
      return getSessionId();
    });
    expect(outer).toBe("outer");
  });
});
