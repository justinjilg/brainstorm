import { z } from "zod";
import { defineTool } from "../base.js";
import type { AgentTask, TaskStatus } from "@brainst0rm/shared";

/**
 * In-session task store. Shared across the three task tools.
 * Tasks are ephemeral — they live only for the duration of the session.
 */
const tasks = new Map<string, AgentTask>();
let nextId = 1;

/** Event callback set by the agent loop to forward task events to the TUI. */
let onTaskEvent:
  | ((type: "task-created" | "task-updated", task: AgentTask) => void)
  | null = null;

export function setTaskEventHandler(handler: typeof onTaskEvent): void {
  onTaskEvent = handler;
}

export function clearTasks(): void {
  tasks.clear();
  nextId = 1;
}

export const taskCreateTool = defineTool({
  name: "task_create",
  description:
    "Create a task to track progress on multi-step work. Use this to show the user what you are working on.",
  permission: "auto",
  inputSchema: z.object({
    description: z
      .string()
      .describe("Short description of the task (1 sentence)"),
  }),
  async execute({ description }) {
    const id = `task-${nextId++}`;
    const now = Date.now();
    const task: AgentTask = {
      id,
      description,
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    };
    tasks.set(id, task);
    onTaskEvent?.("task-created", task);
    return { id, status: task.status };
  },
});

export const taskUpdateTool = defineTool({
  name: "task_update",
  description:
    "Update the status of an existing task. Mark tasks as completed when done, or failed if they cannot be completed.",
  permission: "auto",
  inputSchema: z.object({
    id: z.string().describe("Task ID returned by task_create"),
    status: z
      .enum(["pending", "in_progress", "completed", "failed"])
      .describe("New status"),
  }),
  async execute({ id, status }) {
    const task = tasks.get(id);
    if (!task) return { error: `Task ${id} not found` };
    task.status = status as TaskStatus;
    task.updatedAt = Date.now();
    onTaskEvent?.("task-updated", task);
    return { id, status: task.status };
  },
});

export const taskListTool = defineTool({
  name: "task_list",
  description: "List all tasks in the current session with their status.",
  permission: "auto",
  inputSchema: z.object({}),
  async execute() {
    const all = Array.from(tasks.values()).map((t) => ({
      id: t.id,
      description: t.description,
      status: t.status,
    }));
    return { tasks: all, total: all.length };
  },
});
