import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  clearTasks,
  setTaskEventHandler,
} from "../builtin/task-manage.js";
import { withSession, getSessionId } from "../session-context.js";

describe("task-manage tools", () => {
  beforeEach(() => {
    clearTasks();
    setTaskEventHandler(null); // reset handler
  });

  it("should create a task", async () => {
    const handler = vi.fn();
    setTaskEventHandler(handler);

    const result = await taskCreateTool.execute({
      description: "Write tests for tools",
    });

    expect(result).toMatchObject({
      id: "task-1",
      status: "in_progress",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      "task-created",
      expect.objectContaining({
        id: "task-1",
        description: "Write tests for tools",
        status: "in_progress",
      }),
    );
  });

  it("should list tasks", async () => {
    await taskCreateTool.execute({ description: "Task A" });
    await taskCreateTool.execute({ description: "Task B" });

    const listResult = await taskListTool.execute({});
    expect(listResult.total).toBe(2);
    expect(listResult.tasks).toHaveLength(2);
    expect(listResult.tasks[0].description).toBe("Task A");
    expect(listResult.tasks[1].description).toBe("Task B");
  });

  it("should update a task", async () => {
    const handler = vi.fn();
    setTaskEventHandler(handler);

    const createResult = await taskCreateTool.execute({
      description: "Update me",
    });
    expect(createResult.id).toBeDefined();

    const updateResult = await taskUpdateTool.execute({
      id: createResult.id as string,
      status: "completed",
    });

    expect(updateResult).toMatchObject({
      id: createResult.id,
      status: "completed",
    });

    // Check handler called for update
    expect(handler).toHaveBeenCalledWith(
      "task-updated",
      expect.objectContaining({
        id: createResult.id,
        status: "completed",
      }),
    );

    // Verify list reflects the update
    const listResult = await taskListTool.execute({});
    expect(listResult.tasks[0].status).toBe("completed");
  });

  it("should return error when updating non-existent task", async () => {
    const updateResult = await taskUpdateTool.execute({
      id: "task-999",
      status: "completed",
    });

    expect(updateResult).toHaveProperty("error");
    expect((updateResult as any).error).toContain("not found");
  });
});

describe("task-manage — concurrent session isolation", () => {
  beforeEach(() => {
    clearTasks("session-A");
    clearTasks("session-B");
  });

  it("keeps two concurrent sessions' tasks and IDs separate", async () => {
    // Interleave two sessions exactly as concurrent runs would.
    const a1 = await withSession("session-A", () =>
      taskCreateTool.execute({ description: "A-first" }),
    );
    const b1 = await withSession("session-B", () =>
      taskCreateTool.execute({ description: "B-first" }),
    );
    const a2 = await withSession("session-A", () =>
      taskCreateTool.execute({ description: "A-second" }),
    );

    // Each session numbers from 1 independently — no cross-session collision.
    expect(a1.id).toBe("task-1");
    expect(b1.id).toBe("task-1");
    expect(a2.id).toBe("task-2");

    // Each session sees ONLY its own tasks.
    const aList = await withSession("session-A", () => taskListTool.execute({}));
    const bList = await withSession("session-B", () => taskListTool.execute({}));
    expect(aList.tasks.map((t) => t.description)).toEqual([
      "A-first",
      "A-second",
    ]);
    expect(bList.tasks.map((t) => t.description)).toEqual(["B-first"]);
  });

  it("routes task events to the session that registered the handler", async () => {
    const aHandler = vi.fn();
    const bHandler = vi.fn();
    await withSession("session-A", async () => setTaskEventHandler(aHandler));
    await withSession("session-B", async () => setTaskEventHandler(bHandler));

    await withSession("session-A", () =>
      taskCreateTool.execute({ description: "A work" }),
    );

    // A's handler fired; B's did NOT (no cross-wiring).
    expect(aHandler).toHaveBeenCalledTimes(1);
    expect(bHandler).not.toHaveBeenCalled();
  });

  it("preserves per-session identity across interleaved awaits (true concurrency)", async () => {
    // The other tests here await each withSession to completion before the next
    // starts — sequential, not concurrent. This one runs two sessions with
    // OVERLAPPING lifetimes that yield control (await) between every step, so
    // their executions genuinely interleave on the event loop. It proves
    // getSessionId() (AsyncLocalStorage) stays bound to the right session across
    // await points under real concurrency — the exact property the channel
    // coordinator relaxation (per-conversation instead of global serialization)
    // depends on. See bench/iterations/006/concurrency-isolation-audit.md.
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const runSession = (id: string, descs: string[]) =>
      withSession(id, async () => {
        const seen: string[] = [];
        for (const d of descs) {
          await tick(); // yield: the other session may run here
          seen.push(getSessionId()); // must still be THIS session
          await taskCreateTool.execute({ description: d });
        }
        const list = await taskListTool.execute({});
        return { seen, tasks: list.tasks.map((t) => t.description) };
      });

    const [a, b] = await Promise.all([
      runSession("iso-A", ["A1", "A2", "A3"]),
      runSession("iso-B", ["B1", "B2"]),
    ]);

    // Neither session ever observed the other's id despite interleaving...
    expect(a.seen).toEqual(["iso-A", "iso-A", "iso-A"]);
    expect(b.seen).toEqual(["iso-B", "iso-B"]);
    // ...and each store holds only its own tasks (no cross-write under overlap).
    expect(a.tasks).toEqual(["A1", "A2", "A3"]);
    expect(b.tasks).toEqual(["B1", "B2"]);

    clearTasks("iso-A");
    clearTasks("iso-B");
  });

  it("clearTasks releases only the named session's store", async () => {
    await withSession("session-A", () =>
      taskCreateTool.execute({ description: "A" }),
    );
    await withSession("session-B", () =>
      taskCreateTool.execute({ description: "B" }),
    );
    clearTasks("session-A");

    const aList = await withSession("session-A", () => taskListTool.execute({}));
    const bList = await withSession("session-B", () => taskListTool.execute({}));
    expect(aList.total).toBe(0);
    expect(bList.total).toBe(1);
  });
});
