import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Manages a storm CLI child process for chat communication.
 *
 * Spawns `storm chat --simple --pipe` and communicates via stdin/stdout.
 * Events are parsed from JSON-lines output.
 */
export interface StormEvent {
  type: 'text' | 'tool-call' | 'tool-result' | 'done' | 'error';
  data: unknown;
}

export class StormProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = '';

  constructor(private cwd: string) {
    super();
  }

  /** Start the storm CLI process. */
  start(): void {
    if (this.process) return;

    // Try to find storm in PATH, fallback to npx
    this.process = spawn('storm', ['chat', '--simple', '--pipe'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString());
    });

    this.process.on('exit', (code) => {
      this.process = null;
      this.emit('exit', code);
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /** Send a message to the storm process. */
  send(message: string): void {
    if (!this.process?.stdin) {
      throw new Error('Storm process not started. Call start() first.');
    }
    this.process.stdin.write(message + '\n');
  }

  /** Stop the storm process. */
  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  /** Check if the process is running. */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event: StormEvent = JSON.parse(line);
        this.emit('event', event);
      } catch {
        // Plain text output (not JSON)
        this.emit('text', line);
      }
    }
  }
}
