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

  /** Stop recording and return the audio file path. */
  stop(): string {
    if (!this.process) {
      throw new Error("Not recording. Call start() first.");
    }

    this.process.kill("SIGTERM");
    this.process = null;

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
