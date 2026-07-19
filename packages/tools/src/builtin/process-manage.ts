import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";
import { checkSandbox } from "./sandbox.js";
import { buildChildEnv } from "./shell.js";
import { getSessionId } from "../session-context.js";

const execFileAsync = promisify(execFile);

// Track spawned background processes (capped to prevent memory leaks). Keyed by
// `${sessionId}::${name}` and tagged with the spawning session so one session
// can't enumerate (via error text), collide with, or KILL another session's
// process. The MAX cap remains a process-wide resource limit.
const MAX_MANAGED_PROCESSES = 100;
const managedProcesses = new Map<
  string,
  { pid: number; command: string; startedAt: number; sessionId: string }
>();

const procKey = (sessionId: string, name: string): string =>
  `${sessionId}::${name}`;

/** Names of the current session's managed processes (for error listings). */
function sessionProcessNames(sessionId: string): string[] {
  const prefix = `${sessionId}::`;
  const names: string[] = [];
  for (const key of managedProcesses.keys()) {
    if (key.startsWith(prefix)) names.push(key.slice(prefix.length));
  }
  return names;
}

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
  for (const [key, entry] of toRemove) {
    try {
      // Kill the whole process group — the spawn uses `detached: true`
      // so pid is the pgid. On Linux `/bin/sh` (dash) exits on SIGTERM
      // without forwarding to children, so killing only the shell pid
      // leaves the actual command (npm run dev, etc.) orphaned.
      process.kill(-entry.pid, "SIGTERM");
    } catch {
      /* already dead */
    }
    managedProcesses.delete(key);
  }
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
    // Enforce sandbox restrictions (same as shell tool)
    const sandboxResult = checkSandbox(command, "restricted");
    if (!sandboxResult.allowed) {
      return { error: `Blocked by sandbox: ${sandboxResult.reason}` };
    }

    const sessionId = getSessionId();
    const key = procKey(sessionId, name);

    if (managedProcesses.size >= MAX_MANAGED_PROCESSES) {
      return {
        error: `Too many background processes (max ${MAX_MANAGED_PROCESSES}). Kill some first.`,
      };
    }

    if (managedProcesses.has(key)) {
      return {
        error: `Process '${name}' is already running (pid: ${managedProcesses.get(key)!.pid})`,
      };
    }

    const child = spawn("/bin/sh", ["-c", command], {
      cwd: cwd ?? process.cwd(),
      detached: true,
      env: buildChildEnv("restricted"),
      stdio: "ignore",
    });
    child.unref();

    if (child.pid) {
      managedProcesses.set(key, {
        pid: child.pid,
        command,
        startedAt: Date.now(),
        sessionId,
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
    const sessionId = getSessionId();
    const key = procKey(sessionId, name);
    const proc = managedProcesses.get(key);
    if (!proc) {
      // Only surface THIS session's processes — never another session's.
      return {
        error: `No managed process named '${name}'. Active: ${sessionProcessNames(sessionId).join(", ") || "none"}`,
      };
    }

    try {
      // Group-kill — see cleanupStaleProcesses() for the Linux rationale.
      process.kill(-proc.pid, "SIGTERM");
      managedProcesses.delete(key);
      return { success: true, name, pid: proc.pid };
    } catch (err: any) {
      managedProcesses.delete(key);
      return { error: err.message, name };
    }
  },
});
