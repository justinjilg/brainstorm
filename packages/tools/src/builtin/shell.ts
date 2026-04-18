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
import { getWorkspace } from "../workspace-context.js";

const DEFAULT_TIMEOUT = 120_000;
const BACKGROUND_TIMEOUT = 600_000; // 10 minutes max for background tasks
let HEAD_BYTES = 20_000;
let TAIL_BYTES = 20_000;

/**
 * Env var names that must NEVER reach a shell child under the
 * "restricted" sandbox level. See v9 assessment's Attacker finding
 * (#8, 1/10 agents, high-severity): the parent's `process.env` on
 * this machine includes `OP_SERVICE_ACCOUNT_TOKEN` (which grants
 * access to the entire 1Password "Dev Keys" vault — 60 items) plus
 * every provider API key loaded at shell startup. Pre-fix, a
 * prompt-injection payload that managed to trigger `env | curl ...`
 * would exfiltrate the crown-jewel 1Password token.
 *
 * Explicit-name list covers the known secrets in this project's
 * environment; the pattern list catches anything matching a common
 * secret-name shape. Inclusive over-scrubbing is fine — a child
 * that needs one of these back can re-export it from the command
 * itself, which is audit-visible. Quiet exfiltration from env is
 * the attack.
 */
const SCRUBBED_ENV_NAMES = new Set([
  // 1Password service-account + bare-session token (the wrapped session
  // prefix is handled by SCRUBBED_ENV_PREFIXES below — see v11 Attacker
  // finding: real 1Password CLI env vars are `OP_SESSION_<accountid>`,
  // e.g. `OP_SESSION_abc123xyz`, which escaped both the bare-name set
  // AND the regex pattern in pass 25).
  "OP_SERVICE_ACCOUNT_TOKEN",
  "OP_SESSION",
  // Provider keys (first-party)
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
  "BRAINSTORM_API_KEY",
  // Cloud creds
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ACCESS_KEY_ID",
  // Datastore passwords
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  // Integration tokens
  "SLACK_BOT_TOKEN",
  "LINEAR_API_KEY",
  "STRIPE_SECRET_KEY",
  "POSTHOG_API_KEY",
  "SENTRY_AUTH_TOKEN",
]);

// Anything matching this shape is presumed secret even if not in the
// explicit list. Conservative by design: over-scrubbing a non-secret
// is cheap (the child can re-export it), but under-scrubbing a real
// secret is a leak.
//
// v12 Attacker finding: the pre-pass-31 pattern only matched the
// compound forms `API_KEY` and `PRIVATE_KEY`, missing bare `_KEY`
// suffixes. Real leaks that escaped:
//   - SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   - DATADOG_APP_KEY, HONEYCOMB_WRITEKEY, MIXPANEL_PROJECT_KEY
//   - SENTRY_DSN (auth in URL; DSN shape not covered)
//   - _AUTH / _BEARER / _COOKIE / _JWT / _PAT (personal access token)
// Pass 31 broadens to catch those. `SSH_AUTH_SOCK` (Unix socket path
// used by ssh-agent, not a secret) is the one name that would be
// scrubbed incorrectly — keep it working via the allowlist.
const SCRUBBED_ENV_PATTERN =
  /(?:API_KEY|SECRET|PASSWORD|CREDENTIALS|PRIVATE_KEY|_TOKEN|_KEY|KEY$|_AUTH|_BEARER|_COOKIE|_DSN|_JWT|_PAT)/i;
// Note: `KEY$` (end-anchor) catches shapes like HONEYCOMB_WRITEKEY
// that don't use the `_KEY` convention. Over-matches any env var
// ending in "KEY" — mostly fine (MONKEY / DONKEY etc. aren't
// realistic env names). If a legitimate env var ending in KEY ever
// needs to pass through, add to SCRUBBED_ENV_ALLOWLIST.

/**
 * Env-name prefixes that are always scrubbed. The exact-match set and
 * regex above catch most shapes, but some integrations namespace tokens
 * under a prefix: `OP_SESSION_<accountid>` (1Password CLI), `AWS_`
 * (namespaced cloud creds), `GCP_` (Google Cloud). Adding these as
 * prefixes closes the v11 Attacker finding where bare-name lookup
 * missed `OP_SESSION_abc123` and the regex didn't match either.
 *
 * GITHUB_ is NOT in this list because `GITHUB_TOKEN` is explicitly
 * allowlisted; most other GITHUB_* vars are benign (GITHUB_ACTIONS,
 * GITHUB_REPOSITORY, GITHUB_SHA, etc.) and scrubbing them would break
 * `gh` CLI workflows.
 */
