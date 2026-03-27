import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);

// Track spawned background processes (capped to prevent memory leaks)
const MAX_MANAGED_PROCESSES = 100;
const managedProcesses = new Map<
  string,
  { pid: number; command: string; startedAt: number }
>();

function cleanupStaleProcesses(): void {
  if (managedProcesses.size <= MAX_MANAGED_PROCESSES) return;
  // Evict oldest entries
  const sorted = [...managedProcesses.entries()].sort(
    (a, b) => a[1].startedAt - b[1].startedAt,
  );
  const toRemove = sorted.slice(
    0,
    managedProcesses.size - MAX_MANAGED_PROCESSES,
  );
  for (const [key] of toRemove) managedProcesses.delete(key);
}

export const processSpawnTool = defineTool({
  name: "process_spawn",
  description:
    "Start a long-running background process (dev server, watcher, etc).",
  permission: "confirm",
  inputSchema: z.object({
    name: z.string().describe("Process name for management"),
    command: z.string().describe("Command to run"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute({ name, command, cwd }) {
    if (managedProcesses.has(name)) {
      return {
        error: `Process '${name}' is already running (pid: ${managedProcesses.get(name)!.pid})`,
      };
    }

    const child = spawn("/bin/sh", ["-c", command], {
      cwd: cwd ?? process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    if (child.pid) {
      managedProcesses.set(name, {
        pid: child.pid,
        command,
        startedAt: Date.now(),
      });
      cleanupStaleProcesses();
      return { success: true, name, pid: child.pid };
    }
    return { error: "Failed to spawn process" };
  },
});

export const processKillTool = defineTool({
  name: "process_kill",
  description: "Kill a managed background process by name.",
  permission: "confirm",
  inputSchema: z.object({
    name: z.string().describe("Process name to kill"),
  }),
  async execute({ name }) {
    const proc = managedProcesses.get(name);
    if (!proc) {
      return {
        error: `No managed process named '${name}'. Active: ${Array.from(managedProcesses.keys()).join(", ") || "none"}`,
      };
    }

    try {
      process.kill(proc.pid, "SIGTERM");
      managedProcesses.delete(name);
      return { success: true, name, pid: proc.pid };
    } catch (err: any) {
      managedProcesses.delete(name);
      return { error: err.message, name };
    }
  },
});
