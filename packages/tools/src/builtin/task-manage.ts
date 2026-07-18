import { z } from "zod";
import { defineTool } from "../base.js";
import type { AgentTask, TaskStatus } from "@brainst0rm/shared";
import { getSessionId } from "../session-context.js";

type TaskEventHandler = (
  type: "task-created" | "task-updated",
  task: AgentTask,
) => void;

/**
 * Per-session task store. Previously a single module-global Map + counter +
 * handler, which two concurrent runs (server request + Slack message, or two
 * subagents) would corrupt — colliding IDs, clearing each other's tasks,
 * cross-wiring the event handler. Keyed by the current session id instead.
 * Tasks are ephemeral — they live only for the session's duration.
 */
interface SessionTaskStore {
  tasks: Map<string, AgentTask>;
  nextId: number;
  onTaskEvent: TaskEventHandler | null;
}

// Cardinality bound so a missed clearTasks() (crash, forgotten teardown) can't
// leak stores forever; oldest-inserted is evicted (mirrors the iter-003
// quarantine bound).
const MAX_TRACKED_SESSIONS = 256;
const sessionStores = new Map<string, SessionTaskStore>();

function storeFor(sessionId: string): SessionTaskStore {
  let store = sessionStores.get(sessionId);
  if (!store) {
    if (sessionStores.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessionStores.keys().next().value;
      if (oldest !== undefined) sessionStores.delete(oldest);
    }
    store = { tasks: new Map(), nextId: 1, onTaskEvent: null };
    sessionStores.set(sessionId, store);
  }
  return store;
}

/**
 * Register the TUI task-event handler for a session. Defaults to the current
 * session scope; pass an explicit id from outside a session context.
 */
export function setTaskEventHandler(
  handler: TaskEventHandler | null,
  sessionId: string = getSessionId(),
): void {
  storeFor(sessionId).onTaskEvent = handler;
}

/** Clear a session's tasks and release its store. */
export function clearTasks(sessionId: string = getSessionId()): void {
  sessionStores.delete(sessionId);
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
    const store = storeFor(getSessionId());
    const id = `task-${store.nextId++}`;
    const now = Date.now();
    const task: AgentTask = {
      id,
      description,
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    };
    store.tasks.set(id, task);
    store.onTaskEvent?.("task-created", task);
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
    const store = storeFor(getSessionId());
    const task = store.tasks.get(id);
    if (!task) return { error: `Task ${id} not found` };
    task.status = status as TaskStatus;
    task.updatedAt = Date.now();
    store.onTaskEvent?.("task-updated", task);
    return { id, status: task.status };
  },
});

export const taskListTool = defineTool({
  name: "task_list",
  description: "List all tasks in the current session with their status.",
  permission: "auto",
  inputSchema: z.object({}),
  async execute() {
    const store = storeFor(getSessionId());
    const all = Array.from(store.tasks.values()).map((t) => ({
      id: t.id,
      description: t.description,
      status: t.status,
    }));
    return { tasks: all, total: all.length };
  },
});
