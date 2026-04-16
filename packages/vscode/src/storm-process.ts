import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * Manages a storm CLI child process for chat communication.
 *
 * Spawns `storm chat --simple --pipe` and communicates via stdin/stdout.
 * Events are parsed from JSON-lines output.
 */
export interface StormEvent {
  type: "text" | "tool-call" | "tool-result" | "done" | "error";
  data: unknown;
}

export class StormProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = "";

  constructor(
    private cwd: string,
    private modelId?: string,
  ) {
    super();
  }

  /** Start the storm CLI process. */
  start(): void {
    if (this.process) return;

    // Build args — pass model if specified
    const args = ["chat", "--simple", "--pipe"];
    if (this.modelId) args.push("--model", this.modelId);

    // Try to find storm in PATH, fallback to npx
    const proc = spawn("storm", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.process = proc;

    const onStdout = (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    };
    const onStderr = (chunk: Buffer) => {
      this.emit("stderr", chunk.toString());
    };
    const onExit = (code: number | null) => {
      cleanup();
      if (this.process === proc) this.process = null;
      this.emit("exit", code);
    };
    const onError = (err: Error) => {
      this.emit("error", err);
    };

    const cleanup = () => {
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };

    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("exit", onExit);
    proc.on("error", onError);

    // Stash cleanup so stop() can detach listeners before killing
    this._cleanup = cleanup;
  }

  private _cleanup: (() => void) | null = null;

  /** Send a message to the storm process. */
  send(message: string): void {
    if (!this.process?.stdin) {
      throw new Error("Storm process not started. Call start() first.");
    }
    this.process.stdin.write(message + "\n");
  }

  /** Stop the storm process. */
  stop(): void {
    if (this.process) {
      this._cleanup?.();
      this._cleanup = null;
      this.process.kill("SIGTERM");
      this.process = null;
      this.buffer = "";
    }
  }

  /** Check if the process is running. */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event: StormEvent = JSON.parse(line);
        this.emit("event", event);
      } catch {
        // Plain text output (not JSON)
        this.emit("text", line);
      }
    }
  }
}
