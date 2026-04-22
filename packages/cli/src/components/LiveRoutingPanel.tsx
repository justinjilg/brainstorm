/**
 * LiveRoutingPanel — rolling view of BR's push-first routing decisions.
 *
 * Subscribes (via useRoutingStream) to BR's `GET /v1/routing-stream` and
 * renders the most recent N decisions as a scrolling list. Intended to sit
 * next to the existing static routing-history / leaderboard panels in
 * DashboardMode. When the stream is disabled or credentials are absent,
 * renders a single line explaining how to enable it instead.
 */

import React from "react";
import { Box, Text } from "ink";
import type { RoutingStreamEvent } from "@brainst0rm/gateway";
import type { ConnectionState } from "@brainst0rm/gateway";

interface LiveRoutingPanelProps {
  events: RoutingStreamEvent[];
  state: ConnectionState;
  gapCount: number;
  enabled: boolean;
  hasApiKey: boolean;
  maxRows?: number;
}

const STRATEGY_COLORS: Record<string, string> = {
  quality: "magenta",
  price: "green",
  latency: "cyan",
  throughput: "yellow",
  priority: "red",
  cascade: "blue",
};

function strategyColor(strategy: string): string {
  return STRATEGY_COLORS[strategy] ?? "white";
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${(usd * 1000).toFixed(2)}m`; // milli-dollars
  return `$${usd.toFixed(3)}`;
}

function formatCache(cache: RoutingStreamEvent["decision"]["cache"]): string {
  switch (cache) {
    case "hit":
      return "◉";
    case "miss":
      return "○";
    case "skip":
      return "—";
    default:
      return "?";
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function renderConnectionStatus(
  state: ConnectionState,
  enabled: boolean,
  hasApiKey: boolean,
): { text: string; color: string } {
  if (!enabled) return { text: "disabled", color: "gray" };
  if (!hasApiKey) return { text: "no API key", color: "red" };
  switch (state.phase) {
    case "idle":
      return { text: "idle", color: "gray" };
    case "connecting":
      return { text: "connecting…", color: "yellow" };
    case "open":
      return { text: "● live", color: "green" };
    case "reconnecting":
      return {
        text: `reconnecting (attempt ${state.attempt}, next in ${Math.round(state.nextAttemptMs / 1000)}s)`,
        color: "yellow",
      };
    case "closed":
      return { text: "closed", color: "gray" };
    default:
      return { text: "unknown", color: "gray" };
  }
}

export const LiveRoutingPanel: React.FC<LiveRoutingPanelProps> = ({
  events,
  state,
  gapCount,
  enabled,
  hasApiKey,
  maxRows = 12,
}) => {
  const status = renderConnectionStatus(state, enabled, hasApiKey);
  const visible = events.slice(-maxRows).reverse(); // newest first

  if (!enabled) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Live Routing</Text>
        <Text color="gray">
          Enable with <Text bold>routing.routingStream = true</Text> in{" "}
          <Text bold>~/.brainstorm/config.toml</Text>
        </Text>
      </Box>
    );
  }

  if (!hasApiKey) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Live Routing</Text>
        <Text color="red">
          Requires BRAINSTORM_ROUTER_API_KEY in environment
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>Live Routing</Text>
        <Text> </Text>
        <Text color={status.color}>{status.text}</Text>
        {gapCount > 0 ? (
          <>
            <Text> </Text>
            <Text color="yellow">
              ⚠ {gapCount} missed {gapCount === 1 ? "event" : "events"}
            </Text>
          </>
        ) : null}
      </Box>

      {visible.length === 0 ? (
        <Text color="gray">Waiting for routing decisions…</Text>
      ) : (
        visible.map((evt) => {
          const d = evt.decision;
          const ts = new Date(d.ts).toISOString().slice(11, 19); // HH:MM:SS
          return (
            <Box key={evt.eventId}>
              <Text color="gray">{ts}</Text>
              <Text> </Text>
              <Text color={strategyColor(d.strategy)}>
                {d.strategy.padEnd(10).slice(0, 10)}
              </Text>
              <Text> </Text>
              <Text>{truncate(d.selected_model, 26).padEnd(26)}</Text>
              <Text> </Text>
              <Text color="gray">{formatCache(d.cache)}</Text>
              <Text> </Text>
              <Text color="gray">
                {formatCost(d.cost_estimate_usd).padStart(7)}
              </Text>
              <Text> </Text>
              <Text color="gray">{truncate(d.why, 30)}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
};
