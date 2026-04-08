/**
 * Approval Velocity Tracker — detects rubber-stamping and approval fatigue.
 *
 * When a human approves 3+ tool calls in rapid succession (<2s each),
 * they're likely rubber-stamping without reading. This is the "approval
 * fatigue" attack from the Agent Traps paper: flood low-risk approvals
 * to train the human to click "yes" reflexively, then slip in a high-risk
 * action at position N.
 *
 * Defense: track approval timing. When velocity exceeds threshold,
 * inject a mandatory cooling period before the next approval.
 */

import { createLogger } from "@brainst0rm/shared";

const log = createLogger("approval-velocity");

export interface ApprovalEvent {
  toolName: string;
  timestamp: number;
  decision: "approve" | "deny";
  /** Time in ms the human took to decide (from prompt to response). */
  decisionTimeMs: number;
}

export interface VelocityWarning {
  type: "rapid-approval" | "fatigue-pattern" | "cooling-required";
  message: string;
  /** Minimum wait time in ms before next approval should be accepted. */
  coolingMs: number;
  /** Number of rapid approvals that triggered this warning. */
  rapidCount: number;
}

export class ApprovalVelocityTracker {
  private history: ApprovalEvent[] = [];
  private coolingUntil: number | null = null;

  /** Maximum history entries to keep. */
  private readonly maxHistory = 50;
  /** Approvals faster than this (ms) are considered "rapid". */
  private readonly rapidThresholdMs: number;
  /** Number of rapid approvals before triggering a warning. */
  private readonly rapidCountThreshold: number;
  /** Cooling period duration (ms) after rapid approval detection. */
  private readonly coolingPeriodMs: number;

  constructor(options?: {
    rapidThresholdMs?: number;
    rapidCountThreshold?: number;
    coolingPeriodMs?: number;
  }) {
    this.rapidThresholdMs = options?.rapidThresholdMs ?? 2000;
    this.rapidCountThreshold = options?.rapidCountThreshold ?? 3;
    this.coolingPeriodMs = options?.coolingPeriodMs ?? 5000;
  }

  /**
   * Record an approval decision and check for fatigue patterns.
   * Returns a warning if the approval velocity is too high.
   */
  recordApproval(
    toolName: string,
    decision: "approve" | "deny",
    decisionTimeMs: number,
  ): VelocityWarning | null {
    const event: ApprovalEvent = {
      toolName,
      timestamp: Date.now(),
      decision,
      decisionTimeMs,
    };

    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    // Only check velocity on approvals (denials show the human is paying attention)
    if (decision !== "approve") return null;

    // Count recent rapid approvals
    const recentApprovals = this.getRecentRapidApprovals();

    if (recentApprovals.length >= this.rapidCountThreshold) {
      this.coolingUntil = Date.now() + this.coolingPeriodMs;

      const warning: VelocityWarning = {
        type: "rapid-approval",
        message: `${recentApprovals.length} approvals in <${this.rapidThresholdMs}ms each. Slowing down to prevent approval fatigue.`,
        coolingMs: this.coolingPeriodMs,
        rapidCount: recentApprovals.length,
      };

      log.warn(
        {
          rapidCount: recentApprovals.length,
          tools: recentApprovals.map((e) => e.toolName),
          avgDecisionMs: Math.round(
            recentApprovals.reduce((s, e) => s + e.decisionTimeMs, 0) /
              recentApprovals.length,
          ),
        },
        "Approval fatigue detected — cooling period activated",
      );

      return warning;
    }

    return null;
  }

  /**
   * Check if we're currently in a cooling period.
   * Returns remaining cooling time in ms, or 0 if no cooling active.
   */
  getCoolingRemaining(): number {
    if (!this.coolingUntil) return 0;
    const remaining = this.coolingUntil - Date.now();
    if (remaining <= 0) {
      this.coolingUntil = null;
      return 0;
    }
    return remaining;
  }

  /**
   * Check if a new approval prompt should be delayed.
   */
  shouldDelay(): boolean {
    return this.getCoolingRemaining() > 0;
  }

  /** Get approval statistics for display. */
  getStats(): {
    totalApprovals: number;
    totalDenials: number;
    avgDecisionMs: number;
    rapidApprovalCount: number;
    coolingActive: boolean;
  } {
    const approvals = this.history.filter((e) => e.decision === "approve");
    const denials = this.history.filter((e) => e.decision === "deny");
    const avgMs =
      approvals.length > 0
        ? approvals.reduce((s, e) => s + e.decisionTimeMs, 0) / approvals.length
        : 0;

    return {
      totalApprovals: approvals.length,
      totalDenials: denials.length,
      avgDecisionMs: Math.round(avgMs),
      rapidApprovalCount: this.getRecentRapidApprovals().length,
      coolingActive: this.shouldDelay(),
    };
  }

  /** Reset the tracker (e.g., at session start). */
  reset(): void {
    this.history = [];
    this.coolingUntil = null;
  }

  private getRecentRapidApprovals(): ApprovalEvent[] {
    const now = Date.now();
    const windowMs = 30_000;

    // Look at recent events within the window, but a denial anywhere
    // in the sequence proves the human is paying attention — reset count.
    const recentInWindow = this.history.filter(
      (e) => now - e.timestamp < windowMs,
    );

    // Find the last denial — only count consecutive approvals after it
    let lastDenialIndex = -1;
    for (let i = recentInWindow.length - 1; i >= 0; i--) {
      if (recentInWindow[i].decision === "deny") {
        lastDenialIndex = i;
        break;
      }
    }

    // Only count rapid approvals AFTER the last denial
    const afterDenial = recentInWindow.slice(lastDenialIndex + 1);
    return afterDenial.filter(
      (e) =>
        e.decision === "approve" && e.decisionTimeMs < this.rapidThresholdMs,
    );
  }
}