const SCRUBBED_ENV_PREFIXES = ["OP_SESSION_", "AWS_", "GCP_", "AZURE_"];

// Env names to KEEP even when they match the scrub pattern. `gh` is
// part of our tool surface and fails hard without GITHUB_TOKEN /
// GH_TOKEN — scrubbing these would break a first-class workflow.
// The trade-off is documented: a prompt-injection attacker can still
// exfiltrate via GitHub if the user has a token loaded, but GitHub
// is a trusted exfil channel (audit-logged by GitHub itself).
//
// SSH_AUTH_SOCK is the Unix socket path exported by ssh-agent. It's
// NOT a secret — scrubbing it just forces the child to re-key
// every git/ssh call. Keep it passing through. (Added in pass 31:
// the broader `_AUTH` pattern would scrub it otherwise.)
const SCRUBBED_ENV_ALLOWLIST = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "SSH_AUTH_SOCK",
]);

/**
 * Produce a sanitized env for shell children. Under the "restricted"
 * sandbox level, removes every name in SCRUBBED_ENV_NAMES plus any
 * name matching SCRUBBED_ENV_PATTERN (minus the allowlist). Under
 * "none" returns process.env unchanged — the caller explicitly opted
 * out of sandboxing.
 */
export function buildChildEnv(level: SandboxLevel): NodeJS.ProcessEnv {
  if (level === "none") return process.env;
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (SCRUBBED_ENV_ALLOWLIST.has(name)) {
      scrubbed[name] = value;
      continue;
    }
    if (SCRUBBED_ENV_NAMES.has(name)) continue;
    if (SCRUBBED_ENV_PATTERN.test(name)) continue;
    if (SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))
      continue;
    scrubbed[name] = value;
  }
  return scrubbed;
}

// Module-level sandbox config — set by the CLI during startup via
// `configureSandbox()`. Default flipped from "none" to "restricted"
// per v9 assessment's Attacker finding: pre-fix, a caller that
// forgot to call configureSandbox() (test harnesses, embedder SDKs,
// early-boot shell calls before config loads) ran every command
// unsandboxed. "restricted" blocks the destructive patterns in
// sandbox.ts (rm -rf /, curl | sh, sudo, etc.) by default; callers
// that genuinely need the unrestricted "none" level must opt in
// explicitly via `configureSandbox("none", ...)`.
let currentSandboxLevel: SandboxLevel = "restricted";
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

// Kill a whole process group (shell + every child it forked). Used
// everywhere we need to cancel a shell: abort signal, timeout, or
// background abort. CI Linux (dash as /bin/sh) exposed the gap — a
// plain `child.kill("SIGTERM")` there signals only the shell, which
// exits without forwarding to its children; the `sleep 30` is
// reparented to init and runs to completion. macOS bash happens to
// propagate, which is why this was invisible locally.
//
// Relies on `detached: true` in spawn — that makes the shell a
// process-group leader (pgid == pid), so -pid addresses the whole
// group. Swallows errors: ESRCH (group already gone) and EPERM
// (race with init reaping) are both "nothing to do", not failures.
function killProcessGroup(
  pid: number | undefined,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already dead, or permission denied by a race with init —
    // either way, no one to signal.
  }
}

// ── Background Task Management ──────────────────────────────────────

interface BackgroundTask {
  id: string;
  command: string;
  startedAt: number;
}

const backgroundTasks = new Map<string, BackgroundTask>();
const MAX_BACKGROUND_TASKS = 50;
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
const MAX_PENDING_EVENTS = 100;

