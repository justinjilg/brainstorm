import React from "react";
import { Box, Text } from "ink";
import { Gauge } from "../viz/Gauge.js";
import { Sparkline } from "../viz/Sparkline.js";
import { getProviderColor } from "../../theme.js";

interface RoutingEntry {
  model: string;
  strategy: string;
  reason: string;
  timestamp: number;
}

interface ToolStat {
  name: string;
  calls: number;
  successes: number;
}

interface DashboardModeProps {
  sessionCost: number;
  tokenCount: { input: number; output: number };
  modelCount: { local: number; cloud: number };
  routingHistory: RoutingEntry[];
  toolStats: ToolStat[];
  turnCount: number;
  sessionStart: number;
}

function formatElapsed(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

export function DashboardMode({
  sessionCost,
  tokenCount,
  modelCount,
  routingHistory,
  toolStats,
  turnCount,
  sessionStart,
}: DashboardModeProps) {
  const elapsed = Date.now() - sessionStart;
  const costPerHour = elapsed > 60000 ? (sessionCost / elapsed) * 3600000 : 0;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Top: Session Stats */}
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <Box flexDirection="column">
          <Text color="gray">Session Cost</Text>
          <Text color="yellow" bold>
            ${sessionCost.toFixed(4)}
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">Tokens</Text>
          <Text>
            {formatTokens(tokenCount.input)}
            <Text color="gray">↑</Text> {formatTokens(tokenCount.output)}
            <Text color="gray">↓</Text>
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">Turns</Text>
          <Text bold>{turnCount}</Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">Elapsed</Text>
          <Text>{formatElapsed(elapsed)}</Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">$/hour</Text>
          <Text
            color={
              costPerHour > 5 ? "red" : costPerHour > 1 ? "yellow" : "green"
            }
          >
            ${costPerHour.toFixed(2)}
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">Models</Text>
          <Text>
            {modelCount.local}
            <Text color="gray">L</Text>/{modelCount.cloud}
            <Text color="gray">C</Text>
          </Text>
        </Box>
      </Box>

      {/* Middle: Two panels side by side */}
      <Box marginTop={1} flexDirection="row" flexGrow={1}>
        {/* Left: Routing Log */}
        <Box
          borderStyle="round"
          borderColor="gray"
          flexGrow={1}
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="green">
            {" "}
            Routing Log
          </Text>
          {routingHistory.length === 0 ? (
            <Text color="gray" dimColor>
              {" "}
              No routing decisions yet. Send a message to start.
            </Text>
          ) : (
            routingHistory.slice(0, 8).map((entry, i) => (
              <Box key={i}>
                <Text color="gray" dimColor>
                  {timeAgo(entry.timestamp).padEnd(8)}
                </Text>
                <Text color={getProviderColor(entry.model)} bold>
                  {entry.model.padEnd(20)}
                </Text>
                <Text color="gray">{entry.strategy}</Text>
              </Box>
            ))
          )}
          {routingHistory.length > 0 && (
            <Box marginTop={1}>
              <Text color="gray" dimColor>
                {" "}
                {routingHistory.length} decision
                {routingHistory.length > 1 ? "s" : ""} this session
              </Text>
            </Box>
          )}
        </Box>

        {/* Right: Tool Health */}
        <Box
          borderStyle="round"
          borderColor="gray"
          flexGrow={1}
          paddingX={1}
          marginLeft={1}
          flexDirection="column"
        >
          <Text bold color="cyan">
            {" "}
            Tool Health
          </Text>
          {toolStats.length === 0 ? (
            <Text color="gray" dimColor>
              {" "}
              No tool calls yet.
            </Text>
          ) : (
            toolStats
              .sort((a, b) => b.calls - a.calls)
              .slice(0, 10)
              .map((tool) => {
                const rate =
                  tool.calls > 0
                    ? Math.round((tool.successes / tool.calls) * 100)
                    : 0;
                const color =
                  rate >= 90 ? "green" : rate >= 70 ? "yellow" : "red";
                return (
                  <Box key={tool.name}>
                    <Text color={color}>
                      {rate >= 90 ? "●" : rate >= 70 ? "●" : "●"}{" "}
                    </Text>
                    <Text>{tool.name.padEnd(16)}</Text>
                    <Text color="gray">
                      {String(tool.calls).padStart(3)} calls{" "}
                    </Text>
                    <Gauge value={rate} width={10} showPercent={false} />
                    <Text color={color}> {rate}%</Text>
                  </Box>
                );
              })
          )}
        </Box>
      </Box>
    </Box>
  );
}
