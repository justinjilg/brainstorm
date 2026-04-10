import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  clearTasks,
  setTaskEventHandler,
} from "../builtin/task-manage.js";

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
