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
  type ApprovalGateContext,
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
  /** Tracks state since last approval gate for KAIROS review summaries. */
  private lastGateTick = 0;
  private costAtLastGate = 0;
  private toolCallsSinceGate: string[] = [];

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

      // Fire DaemonTick hook
      if (this.options.onHook) {
        await this.options.onHook("DaemonTick", {
          tickNumber: tickResult.tickNumber,
          cost: tickResult.cost,
        });
      }

      // Auto-reflection: trigger memory consolidation every N ticks
      const reflectionInterval = this.options.reflectionInterval ?? 50;
      if (
        this.options.onReflectionDue &&
        tickResult.tickNumber > 0 &&
        tickResult.tickNumber % reflectionInterval === 0
      ) {
        log.info(
          { tickNumber: tickResult.tickNumber },
          "Reflection due — triggering memory consolidation",
        );
        await this.options.onReflectionDue(tickResult.tickNumber).catch((e) => {
          log.warn({ err: e }, "Reflection trigger failed (non-fatal)");
        });
      }

      // Track tool calls for approval gate summary
      this.toolCallsSinceGate.push(...tickResult.toolCalls);

      // 5b. Approval gate: pause for human review every N ticks
      const gateInterval = this.options.approvalGateInterval ?? 0;
      if (
        gateInterval > 0 &&
        this.options.onApprovalGate &&
        tickResult.tickNumber > 0 &&
        tickResult.tickNumber % gateInterval === 0
      ) {
        // Gather router intelligence for the gate context
        const routerIntel = this.options.getRouterIntelligence?.() ?? null;
        const costPacing =
          this.options.getCostPacing?.(this.config.tickIntervalMs) ?? null;

        const gateContext: ApprovalGateContext = {
          tickNumber: tickResult.tickNumber,
          ticksSinceLastGate: tickResult.tickNumber - this.lastGateTick,
          costSinceLastGate: this.state.totalCost - this.costAtLastGate,
          toolCallsSinceLastGate: [...this.toolCallsSinceGate],
          totalCost: this.state.totalCost,
          sessionDurationMs: Date.now() - this.state.sessionStartedAt,
          // Router intelligence
          modelMomentum: routerIntel?.momentum ?? null,
          recentFailures: routerIntel?.recentFailureCount ?? 0,
          budgetPressure: costPacing?.budgetPressure ?? 0,
          costPacingActive: costPacing
            ? costPacing.intervalMs > this.config.tickIntervalMs
            : false,
          convergenceAlerts: routerIntel?.convergenceAlerts.length
            ? routerIntel.convergenceAlerts
            : undefined,
        };

        log.info(
          { tickNumber: tickResult.tickNumber, gateInterval },
          "Approval gate reached — pausing for human review",
        );

        this.state.isPaused = true;
        this.state.status = "paused";
        await this.notifyStateChange();

        yield {
          type: "daemon-sleep",
          sleepMs: 0,
          reason: `Approval gate at tick ${tickResult.tickNumber} — awaiting human review`,
        } as AgentEvent;

        const shouldContinue = await this.options
          .onApprovalGate(gateContext)
          .catch((e) => {
            log.warn({ err: e }, "Approval gate callback failed — stopping");
            return false;
          });

        // Reset gate tracking
        this.lastGateTick = tickResult.tickNumber;
        this.costAtLastGate = this.state.totalCost;
        this.toolCallsSinceGate = [];

        if (!shouldContinue) {
          log.info("Human declined to continue at approval gate — stopping");
          break;
        }

        this.state.isPaused = false;
        this.state.status = "running";
        await this.notifyStateChange();

        yield { type: "daemon-wake", trigger: "user" } as AgentEvent;
      }

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

        // Fire DaemonSleep hook
        if (this.options.onHook) {
          await this.options.onHook("DaemonSleep", { sleepMs });
        }

        await this.notifyStateChange();
      } else {
        // Cost-paced tick interval: ask BR's cost tracker for advice
        const pacing = this.options.getCostPacing?.(this.config.tickIntervalMs);

        // Budget exhausted — stop the daemon, don't just slow down
        if (pacing?.shouldStop) {
          log.warn(
            { reason: pacing.reason, pressure: pacing.budgetPressure },
            "Cost pacer signals stop — budget exhausted",
          );
          break;
        }

        const sleepMs = pacing?.intervalMs ?? this.config.tickIntervalMs;
        this.state.sleepUntil = Date.now() + sleepMs;
        this.state.sleepReason = pacing?.reason ?? "default tick interval";
        this.state.status = "sleeping";

        if (pacing && pacing.intervalMs > this.config.tickIntervalMs) {
          log.info(
            {
              defaultMs: this.config.tickIntervalMs,
              advisedMs: pacing.intervalMs,
              pressure: pacing.budgetPressure.toFixed(2),
            },
            "Cost pacer stretched tick interval",
          );
        }
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
      memorySummary: this.options.getMemorySummary?.(),
      availableSkills: this.options.getAvailableSkills?.(),
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
