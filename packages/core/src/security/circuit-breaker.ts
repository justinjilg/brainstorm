/**
 * Circuit Breaker — prevents cascading failures in workflow pipelines.
 *
 * Tracks consecutive failures per operation. When failures exceed the
 * threshold, the circuit "opens" and blocks further calls until a
 * cooldown period passes. After cooldown, allows one "probe" call —
 * if it succeeds, the circuit closes (healthy). If it fails, the
 * circuit opens again.
 *
 * States: CLOSED (healthy) → OPEN (blocking) → HALF_OPEN (probing) → CLOSED
 *
 * Also tracks confidence drops: if a metric (e.g., model accuracy)
 * drops below a threshold relative to its running average, the breaker
 * fires an alert.
 */

import { createLogger } from "@brainst0rm/shared";

const log = createLogger("circuit-breaker");

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Name of the operation being protected. */
  name: string;
  /** Number of consecutive failures to trigger the breaker. */
  failureThreshold?: number;
  /** Cooldown period in ms before allowing a probe (default: 30s). */
  cooldownMs?: number;
  /** Maximum retries before giving up (default: 3). */
  maxRetries?: number;
  /** Confidence drop threshold (0-1) — alert if metric drops by this ratio. */
  confidenceDropThreshold?: number;
}

export interface CircuitEvent {
  type:
    | "opened"
    | "closed"
    | "half_open"
    | "probe_success"
    | "probe_failure"
    | "confidence_drop";
  name: string;
  timestamp: number;
  detail: string;
}

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly maxRetries: number;
  private readonly confidenceDropThreshold: number;
  private events: CircuitEvent[] = [];
  private metricHistory: number[] = [];

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.confidenceDropThreshold = options.confidenceDropThreshold ?? 0.3;
  }

  /** Get the current circuit state. */
  getState(): CircuitState {
    // Check if cooldown has passed and we should transition to half_open
    if (
      this.state === "open" &&
      Date.now() - this.lastFailureAt >= this.cooldownMs
    ) {
      this.transition("half_open", "Cooldown period elapsed");
    }
    return this.state;
  }

  /** Check if the circuit allows the operation to proceed. */
  canExecute(): boolean {
    const state = this.getState();
    return state === "closed" || state === "half_open";
  }

  /** Record a successful operation. */
  recordSuccess(): void {
    if (this.state === "half_open") {
      this.transition("closed", "Probe succeeded");
      this.addEvent("probe_success", "Circuit closed after successful probe");
    }
    this.consecutiveFailures = 0;
  }

  /** Record a failed operation. */
  recordFailure(error?: string): void {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    if (this.state === "half_open") {
      this.transition("open", `Probe failed: ${error ?? "unknown"}`);
      this.addEvent(
        "probe_failure",
        `Circuit re-opened: ${error ?? "unknown"}`,
      );
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.transition(
        "open",
        `${this.consecutiveFailures} consecutive failures`,
      );
    }
  }

  /**
   * Record a confidence/quality metric.
   * Alerts if the metric drops significantly from the running average.
   */
  recordMetric(value: number): CircuitEvent | null {
    this.metricHistory.push(value);

    // Need at least 5 data points for meaningful comparison
    if (this.metricHistory.length < 5) return null;

    // Keep last 20 metrics
    if (this.metricHistory.length > 20) {
      this.metricHistory = this.metricHistory.slice(-20);
    }

    // Compare latest value to running average of previous entries
    const previous = this.metricHistory.slice(0, -1);
    const avg = previous.reduce((s, v) => s + v, 0) / previous.length;

    if (avg > 0 && (avg - value) / avg > this.confidenceDropThreshold) {
      const event: CircuitEvent = {
        type: "confidence_drop",
        name: this.name,
        timestamp: Date.now(),
        detail: `Metric dropped from avg ${avg.toFixed(3)} to ${value.toFixed(3)} (${((1 - value / avg) * 100).toFixed(1)}% drop)`,
      };
      this.events.push(event);

      log.warn(
        { name: this.name, avg, value, drop: avg - value },
        "Confidence drop detected",
      );

      return event;
    }

    return null;
  }

  /** Get the maximum retries allowed. */
  getMaxRetries(): number {
    return this.maxRetries;
  }

  /** Get recent circuit events for audit. */
  getEvents(limit = 20): CircuitEvent[] {
    return this.events.slice(-limit);
  }

  /** Get a summary of the breaker's current status. */
  getSummary(): {
    name: string;
    state: CircuitState;
    consecutiveFailures: number;
    failureThreshold: number;
    cooldownRemaining: number;
  } {
    const cooldownRemaining =
      this.state === "open"
        ? Math.max(0, this.cooldownMs - (Date.now() - this.lastFailureAt))
        : 0;

    return {
      name: this.name,
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      cooldownRemaining,
    };
  }

  /** Reset the breaker to closed state. */
  reset(): void {
    this.transition("closed", "Manual reset");
    this.consecutiveFailures = 0;
  }

  private transition(newState: CircuitState, reason: string): void {
    const oldState = this.state;
    this.state = newState;

    log.info(
      { name: this.name, from: oldState, to: newState, reason },
      "Circuit state transition",
    );

    // Map state names to event type names (open → opened)
    const eventType: CircuitEvent["type"] =
      newState === "open" ? "opened" : newState;
    this.addEvent(eventType, reason);
  }

  private addEvent(type: CircuitEvent["type"], detail: string): void {
    this.events.push({
      type,
      name: this.name,
      timestamp: Date.now(),
      detail,
    });

    // Keep event history bounded
    if (this.events.length > 100) {
      this.events = this.events.slice(-100);
    }
  }
}

/**
 * Circuit Breaker Registry — manages breakers for multiple operations.
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /** Get or create a circuit breaker for an operation. */
  getBreaker(options: CircuitBreakerOptions): CircuitBreaker {
    const existing = this.breakers.get(options.name);
    if (existing) {
      // Warn if caller expects different configuration than what exists
      if (
        options.failureThreshold !== undefined ||
        options.cooldownMs !== undefined
      ) {
        log.info(
          { name: options.name },
          "Returning existing circuit breaker — options from first registration apply",
        );
      }
      return existing;
    }
    const breaker = new CircuitBreaker(options);
    this.breakers.set(options.name, breaker);
    return breaker;
  }

  /** Get all breaker summaries for dashboard display. */
  getAllSummaries(): Array<ReturnType<CircuitBreaker["getSummary"]>> {
    return Array.from(this.breakers.values()).map((b) => b.getSummary());
  }

  /** Get all breakers that are currently open. */
  getOpenBreakers(): CircuitBreaker[] {
    return Array.from(this.breakers.values()).filter(
      (b) => b.getState() === "open",
    );
  }

  /** Reset all breakers. */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}
