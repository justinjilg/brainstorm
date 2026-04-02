/**
 * DaemonController — the heart of KAIROS.
 *
 * Wraps the existing agent loop in a tick cycle:
 * 1. Build a <tick> message with temporal context
 * 2. Inject it as a user message
 * 3. Run the agent loop, yielding all events
 * 4. Check for daemon_sleep in tool results
 * 5. Sleep (or use default interval)
 * 6. Repeat until stopped or budget exhausted
 *
 * Key design: user input preempts the sleep cycle. When a user
 * sends a message, the daemon wakes immediately, processes the
 * input through the normal agent loop, then resumes ticking.
 */

import { createLogger, type AgentEvent } from "@brainst0rm/shared";
import type { DaemonConfig } from "@brainst0rm/config";
import {
  type DaemonControllerOptions,
  type DaemonState,
  type TickResult,
  type WakeTrigger,
  createInitialState,
} from "./types.js";
import { formatTickMessage, type TickMessageContext } from "./tick-message.js";

const log = createLogger("daemon");

// How long prompt cache is valid (Anthropic: ~5 minutes)
const PROMPT_CACHE_TTL_MS = 300_000;

export class DaemonController {
  private state: DaemonState;
  private config: DaemonConfig;
  private options: DaemonControllerOptions;
  private abortController: AbortController;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private userMessageQueue: string[] = [];
  private wakeResolve: (() => void) | null = null;

  constructor(options: DaemonControllerOptions) {
    this.options = options;
    this.config = options.config;
    this.state = createInitialState();
    this.abortController = new AbortController();
  }

  /** Get current daemon state. */
  getState(): Readonly<DaemonState> {
    return { ...this.state };
  }

  /**
   * Run the daemon tick loop. Yields AgentEvents from each tick.
   * This is the main entry point — call this with `for await`.
   */
  async *run(): AsyncGenerator<AgentEvent> {
    log.info(
      {
        tickInterval: this.config.tickIntervalMs,
        maxTicks: this.config.maxTicksPerSession,
      },
      "Daemon starting",
    );

    yield {
      type: "daemon-wake",
      trigger: "timer",
    } as AgentEvent;

    while (!this.abortController.signal.aborted) {
      // 1. Check pause state
      if (this.state.isPaused) {
        await this.waitForWake();
        if (this.abortController.signal.aborted) break;
        this.state.isPaused = false;
        await this.notifyStateChange();
      }

      // 2. Check sleep state
      if (this.state.sleepUntil && Date.now() < this.state.sleepUntil) {
        const remaining = this.state.sleepUntil - Date.now();
        const woke = await this.sleepFor(remaining);
        if (this.abortController.signal.aborted) break;

        // Determine wake trigger
        const trigger: WakeTrigger = woke ? "timer" : "user";
        this.state.lastWakeTrigger = trigger;
        this.state.sleepUntil = null;
        this.state.sleepReason = null;

        yield { type: "daemon-wake", trigger } as AgentEvent;
      }

      // 3. Check for user input preemption
      if (this.userMessageQueue.length > 0) {
        const userMsg = this.userMessageQueue.shift()!;
        this.state.lastWakeTrigger = "user";
        yield { type: "daemon-wake", trigger: "user" } as AgentEvent;

        // Run agent loop with user's message (not a tick)
        for await (const event of this.options.runTick(userMsg)) {
          yield event;
          if (event.type === "done") {
            this.state.totalCost = event.totalCost;
          }
        }
        continue; // Skip tick, go back to top of loop
      }

      // 4. Check tick limit
      if (this.state.tickCount >= this.config.maxTicksPerSession) {
        log.info(
          { tickCount: this.state.tickCount },
          "Max ticks reached, stopping daemon",
        );
        break;
      }

      // 5. Build and run tick
      const tickResult = await this.runTick();
      yield* this.emitTickEvents(tickResult);

      // 6. Handle sleep request from model
      if (tickResult.sleepRequested) {
        const sleepMs = tickResult.sleepRequested.ms;
        this.state.sleepUntil = Date.now() + sleepMs;
        this.state.sleepReason = tickResult.sleepRequested.reason;
        this.state.status = "sleeping";

        yield {
          type: "daemon-sleep",
          sleepMs,
          reason: tickResult.sleepRequested.reason,
        } as AgentEvent;

        await this.notifyStateChange();
      } else {
        // Default tick interval
        const defaultSleep = this.config.tickIntervalMs;
        this.state.sleepUntil = Date.now() + defaultSleep;
        this.state.sleepReason = "default tick interval";
        this.state.status = "sleeping";
      }
    }

    // Emit stop event
    yield {
      type: "daemon-stopped",
      tickCount: this.state.tickCount,
      totalCost: this.state.totalCost,
    } as AgentEvent;

    this.state.status = "stopped";
    await this.notifyStateChange();
    log.info(
      { ticks: this.state.tickCount, cost: this.state.totalCost },
      "Daemon stopped",
    );
  }

