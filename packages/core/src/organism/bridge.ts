/**
 * The daemon→organism bridge.
 *
 * The KAIROS daemon keeps yielding its native {@link AgentEvent}s to its own
 * spawner (unchanged); this pure mapper projects the subset that the organism
 * cares about onto {@link OrganismEventInput}s so the daemon can ALSO publish to
 * the bus. Keeping the mapping a pure function makes the projection testable in
 * isolation and keeps the controller's emit path a one-liner.
 *
 * It also carries the chat loop's routing producer ({@link publishRouteDecision}):
 * the daemon's `run()` is wrapped to mirror every event, but the chat loop isn't,
 * so it publishes its own route at its routing seam.
 */
import type {
  AgentEvent,
  OrganismEventInput,
  RoutingDecision,
} from "@brainst0rm/shared";
import { getOrganismBus } from "./bus.js";

/**
 * Project a daemon-emitted AgentEvent onto an organism event, or `null` when the
 * event has no organism projection (most chat-loop events don't — the daemon
 * only surfaces its heartbeat and routing here).
 */
export function agentEventToOrganism(
  ev: AgentEvent,
): OrganismEventInput | null {
  switch (ev.type) {
    case "daemon-tick":
      return {
        type: "kairos.tick",
        tickNumber: ev.tickNumber,
        idleSeconds: ev.idleSeconds,
        cost: ev.cost,
        actor: "kairos",
      };
    case "daemon-sleep":
      return {
        type: "kairos.sleep",
        sleepMs: ev.sleepMs,
        reason: ev.reason,
        actor: "kairos",
      };
    case "daemon-wake":
      return { type: "kairos.wake", trigger: ev.trigger, actor: "kairos" };
    case "daemon-stopped":
      return {
        type: "kairos.state",
        status: "stopped",
        tickCount: ev.tickCount,
        totalCost: ev.totalCost,
        actor: "kairos",
      };
    case "routing":
      return {
        type: "route.decision",
        taskType: "daemon",
        model: ev.decision.model.id,
        provider: ev.decision.model.provider,
        strategy: ev.decision.strategy,
        estimatedCost: ev.decision.estimatedCost,
        actor: "kairos",
      };
    default:
      return null;
  }
}

/**
 * Publish a chat-loop routing decision to the organism bus (best-effort). The
 * daemon mirrors its routes through {@link agentEventToOrganism}; the chat loop
 * isn't wrapped, so it calls this at its routing seam with the real task type.
 * The bus must never break the loop — any failure is swallowed.
 */
export function publishRouteDecision(
  decision: RoutingDecision,
  taskType: string,
  actor = "you",
): void {
  try {
    getOrganismBus().publish({
      type: "route.decision",
      taskType,
      model: decision.model.id,
      provider: decision.model.provider,
      strategy: decision.strategy,
      estimatedCost: decision.estimatedCost,
      actor,
    });
  } catch {
    // Non-fatal: a live-telemetry publish is never worth failing a turn.
  }
}
