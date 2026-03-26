import { z } from "zod";
import { spawn } from "node:child_process";
import { defineTool } from "../base.js";
import {
  checkGitSafety,
  formatViolations,
  hasHardBlock,
} from "./git-safety.js";
import { checkSandbox, type SandboxLevel } from "./sandbox.js";
import { DockerSandbox } from "../sandbox/docker-sandbox.js";

const DEFAULT_TIMEOUT = 120_000;
const BACKGROUND_TIMEOUT = 600_000; // 10 minutes max for background tasks
let HEAD_BYTES = 20_000;
let TAIL_BYTES = 20_000;

// Module-level sandbox config — set by the CLI during startup
let currentSandboxLevel: SandboxLevel = "none";
let currentProjectPath: string | undefined;

// Docker sandbox — lazy-started on first container-mode shell call
let dockerSandbox: DockerSandbox | null = null;
let dockerConfig: { image: string; timeout: number } = {
  image: "node:22-slim",
  timeout: 120_000,
};

/** Configure the shell sandbox level and output limits. Call once during CLI startup. */
export function configureSandbox(
  level: SandboxLevel,
  projectPath?: string,
  maxOutputBytes?: number,
  containerImage?: string,
  containerTimeout?: number,
): void {
  currentSandboxLevel = level;
  currentProjectPath = projectPath;
  if (maxOutputBytes) {
    // Split output budget: 40% head, 60% tail (tail is more useful for errors)
    HEAD_BYTES = Math.floor(maxOutputBytes * 0.4);
    TAIL_BYTES = Math.floor(maxOutputBytes * 0.6);
  }
  if (containerImage) dockerConfig.image = containerImage;
  if (containerTimeout) dockerConfig.timeout = containerTimeout;
}

/** Stop and clean up the Docker sandbox container, if running. */
export function stopDockerSandbox(): void {
  if (dockerSandbox) {
    dockerSandbox.stop();
    dockerSandbox = null;
  }
}

/** Swap the Docker sandbox instance. Returns the previous instance for restore. */
export function setDockerSandbox(
  instance: DockerSandbox | null,
): DockerSandbox | null {
  const prev = dockerSandbox;
  dockerSandbox = instance;
  return prev;
}

// ── Background Task Management ──────────────────────────────────────

interface BackgroundTask {
  id: string;
  command: string;
  startedAt: number;
}

const backgroundTasks = new Map<string, BackgroundTask>();
let nextTaskId = 0;

