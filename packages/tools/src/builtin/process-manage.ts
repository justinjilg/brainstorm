import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool } from "../base.js";
import { checkSandbox } from "./sandbox.js";
import {
  buildChildEnv,
  getConfiguredProjectPath,
  getConfiguredSandboxLevel,
} from "./shell.js";
import { getWorkspace } from "../workspace-context.js";

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
    const sandboxLevel = getConfiguredSandboxLevel();
    const projectPath = getConfiguredProjectPath();
    if (sandboxLevel === "container") {
      return {
        error:
          "process_spawn cannot safely manage a host process while container sandboxing is enabled; use shell with background: true instead.",
      };
    }

    // Enforce sandbox restrictions (same as shell tool)
    const sandboxResult = checkSandbox(command, sandboxLevel, projectPath);
    if (!sandboxResult.allowed) {
      return { error: `Blocked by sandbox: ${sandboxResult.reason}` };
    }

    if (managedProcesses.size >= MAX_MANAGED_PROCESSES) {
      return {
        error: `Too many background processes (max ${MAX_MANAGED_PROCESSES}). Kill some first.`,
      };
    }

    if (managedProcesses.has(name)) {
      return {
        error: `Process '${name}' is already running (pid: ${managedProcesses.get(name)!.pid})`,
      };
    }

    const workspace = resolve(getWorkspace());
    const processCwd = resolve(workspace, cwd ?? ".");
    const workspaceRelative = relative(workspace, processCwd);
    if (
      workspaceRelative === ".." ||
      workspaceRelative.startsWith(`..${sep}`) ||
      isAbsolute(workspaceRelative)
    ) {
      return {
        error: "Process working directory must remain inside the workspace",
      };
    }

    const child = spawn("/bin/sh", ["-c", command], {
      cwd: processCwd,
      detached: true,
      env: buildChildEnv(sandboxLevel),
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
      // Group-kill — see cleanupStaleProcesses() for the Linux rationale.
      process.kill(-proc.pid, "SIGTERM");
      managedProcesses.delete(name);
      return { success: true, name, pid: proc.pid };
    } catch (err: any) {
      managedProcesses.delete(name);
      return { error: err.message, name };
    }
  },
});
