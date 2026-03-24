import { z } from 'zod';
import { spawn } from 'node:child_process';
import { defineTool } from '../base.js';
import { checkGitSafety, formatViolations, hasHardBlock } from './git-safety.js';
import { checkSandbox, type SandboxLevel } from './sandbox.js';

const DEFAULT_TIMEOUT = 120_000;
const BACKGROUND_TIMEOUT = 600_000; // 10 minutes max for background tasks
const HEAD_BYTES = 20_000;
const TAIL_BYTES = 20_000;

// Module-level sandbox config — set by the CLI during startup
let currentSandboxLevel: SandboxLevel = 'none';
let currentProjectPath: string | undefined;

/** Configure the shell sandbox level. Call once during CLI startup. */
export function configureSandbox(level: SandboxLevel, projectPath?: string): void {
  currentSandboxLevel = level;
  currentProjectPath = projectPath;
}

// ── Background Task Management ──────────────────────────────────────

interface BackgroundTask {
  id: string;
  command: string;
  startedAt: number;
}

const backgroundTasks = new Map<string, BackgroundTask>();
let nextTaskId = 0;
let backgroundEventHandler: ((event: { taskId: string; command: string; exitCode: number; stdout: string; stderr: string }) => void) | null = null;

/** Set a callback for background task completion events. */
export function setBackgroundEventHandler(handler: typeof backgroundEventHandler): void {
  backgroundEventHandler = handler;
}

/** Get list of currently running background tasks. */
export function getBackgroundTasks(): BackgroundTask[] {
  return Array.from(backgroundTasks.values());
}

/**
 * Collect output with head+tail truncation.
 * Keeps the first HEAD_BYTES and last TAIL_BYTES of output,
 * so both the start (config/setup) and end (errors/summary) are visible.
 */
class OutputCollector {
  private head = '';
  private tail = '';
  private totalBytes = 0;
  private readonly maxHead: number;
  private readonly maxTail: number;
  private headFull = false;

  constructor(maxHead = HEAD_BYTES, maxTail = TAIL_BYTES) {
    this.maxHead = maxHead;
    this.maxTail = maxTail;
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

    // Ring-buffer the tail
    this.tail += chunk;
    if (this.tail.length > this.maxTail * 2) {
      this.tail = this.tail.slice(-this.maxTail);
    }
  }

  toString(): string {
    if (!this.headFull) return this.head;
    const trimmedTail = this.tail.slice(-this.maxTail);
    const omitted = this.totalBytes - this.head.length - trimmedTail.length;
    return `${this.head}\n\n... ${omitted.toLocaleString()} bytes omitted ...\n\n${trimmedTail}`;
  }
}

export const shellTool = defineTool({
  name: 'shell',
  description: 'Execute a shell command and return its stdout, stderr, and exit code. Streams output in real-time for long-running commands (builds, tests). Use for running tests, builds, git operations, etc.',
  permission: 'confirm',
  inputSchema: z.object({
    command: z.string().describe('The command to execute (passed to /bin/sh -c)'),
    cwd: z.string().optional().describe('Working directory for the command'),
    timeout: z.number().optional().describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT})`),
    background: z.boolean().optional().describe('Run in background. Returns immediately with a task ID. You will be notified on completion.'),
  }),
  async execute({ command, cwd, timeout, background }) {
    // Sandbox check — block dangerous commands based on configured level
    const sandboxResult = checkSandbox(command, currentSandboxLevel, currentProjectPath);
    if (!sandboxResult.allowed) {
      return {
        stdout: '',
        stderr: sandboxResult.reason ?? 'Command blocked by sandbox',
        exitCode: 1,
        blocked: true,
      };
    }

    // Git safety check — block destructive git operations
    if (/\bgit\b/.test(command)) {
      const violations = checkGitSafety(command);
      if (violations.length > 0 && hasHardBlock(violations)) {
        return {
          stdout: '',
          stderr: formatViolations(violations),
          exitCode: 1,
          blocked: true,
        };
      }
    }

    // Background mode: spawn and return immediately, notify on completion
    if (background) {
      const taskId = `bg-${nextTaskId++}`;
      const timeoutMs = timeout ?? BACKGROUND_TIMEOUT;
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: cwd ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      backgroundTasks.set(taskId, { id: taskId, command, startedAt: Date.now() });

      const bgStdout = new OutputCollector();
      const bgStderr = new OutputCollector();
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => bgStdout.append(chunk));
      child.stderr.on('data', (chunk: string) => bgStderr.append(chunk));

      // Timeout: SIGTERM then SIGKILL, same pattern as foreground
      const bgTimer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
      }, timeoutMs);
      bgTimer.unref(); // Don't keep event loop alive for background timeout

      let completed = false;
      const emitCompletion = (exitCode: number, stderr?: string) => {
        if (completed) return; // Idempotent — error+close can both fire
        completed = true;
        clearTimeout(bgTimer);
        backgroundTasks.delete(taskId);
        if (backgroundEventHandler) {
          backgroundEventHandler({
            taskId,
            command,
            exitCode,
            stdout: bgStdout.toString(),
            stderr: stderr ?? bgStderr.toString(),
          });
        }
      };

      child.on('close', (code) => {
        emitCompletion(code ?? 1);
      });

      child.on('error', (err) => {
        emitCompletion(1, err.message);
      });

      return { taskId, status: 'running', message: `Running in background (${taskId}). You will be notified on completion.` };
    }

    const timeoutMs = timeout ?? DEFAULT_TIMEOUT;

    return new Promise((resolve) => {
      const stdout = new OutputCollector();
      const stderr = new OutputCollector();

      const child = spawn('/bin/sh', ['-c', command], {
        cwd: cwd ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');

      child.stdout.on('data', (chunk: string) => stdout.append(chunk));
      child.stderr.on('data', (chunk: string) => stderr.append(chunk));

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        // Give 5s for graceful shutdown, then force kill
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
      }, timeoutMs);

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const exitCode = code ?? (signal ? 128 : 1);
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode,
          ...(signal ? { signal } : {}),
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          stdout: '',
          stderr: err.message,
          exitCode: 1,
        });
      });
    });
  },
});
