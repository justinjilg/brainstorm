import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

/**
 * Audio recorder using sox (cross-platform).
 *
 * Records audio from the default microphone to a temp WAV file.
 * Requires `sox` to be installed (brew install sox / apt install sox).
 */
export class AudioRecorder {
  private process: ChildProcess | null = null;
  private outputPath: string = "";

  /** Check if sox is available. */
  static isAvailable(): boolean {
    try {
      execFileSync("sox", ["--version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Start recording audio. Returns the path where audio will be saved. */
  start(): string {
    if (this.process) {
      throw new Error("Already recording. Call stop() first.");
    }

    this.outputPath = join(
      tmpdir(),
      `brainstorm-voice-${randomUUID().slice(0, 8)}.wav`,
    );

    // sox -d = default audio device, -r 16000 = 16kHz (Whisper optimal), -c 1 = mono
    this.process = spawn(
      "sox",
      ["-d", "-r", "16000", "-c", "1", "-b", "16", this.outputPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.process.on("error", (err) => {
      console.error(`Recording error: ${err.message}`);
      this.process = null;
    });

    return this.outputPath;
  }

  /**
   * Stop recording and return the audio file path.
   *
   * Async because sox needs a moment after SIGTERM to flush the WAV
   * header + closing chunk. Pre-fix this was sync: kill + immediate
   * existsSync check. existsSync returned `true` the moment sox
   * opened the file at start() — but the file contents could still
   * be a truncated, header-less write at stop() time. Callers saw
   * "recording succeeded" and got corrupt audio. Awaiting 'exit'
   * guarantees sox has closed its write handle.
   */
  async stop(): Promise<string> {
    if (!this.process) {
      throw new Error("Not recording. Call start() first.");
    }

    const proc = this.process;
    this.process = null;

    await new Promise<void>((resolve) => {
      // Race: sox exiting naturally vs. our SIGTERM. Either way we
      // resolve on 'exit'. The SIGTERM is idempotent — if sox
      // already exited on its own (unlikely but possible), kill()
      // throws and we swallow it; the pending 'exit' listener
      // would fire synchronously with the close anyway.
      proc.once("exit", () => resolve());
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already exited between the start() return and now.
        // 'exit' may already have fired on a different tick — fall
        // back to a short watchdog so we don't hang if the event
        // was dispatched before we registered.
        setTimeout(resolve, 50);
      }
    });

    if (!existsSync(this.outputPath)) {
      throw new Error("Recording failed — no audio file produced.");
    }

    return this.outputPath;
  }

  /** Check if currently recording. */
  isRecording(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
