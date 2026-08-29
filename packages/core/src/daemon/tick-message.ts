/**
 * Tick Message Formatter — builds the <tick> message injected each cycle.
 *
 * The tick message gives the model temporal context:
 * - Current time (for time-aware decisions)
 * - Tick number (for self-limiting behavior)
 * - Idle duration (how long since last activity)
 * - Log summary (what happened recently)
 * - Pending tasks (from scheduler)
 *
 * The model responds by either doing work or calling daemon_sleep.
 */

import type {
  DaemonState,
  DriftNotice,
  PlatformEventNotice,
  WorldStateSummary,
} from "./types.js";

export interface TickMessageContext {
  state: DaemonState;
  logSummary?: string;
  dueTasks?: string[];
  pendingTasks?: string[];
  budgetRemaining?: number;
  promptCacheStale?: boolean;
  /** Summary of active (system-tier) memory entries. */
  memorySummary?: string;
  /** Available skill names for autonomous invocation. */
  availableSkills?: Array<{ name: string; description: string }>;
  /** What the daemon can currently see and reach (connectors, BR, project). */
  worldState?: WorldStateSummary;
  /** Open drift observations from the harness world model. */
  openDrifts?: DriftNotice[];
  /** Unconsumed platform events pushed by connected products. */
  platformEvents?: PlatformEventNotice[];

  /** Fleet quality signals from quality observability middleware. */
  fleetSummary?: {
    activeSessions: number;
    avgReadEditRatio: number;
    totalFailures: number;
    degradedSessions: string[];
  };

  // ── Daemon Self-Awareness (KAIROS ↔ BR intelligence loop) ──

  /** Performance metrics from the router — makes the model aware of its own trajectory. */
  daemonMetrics?: DaemonMetrics;

  /** Self-improvement charter — the daemon's standing objective, if enabled. */
  selfImprovement?: {
    enabled: boolean;
    /** "off" | "propose" | "branch" — what may happen to a verified fix. */
    autonomy: "off" | "propose" | "branch";
    /** Isolated branch for auto-committed fixes. */
    branch: string;
  };
}

export interface DaemonMetrics {
  /** Success rate over recent ticks (0.0-1.0). */
  successRate: number;
  /** Model momentum strength. */
  momentum: "strong" | "building" | "none" | "broken";
  /** Currently active model ID. */
  activeModel: string;
  /** Consecutive successes with current model. */
  consecutiveSuccesses: number;
  /** Budget pressure level. */
  budgetPressure: "healthy" | "moderate" | "high" | "critical";
  /** Whether tick interval has been stretched by cost pacer. */
  costPacingActive: boolean;
  /** Ticks until next approval gate (null = no gates configured). */
  ticksUntilGate: number | null;
  /** Convergence warning from Thompson sampling, if any. */
  convergenceWarning?: string;
}