type BackgroundEvent = {
  taskId: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

let backgroundEventHandler: ((event: BackgroundEvent) => void) | null = null;
const pendingEvents: BackgroundEvent[] = [];

/** Set a callback for background task completion events. Replays any queued events. */
export function setBackgroundEventHandler(
  handler: typeof backgroundEventHandler,
): void {
  backgroundEventHandler = handler;
  // Replay any events that arrived before handler was registered
  if (handler && pendingEvents.length > 0) {
    for (const event of pendingEvents) handler(event);
    pendingEvents.length = 0;
  }
}

// ── Tool Output Streaming ──────────────────────────────────────

let toolOutputHandler:
  | ((event: { toolName: string; chunk: string }) => void)
  | null = null;

/** Set a callback for streaming tool output chunks during foreground execution. */
export function setToolOutputHandler(handler: typeof toolOutputHandler): void {
  toolOutputHandler = handler;
}

/** Get list of currently running background tasks. */
export function getBackgroundTasks(): BackgroundTask[] {
  return Array.from(backgroundTasks.values());
}

/**
 * Collect output with head+tail truncation.
 * Keeps the first HEAD_BYTES and last TAIL_BYTES of output,
 * so both the start (config/setup) and end (errors/summary) are visible.
 *
 * Tail uses a fixed-size circular line buffer to avoid repeated large
 * string allocations from concatenation + slicing.
 */
class OutputCollector {
  private head = "";
  private totalBytes = 0;
  private readonly maxHead: number;
  private readonly maxTail: number;
  private headFull = false;

  // Circular line buffer for tail
  private readonly tailLines: string[];
  private tailWriteIdx = 0;
  private tailLineCount = 0;
  private tailBytes = 0;
  private readonly maxTailLines: number;

  constructor(maxHead = HEAD_BYTES, maxTail = TAIL_BYTES) {
    this.maxHead = maxHead;
    this.maxTail = maxTail;
    // Pre-allocate ring buffer — estimate ~80 chars/line average
    this.maxTailLines = Math.max(64, Math.ceil(maxTail / 80));
    this.tailLines = new Array(this.maxTailLines).fill("");
  }

  append(chunk: string): void {
    this.totalBytes += chunk.length;

    if (!this.headFull) {
      const remaining = this.maxHead - this.head.length;
      if (chunk.length <= remaining) {
        this.head += chunk;
        return;
      }
      this.head += chunk.slice(0, remaining);
      this.headFull = true;
      chunk = chunk.slice(remaining);
    }

    // Split into lines and push into circular buffer
    const lines = chunk.split("\n");
    for (const line of lines) {
      const evicted = this.tailLines[this.tailWriteIdx];
      this.tailBytes -= evicted.length;
      this.tailLines[this.tailWriteIdx] = line;
      this.tailBytes += line.length;
      this.tailWriteIdx = (this.tailWriteIdx + 1) % this.maxTailLines;
      this.tailLineCount++;
    }
  }

  toString(): string {
    if (!this.headFull) return this.head;

    // Read lines from ring buffer in order
    const count = Math.min(this.tailLineCount, this.maxTailLines);
    const start =
      this.tailLineCount >= this.maxTailLines ? this.tailWriteIdx : 0;
    const ordered: string[] = [];
    let bytes = 0;

    for (let i = 0; i < count; i++) {
      const idx = (start + i) % this.maxTailLines;
      const line = this.tailLines[idx];
      bytes += line.length;
      // Trim from the start if we exceed maxTail bytes
      if (bytes > this.maxTail && ordered.length > 0) continue;
      ordered.push(line);
    }

    const tail = ordered.join("\n");
    const omitted = this.totalBytes - this.head.length - tail.length;
    if (omitted <= 0) return this.head + tail;
    return `${this.head}\n\n... ${omitted.toLocaleString()} bytes omitted ...\n\n${tail}`;
  }
}

export const shellTool = defineTool({
  name: "shell",
  description:
    "Execute a shell command via /bin/sh -c. Returns { stdout, stderr, exitCode }. Output is truncated to first 200 + last 200 lines if >400 lines total. Default timeout: 30s. Use `background: true` for long-running commands (returns immediately with a task ID, notifies on completion). Blocked by sandbox for dangerous commands (rm -rf, sudo, etc.).",
  permission: "confirm",
  inputSchema: z.object({
    command: z
      .string()
      .describe("The command to execute (passed to /bin/sh -c)"),
    cwd: z.string().optional().describe("Working directory for the command"),
    timeout: z
      .number()
      .optional()
      .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT})`),
    background: z
      .boolean()
      .optional()
      .describe(
        "Run in background. Returns immediately with a task ID. You will be notified on completion.",
      ),
  }),
  async execute({ command, cwd, timeout, background }) {
    // Sandbox check — block dangerous commands based on configured level
    const sandboxResult = checkSandbox(
      command,
      currentSandboxLevel,
      currentProjectPath,
    );
    if (!sandboxResult.allowed) {
      return {
        stdout: "",
        stderr: sandboxResult.reason ?? "Command blocked by sandbox",
        exitCode: 1,
        blocked: true,
      };
    }

    // Git safety check — block destructive git operations
    if (/\bgit\b/.test(command)) {
      const violations = checkGitSafety(command);
      if (violations.length > 0 && hasHardBlock(violations)) {
        return {
          stdout: "",
          stderr: formatViolations(violations),
          exitCode: 1,
          blocked: true,
        };
      }
    }

    // Container mode: route through Docker sandbox
    if (currentSandboxLevel === "container" && currentProjectPath) {
      if (!dockerSandbox) {
        if (!DockerSandbox.isAvailable()) {
          return {
            stdout: "",
            stderr:
              "Docker is not available. Install Docker or switch to sandbox = 'restricted'.",
            exitCode: 1,
            blocked: true,
          };
        }
        dockerSandbox = new DockerSandbox({
          hostWorkspace: currentProjectPath,
          image: dockerConfig.image,
          timeout: dockerConfig.timeout,
        });
        dockerSandbox.start();
      }

      const result = dockerSandbox.exec(command);
      return {
        stdout: result.output,
        stderr: "",
        exitCode: result.exitCode,
      };
    }

    // Background mode: spawn and return immediately, notify on completion
    if (background) {
      const taskId = `bg-${nextTaskId++}`;
      const timeoutMs = timeout ?? BACKGROUND_TIMEOUT;
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: cwd ?? process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      backgroundTasks.set(taskId, {
        id: taskId,
        command,
        startedAt: Date.now(),
      });

      const bgStdout = new OutputCollector();
      const bgStderr = new OutputCollector();
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => bgStdout.append(chunk));
      child.stderr.on("data", (chunk: string) => bgStderr.append(chunk));

      // Timeout: SIGTERM then SIGKILL, same pattern as foreground
      const bgTimer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      }, timeoutMs);
      bgTimer.unref(); // Don't keep event loop alive for background timeout

      let completed = false;
      const emitCompletion = (exitCode: number, stderr?: string) => {
        if (completed) return; // Idempotent — error+close can both fire
        completed = true;
        clearTimeout(bgTimer);
        backgroundTasks.delete(taskId);
        const event: BackgroundEvent = {
          taskId,
          command,
          exitCode,
          stdout: bgStdout.toString(),
          stderr: stderr ?? bgStderr.toString(),
        };
        if (backgroundEventHandler) {
          backgroundEventHandler(event);
        } else {
          pendingEvents.push(event);
        }
      };

      child.on("close", (code) => {
        emitCompletion(code ?? 1);
      });

      child.on("error", (err) => {
        emitCompletion(1, err.message);
      });

      return {
        taskId,
        status: "running",
        message: `Running in background (${taskId}). You will be notified on completion.`,
      };
    }

    const timeoutMs = timeout ?? DEFAULT_TIMEOUT;

    return new Promise((resolve) => {
      const stdout = new OutputCollector();
      const stderr = new OutputCollector();

      const child = spawn("/bin/sh", ["-c", command], {
        cwd: cwd ?? process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");

      child.stdout.on("data", (chunk: string) => {
        stdout.append(chunk);
        if (toolOutputHandler) toolOutputHandler({ toolName: "shell", chunk });
      });
      child.stderr.on("data", (chunk: string) => {
        stderr.append(chunk);
        if (toolOutputHandler) toolOutputHandler({ toolName: "shell", chunk });
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        // Give 5s for graceful shutdown, then force kill
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      }, timeoutMs);

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const exitCode = code ?? (signal ? 128 : 1);
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode,
          ...(signal ? { signal } : {}),
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
        });
      });
    });
  },
});