/** Set a callback for background task completion events. Replays any queued events. */
export function setBackgroundEventHandler(
  handler: typeof backgroundEventHandler,
): void {
  backgroundEventHandler = handler;
  if (handler && pendingEvents.length > 0) {
    // Replay events that arrived before handler was registered
    for (const event of pendingEvents) handler(event);
  }
  // Clear pending events on every handler change (including null).
  // Without this, orphaned events from background test runs accumulate
  // in the module-level array holding full stdout/stderr strings.
  pendingEvents.length = 0;
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
  async execute({ command, cwd, timeout, background }, ctx) {
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
        cwd: cwd ?? getWorkspace(),
        stdio: ["ignore", "pipe", "pipe"],
        env: buildChildEnv(currentSandboxLevel),
        // Put the shell + everything it spawns into its own process
        // group so we can kill the whole group on abort/timeout. See
        // killProcessGroup() for the CI-Linux rationale.
        detached: true,
      });

      // Detach the child's handle from the parent's event loop. Without
      // this, a long-running background task (sleep 100, a dev server,
      // etc.) would keep Node alive after the user quit the CLI, because
      // the ChildProcess handle counts as a live reference. The 'close'
      // listener below still fires when the child exits, so completion
      // notification is unaffected.
      child.unref();

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

      // Timeout: SIGTERM then SIGKILL, same pattern as foreground.
      // Group kill (via -pid) ensures we catch shell grandchildren on
      // Linux where SIGTERM to dash doesn't forward.
      const bgTimer = setTimeout(() => {
        killProcessGroup(child.pid, "SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) killProcessGroup(child.pid, "SIGKILL");
        }, 5000);
      }, timeoutMs);
      bgTimer.unref(); // Don't keep event loop alive for background timeout

      // Honour the caller's AbortSignal even in background mode. A
      // background task by design survives the turn that spawned it,
      // but when the USER cancels (Ctrl+C / desktop Stop), the signal
      // DOES fire, and ignoring it leaves a runaway subprocess the
      // user explicitly told us to stop. Mirrors the foreground
      // branch; we only attach the listener once and detach it on
      // completion so the signal can't keep the listener array
      // growing on long-lived per-session controllers.
      const bgAbortSignal = ctx?.abortSignal;
      const onBgAbort = () => {
        killProcessGroup(child.pid, "SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) killProcessGroup(child.pid, "SIGKILL");
        }, 2000);
      };

      let completed = false;
      const emitCompletion = (exitCode: number, stderr?: string) => {
        if (completed) return; // Idempotent — error+close can both fire
        completed = true;
        clearTimeout(bgTimer);
        if (bgAbortSignal) {
          bgAbortSignal.removeEventListener("abort", onBgAbort);
        }
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
          if (pendingEvents.length < MAX_PENDING_EVENTS)
            pendingEvents.push(event);
        }
      };

      child.on("close", (code, signal) => {
        // POSIX convention: signal-terminated processes report exitCode
        // 128+signum. We don't know the exact number, so fall back to
        // 128 (generic "killed by signal") — non-zero so callers can
        // distinguish cancelled from clean-exit.
        emitCompletion(code ?? (signal ? 128 : 1));
      });

      child.on("error", (err) => {
        emitCompletion(1, err.message);
      });

      if (bgAbortSignal) {
        if (bgAbortSignal.aborted) {
          // Already aborted before we could register — kill now and
          // let the close handler fire naturally.
          onBgAbort();
        } else {
          bgAbortSignal.addEventListener("abort", onBgAbort, { once: true });
        }
      }

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
        cwd: cwd ?? getWorkspace(),
        stdio: ["ignore", "pipe", "pipe"],
        env: buildChildEnv(currentSandboxLevel),
        // Process-group leader so abort/timeout can kill everything
        // the command forked — see killProcessGroup().
        detached: true,
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
        killProcessGroup(child.pid, "SIGTERM");
        // Give 5s for graceful shutdown, then force kill the group.
        setTimeout(() => {
          if (child.exitCode === null) killProcessGroup(child.pid, "SIGKILL");
        }, 5000);
      }, timeoutMs);

      // Propagate caller aborts into a SIGTERM/SIGKILL pair on the
      // child. Without this, user cancel (Ctrl+C or desktop Stop
      // button) only clears the local stream; the shell command keeps
      // running to completion and its output bleeds into the next
      // turn as a ghost PostToolUse event. The AI SDK forwards its
      // signal through ToolExecuteContext — we just have to honour it.
      // { once: true } keeps this from leaking listeners if the signal
      // is a long-lived one shared across turns.
      const onAbort = () => {
        killProcessGroup(child.pid, "SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) killProcessGroup(child.pid, "SIGKILL");
        }, 2000);
      };
      const abortSignal = ctx?.abortSignal;
      if (abortSignal) {
        if (abortSignal.aborted) {
          // Signal fired before we could register — kill immediately
          // and skip the execution.
          onAbort();
        } else {
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (abortSignal) {
          abortSignal.removeEventListener("abort", onAbort);
        }
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
        if (abortSignal) {
          abortSignal.removeEventListener("abort", onAbort);
        }
        resolve({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
        });
      });
    });
  },
});
