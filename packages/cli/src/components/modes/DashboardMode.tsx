import React, { useEffect } from "react";
import { Box, Text } from "ink";
import { Gauge } from "../viz/Gauge.js";
import { Sparkline } from "../viz/Sparkline.js";
import { getProviderColor } from "../../theme.js";
import type { BRDashboardData } from "../../hooks/useBRData.js";

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
  brData?: BRDashboardData;
  onRefreshBR?: () => void;
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
  brData,
  onRefreshBR,
}: DashboardModeProps) {
  const elapsed = Date.now() - sessionStart;
  const costPerHour = elapsed > 60000 ? (sessionCost / elapsed) * 3600000 : 0;

  // Auto-fetch BR data on first mount
  useEffect(() => {
    if (onRefreshBR && (!brData || brData.lastFetched === 0)) {
      onRefreshBR();
    }
  }, []);

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
          <Text color="gray">Session</Text>
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
        {brData?.forecast && (
          <Box flexDirection="column">
            <Text color="gray">Forecast</Text>
            <Text color={brData.forecast.will_exceed ? "red" : "green"} bold>
              ${brData.forecast.projected_spend.toFixed(2)}
            </Text>
          </Box>
        )}
      </Box>

      {/* Middle row: 3 panels */}
      <Box marginTop={1} flexDirection="row" flexGrow={1}>
        {/* Left: Routing Log + Leaderboard */}
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
              Send a message to start.
            </Text>
          ) : (
            routingHistory.slice(0, 6).map((entry, i) => (
              <Box key={i}>
                <Text color="gray" dimColor>
                  {timeAgo(entry.timestamp).padEnd(8)}
                </Text>
                <Text color={getProviderColor(entry.model)} bold>
                  {entry.model.padEnd(18)}
                </Text>
                <Text color="gray">{entry.strategy}</Text>
              </Box>
            ))
          )}

          {/* BR Leaderboard */}
          {brData && brData.leaderboard.length > 0 && (
            <>
              <Text> </Text>
              <Text bold color="yellow">
                {" "}
                Leaderboard
              </Text>
              {brData.leaderboard.slice(0, 5).map((entry, i) => (
                <Box key={i}>
                  <Text color="gray">{String(i + 1).padStart(2)}. </Text>
                  <Text color={getProviderColor(entry.provider)} bold>
                    {entry.model.split("/").pop()?.padEnd(18) ??
                      entry.model.padEnd(18)}
                  </Text>
                  <Text color="gray">
                    Q{entry.quality_rank} S{entry.speed_rank} V
                    {entry.value_rank}
                  </Text>
                </Box>
              ))}
            </>
          )}
        </Box>

        {/* Center: Tool Health */}
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
              .slice(0, 8)
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
                      {rate >= 90 ? "●" : rate >= 70 ? "◐" : "○"}{" "}
                    </Text>
                    <Text>{tool.name.padEnd(14)}</Text>
                    <Text color="gray">{String(tool.calls).padStart(3)} </Text>
                    <Gauge value={rate} width={8} showPercent={false} />
                    <Text color={color}> {rate}%</Text>
                  </Box>
                );
              })
          )}

          {/* BR Waste Detection */}
          {brData?.waste && brData.waste.total_waste_usd > 0 && (
            <>
              <Text> </Text>
              <Text bold color="red">
                {" "}
                Waste: ${brData.waste.total_waste_usd.toFixed(2)}
              </Text>
              {brData.waste.suggestions.slice(0, 3).map((s, i) => (
                <Text key={i} color="gray" dimColor>
                  {" "}
                  {s.description.slice(0, 50)}
                </Text>
              ))}
            </>
          )}
        </Box>

        {/* Right: Audit + Daily Trend */}
        <Box
          borderStyle="round"
          borderColor="gray"
          flexGrow={1}
          paddingX={1}
          marginLeft={1}
          flexDirection="column"
        >
          <Text bold color="magenta">
            {" "}
            Guardian Audit
          </Text>
          {!brData || brData.audit.length === 0 ? (
            <Text color="gray" dimColor>
              {" "}
              No audit data. Press r to refresh.
            </Text>
          ) : (
            brData.audit.slice(0, 6).map((entry, i) => {
              const statusColor =
                entry.guardian_status === "safe"
                  ? "green"
                  : entry.guardian_status === "flagged"
                    ? "yellow"
                    : "red";
              return (
                <Box key={i}>
                  <Text color={statusColor}>
                    {entry.guardian_status === "safe" ? "●" : "⚠"}{" "}
                  </Text>
                  <Text color={getProviderColor(entry.model)}>
                    {entry.model.split("/").pop()?.padEnd(14) ?? ""}
                  </Text>
                  <Text color="gray">${entry.cost_usd.toFixed(4)}</Text>
                </Box>
              );
            })
          )}

          {/* Daily Cost Trend */}
          {brData && brData.dailyTrend.length > 0 && (
            <>
              <Text> </Text>
              <Text bold color="blue">
                {" "}
                7-Day Trend
              </Text>
              <Box>
                <Sparkline
                  data={brData.dailyTrend.map((d) => d.cost_usd)}
                  color="yellow"
                  width={20}
                />
                <Text color="gray">
                  {" "}
                  $
                  {brData.dailyTrend
                    .reduce((s, d) => s + d.cost_usd, 0)
                    .toFixed(2)}{" "}
                  total
                </Text>
              </Box>
            </>
          )}
        </Box>
      </Box>

      {/* Bottom: Status */}
      <Box paddingX={1}>
        <Text color="gray" dimColor>
          {brData?.loading
            ? "Loading BR data..."
            : brData?.error
              ? `BR: ${brData.error}`
              : `r refresh │ ${modelCount.local}L/${modelCount.cloud}C`}
        </Text>
      </Box>
    </Box>
  );
}