  /**
   * Inject a user message — breaks the sleep cycle.
   * The daemon will wake immediately and process this message.
   */
  injectUserMessage(message: string): void {
    this.userMessageQueue.push(message);
    this.wake();
  }

  /** Pause the daemon. Ticks stop until resume() is called. */
  pause(): void {
    this.state.isPaused = true;
    this.state.status = "paused";
    this.wake(); // Break out of any sleep
    this.notifyStateChange();
  }

  /** Resume a paused daemon. */
  resume(): void {
    this.state.isPaused = false;
    this.state.status = "running";
    this.wake();
    this.notifyStateChange();
  }

  /** Stop the daemon permanently. */
  stop(): void {
    this.abortController.abort();
    this.wake();
  }

  // ── Private ──────────────────────────────────────────────────────

  private async runTick(): Promise<TickResult> {
    const tickNumber = this.state.tickCount + 1;
    const promptCacheStale =
      this.state.lastTickAt !== null &&
      Date.now() - this.state.lastTickAt > PROMPT_CACHE_TTL_MS;

    const tickCtx: TickMessageContext = {
      state: this.state,
      logSummary: this.options.getLogSummary?.(),
      dueTasks: this.options.getDueTasks?.(),
      pendingTasks: this.options.getPendingTasks?.(),
      promptCacheStale,
    };

    const tickMessage = formatTickMessage(tickCtx);
    const events: AgentEvent[] = [];
    const toolCalls: string[] = [];
    let cost = 0;
    let modelUsed = "";
    let sleepRequested: { ms: number; reason: string } | undefined;

    this.state.status = "running";
    await this.notifyStateChange();

    for await (const event of this.options.runTick(tickMessage)) {
      events.push(event);

      if (event.type === "tool-call-result") {
        // Check for daemon_sleep result
        const result = event.result as any;
        if (result?.sleepMs !== undefined) {
          sleepRequested = {
            ms: result.sleepMs,
            reason: result.reason ?? "model requested sleep",
          };
        }
      }

      if (event.type === "tool-call-start") {
        toolCalls.push(event.toolName);
      }

      if (event.type === "routing") {
        modelUsed = event.decision.model.name;
      }

      if (event.type === "done") {
        cost = event.totalCost - this.state.totalCost;
        this.state.totalCost = event.totalCost;
      }
    }

    // Update state
    this.state.tickCount = tickNumber;
    this.state.lastTickAt = Date.now();

    const tickResult: TickResult = {
      tickNumber,
      events,
      cost,
      modelUsed,
      sleepRequested,
      toolCalls,
    };

    // Notify listeners
    if (this.options.onTickComplete) {
      await this.options.onTickComplete(tickResult);
    }

    return tickResult;
  }

  private async *emitTickEvents(
    result: TickResult,
  ): AsyncGenerator<AgentEvent> {
    yield {
      type: "daemon-tick",
      tickNumber: result.tickNumber,
      idleSeconds: this.state.lastTickAt
        ? Math.floor((Date.now() - this.state.lastTickAt) / 1000)
        : 0,
      cost: result.cost,
    } as AgentEvent;
  }

  /**
   * Sleep for the given duration. Returns true if the full sleep
   * completed, false if woken early (by user input or stop).
   */
  private sleepFor(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.wakeResolve = () => resolve(false);

      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        this.wakeResolve = null;
        resolve(true);
      }, ms);

      // .unref() so the timer doesn't keep the process alive
      if (this.sleepTimer && typeof this.sleepTimer.unref === "function") {
        this.sleepTimer.unref();
      }
    });
  }

  /** Wait for a wake signal (used during pause). */
  private waitForWake(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wakeResolve = () => resolve();
    });
  }

  /** Wake from sleep or pause. */
  private wake(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    if (this.wakeResolve) {
      const resolve = this.wakeResolve;
      this.wakeResolve = null;
      resolve();
    }
  }

  private async notifyStateChange(): Promise<void> {
    if (this.options.onStateChange) {
      await this.options.onStateChange(this.state);
    }
  }
}