export function formatTickMessage(ctx: TickMessageContext): string {
  const now = new Date();
  const idleSeconds = ctx.state.lastTickAt
    ? Math.floor((Date.now() - ctx.state.lastTickAt) / 1000)
    : 0;

  const parts: string[] = [
    `<tick time="${now.toISOString()}" tick_number="${ctx.state.tickCount + 1}" idle_seconds="${idleSeconds}">`,
  ];

  // Budget context
  if (ctx.budgetRemaining !== undefined) {
    parts.push(
      `  <budget remaining="$${ctx.budgetRemaining.toFixed(4)}" spent="$${ctx.state.totalCost.toFixed(4)}" />`,
    );
  }

  // Prompt cache status
  if (ctx.promptCacheStale) {
    parts.push(
      `  <cache status="stale" note="Prompt cache expired. This tick costs more input tokens." />`,
    );
  }

  // Perception — what the daemon can see and reach. On tick 1 this is the
  // awakening inventory: the model wakes up already knowing its world.
  if (ctx.worldState) {
    const w = ctx.worldState;
    const healthy = w.connectors.filter((c) => c.healthy).length;
    parts.push(
      `  <perception connectors="${w.connectors.length}" healthy="${healthy}">`,
    );
    for (const c of w.connectors) {
      if (c.healthy) {
        const domains = c.domains?.length
          ? ` (domains: ${c.domains.join(", ")})`
          : "";
        parts.push(`    - ${c.name}: healthy, ${c.toolCount} tools${domains}`);
      } else {
        parts.push(`    - ${c.name}: UNREACHABLE`);
      }
    }
    if (w.br) {
      const brBits = [
        `connected="${w.br.connected}"`,
        w.br.models !== undefined ? `models="${w.br.models}"` : "",
        w.br.budgetRemainingUsd !== undefined
          ? `budget_remaining="$${w.br.budgetRemainingUsd.toFixed(2)}"`
          : "",
        w.br.note ? `note="${w.br.note}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      parts.push(`    <br ${brBits} />`);
    }
    if (w.project) {
      const p = w.project;
      const projBits = [
        p.name ? `name="${p.name}"` : "",
        `onboarded="${p.onboarded}"`,
        p.memoryCount !== undefined ? `memories="${p.memoryCount}"` : "",
        p.codeGraphNodes !== undefined
          ? `code_graph_nodes="${p.codeGraphNodes}"`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      parts.push(`    <project ${projBits} />`);
    }
    parts.push(`  </perception>`);
  }

  // Open drift — the world model disagrees with observed reality. These are
  // the daemon's notices: things worth investigating without being asked.
  if (ctx.openDrifts && ctx.openDrifts.length > 0) {
    parts.push(`  <drift open="${ctx.openDrifts.length}">`);
    for (const d of ctx.openDrifts) {
      const source = d.source ? ` source=${d.source}` : "";
      parts.push(
        `    - [${d.severity}] ${d.kind}: ${d.summary} (id=${d.id}${source})`,
      );
    }
    parts.push(`  </drift>`);
  }

  // Platform events — pushed perception from connected products.
  if (ctx.platformEvents && ctx.platformEvents.length > 0) {
    parts.push(`  <platform_events count="${ctx.platformEvents.length}">`);
    for (const ev of ctx.platformEvents) {
      const ageSec = Math.max(
        0,
        Math.floor((Date.now() - ev.receivedAt) / 1000),
      );
      parts.push(
        `    - [${ev.source}] ${ev.eventType}: ${ev.summary} (${ageSec}s ago)`,
      );
    }
    parts.push(`  </platform_events>`);
  }

  // Scheduled tasks that are due
  if (ctx.dueTasks && ctx.dueTasks.length > 0) {
    parts.push(`  <due_tasks>`);
    for (const task of ctx.dueTasks) {
      parts.push(`    - ${task}`);
    }
    parts.push(`  </due_tasks>`);
  }

  // Pending tasks from user
  if (ctx.pendingTasks && ctx.pendingTasks.length > 0) {
    parts.push(`  <pending_tasks>`);
    for (const task of ctx.pendingTasks) {
      parts.push(`    - ${task}`);
    }
    parts.push(`  </pending_tasks>`);
  }

  // Recent activity summary
  if (ctx.logSummary) {
    parts.push(`  <recent_activity>`);
    parts.push(`    ${ctx.logSummary}`);
    parts.push(`  </recent_activity>`);
  }

  // Memory awareness — what the daemon knows
  if (ctx.memorySummary) {
    parts.push(`  <memory_summary>`);
    parts.push(`    ${ctx.memorySummary}`);
    parts.push(`  </memory_summary>`);
  }

  // Available skills — the daemon's playbook
  if (ctx.availableSkills && ctx.availableSkills.length > 0) {
    parts.push(`  <available_skills count="${ctx.availableSkills.length}">`);
    for (const skill of ctx.availableSkills) {
      parts.push(`    - ${skill.name}: ${skill.description}`);
    }
    parts.push(`  </available_skills>`);
  }

  // Fleet quality signals — aggregated from subagent quality observability
  if (ctx.fleetSummary) {
    const f = ctx.fleetSummary;
    parts.push(
      `  <fleet_quality sessions="${f.activeSessions}" avg_read_edit_ratio="${f.avgReadEditRatio}" failures="${f.totalFailures}">`,
    );
    if (f.degradedSessions.length > 0) {
      parts.push(
        `    <degraded count="${f.degradedSessions.length}" note="These sessions have Read:Edit ratio below 3.0 — agents are editing without sufficient research">`,
      );
      for (const sid of f.degradedSessions) {
        parts.push(`      - ${sid}`);
      }
      parts.push(`    </degraded>`);
    }
    parts.push(`  </fleet_quality>`);
  }

  // Daemon self-awareness — performance metrics from the router
  if (ctx.daemonMetrics) {
    const m = ctx.daemonMetrics;
    parts.push(`  <performance>`);
    parts.push(
      `    <model id="${m.activeModel}" momentum="${m.momentum}" successes="${m.consecutiveSuccesses}" />`,
    );
    parts.push(
      `    <success_rate>${(m.successRate * 100).toFixed(0)}%</success_rate>`,
    );
    parts.push(`    <budget_pressure>${m.budgetPressure}</budget_pressure>`);
    if (m.costPacingActive) {
      parts.push(
        `    <cost_pacing active="true" note="Tick intervals stretched to conserve budget" />`,
      );
    }
    if (m.ticksUntilGate !== null) {
      parts.push(`    <next_gate ticks="${m.ticksUntilGate}" />`);
    }
    if (m.convergenceWarning) {
      parts.push(`    <warning>${m.convergenceWarning}</warning>`);
    }
    parts.push(`  </performance>`);
  }

  parts.push(`</tick>`);
  parts.push("");
  const hasNotices =
    (ctx.openDrifts?.length ?? 0) > 0 || (ctx.platformEvents?.length ?? 0) > 0;

  const si = ctx.selfImprovement;
  if (si?.enabled) {
    parts.push(buildSelfImprovementDirective(si, hasNotices));
  } else {
    parts.push(
      hasNotices
        ? "You are in daemon mode. Open drift and platform events above are live signals from your environment: pick the most important one, investigate it with read-only tools first, and prepare a fix within your authority — propose a ChangeSet for anything material, never mutate beyond your grants. If other work is due, do it. If nothing needs you, call daemon_sleep with an appropriate duration and reason. Be efficient with tokens."
        : "You are in daemon mode. Review the tick context above. If there's work to do, do it. If not, call daemon_sleep with an appropriate duration and reason. Do not generate unnecessary output — be efficient with tokens.",
    );
  }

  return parts.join("\n");
}

/**
 * The self-improvement charter — the daemon's standing directive. Turns each
 * idle tick into a unit of continuous self-hardening: perceive one concrete,
 * evidence-backed weakness in Brainstorm's OWN state, fix it, VERIFY the fix,
 * and record the outcome as feedback — all on an isolated branch so `main` is
 * never touched.
 */
function buildSelfImprovementDirective(
  si: NonNullable<TickMessageContext["selfImprovement"]>,
  hasNotices: boolean,
): string {
  const lines: string[] = [];
  lines.push(
    "You are KAIROS, the always-on operator of Brainstorm. Your STANDING OBJECTIVE is to make Brainstorm's own state continuously more robust and stable — with no prompt, on your own initiative.",
  );
  lines.push("");
  lines.push(
    "You work inside an ISOLATED CLONE of Brainstorm (its own .git). You have NO shell and NO raw git — by design, so nothing you do can reach the real repo. Read with grep/file_read/code tools; edit with file_edit; commit with the `commit_self_heal` tool (it typechecks, then commits to the clone).",
  );
  lines.push("");
  lines.push("Each tick, run one unit of self-improvement:");
  lines.push(
    "1. PERCEIVE a weakness with read-only tools (grep, file_read, code_* ). Prefer concrete, evidence-backed problems: a type error, a failing check, an unhandled error in the logs above, open drift, a brittle joint (a missing guard, an FK that can break, an unwired default). Pick the single highest-leverage one.",
  );

  if (si.autonomy === "branch") {
    lines.push(
      "2. FIX it with the smallest change that resolves the root cause, using file_edit. Match surrounding code and conventions.",
    );
    lines.push(
      "3. COMMIT with the `commit_self_heal` tool and a clear message describing the weakness and the fix. It VERIFIES (typecheck) first and commits ONLY if green — if it returns errors, fix them and call it again. The commit lands on the isolated clone; the user's repo is never touched.",
    );
  } else if (si.autonomy === "propose") {
    lines.push(
      "2. FIX it in the working tree with the smallest change that resolves the root cause.",
    );
    lines.push(
      "3. VERIFY before it counts: run the typecheck and the relevant tests. Only a green fix is real.",
    );
    lines.push(
      "4. PROPOSE — stage the verified change as a ChangeSet for human review. Do NOT commit; you are in propose-only mode.",
    );
  } else {
    lines.push(
      "2. Autonomy is OFF: do not modify code. Record the weakness and the fix you would make so a human can act on it.",
    );
  }

  lines.push(
    "FEEDBACK: record the outcome — the problem, the fix, the verify result, and which model did the work — so the system learns which models solve which problems (this is the signal BR routes on).",
  );
  lines.push("");
  lines.push(
    "MESH: you are one of many models reachable through BrainstormRouter — the control layer. When a problem is hard or ambiguous, or outside your strengths, get independent perspectives from other models rather than guessing alone (fill your gaps with theirs). BR is how they collaborate.",
  );
  lines.push(
    "SAFETY: the isolated clone and the commit_self_heal tool are the hard controls — you literally have no shell and no raw git, so you cannot reach the user's repo. Do not attempt to; make one focused, verified fix and let commit_self_heal persist it. Be efficient with tokens.",
  );
  if (hasNotices) {
    lines.push(
      "Live drift/platform signals are above — weigh them as candidate weaknesses this tick.",
    );
  }
  lines.push(
    "If, after perceiving, nothing genuinely needs hardening right now, call daemon_sleep with an appropriate duration and reason instead of inventing busywork.",
  );
  return lines.join("\n");
}
